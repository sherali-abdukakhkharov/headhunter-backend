import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';

/** The setting that remembers what has already gone out. */
const LAST_NOTIFIED = 'release.last_notified_version';

/** The Bot API's own ceiling for a document a bot sends. */
const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50_000_000;

/** Telegram refuses a caption over this rather than trimming it. */
const CAPTION_LIMIT = 1024;

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  assets: GithubAsset[];
}

/**
 * Posts each new client release to Telegram, as the file plus what changed.
 *
 * ## Why this lives on the server and not in CI
 *
 * The obvious home is the workflow that builds the APK — it has the file in
 * hand. It does not have a bot. Giving it one means either a second bot or
 * putting **this** bot's token into GitHub Actions secrets, and this bot is the
 * file store: its token is the handle on the chat holding every CV and every
 * verification document a user has uploaded. That is not a credential to widen
 * the blast radius of for a release notice.
 *
 * So the direction is reversed. CI publishes the assets to a public release and
 * this polls for them, which needs no credential in either direction: the
 * GitHub API is read without a token and Telegram is written with one that
 * never leaves the server.
 *
 * ## Why polling, and why no scheduler
 *
 * A webhook would need an inbound route with its own shared secret — the thing
 * this exists to avoid. Polling costs one unauthenticated request every
 * [pollMinutes] minutes against a 60-per-hour limit.
 *
 * `setInterval` rather than `@nestjs/schedule`: one timer does not earn a
 * dependency, and there is exactly one API container
 * (`docker-compose.api.yml`), so there is no second instance to race. Even if
 * there were, [LAST_NOTIFIED] is written after a successful send and compared
 * before the next one.
 *
 * ## Which file it sends
 *
 * The **arm64** APK, not the universal one. A bot may send 50 MB and the
 * universal build is about 65 — three ABIs of the Flutter engine plus Firebase.
 * The arm64 file is around 40 and runs on every Android phone sold since
 * roughly 2017. Both report the same `versionCode`, so a person can move
 * between the two; that is why the workflow builds it with `--target-platform`
 * rather than `--split-per-abi`.
 *
 * ## Its own timeout
 *
 * `RELEASE_TIMEOUT_MS`, not the file store's `TELEGRAM_TIMEOUT_MS`. That one is
 * 30 seconds because a CV is a few hundred kilobytes each way; this moves a
 * 23 MB APK **twice** — down from GitHub, up to Telegram. The first attempt on
 * the deployed API aborted at 30 s and logged "This operation was aborted",
 * which is what a shared timeout tuned for the smaller case looks like from the
 * larger one.
 *
 * ## What it is not
 *
 * Not an update check for the app. This tells a person a build exists; a client
 * asking "am I current?" is a different question with a different answer shape,
 * and inventing one here would make this the accidental authority on it.
 */
