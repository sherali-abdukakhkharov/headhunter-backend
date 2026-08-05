import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  EmployerType,
  VerificationStatus,
} from '@infra/db/database.types';

import { EMPLOYER_REQUIREMENTS } from './employer-requirements';

export interface EmployerProfile {
  userId: string;
  type: EmployerType;
  contactPhone: string | null;
  regionId: string | null;
  districtId: string | null;
  address: string | null;
  description: string | null;
  fullName: string | null;
  legalName: string | null;
  publicName: string | null;
  industryId: string | null;
  contactPersonName: string | null;
  logoFileId: string | null;
  verificationStatus: VerificationStatus;
  verificationReason: string | null;
  verifiedAt: Date | null;
  completenessPercent: number;
  isComplete: boolean;
  updatedAt: Date;
}

/** What a candidate-facing or vacancy-facing route needs to know (BR-03). */
export interface EmployerGate {
  isComplete: boolean;
  isVerified: boolean;
}

@Injectable()
export class EmployersService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /**
   * Reads the caller's employer profile.
   *
   * A 404 here, unlike the candidate profile's empty-shape response: an employer
   * profile cannot be synthesised, because `type` is chosen at creation and decides
   * which fields even exist. There is no neutral empty employer to render.
   */
  async findMine(userId: string): Promise<EmployerProfile> {
    const profile = await this.find(userId);

    if (!profile) {
      throw new NotFoundError('employer.profile_not_found');
    }

    return profile;
  }

  /**
   * @param db a transaction handle when the caller is mid-write and needs to read
   *   its own uncommitted state - which `refreshCompleteness` does.
   */
  async find(
    userId: string,
    db: Database = this.db,
  ): Promise<EmployerProfile | null> {
    const row = await db
      .selectFrom('employers')
      .leftJoin('companies', 'companies.employer_user_id', 'employers.user_id')
      .select([
        'employers.user_id',
        'employers.type',
        'employers.contact_phone',
        'employers.region_id',
        'employers.district_id',
        'employers.address',
        'employers.description',
        'employers.full_name',
        'employers.verification_status',
        'employers.verification_reason',
        'employers.verified_at',
        'employers.completeness_percent',
        'employers.is_complete',
        'employers.updated_at',
        'companies.legal_name',
        'companies.public_name',
        'companies.industry_id',
        'companies.contact_person_name',
        'companies.logo_file_id',
      ])
      .where('employers.user_id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      userId: row.user_id,
      type: row.type,
      contactPhone: row.contact_phone,
      regionId: row.region_id,
      districtId: row.district_id,
      address: row.address,
      description: row.description,
      fullName: row.full_name,
      legalName: row.legal_name,
      publicName: row.public_name,
      industryId: row.industry_id,
      contactPersonName: row.contact_person_name,
      logoFileId: row.logo_file_id,
      verificationStatus: row.verification_status,
      verificationReason: row.verification_reason,
      verifiedAt: row.verified_at,
      completenessPercent: row.completeness_percent,
      isComplete: row.is_complete,
      updatedAt: row.updated_at,
    };
  }

  /**
   * BR-03's precondition, in one place.
   *
   * §6.1 and BR-03 require a complete employer profile before an invitation or a
   * vacancy submission, and §7 requires a **verified** one before candidate search.
   * The two conditions are returned together rather than as one boolean because they
   * are different refusals with different fixes - "finish your profile" and "wait for
   * verification" are not interchangeable messages.
   *
   * Its callers arrive with M5's vacancy submit and M7's search and invitations. It
   * lives here now, with tests, because the state it reads is here and duplicating
   * the rule at each of those three call sites is how a precondition drifts.
   */
  async gate(userId: string): Promise<EmployerGate> {
    const row = await this.db
      .selectFrom('employers')
      .select(['is_complete', 'verification_status'])
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return {
      isComplete: row?.is_complete ?? false,
      isVerified: row?.verification_status === 'verified',
    };
  }

  /** Throws the specific refusal, for a route that requires a verified employer (§7). */
  async assertVerified(userId: string): Promise<void> {
    const { isComplete, isVerified } = await this.gate(userId);

    if (!isComplete) {
      throw new ForbiddenError('employer.profile_incomplete');
    }

    if (!isVerified) {
      throw new ForbiddenError('employer.not_verified');
    }
  }

  /**
   * Creates or updates the profile, then recomputes completeness.
   *
   * `type` is settable only at creation. Changing it later would strand the answers
   * to the other type's questions - a company that became an individual would keep a
   * legal name nobody can see or edit, and its verification would have been granted
   * against evidence for a different set of rules.
   */
  async upsert(
    userId: string,
    type: EmployerType,
    input: {
      contactPhone?: string | null;
      regionId?: string | null;
      districtId?: string | null;
      address?: string | null;
      description?: string | null;
      fullName?: string | null;
      legalName?: string | null;
      publicName?: string | null;
      industryId?: string | null;
      contactPersonName?: string | null;
      logoFileId?: string | null;
    },
  ): Promise<EmployerProfile> {
    const outcome = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('employers')
        .select('type')
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (existing && existing.type !== type) {
        // Returned rather than thrown: a throw here would roll back nothing today,
        // but this transaction grows, and the rule in MEMORY.md is that a
        // transaction reports its outcome and the caller throws after the commit.
        return { conflict: true as const };
      }

      await trx
        .insertInto('employers')
        .values({
          user_id: userId,
          type,
          contact_phone: input.contactPhone ?? null,
          region_id: input.regionId ?? null,
          district_id: input.districtId ?? null,
          address: input.address ?? null,
          description: input.description ?? null,
          full_name: input.fullName ?? null,
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            contact_phone: input.contactPhone ?? null,
            region_id: input.regionId ?? null,
            district_id: input.districtId ?? null,
            address: input.address ?? null,
            description: input.description ?? null,
            full_name: input.fullName ?? null,
            updated_at: sql`now()`,
          }),
        )
        .execute();

      if (type === 'company') {
        await trx
          .insertInto('companies')
          .values({
            employer_user_id: userId,
            legal_name: input.legalName ?? null,
            public_name: input.publicName ?? null,
            industry_id: input.industryId ?? null,
            contact_person_name: input.contactPersonName ?? null,
            logo_file_id: input.logoFileId ?? null,
          })
          .onConflict((oc) =>
            oc.column('employer_user_id').doUpdateSet({
              legal_name: input.legalName ?? null,
              public_name: input.publicName ?? null,
              industry_id: input.industryId ?? null,
              contact_person_name: input.contactPersonName ?? null,
              logo_file_id: input.logoFileId ?? null,
              updated_at: sql`now()`,
            }),
          )
          .execute();
      }

      await this.refreshCompleteness(trx, userId);

      return { conflict: false as const };
    });

    if (outcome.conflict) {
      throw new ForbiddenError('employer.type_immutable');
    }

    return this.findMine(userId);
  }

  /**
   * Recomputes `completeness_percent` and `is_complete` from the requirement list.
   *
   * Stored rather than computed per read for the same reason as the candidate's:
   * BR-03 is checked on every vacancy submission and every invitation, and those are
   * not the places to run a join per request. Takes the transaction handle so the
   * write and its derived state commit together.
   */
  async refreshCompleteness(trx: Database, userId: string): Promise<void> {
    const profile = await this.find(userId, trx);

    if (!profile) {
      return;
    }

    const required = EMPLOYER_REQUIREMENTS[profile.type].fields;
    const missing = required.filter(
      (requirement) =>
        !isFilled(profile[requirement.field as keyof EmployerProfile]),
    );
    const filled = required.length - missing.length;

    await trx
      .updateTable('employers')
      .set({
        completeness_percent:
          required.length === 0
            ? 100
            : Math.round((filled / required.length) * 100),
        is_complete: missing.length === 0,
        updated_at: sql`now()`,
      })
      .where('user_id', '=', userId)
      .execute();
  }

  /** The missing required fields, for the client's prompts (§6.1). */
  missingFields(profile: EmployerProfile): { field: string }[] {
    return EMPLOYER_REQUIREMENTS[profile.type].fields
      .filter(
        (requirement) =>
          !isFilled(profile[requirement.field as keyof EmployerProfile]),
      )
      .map((requirement) => ({ field: requirement.field }));
  }
}

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}
