import type { ConfigService } from '@nestjs/config';

import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { FilesService } from '@infra/files/files.service';
import type {
  FileToUpload,
  TelegramFileClient,
  UploadedFile,
} from '@infra/files/telegram-file.client';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { SchemasService } from '@modules/schemas/schemas.service';

import { AttachmentsService } from './attachments.service';

/**
 * Integration tests against a real Postgres, with the Telegram Bot API faked - the
 * same split as `infra/files`: the database is real because the purpose lookup, the
 * ownership check and the soft delete are all queries, while Telegram is faked
 * because otherwise these tests need a bot token and a working network to assert
 * something that is not about Telegram.
 *
 * What is under test is the profile's reading of an attachment: only declared
 * purposes, and §5.4's "replace" implemented by superseding.
 */

class FakeTelegram {
  private next = 1;
  readonly deleted: number[] = [];

  upload(file: FileToUpload): Promise<UploadedFile> {
    const id = this.next++;

    return Promise.resolve({
      fileId: `fake-${id}`,
      fileUniqueId: `unique-${id}`,
      messageId: id,
      sizeBytes: file.bytes.length,
    });
  }

  download(): Promise<Buffer> {
    return Promise.resolve(Buffer.from('%PDF-1.4 fake'));
  }

  deleteMessage(messageId: number): Promise<void> {
    this.deleted.push(messageId);
    return Promise.resolve();
  }
}

let db: Database;
let destroy: () => Promise<void>;
let attachments: AttachmentsService;
let telegram: FakeTelegram;

const users: string[] = [];

const config = {
  get: (key: string) =>
    key === 'FILE_MAX_SIZE_BYTES'
      ? 10_485_760
      : key === 'PLATFORM_TIME_ZONE'
        ? 'Asia/Tashkent'
        : undefined,
} as unknown as ConfigService<AppEnv, true>;

/** A minimal but genuinely valid PDF: the magic bytes are checked (§12.5). */
function pdf(marker: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${marker}\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
  telegram = new FakeTelegram();

  const files = new FilesService(
    db,
    telegram as unknown as TelegramFileClient,
    config,
  );
  const schemas = new SchemasService(db, new DictionariesService(db), config);

  attachments = new AttachmentsService(db, files, schemas);
});

afterAll(async () => {
  for (const id of users) {
    await db
      .deleteFrom('stored_files')
      .where('owner_user_id', '=', id)
      .execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function newCandidate(): Promise<string> {
  const phone = `+99894${String(Math.floor(Math.random() * 10 ** 7)).padStart(7, '0')}`;
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  users.push(row.id);
  return row.id;
}

function upload(userId: string, purpose: string, marker: string) {
  return attachments.upload(userId, purpose, {
    bytes: pdf(marker),
    originalName: `${marker}.pdf`,
    mimeType: 'application/pdf',
  });
}

describe('AttachmentsService', () => {
  it('refuses a purpose no attachment slot declares', async () => {
    const userId = await newCandidate();

    // `file_purpose` is a dictionary the admin path can extend (§10.3), so "is this
    // a real purpose" and "is it part of the profile" are different questions.
    await expect(upload(userId, 'passport', 'x')).rejects.toThrow(
      BadRequestError,
    );
  });

  it('replaces a CV by superseding the previous one (§5.4)', async () => {
    const userId = await newCandidate();
    const first = await upload(userId, 'cv', 'first');
    const second = await upload(userId, 'cv', 'second');

    const list = await attachments.list(userId);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(second.id);

    // Soft-deleted, not purged: BR-14's retention period is still open, and the
    // metadata row is what every read goes through.
    const superseded = await db
      .selectFrom('stored_files')
      .select('deleted_at')
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();

    expect(superseded.deleted_at).not.toBeNull();
  });

  it('keeps the new file when superseding, not the old one', async () => {
    const userId = await newCandidate();
    await upload(userId, 'cv', 'old');
    const replacement = await upload(userId, 'cv', 'new');

    // The order matters: storing first and retiring second means a failed upload
    // leaves the candidate with their existing CV rather than none.
    const list = await attachments.list(userId);
    expect(list.map((item) => item.id)).toEqual([replacement.id]);
  });

  it('keeps several files for a purpose that allows them', async () => {
    const userId = await newCandidate();
    await upload(userId, 'certificate', 'one');
    await upload(userId, 'certificate', 'two');

    const list = await attachments.list(userId);

    expect(
      list.filter((item) => item.purposeCode === 'certificate'),
    ).toHaveLength(2);
  });

  it('carries a path on this API and never a storage URL (§11.1)', async () => {
    const userId = await newCandidate();
    const stored = await upload(userId, 'cv', 'cv');
    const [item] = await attachments.list(userId);

    expect(item.downloadPath).toBe(`/files/${stored.id}/content`);
    expect(item.downloadPath).not.toContain('http');
  });

  it('shows one candidate nothing of another’s', async () => {
    const owner = await newCandidate();
    const other = await newCandidate();
    await upload(owner, 'cv', 'owner-cv');

    expect(await attachments.list(other)).toHaveLength(0);
  });
});
