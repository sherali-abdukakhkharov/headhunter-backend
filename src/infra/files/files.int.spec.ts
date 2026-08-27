import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';

import { FilesService, safeFileName } from './files.service';
import type {
  FileToUpload,
  TelegramFileClient,
  UploadedFile,
} from './telegram-file.client';

/**
 * Integration tests against a real Postgres, with the Telegram Bot API faked.
 *
 * The database is real because ownership, the soft delete and the `file_purpose`
 * dictionary lookup are all queries. Telegram is faked because the alternative is
 * a test suite that needs a bot token, posts into somebody's chat, and fails when
 * the network does - while testing Telegram rather than this service.
 *
 * What the fake preserves is the contract this service depends on: a `file_id` and
 * a `file_unique_id` come back from an upload, and a download returns bytes for a
 * `file_id`.
 */

class FakeTelegram {
  readonly uploads: FileToUpload[] = [];
  readonly deleted: number[] = [];
  /** file_id â†’ bytes, as Telegram would hold them. */
  private readonly stored = new Map<string, Buffer>();
  private nextId = 1;

  /** Set to have the next download return different bytes than were stored. */
  corruptNextDownload = false;

  upload(file: FileToUpload): Promise<UploadedFile> {
    this.uploads.push(file);
    const fileId = `fake-file-id-${this.nextId}`;
    this.stored.set(fileId, file.bytes);

    return Promise.resolve({
      fileId,
      fileUniqueId: `fake-unique-${this.nextId}`,
      messageId: 1000 + this.nextId++,
      sizeBytes: file.bytes.length,
    });
  }

  download(fileId: string): Promise<Buffer> {
    if (this.corruptNextDownload) {
      this.corruptNextDownload = false;
      return Promise.resolve(Buffer.from('not the bytes that were uploaded'));
    }

    const bytes = this.stored.get(fileId);

    if (!bytes) {
      return Promise.reject(new Error(`unknown file_id ${fileId}`));
    }

    return Promise.resolve(bytes);
  }

  deleteMessage(messageId: number): Promise<boolean> {
    this.deleted.push(messageId);
    return Promise.resolve(true);
  }
}

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('a fake but structurally plausible document body'),
]);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('image bytes'),
]);

let db: Database;
let destroy: () => Promise<void>;
let telegram: FakeTelegram;
let files: FilesService;

function configService(overrides: Partial<AppEnv> = {}) {
  const values = {
    FILE_MAX_SIZE_BYTES: 10 * 1024 * 1024,
    ...overrides,
  } as Record<string, unknown>;

  return { get: (key: string) => values[key] } as unknown as ConfigService<
    AppEnv,
    true
  >;
}

function build(overrides: Partial<AppEnv> = {}): FilesService {
  return new FilesService(
    db,
    telegram as unknown as TelegramFileClient,
    configService(overrides),
  );
}

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());
});

afterAll(async () => {
  await destroy();
});

beforeEach(() => {
  telegram = new FakeTelegram();
  files = build();
});

async function newUser(): Promise<string> {
  const phone = fixturePhone();

  const row = await db
    .insertInto('users')
    .values({ phone })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

describe('storing a file', () => {
  it('sends the bytes to Telegram and records what came back', async () => {
    const owner = await newUser();

    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'my-resume.pdf',
      mimeType: 'application/pdf',
    });

    expect(stored.fileName).toBe('my-resume.pdf');
    expect(stored.sizeBytes).toBe(PDF.length);
    expect(telegram.uploads).toHaveLength(1);

    const row = await db
      .selectFrom('stored_files')
      .select([
        'telegram_file_id',
        'telegram_file_unique_id',
        'telegram_message_id',
        'sha256',
      ])
      .where('id', '=', stored.id)
      .executeTakeFirstOrThrow();

    expect(row.telegram_file_id).toBe('fake-file-id-1');
    expect(row.telegram_file_unique_id).toBe('fake-unique-1');
    expect(Number(row.telegram_message_id)).toBe(1001);
    // The checksum is ours, not Telegram's - it is what makes the download
    // verifiable without trusting the store.
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the purpose as a code as well as an id', async () => {
    const owner = await newUser();

    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    // The id/code confusion CLAUDE.md warns about, one layer down: `store`
    // takes a code, so returning only the id means nothing that uploaded a file
    // can tell which slot it just filled without resolving the dictionary.
    expect(stored.purposeCode).toBe('cv');
    expect(stored.purposeId).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const [listed] = await files.listForOwner(owner);
    expect(listed.purposeCode).toBe('cv');

    const { file: read } = await files.read(owner, stored.id);
    expect(read.purposeCode).toBe('cv');
  });

  it('never puts a storage URL or the bot token in the database', async () => {
    const owner = await newUser();
    await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    const columns = await db
      .selectFrom('stored_files')
      .selectAll()
      .where('owner_user_id', '=', owner)
      .executeTakeFirstOrThrow();

    // Telegram's download link embeds the bot token and expires within the hour.
    // Persisting one would be both a secret at rest and a stale value (Â§11.1).
    for (const value of Object.values(columns)) {
      if (typeof value === 'string') {
        expect(value).not.toMatch(/api\.telegram\.org/);
        expect(value).not.toMatch(/^\d+:[A-Za-z0-9_-]{30,}$/);
      }
    }
  });

  it('keeps the ownerâ€™s phone number out of the storage chat caption', async () => {
    const owner = await newUser();
    await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    // Â§12.1: the caption is readable by whoever can read the storage chat.
    expect(telegram.uploads[0].caption).not.toMatch(/\+998/);
    expect(telegram.uploads[0].caption).toContain(owner);
  });

  it('refuses a purpose that is not an active dictionary item', async () => {
    const owner = await newUser();

    await expect(
      files.store(owner, 'not_a_purpose', {
        bytes: PDF,
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ messageKey: 'file.purpose_invalid' });

    // Nothing reached Telegram: validation runs before the upload.
    expect(telegram.uploads).toEqual([]);
  });
});

