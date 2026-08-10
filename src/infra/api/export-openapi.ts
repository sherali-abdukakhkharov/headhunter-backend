/**
 * Writes the OpenAPI description to `docs/openapi.json` (§13.2).
 *
 *   pnpm docs:openapi
 *
 * The running service already serves this at `/docs`, so why a file: the deliverable is
 * "a current API description", and a description that only exists while the service is up
 * cannot be read by somebody reviewing the handover, diffed in a pull request, or fed to a
 * client generator. Committing it also makes an accidental contract change **visible** -
 * a renamed field shows up in the diff of this file rather than in a Flutter
 * deserialization error.
 *
 * It builds the real application module, so every decorator and DTO is the running one -
 * but never listens on a port and never queries: `pg` connects lazily, so no database is
 * needed to produce it.
 *
 * **Runs from `dist`, not through `tsx`.** Every other script in this repository is a
 * `tsx` entry point, and this one cannot be: tsx compiles with esbuild, which does not
 * emit `design:paramtypes`, so Nest's DI injects `undefined` for every constructor
 * parameter and the first guard to read its config dies. The others get away with it
 * because they wire their dependencies by hand; this one boots the container. SWC (what
 * `nest build` uses) does emit the metadata, so `pnpm docs:openapi` builds first.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NestFactory } from '@nestjs/core';
import * as dotenv from 'dotenv';

import { AppModule } from '../../app.module';
import { buildOpenApiDocument } from './openapi';

async function main(): Promise<void> {
  dotenv.config({ quiet: true });

  // Errors only. Not `false`: a silent boot failure here looks exactly like a script
  // that did nothing, which cost a debugging session the first time.
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.init();

  const document = buildOpenApiDocument(app);
  const target = join(process.cwd(), 'docs', 'openapi.json');

  // Two spaces and a trailing newline, so a contract change is a readable diff rather
  // than one enormous line.
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;

  console.log(`wrote ${target}: ${paths} paths, ${schemas} schemas`);

  await app.close();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
