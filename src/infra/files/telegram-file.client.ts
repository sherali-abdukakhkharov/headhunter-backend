import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { UpstreamError } from '@infra/api/exceptions/localized.exception';
import type { AppEnv } from '@infra/env-schema';
import type { MessageKey } from '@infra/i18n/messages';

/**
 * The Telegram Bot API, used as the file store.
 *
 * Bytes are sent to one fixed chat with `sendDocument`; Telegram answers with a
 * `file_id`, which is the download handle. Retrieval is `getFile` for a temporary
 * path, then a GET against the file endpoint.
 *
 * Three properties of that API shape everything here:
 *
 * 1. **The download URL contains the bot token.** `https://api.telegram.org/file/
 *    bot<token>/<path>` is an unauthenticated URL that anyone holding it can read,
 *    and it exposes the token itself. It must never be handed to a client - not
 *    even briefly, not even over TLS. Downloads are proxied through this service,
 *    which is also what §11.1 requires: no permanently public links.
 * 2. **`getFile` caps downloads at 20 MB** regardless of what a bot may send
 *    (50 MB). The upload limit is therefore validated against the *download*
 *    ceiling, or a file could be accepted and then be permanently unreadable.
 * 3. **The path expires after about an hour** ("guaranteed to be valid for at
 *    least 1 hour"), so it is fetched per download and never stored.
 *
 * Files also leave our infrastructure: they sit in a Telegram chat and are visible
 * to whoever can read that chat. That is a deliberate deployment decision, and it
 * makes the storage chat's access control part of this product's privacy surface.
 */

/** Telegram's envelope: every response is `{ok, result}` or `{ok, description}`. */
interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  document?: TelegramDocument;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/** What a successful upload gives us to persist. */
export interface UploadedFile {
  fileId: string;
  fileUniqueId: string;
  messageId: number;
  sizeBytes: number;
}

export interface FileToUpload {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  /** Sent as the message caption, so the storage chat is readable by a human. */
  caption?: string;
}

@Injectable()
export class TelegramFileClient implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramFileClient.name);

  private readonly token: string;
  private readonly chatId: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<AppEnv, true>) {
    this.token = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
    this.chatId = config.get('TELEGRAM_STORAGE_CHAT_ID', { infer: true });
    this.apiBase = config.get('TELEGRAM_API_BASE_URL', { infer: true });
    this.timeoutMs = config.get('TELEGRAM_TIMEOUT_MS', { infer: true });
  }

  /**
   * Sends bytes to the storage chat.
   *
   * `FormData`/`Blob` from the platform rather than a multipart library: Node 24
   * has both, and `fetch` encodes the boundary itself.
   *
   * `disable_notification` is set because the storage chat would otherwise ping on
   * every CV a candidate uploads.
   */
  async upload(file: FileToUpload): Promise<UploadedFile> {
    const form = new FormData();
    form.append('chat_id', this.chatId);
    form.append('disable_notification', 'true');

    if (file.caption) {
      form.append('caption', file.caption);
    }

    form.append(
      'document',
      new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      file.fileName,
    );

    const message = await this.call<TelegramMessage>('sendDocument', form);
    const document = message.document;

    if (!document) {
      // Telegram converts some uploads to a photo/video/audio message instead of a
      // document. Everything here is sent as a document deliberately - that is
      // what keeps the bytes untouched - so a non-document reply means the file
      // was re-encoded and what we stored is not what was uploaded.
      this.logger.error(
        `sendDocument returned message ${message.message_id} without a document`,
      );
      throw new UpstreamError('file.upload_failed');
    }

    return {
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      messageId: message.message_id,
      sizeBytes: document.file_size ?? file.bytes.length,
    };
  }

  /**
   * Downloads bytes by `file_id`.
   *
   * Two round trips, every time: `getFile` for a fresh path, then the file
   * endpoint. Caching the path would save a call for at most an hour and would put
   * a URL containing the bot token into a cache.
   */
  async download(fileId: string): Promise<Buffer> {
    const params = new URLSearchParams({ file_id: fileId });
    const file = await this.call<TelegramFile>(`getFile?${params.toString()}`);

    if (!file.file_path) {
      this.logger.error(`getFile returned no file_path for ${fileId}`);
      throw new UpstreamError('file.download_failed');
    }

    const response = await this.fetchWithTimeout(
      `${this.apiBase}/file/bot${this.token}/${file.file_path}`,
      'file.download_failed',
    );

    if (!response.ok) {
      // Logged without the URL: it contains the bot token.
      this.logger.error(
        `Telegram file download failed with HTTP ${response.status}`,
      );
      throw new UpstreamError('file.download_failed');
    }

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Deletes the message holding a file, best effort.
   *
   * Returns whether it worked instead of throwing: our metadata row is the record
   * a user acts on, and refusing their delete because Telegram declined to remove
   * a message older than 48 hours would be the wrong outcome. The failure is
   * logged so the residue is known.
   */
  async deleteMessage(messageId: number): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        chat_id: this.chatId,
        message_id: String(messageId),
      });

      await this.call<boolean>(`deleteMessage?${params.toString()}`);
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not delete Telegram message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Reports at boot whether the bot credentials work.
   *
   * A warning rather than a failed boot: a Telegram outage or a slow network at
   * start-up must not stop the API from serving everything that has nothing to do
   * with files. But a wrong token or an unreachable chat is a deployment mistake
   * that would otherwise surface as the first user's failed CV upload, so it is
   * said out loud once, at the moment someone is watching the logs.
   *
   * Deliberately not part of `GET /health`: that endpoint is polled continuously,
   * and calling `getMe` on every poll would spend Telegram's rate limit on
   * monitoring.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const bot = await this.call<{ username?: string }>('getMe');
      this.logger.log(
        `File storage ready: bot @${bot.username ?? 'unknown'}, chat ${this.chatId}`,
      );
    } catch {
      // `call` has already logged the reason.
      this.logger.warn(
        'File storage is not reachable. Uploads will fail until ' +
          'TELEGRAM_BOT_TOKEN and TELEGRAM_STORAGE_CHAT_ID are correct.',
      );
    }
  }

  private async call<T>(method: string, body?: FormData): Promise<T> {
    const failureKey: MessageKey = method.startsWith('sendDocument')
      ? 'file.upload_failed'
      : 'file.download_failed';

    const response = await this.fetchWithTimeout(
      `${this.apiBase}/bot${this.token}/${method}`,
      failureKey,
      body,
    );

    // Telegram reports application errors in the body with a non-2xx status, so
    // both have to be read before deciding.
    const payload = (await response.json()) as TelegramResponse<T>;

    if (!response.ok || !payload.ok || payload.result === undefined) {
      // `description` is Telegram's, e.g. "Bad Request: file is too big". Logged,
      // never returned: it is upstream wording in one language and would defeat
      // the localized error contract.
      this.logger.error(
        `Telegram ${method.split('?')[0]} failed: ` +
          `${payload.error_code ?? response.status} ${payload.description ?? ''}`,
      );

      throw new UpstreamError(failureKey);
    }

    return payload.result;
  }

  /**
   * `fetch` with a deadline.
   *
   * Without one, a stalled upload holds a request handler until the client gives
   * up, and a mobile client on a bad connection will retry in the meantime.
   */
  private async fetchWithTimeout(
    url: string,
    failureKey: MessageKey,
    body?: FormData,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        method: body ? 'POST' : 'GET',
        body,
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.error(
        `Telegram request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new UpstreamError(failureKey);
    } finally {
      clearTimeout(timer);
    }
  }
}