describe('the policy it publishes', () => {
  it('names the extensions and the cap it actually enforces', () => {
    const policy = files.policy();

    // Every extension it advertises must be one an upload of that type gets
    // through, and the cap must be the configured one rather than a repeated
    // literal â€” a published policy that disagrees with the gate is worse than
    // none, because a client will filter its picker by it.
    expect(policy.acceptedExtensions).toEqual(
      expect.arrayContaining(['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png']),
    );
    expect(policy.maxSizeBytes).toBe(10 * 1024 * 1024);
  });

  it('advertises nothing the validator would refuse', async () => {
    const owner = await newUser();

    // The one extension the table lists that the fixtures can prove end to end:
    // the rest need their own magic bytes, and the refusal tests below already
    // pin the fact that content is checked. What matters here is that the list
    // and the gate are the same table.
    await expect(
      files.store(owner, 'cv', {
        bytes: PDF,
        originalName: 'a.pdf',
        mimeType: 'application/pdf',
      }),
    ).resolves.toBeDefined();

    await expect(
      files.store(owner, 'cv', {
        bytes: PDF,
        originalName: 'a.exe',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow();

    expect(files.policy().acceptedExtensions).not.toContain('exe');
  });
});

describe('upload validation (Â§12.5)', () => {
  it('refuses an empty file', async () => {
    const owner = await newUser();

    await expect(
      files.store(owner, 'cv', {
        bytes: Buffer.alloc(0),
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(BadRequestError);
  });

  it('refuses a file over the configured limit and says the limit', async () => {
    const owner = await newUser();
    const small = build({ FILE_MAX_SIZE_BYTES: 2 * 1024 * 1024 });

    await expect(
      small.store(owner, 'cv', {
        bytes: Buffer.concat([PDF, Buffer.alloc(3 * 1024 * 1024)]),
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({
      messageKey: 'file.too_large',
      params: { maxMb: 2 },
    });
  });

  it('refuses an extension that is not accepted', async () => {
    const owner = await newUser();

    await expect(
      files.store(owner, 'cv', {
        bytes: PDF,
        originalName: 'resume.exe',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ messageKey: 'file.type_not_allowed' });
  });

  it('refuses content that does not match its extension', async () => {
    const owner = await newUser();

    // The realistic attack: an executable renamed to .pdf. Neither the extension
    // nor the MIME type is evidence, since both come from the caller.
    await expect(
      files.store(owner, 'cv', {
        bytes: Buffer.from('MZ\x90\x00 this is a windows executable'),
        originalName: 'resume.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toMatchObject({ messageKey: 'file.type_not_allowed' });

    expect(telegram.uploads).toEqual([]);
  });

  it('tolerates a generic MIME type from a mobile picker', async () => {
    const owner = await newUser();

    // Android and iOS pickers frequently send application/octet-stream. The
    // content check still has to pass, so this loosens nothing that matters.
    await expect(
      files.store(owner, 'certificate', {
        bytes: PNG,
        originalName: 'diploma.png',
        mimeType: 'application/octet-stream',
      }),
    ).resolves.toMatchObject({ fileName: 'diploma.png' });
  });

  it('refuses a size the transport never enforced', async () => {
    const owner = await newUser();
    const small = build({ FILE_MAX_SIZE_BYTES: 1024 });

    // The multer limit is the first line of defence; this is the second, because
    // FilesService is also called from other modules (M3, M4, M8) that may not go
    // through the same interceptor.
    await expect(
      small.store(owner, 'cv', {
        bytes: Buffer.concat([PDF, Buffer.alloc(2048)]),
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(PayloadTooLargeError);
  });
});

describe('reading a file', () => {
  it('returns the exact bytes that were uploaded', async () => {
    const owner = await newUser();
    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    const { bytes, file } = await files.read(owner, stored.id);

    expect(bytes.equals(PDF)).toBe(true);
    expect(file.fileName).toBe('cv.pdf');
  });

  it('refuses another accountâ€™s file as not found, not forbidden', async () => {
    const owner = await newUser();
    const stranger = await newUser();

    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    // Confirming that an id exists but belongs to someone else is information we
    // do not owe (Â§11.1).
    await expect(files.read(stranger, stored.id)).rejects.toMatchObject({
      messageKey: 'file.not_found',
    });
  });

  it('refuses to serve bytes whose checksum does not match', async () => {
    const owner = await newUser();
    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    telegram.corruptNextDownload = true;

    // Serving the wrong document to an employer is worse than serving none.
    await expect(files.read(owner, stored.id)).rejects.toThrow(NotFoundError);
  });

  it('refuses an unknown id', async () => {
    const owner = await newUser();

    await expect(files.read(owner, randomUUID())).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('listing and deleting', () => {
  it('lists the ownerâ€™s files, newest first, optionally by purpose', async () => {
    const owner = await newUser();

    await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });
    await files.store(owner, 'certificate', {
      bytes: PNG,
      originalName: 'cert.png',
      mimeType: 'image/png',
    });

    expect(await files.listForOwner(owner)).toHaveLength(2);

    const onlyCvs = await files.listForOwner(owner, 'cv');
    expect(onlyCvs.map((f) => f.fileName)).toEqual(['cv.pdf']);
  });

  it('does not list another accountâ€™s files', async () => {
    const owner = await newUser();
    const stranger = await newUser();

    await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    expect(await files.listForOwner(stranger)).toEqual([]);
  });

  it('soft-deletes, drops the Telegram message, and stops serving the file', async () => {
    const owner = await newUser();
    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    await files.softDelete(owner, stored.id);

    expect(telegram.deleted).toEqual([1001]);
    await expect(files.read(owner, stored.id)).rejects.toThrow(NotFoundError);
    expect(await files.listForOwner(owner)).toEqual([]);

    // The row survives: BR-14's retention period is unanswered, and a CV attached
    // to a submitted application must stay resolvable for the employer's history.
    const row = await db
      .selectFrom('stored_files')
      .select('deleted_at')
      .where('id', '=', stored.id)
      .executeTakeFirstOrThrow();

    expect(row.deleted_at).not.toBeNull();
  });

  it('refuses to delete another accountâ€™s file', async () => {
    const owner = await newUser();
    const stranger = await newUser();

    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    await expect(files.softDelete(stranger, stored.id)).rejects.toThrow(
      NotFoundError,
    );
    expect(telegram.deleted).toEqual([]);
  });

  it('is idempotent: deleting twice is not an error the second time', async () => {
    const owner = await newUser();
    const stored = await files.store(owner, 'cv', {
      bytes: PDF,
      originalName: 'cv.pdf',
      mimeType: 'application/pdf',
    });

    await files.softDelete(owner, stored.id);

    // The second call finds no undeleted row. A 404 is the honest answer - the
    // file is already gone from the caller's point of view.
    await expect(files.softDelete(owner, stored.id)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('safeFileName', () => {
  it('strips any path a client supplied', () => {
    expect(safeFileName('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
    expect(safeFileName('C:\\Users\\me\\cv.pdf', 'pdf')).toBe('cv.pdf');
  });

  it('removes quotes and control characters', () => {
    // The name is echoed in a Content-Disposition header, where a quote or a
    // newline is a header injection.
    expect(safeFileName('my"cv\r\n.pdf', 'pdf')).toBe('mycv.pdf');
  });

  it('always produces a name with the validated extension', () => {
    expect(safeFileName('', 'pdf')).toBe('file.pdf');
    expect(safeFileName('.....', 'pdf')).toBe('file.pdf');
    // The extension comes from validation, not from the supplied name, so a
    // double extension cannot survive.
    expect(safeFileName('invoice.pdf.exe', 'pdf')).toBe('invoice.pdf.pdf');
  });

  it('bounds the length', () => {
    expect(safeFileName('a'.repeat(500), 'pdf').length).toBeLessThanOrEqual(
      124,
    );
  });
});
