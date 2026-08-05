import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import {
  type FieldViolation,
  ValidationFailedException,
} from '@infra/api/exceptions/validation-failed.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';
import { formatDateOnly } from '@infra/time/format';

import { CandidatesService } from './candidates.service';
import type {
  EducationDto,
  EducationInputDto,
  ExperienceDto,
  ExperienceInputDto,
} from './dto/history.dto';

/**
 * Experience and education records (§5.1).
 *
 * The bespoke repeating sections of API_CONTRACTS.md §4.1. Every write refreshes the
 * profile's derived state in the same transaction, because both count toward §5.3's
 * completeness percentage - a job added without that would leave the percentage
 * saying otherwise until the next field save.
 */
@Injectable()
export class HistoryService {
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly candidates: CandidatesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- experience ----------------------------------------------------------

  async listExperience(userId: string): Promise<ExperienceDto[]> {
    const rows = await this.db
      .selectFrom('candidate_experience')
      .selectAll()
      .where('user_id', '=', userId)
      // Current roles first, then most recent - the order a CV is read in.
      .orderBy('is_current', 'desc')
      .orderBy('started_on', 'desc')
      .execute();

    return rows.map(toExperience);
  }

  async addExperience(
    userId: string,
    input: ExperienceInputDto,
  ): Promise<ExperienceDto> {
    this.assertExperienceCoherent(input);

    return this.db.transaction().execute(async (trx) => {
      await this.candidates.ensureProfile(trx, userId);

      const row = await trx
        .insertInto('candidate_experience')
        .values({
          user_id: userId,
          employer_name: input.employerName ?? null,
          role_title: input.roleTitle,
          occupation_id: input.occupationId ?? null,
          started_on: input.startedOn,
          ended_on: input.endedOn ?? null,
          is_current: input.isCurrent ?? false,
          responsibilities: input.responsibilities ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.candidates.refreshDerived(trx, userId);

      return toExperience(row);
    });
  }

  async updateExperience(
    userId: string,
    id: string,
    input: ExperienceInputDto,
  ): Promise<ExperienceDto> {
    this.assertExperienceCoherent(input);

    // The outcome is returned from the transaction and the 404 is thrown after it
    // commits. A throw inside would roll back the derived-state refresh as well -
    // the trap recorded in MEMORY.md, where the write that reported a failure was
    // undone by the very exception that reported it.
    const row = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('candidate_experience')
        .set({
          employer_name: input.employerName ?? null,
          role_title: input.roleTitle,
          occupation_id: input.occupationId ?? null,
          started_on: input.startedOn,
          ended_on: input.endedOn ?? null,
          is_current: input.isCurrent ?? false,
          responsibilities: input.responsibilities ?? null,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst();

      if (updated) {
        await this.candidates.refreshDerived(trx, userId);
      }

      return updated;
    });

    if (!row) {
      throw new NotFoundError('candidate.record_not_found');
    }

    return toExperience(row);
  }

  async removeExperience(userId: string, id: string): Promise<void> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('candidate_experience')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst();

      if (row) {
        await this.candidates.refreshDerived(trx, userId);
      }

      return row;
    });

    if (!deleted) {
      throw new NotFoundError('candidate.record_not_found');
    }
  }

  // --- education -----------------------------------------------------------

  async listEducation(userId: string): Promise<EducationDto[]> {
    const rows = await this.db
      .selectFrom('candidate_education')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('graduation_year', 'desc')
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map(toEducation);
  }

  async addEducation(
    userId: string,
    input: EducationInputDto,
  ): Promise<EducationDto> {
    return this.db.transaction().execute(async (trx) => {
      await this.candidates.ensureProfile(trx, userId);

      const row = await trx
        .insertInto('candidate_education')
        .values({
          user_id: userId,
          level_id: input.levelId,
          institution: input.institution ?? null,
          specialization: input.specialization ?? null,
          graduation_year: input.graduationYear ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await this.candidates.refreshDerived(trx, userId);

      return toEducation(row);
    });
  }

  async updateEducation(
    userId: string,
    id: string,
    input: EducationInputDto,
  ): Promise<EducationDto> {
    const row = await this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('candidate_education')
        .set({
          level_id: input.levelId,
          institution: input.institution ?? null,
          specialization: input.specialization ?? null,
          graduation_year: input.graduationYear ?? null,
          updated_at: sql`now()`,
        })
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst();

      if (updated) {
        await this.candidates.refreshDerived(trx, userId);
      }

      return updated;
    });

    if (!row) {
      throw new NotFoundError('candidate.record_not_found');
    }

    return toEducation(row);
  }

  async removeEducation(userId: string, id: string): Promise<void> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('candidate_education')
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst();

      if (row) {
        await this.candidates.refreshDerived(trx, userId);
      }

      return row;
    });

    if (!deleted) {
      throw new NotFoundError('candidate.record_not_found');
    }
  }

  /**
   * The two cross-field rules the columns also carry as CHECKs.
   *
   * Checked here so a plausible client mistake gets a localized field-level message
   * instead of a constraint violation the caller cannot act on. The CHECKs stay:
   * they are what holds for the admin path and a manual SQL fix.
   */
  private assertExperienceCoherent(input: ExperienceInputDto): void {
    const violations: FieldViolation[] = [];
    const endedOn = input.endedOn ?? null;

    if (input.isCurrent && endedOn !== null) {
      violations.push({
        field: 'endedOn',
        rule: 'currentHasNoEnd',
        messageKey: 'validation.current_has_no_end',
      });
    }

    if (endedOn !== null && endedOn < input.startedOn) {
      violations.push({
        field: 'endedOn',
        rule: 'dateOrder',
        messageKey: 'validation.date_order',
      });
    }

    if (input.startedOn > formatDateOnly(new Date(), this.timeZone)) {
      violations.push({
        field: 'startedOn',
        rule: 'notAfter',
        messageKey: 'validation.date_in_future',
      });
    }

    if (violations.length > 0) {
      throw new ValidationFailedException(violations);
    }
  }
}

function toExperience(row: {
  id: string;
  employer_name: string | null;
  role_title: string;
  occupation_id: string | null;
  started_on: string;
  ended_on: string | null;
  is_current: boolean;
  responsibilities: string | null;
}): ExperienceDto {
  return {
    id: row.id,
    employerName: row.employer_name,
    roleTitle: row.role_title,
    occupationId: row.occupation_id,
    startedOn: row.started_on,
    endedOn: row.ended_on,
    isCurrent: row.is_current,
    responsibilities: row.responsibilities,
  };
}

function toEducation(row: {
  id: string;
  level_id: string;
  institution: string | null;
  specialization: string | null;
  graduation_year: number | null;
}): EducationDto {
  return {
    id: row.id,
    levelId: row.level_id,
    institution: row.institution,
    specialization: row.specialization,
    graduationYear: row.graduation_year,
  };
}
