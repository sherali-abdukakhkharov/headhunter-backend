import { Inject, Injectable, Logger } from '@nestjs/common';

import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import { type FileUpload, FilesService } from '@infra/files/files.service';
import { attachmentsFor } from '@modules/schemas/schema-resolver';
import { SchemasService } from '@modules/schemas/schemas.service';

import { loadAggregate } from './profile-state';

export interface ProfileAttachment {
  id: string;
  purposeCode: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  downloadPath: string;
}

/**
 * The candidate's profile attachments (§5.4, §4.5).
 *
 * A thin layer over `infra/files`, which already owns validation, storage and
 * owner-scoped reads. What it adds is the two things the *profile* means by an
 * attachment:
 *
 * - **Only declared purposes.** A file whose purpose no attachment slot names is
 *   refused, so `file_purpose` stays the list of things the product actually
 *   collects rather than a free-form label.
 * - **`maxCount`, enforced by superseding.** §5.4 is "upload, replace, download and
 *   delete a CV" - one document. The client cannot express "replace" as a distinct
 *   operation without a race (delete then upload leaves a candidate with no CV if
 *   the second call fails), so an upload past the limit retires the oldest file of
 *   that purpose instead. The old bytes are soft-deleted, exactly like a manual
 *   delete.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly files: FilesService,
    private readonly schemas: SchemasService,
  ) {}

  async list(userId: string): Promise<ProfileAttachment[]> {
    const files = await this.files.listForOwner(userId);

    return files.map((file) => ({
      id: file.id,
      purposeCode: file.purposeCode,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      createdAt: file.createdAt,
      downloadPath: `/files/${file.id}/content`,
    }));
  }

  async upload(
    userId: string,
    purposeCode: string,
    upload: FileUpload,
  ): Promise<ProfileAttachment> {
    const slot = await this.slotFor(userId, purposeCode);

    const stored = await this.files.store(userId, purposeCode, upload);
    await this.superseded(userId, stored.purposeId, slot.maxCount);

    return {
      id: stored.id,
      purposeCode,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      createdAt: stored.createdAt,
      downloadPath: `/files/${stored.id}/content`,
    };
  }

  /** Delegated whole: ownership, the soft delete and the Telegram cleanup are one rule. */
  async remove(userId: string, fileId: string): Promise<void> {
    await this.files.softDelete(userId, fileId);
  }

  /**
   * The declared slot for a purpose, or a 400.
   *
   * Resolved against the candidate's own category so a slot only some categories
   * offer cannot be filled by everyone. A profile with no category yet gets the
   * category-independent slots, which is all four of them today.
   */
  private async slotFor(userId: string, purposeCode: string) {
    const definition = this.schemas.definition('candidate_profile');
    const aggregate = await loadAggregate(this.db, userId);
    const slot = attachmentsFor(
      definition,
      aggregate?.row.category ?? null,
    ).find((attachment) => attachment.purposeCode === purposeCode);

    if (!slot) {
      throw new BadRequestError('candidate.attachment_purpose_invalid');
    }

    return slot;
  }

  /**
   * Retires whatever is now over the limit, oldest first.
   *
   * Runs after the new file is stored, so a failed upload leaves the existing CV in
   * place. The reverse order would delete a candidate's only CV and then fail to
   * replace it.
   */
  private async superseded(
    userId: string,
    purposeId: string,
    maxCount: number,
  ): Promise<void> {
    const existing = await this.db
      .selectFrom('stored_files')
      .select('id')
      .where('owner_user_id', '=', userId)
      .where('purpose_id', '=', purposeId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();

    for (const file of existing.slice(maxCount)) {
      // Best effort: the new file is already stored and is what the profile shows.
      // Failing the request now would tell the candidate their upload did not work.
      try {
        await this.files.softDelete(userId, file.id);
      } catch (error) {
        this.logger.warn(
          `Could not retire superseded file ${file.id} for ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** `file_purpose` id → code, so a stored file can name its purpose. */
}
