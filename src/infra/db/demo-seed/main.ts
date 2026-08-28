// MUST STAY FIRST. It writes an environment variable that `AppModule` reads while
// it is being imported; anything above it wins the race. See the file itself.
import './disarm-release-notifier';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';

import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import type { Database } from '@infra/db/database.module';
import { KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';

import { AppModule } from '../../../app.module';

import { demoRoster } from './people';
import { seedDemoWorld } from './seed';
import { demoUserCount, removeDemoWorld } from './teardown';

/**
 * Tester accounts, created and removed.
 *
 *   pnpm seed:demo          write the demo world
 *   pnpm seed:demo:clean    remove every row it wrote
 *
 * **Boots the whole application rather than opening a connection**, unlike every other
 * script in this directory. It has to: the point is that these rows are written by the
 * same services a request would use, and those services want their dependencies —
 * the field validator, the schema resolver, the notification dispatcher, the file
 * store. A hand-wired subset would be a second, quietly diverging copy of the module
 * graph.
 *
 * **So it runs from `dist`, not through `tsx`** — the second script in this repository
 * that has to, after `export-openapi.ts`, and for the same reason: tsx compiles with
 * esbuild, which does not emit `design:paramtypes`, so Nest injects `undefined` for
 * every constructor parameter and the first guard to read its config dies at boot.
 * SWC, which `nest build` uses, does emit it. The other scripts here get away with tsx
 * because they wire their dependencies by hand; anything that boots the container
 * cannot.
 *
 * Booting has one side effect worth disarming, and it is disarmed below.
 */
async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  const clean = process.argv.includes('--clean');

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The seeder's own output is the report; Nest's boot chatter buries it.
    logger: ['warn', 'error'],
  });

  // Proof that `disarm-release-notifier` ran before `AppModule` was imported. It is an
  // ordering constraint expressed as an import, which is the kind of thing a tidy-up
  // reorders without noticing - and the symptom would be an APK arriving in the
  // owner's Telegram chat because somebody seeded a database.
  const config = app.get<ConfigService<AppEnv, true>>(ConfigService);

  if (config.get('RELEASE_CHAT_ID', { infer: true })) {
    await app.close();
    throw new Error(
      'The release notifier is still armed: "./disarm-release-notifier" must be ' +
        'imported before "../../../app.module" in this file.',
    );
  }

  const db = app.get<Database>(KYSELY);

  try {
    if (clean) {
      const report = await removeDemoWorld(db);

      console.log('Demo accounts removed:');
      console.log(`  accounts deleted      ${report.deleted}`);
      console.log(`  accounts anonymised   ${report.anonymized}`);
      console.log(`  fixed login codes     ${report.demoLogins}`);
      console.log(`  stored files          ${report.files}`);
      console.log(`  complaints            ${report.complaints}`);
      console.log(`  pending OTP codes     ${report.otpCodes}`);

      if (report.anonymized > 0) {
        console.log(
          `\n${report.anonymized} account(s) could not be deleted: they hold audit or ledger\n` +
            'rows that this product keeps append-only on purpose. They were\n' +
            'anonymised instead — no phone, no name, no roles, nothing to sign\n' +
            'into — which is what a real account deletion does here too.',
        );
      }

      console.log(
        '\nUploaded documents stay in the Telegram storage chat: a bot can only\n' +
          'delete its own messages for 48 hours. They are generated files for\n' +
          'people who do not exist.',
      );

      return;
    }

    const existing = await demoUserCount(db);

    if (existing > 0) {
      // Refused rather than merged. The phone numbers are unique, so a second run
      // would sign in to the existing accounts and write a second profile, a second
      // set of vacancies and a second set of applications on top of them — a world
      // that looks seeded and is quietly doubled.
      throw new Error(
        `${existing} demo accounts already exist. Run "pnpm seed:demo:clean" ` +
          `first — re-seeding on top of them duplicates every vacancy and ` +
          `application rather than replacing them.`,
      );
    }

    if (process.env.DEMO_ACCOUNTS_ENABLED !== 'true') {
      // Refused, because the alternative is a seeded database whose accounts cannot
      // be signed into and no indication why: the numbers cannot receive an SMS
      // either, so the login screen simply fails.
      throw new Error(
        'DEMO_ACCOUNTS_ENABLED is not true, so the fixed codes this writes would ' +
          'not be accepted. Set it in .env and restart the API, then re-run.',
      );
    }

    const started = Date.now();
    await seedDemoWorld(app);

    console.log(`\nDone in ${Math.round((Date.now() - started) / 1000)}s.\n`);
    printRoster();
  } finally {
    await app.close();
  }
}

/**
 * The sign-in table, printed at the end of a run.
 *
 * Duplicated into `docs/TEST_ACCOUNTS.md`, which `test-accounts.spec.ts` checks
 * against this same fixture — so the document cannot drift from what was seeded, and
 * neither can this.
 */
function printRoster(): void {
  console.log('Sign in with these. Type the last nine digits into the app.\n');

  for (const account of demoRoster()) {
    const typed = account.phone.replace('+998', '');
    console.log(
      `  ${typed}  code ${account.code}  ${account.role.padEnd(9)} ${account.label}`,
    );
  }

  console.log('\nSee docs/TEST_ACCOUNTS.md for what each account is for.');
}

main().catch((error: unknown) => {
  // A fixture that fails the field validator says only "validation.failed" through
  // the normal channel, because the violations are the API's response body rather
  // than the message. Unpacked here: the whole point of this failing is to name the
  // field, and looking it up by hand is a five-minute detour every time.
  if (error instanceof ValidationFailedException) {
    console.error('The fixture failed validation:');

    for (const violation of error.violations) {
      console.error(
        `  ${violation.field}: ${violation.rule} (${violation.messageKey})`,
      );
    }
  } else {
    console.error(error instanceof Error ? error.stack : error);
  }

  process.exitCode = 1;
});
