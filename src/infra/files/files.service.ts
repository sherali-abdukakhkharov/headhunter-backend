import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  BadRequestError,
  NotFoundError,
  PayloadTooLargeError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';

import { TelegramFileClient } from './telegram-file.client';

/** A stored file as the owner sees it. Never carries a URL - see the client. */
export interface StoredFile {
  id: string;
  purposeId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface FileUpload {
  bytes: Buffer;
  originalName: string;
  mimeType: string;
}

/**
 * Accepted types, by extension and the MIME types that go with them.
 *
 * Keyed by extension because that is what a user recognises and what the client's
 * `accept` list shows (API_CONTRACTS.md §4.5). The MIME type is checked too, but
 * only as corroboration: browsers and mobile pickers disagree about DOC and DOCX
 * often enough that trusting the MIME type alone rejects legitimate files.
 */
const ACCEPTED: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
};

/**
 * The first bytes each accepted format must begin with.
 *
 * An extension and a MIME type are both supplied by the caller, so neither is
 * evidence. §12.5 asks for file-type validation and malware scanning "where
 * infrastructure permits"; a magic-number check is not a virus scanner, but it is
 * what stops a renamed executable from being accepted as a CV, which is the
 * realistic case here.
 */
const SIGNATURES: Record<string, Buffer[]> = {
  pdf: [Buffer.from('%PDF-')],
  // DOCX is a ZIP container; DOC is an OLE2 compound file.
  docx: [Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  doc: [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
};

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);
  private readonly maxBytes: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly telegram: TelegramFileClient,
    config: ConfigService<AppEnv, true>,
  ) {
    this.maxBytes = config.get('FILE_MAX_SIZE_BYTES', { infer: true });
  }

  /**
   * Validates and stores an upload.
   *
   * Telegram first, database second. The reverse order can leave a metadata row
   * pointing at a file that was never stored, which reads as corruption; this
   * order can at worst leave an unreferenced message in the storage chat, which is
   * inert. Neither is a transaction - one side is an HTTP call.
   */
  async store(
    ownerUserId: string,
    purposeCode: string,
    upload: FileUpload,
  ): Promise<StoredFile> {
    const purpose = await this.resolvePurpose(purposeCode);
    const extension = this.validate(upload);

    const uploaded = await this.telegram.upload({
      bytes: upload.bytes,
      fileName: safeFileName(upload.originalName, extension),
      mimeType: upload.mimeType,
      // Makes the storage chat legible to a human without exposing the owner's
      // phone number or name (§12.1).
      caption: `${purposeCode} · user ${ownerUserId}`,
    });

    const row = await this.db
      .insertInto('stored_files')
      .values({
        owner_user_id: ownerUserId,
        purpose_id: purpose.id,
        telegram_file_id: uploaded.fileId,
        telegram_file_unique_id: uploaded.fileUniqueId,
        telegram_message_id: String(uploaded.messageId),
        file_name: safeFileName(upload.originalName, extension),
        mime_type: upload.mimeType,
        size_bytes: upload.bytes.length,
        sha256: createHash('sha256').update(upload.bytes).digest('hex'),
      })
      .returning([
        'id',
        'purpose_id',
        'file_name',
        'mime_type',
        'size_bytes',
        'created_at',
      ])
      .executeTakeFirstOrThrow();

    return toStoredFile(row);
  }

  /**
   * Fetches the bytes of a file its **owner** is asking for.
   *
   * Owner-only is the whole authorization this layer performs. Employer access to a
   * candidate's CV is BR-09's decision and belongs to whoever can evaluate it - see
   * `readAsAuthorized`, which M6 added once BR-09 had all three of its inputs.
   */
  async read(
    viewerUserId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    const row = await this.db
      .selectFrom('stored_files')
      .select([
        'id',
        'purpose_id',
        'file_name',
        'mime_type',
        'size_bytes',
        'created_at',
        'telegram_file_id',
        'sha256',
      ])
      .where('id', '=', fileId)
      .where('owner_user_id', '=', viewerUserId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    // 404 rather than 403 for someone else's file: confirming that an id exists
    // but belongs to another account is information we do not owe (§11.1).
    if (!row) {
      throw new NotFoundError('file.not_found');
    }

    const bytes = await this.telegram.download(row.telegram_file_id);
    const digest = createHash('sha256').update(bytes).digest('hex');

    if (digest !== row.sha256) {
      // Telegram returning different bytes than we sent should be impossible.
      // Logged loudly rather than served, because the alternative is handing an
      // employer a document that is not the one the candidate uploaded.
      this.logger.error(
        `Checksum mismatch for file ${row.id}: stored ${row.sha256}, got ${digest}`,
      );
      throw new NotFoundError('file.not_found');
    }

    return { file: toStoredFile(row), bytes };
  }

  /**
   * Fetches the bytes of a file belonging to `ownerUserId`, for a caller who is not the
   * owner.
   *
   * **The caller must already have decided that BR-09 allows it.** This method verifies
   * only that the file really belongs to the candidate the caller named, which is the
   * part it can check - an employer must not be able to name their own file id, or
   * anyone else's, and have it served under somebody else's authorization.
   *
   * Separate from `read` rather than a flag on it, because the two have different
   * preconditions and a boolean parameter is how "authorized" ends up defaulting to true
   * at some future call site.
   */
  async readAsAuthorized(
    ownerUserId: string,
    fileId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    return this.read(ownerUserId, fileId);
  }

  async listForOwner(
    ownerUserId: string,
    purposeCode?: string,
  ): Promise<StoredFile[]> {
    let query = this.db
      .selectFrom('stored_files')
      .select([
        'id',
        'purpose_id',
        'file_name',
        'mime_type',
        'size_bytes',
        'created_at',
      ])
      .where('owner_user_id', '=', ownerUserId)
      .where('deleted_at', 'is', null);

    if (purposeCode) {
      const purpose = await this.resolvePurpose(purposeCode);
      query = query.where('purpose_id', '=', purpose.id);
    }

    const rows = await query.orderBy('created_at', 'desc').execute();

    return rows.map(toStoredFile);
  }

  /**
   * Soft-deletes a file and asks Telegram to drop the message.
   *
   * The row is marked deleted whether or not Telegram cooperates: Telegram refuses
   * to delete messages older than 48 hours, and a user's "delete my CV" must not
   * fail because of that. The metadata row is what every read goes through, so a
   * deleted row is unreachable regardless of the residue in the chat.
   */
  async softDelete(ownerUserId: string, fileId: string): Promise<void> {
    const row = await this.db
      .updateTable('stored_files')
      .set({ deleted_at: new Date() })
      .where('id', '=', fileId)
      .where('owner_user_id', '=', ownerUserId)
      .where('deleted_at', 'is', null)
      .returning('telegram_message_id')
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('file.not_found');
    }

    await this.telegram.deleteMessage(Number(row.telegram_message_id));
  }

  /** Extension of the accepted upload, for the caller to reuse. */
  private validate(upload: FileUpload): string {
    if (upload.bytes.length === 0) {
      throw new BadRequestError('file.empty');
    }

    if (upload.bytes.length > this.maxBytes) {
      throw new PayloadTooLargeError('file.too_large', {
        maxMb: Math.floor(this.maxBytes / (1024 * 1024)),
      });
    }

    const extension = extname(upload.originalName)
      .replace('.', '')
      .toLowerCase();
    const allowedMimes = ACCEPTED[extension];

    if (!allowedMimes) {
      throw new BadRequestError('file.type_not_allowed', {
        allowed: Object.keys(ACCEPTED).join(', '),
      });
    }

    // The declared MIME type has to be consistent with the extension, but an
    // absent or generic one is tolerated: mobile pickers frequently send
    // application/octet-stream for a DOCX.
    const mimeAcceptable =
      allowedMimes.includes(upload.mimeType) ||
      upload.mimeType === 'application/octet-stream' ||
      upload.mimeType === '';

    const signatures = SIGNATURES[extension];
    const contentMatches = signatures.some((signature) =>
      upload.bytes.subarray(0, signature.length).equals(signature),
    );

    if (!mimeAcceptable || !contentMatches) {
      throw new BadRequestError('file.type_not_allowed', {
        allowed: Object.keys(ACCEPTED).join(', '),
      });
    }

    return extension;
  }

  /**
   * Resolves a `file_purpose` dictionary code to its item.
   *
   * The purpose is a dictionary row (API_CONTRACTS.md §4.5), so an unknown or
   * deactivated code is a client error rather than a lookup miss.
   */
  private async resolvePurpose(code: string): Promise<{ id: string }> {
    const row = await this.db
      .selectFrom('dictionary_items')
      .select('id')
      .where('type_code', '=', 'file_purpose')
      .where('code', '=', code)
      .where('is_active', '=', true)
      .executeTakeFirst();

    if (!row) {
      throw new BadRequestError('file.purpose_invalid');
    }

    return row;
  }
}

interface StoredFileRow {
  id: string;
  purpose_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: Date;
}

function toStoredFile(row: StoredFileRow): StoredFile {
  return {
    id: row.id,
    purposeId: row.purpose_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  };
}

/**
 * Reduces a client-supplied filename to something safe to store and to echo in a
 * `Content-Disposition` header.
 *
 * Directory separators, control characters and quotes are removed rather than
 * escaped: the name is display text here, never a path, and a header-injecting
 * quote has no legitimate use in one.
 */
export function safeFileName(original: string, extension: string): string {
  const base = original
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^.]*$/, '')
    // Control characters, DEL, quotes and separators - removing them is the whole
    // point of this function, so the lint rule that flags control characters in a
    // pattern is exactly backwards here.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"'`;\\]/g, '')
    .trim()
    .slice(0, 120);

  // A name made only of dots or whitespace survives the filters above but is not
  // a name - and `.....pdf` looks like something a filter missed.
  const usable = base && /[^.\s]/.test(base) ? base : 'file';

  return `${usable}.${extension}`;
}
