import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, importPKCS8 } from 'jose';

import type { AppEnv } from '@infra/env-schema';

import { type PushMessage, type PushResult, PushSender } from './push-sender';

/** What the service-account JSON gives us, of the fields this needs. */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

/**
 * Firebase Cloud Messaging over the **HTTP v1 API** (§9.2).
 *
 * *Why no `firebase-admin`.* The SDK exists to hide an OAuth2 exchange and one HTTPS POST,
 * and it brings gRPC and a large dependency tree to do it. This service already signs and
 * verifies JWTs with `jose` for Telegram login, and already talks to Telegram's HTTP API
 * directly for file storage - the same shape, and one fewer dependency in a container that
 * ships production dependencies only.
 *
 * *Why HTTP v1 and not the legacy endpoint.* The legacy `fcm/send` API and its static
 * server key were shut down in 2024. v1 authenticates with a short-lived OAuth2 token
 * obtained by signing a JWT with the service account's private key, which is why the
 * credential is a JSON file rather than a string.
 *
 * *What it deliberately does not do.* No retries and no backoff: a push is best effort and
 * the in-app row is the record (ARCHITECTURE.md §10), so a failure is reported and
 * forgotten rather than queued. If delivery ever needs to be guaranteed, that is a queue
 * and a worker, not a loop here.
 */
@Injectable()
export class FcmPushSender extends PushSender {
  private readonly logger = new Logger(FcmPushSender.name);
  private readonly account: ServiceAccount;
  private readonly timeoutMs: number;
  /** Cached OAuth2 token. Google issues these for an hour; renewed a minute early. */
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(config: ConfigService<AppEnv, true>) {
    super();

    this.account = parseServiceAccount(
      config.get('FCM_SERVICE_ACCOUNT_BASE64', { infer: true }),
    );
    this.timeoutMs = config.get('FCM_TIMEOUT_MS', { infer: true });
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (messages.length === 0) {
      return [];
    }

    const token = await this.authorize();

    // One request per message. FCM's v1 batch endpoint was retired with the legacy API,
    // and a handful of devices per notification does not justify multipart assembly.
    return Promise.all(messages.map((message) => this.sendOne(token, message)));
  }

  private async sendOne(
    accessToken: string,
    message: PushMessage,
  ): Promise<PushResult> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: message.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: {
              // §9.2's notifications are things a person is waiting on - an interview
              // time, a hire. High priority is what wakes a dozing device; the
              // aggressive battery managers common on this market's phones may still
              // delay it, which is why the in-app list is the record.
              priority: 'HIGH',
              notification: { sound: 'default' },
            },
            apns: {
              headers: { 'apns-priority': '10' },
              payload: { aps: { sound: 'default' } },
            },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.ok) {
        return { token: message.token, status: 'sent' };
      }

      const detail = await response.text();

      // A token for an uninstalled app, or one that never existed. The dispatcher
      // disables it rather than retrying a device that is gone.
      if (
        response.status === 404 ||
        detail.includes('UNREGISTERED') ||
        detail.includes('INVALID_ARGUMENT')
      ) {
        return { token: message.token, status: 'invalid', error: detail };
      }

      return { token: message.token, status: 'failed', error: detail };
    } catch (error) {
      return { token: message.token, status: 'failed', error: String(error) };
    }
  }

  /**
   * A short-lived OAuth2 access token, from a JWT signed with the service account key.
   *
   * The JWT-bearer grant of RFC 7523, which is what `firebase-admin` does internally.
   * Cached until a minute before expiry: minting one per push would add a round trip to
   * Google to every notification.
   */
  private async authorize(): Promise<string> {
    const now = Date.now();

    if (this.accessToken && this.accessToken.expiresAt > now) {
      return this.accessToken.value;
    }

    const key = await importPKCS8(
      this.account.private_key.replace(/\\n/g, '\n'),
      'RS256',
    );
    const tokenUri = this.account.token_uri ?? DEFAULT_TOKEN_URI;
    const assertion = await new SignJWT({ scope: OAUTH_SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.account.client_email)
      .setSubject(this.account.client_email)
      .setAudience(tokenUri)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(
        `FCM authorization failed: ${response.status} ${await response.text()}`,
      );
    }

    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = {
      value: body.access_token,
      expiresAt: now + (body.expires_in - 60) * 1000,
    };
    this.logger.debug('Obtained an FCM access token');

    return this.accessToken.value;
  }
}

/**
 * Reads the credential from base64.
 *
 * Base64 rather than raw JSON because the value is a multi-line document with embedded
 * newlines in the private key, and `.env` files handle that badly enough that half the
 * failures would be quoting mistakes. Validated at construction, so a malformed credential
 * fails at boot rather than at the first notification.
 */
export function parseServiceAccount(encoded: string): ServiceAccount {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT_BASE64 is not base64-encoded JSON: ${String(error)}`,
    );
  }

  const account = parsed as Partial<ServiceAccount>;

  if (!account.project_id || !account.client_email || !account.private_key) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT_BASE64 is missing project_id, client_email or private_key',
    );
  }

  return account as ServiceAccount;
}