@Injectable()
export class ReleaseNotifierService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReleaseNotifierService.name);

  private readonly token: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly repo: string;
  private readonly pollMinutes: number;

  private timer?: NodeJS.Timeout;

  /** The version last complained about, so a broken release logs once. */
  private warnedAbout: string | null = null;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.chatId = config.get('RELEASE_CHAT_ID', { infer: true });
    this.apiBase = config.get('TELEGRAM_API_BASE_URL', { infer: true });
    this.timeoutMs = config.get('RELEASE_TIMEOUT_MS', { infer: true });
    this.repo = config.get('RELEASE_REPO', { infer: true });
    this.pollMinutes = config.get('RELEASE_POLL_MINUTES', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.chatId) {
      this.logger.log('RELEASE_CHAT_ID is not set; release notices are off.');
      return;
    }

    this.logger.log(
      `Watching ${this.repo} for releases every ${this.pollMinutes} min.`,
    );

    // `unref` so a shutdown is not held open by a timer that has nothing to
    // finish, and an immediate first check so a restart after a release does
    // not wait a whole interval.
    this.timer = setInterval(
      () => void this.check(),
      this.pollMinutes * 60_000,
    );
    this.timer.unref();

    void this.check();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass: is there a release newer than the last one sent?
   *
   * Every failure is caught and logged. A GitHub outage, a Telegram refusal or
   * a half-published release must not take the API down with it, and the next
   * tick retries whatever went wrong — which is also why [LAST_NOTIFIED] is
   * written only after a send succeeds.
   */
  async check(): Promise<void> {
    if (!this.chatId) return;

    try {
      const release = await this.latestRelease();
      if (!release) return;

      const version = release.tag_name.replace(/^v/, '');
      const rank = rankOf(version);
      if (rank === null) {
        this.warnOnce(version, `tag ${release.tag_name} is not a version`);
        return;
      }

      const last = await this.lastNotified();
      if (last !== null && rank <= last) return;

      const apk = release.assets.find((a) => a.name.endsWith('-arm64.apk'));
      if (!apk) {
        // Ordinary for a minute or two: the workflow publishes the release and
        // its assets in one step, but a run that failed after tagging leaves a
        // release with nothing on it.
        this.warnOnce(version, `release ${release.tag_name} has no arm64 APK`);
        return;
      }

      const caption = await this.caption(release, version);
      const sent =
        apk.size <= TELEGRAM_DOCUMENT_LIMIT_BYTES
          ? await this.sendDocument(apk, caption)
          : await this.sendMessage(`${caption}\n\n${release.html_url}`);

      if (!sent) return;

      await this.remember(rank);
      this.warnedAbout = null;
      this.logger.log(`Sent ${release.tag_name} to Telegram.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // An abort names the timeout it hit, because "This operation was
      // aborted" on its own says nothing about which knob to turn.
      const detail =
        error instanceof Error && error.name === 'AbortError'
          ? `${reason} (RELEASE_TIMEOUT_MS is ${this.timeoutMs}ms)`
          : reason;
      this.logger.error(`Release check failed: ${detail}`);
    }
  }

  private async latestRelease(): Promise<GithubRelease | null> {
    const response = await this.fetchWithTimeout(
      `https://api.github.com/repos/${this.repo}/releases/latest`,
      { headers: { accept: 'application/vnd.github+json' } },
    );

    if (!response.ok) {
      this.logger.warn(`GitHub answered ${response.status} for the release.`);
      return null;
    }

    return (await response.json()) as GithubRelease;
  }

  /**
   * The Uzbek note the workflow published beside the APK.
   *
   * Read as an asset rather than parsed out of the release body: the file lives
   * in the client repository and a parser here would break the first time it
   * was reformatted. A release without one still goes out — the version alone
   * is worth more than silence.
   */
  private async caption(
    release: GithubRelease,
    version: string,
  ): Promise<string> {
    const asset = release.assets.find((a) => a.name === 'notes-uz.txt');
    let notes = 'Yangi versiya.';

    if (asset) {
      const response = await this.fetchWithTimeout(asset.browser_download_url);
      if (response.ok) notes = (await response.text()).trim() || notes;
    }

    const caption = `JobBridge ${version}\n\n${notes}`;

    return caption.length <= CAPTION_LIMIT
      ? caption
      : `${caption.slice(0, CAPTION_LIMIT - 120).trimEnd()}…\n\n${release.html_url}`;
  }

  private async sendDocument(
    apk: GithubAsset,
    caption: string,
  ): Promise<boolean> {
    const download = await this.fetchWithTimeout(apk.browser_download_url);
    if (!download.ok) {
      this.logger.warn(`Could not download ${apk.name}: ${download.status}`);
      return false;
    }

    const bytes = new Uint8Array(await download.arrayBuffer());

    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('caption', caption);
    form.append(
      'document',
      new Blob([bytes], { type: 'application/vnd.android.package-archive' }),
      apk.name,
    );

    return this.call('sendDocument', form);
  }

  private async sendMessage(text: string): Promise<boolean> {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('text', text);

    return this.call('sendMessage', form);
  }

  /**
   * Calls the Bot API.
   *
   * **The token is in the URL**, so nothing from a failure is logged verbatim —
   * only Telegram's own `description`, which never contains it.
   */
  private async call(method: string, form: FormData): Promise<boolean> {
    const response = await this.fetchWithTimeout(
      `${this.apiBase}/bot${this.token}/${method}`,
      { method: 'POST', body: form },
    );

    const body = (await response.json()) as {
      ok: boolean;
      description?: string;
    };

    if (!body.ok) {
      this.logger.warn(`Telegram refused ${method}: ${body.description}`);
      return false;
    }

    return true;
  }

  private async lastNotified(): Promise<number | null> {
    const row = await this.db
      .selectFrom('platform_settings')
      .select('value_int')
      .where('key', '=', LAST_NOTIFIED)
      .executeTakeFirst();

    return row ? Number(row.value_int) : null;
  }

  private async remember(rank: number): Promise<void> {
    await this.db
      .insertInto('platform_settings')
      .values({
        key: LAST_NOTIFIED,
        value_int: rank,
        updated_by_user_id: null,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc
          .column('key')
          .doUpdateSet({ value_int: rank, updated_at: new Date() }),
      )
      .execute();
  }

  private warnOnce(version: string, message: string): void {
    if (this.warnedAbout === version) return;

    this.warnedAbout = version;
    this.logger.warn(message);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `1.33.0` → `1_033_000`, so "newer" is one integer comparison.
 *
 * A number rather than the tag, because `platform_settings` stores integers and
 * because `>` on a rank cannot be fooled by a tag that was deleted and pushed
 * again at an older version — which a string equality check would resend.
 *
 * Three components, each below 1000. Anything else is not a version this
 * repository produces.
 */
export function rankOf(version: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(version.trim());
  if (!match) return null;

  const [, major, minor, patch] = match;

  return Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
}
