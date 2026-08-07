import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { ValidationFailedException } from '@infra/api/exceptions/validation-failed.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DictionaryCategory,
  ProfileVisibility,
} from '@infra/db/database.types';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { completenessEntriesFor } from '@modules/schemas/schema-resolver';
import { SchemasService } from '@modules/schemas/schemas.service';

import { type Completeness, computeCompleteness } from './completeness';
import { applyFields } from './profile-writer';
import {
  type ProfileAggregate,
  emptyAggregate,
  filledCodes,
  loadAggregate,
  toFields,
} from './profile-state';

export interface CandidateProfile {
  /** A profile row exists - false before the first save (§5.3's starting state). */
  isStarted: boolean;
  aggregate: ProfileAggregate;
  completeness: Completeness;
  fields: Record<string, unknown>;
}

/**
 * The candidate profile (§5, BR-02).
 *
 * The profile row is created on first write rather than at registration: a user may
 * hold several roles (§2.3), and a row for a candidate profile nobody has started
 * would make "has this candidate begun" unanswerable and pollute every count.
 */
@Injectable()
export class CandidatesService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly schemas: SchemasService,
    private readonly validator: FieldValidatorService,
  ) {}

  async read(userId: string): Promise<CandidateProfile> {
    const aggregate = await loadAggregate(this.db, userId);

    return aggregate === null
      ? this.project(emptyAggregate(userId), false)
      : this.project(aggregate, true);
  }

  /**
   * Applies a partial field write (API_CONTRACTS.md §4.6).
   *
   * The order is deliberate and is the codebase's hardest-won rule: **validate
   * everything, then open the transaction**. A rejected Kysely callback rolls back,
   * so a throw raised after a write inside the transaction destroys the write and
   * leaves only the exception - which cost two M1 security bugs (MEMORY.md).
   */
  async patch(
    userId: string,
    input: Record<string, unknown>,
  ): Promise<CandidateProfile> {
    const definition = this.schemas.definition('candidate_profile');
    const existing = await loadAggregate(this.db, userId);

    // The category decides which fields exist. It comes from the primary
    // occupation, so a request that sets one changes the field set it is itself
    // validated against - which is why the incoming value is resolved first.
    const category = await this.effectiveCategory(existing, input);

    const stored = new Map<string, string | null>([
      ['region_id', existing?.row.region_id ?? null],
    ]);

    const { values, violations } = await this.validator.validate(
      definition,
      category,
      input,
      stored,
    );

    if (violations.length > 0) {
      throw new ValidationFailedException(violations);
    }

    const aggregate = await this.db.transaction().execute(async (trx) => {
      await this.ensureProfile(trx, userId);

      // Locks the aggregate for this user: the field sets are rewritten wholesale,
      // so two concurrent saves from a retrying mobile client must not interleave.
      await trx
        .selectFrom('candidate_profiles')
        .select('user_id')
        .where('user_id', '=', userId)
        .forUpdate()
        .execute();

      await applyFields(trx, definition, category, userId, values);

      return this.refreshDerived(trx, userId);
    });

    return this.project(aggregate, true);
  }

  /**
   * Recomputes the category, completeness and `last_meaningful_update_at` from
   * whatever is now stored, and returns the fresh aggregate.
   *
   * Re-reads rather than predicting the outcome of the writes that just ran: these
   * three are what search and the client both trust, so computing them from actual
   * rows is what stops them disagreeing with what a client reads back. Takes the
   * transaction handle, so a caller's writes and this update commit together - a
   * profile whose rows changed but whose completeness did not is exactly the state
   * BR-02 must never see.
   *
   * Called by every write that changes profile *content*, which is why experience
   * and education go through it too: they count toward §5.3's percentage.
   */
  async refreshDerived(
    trx: Database,
    userId: string,
  ): Promise<ProfileAggregate> {
    const definition = this.schemas.definition('candidate_profile');
    const written = await loadAggregate(trx, userId);

    if (!written) {
      // Callers create the row first. Unreachable, and a programming error rather
      // than a request one.
      throw new Error(`Candidate profile for ${userId} is missing`);
    }

    const category = await this.categoryOfPrimaryOccupation(trx, userId);
    const completeness = computeCompleteness(
      completenessEntriesFor(definition, category),
      filledCodes(definition, category, written),
    );

    const row = await trx
      .updateTable('candidate_profiles')
      .set({
        category,
        completeness_percent: completeness.percent,
        is_complete: completeness.isComplete,
        // Every field and every history record is meaningful content (§5.3). The
        // one write that must not move this - the privacy toggle - has its own
        // route and never calls this method.
        last_meaningful_update_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where('user_id', '=', userId)
      .returning([
        'category',
        'completeness_percent',
        'is_complete',
        'last_meaningful_update_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();

    return { ...written, row: { ...written.row, ...row } };
  }

  /**
   * Creates the profile row if the candidate has not saved anything yet.
   *
   * Every child table references `candidate_profiles`, so adding a job before
   * filling in a name would otherwise fail on the foreign key - and "fill in your
   * name first" is not a rule §5 has.
   */
  async ensureProfile(trx: Database, userId: string): Promise<void> {
    await trx
      .insertInto('candidate_profiles')
      .values({ user_id: userId })
      .onConflict((oc) => oc.column('user_id').doNothing())
      .execute();
  }

  /**
   * Sets search visibility (§5.1 Privacy, §5.3).
   *
   * Deliberately **not** a schema field, and deliberately the only write that
   * leaves `last_meaningful_update_at` alone: §5.3 shows the last meaningful update
   * and §7.3 sorts by it, so a privacy toggle that refreshed it would let a stale
   * profile present itself as freshly maintained.
   *
   * Allowed on an incomplete profile. §5.3 gates the *effect*, not the setting:
   * BR-02 requires completeness **and** visibility, so an incomplete profile that
   * enables search simply stays out of results until it is finished.
   */
  async setVisibility(
    userId: string,
    visibility: ProfileVisibility,
  ): Promise<CandidateProfile> {
    // Creates the row if the candidate set privacy before filling anything in.
    // Without this the update would match nothing and silently do neither.
    await this.db
      .insertInto('candidate_profiles')
      .values({ user_id: userId, visibility })
      .onConflict((oc) =>
        oc
          .column('user_id')
          .doUpdateSet({ visibility, updated_at: sql`now()` }),
      )
      .execute();

    return this.read(userId);
  }

  /**
   * The category to validate against: from the primary occupation in this request
   * if it carries one, otherwise the stored one, otherwise none.
   *
   * "None" is the first save of a new profile, and it means only the fields common
   * to all five categories are accepted - the client's first screen is choosing what
   * work the candidate is looking for.
   */
  private async effectiveCategory(
    existing: ProfileAggregate | null,
    input: Record<string, unknown>,
  ): Promise<DictionaryCategory | null> {
    const incoming = input.primary_occupation_id;

    if (typeof incoming === 'string' && incoming !== '') {
      const facts = await this.db
        .selectFrom('dictionary_items')
        .select('category')
        .where('id', '=', incoming)
        .executeTakeFirst();

      // A malformed or unknown id falls through to the stored category and is
      // reported by the validator, which owns that message.
      if (facts?.category) {
        return facts.category;
      }
    }

    return existing?.row.category ?? null;
  }

  private async categoryOfPrimaryOccupation(
    db: Database,
    userId: string,
  ): Promise<DictionaryCategory | null> {
    const row = await db
      .selectFrom('candidate_occupations')
      .innerJoin(
        'dictionary_items',
        'dictionary_items.id',
        'candidate_occupations.item_id',
      )
      .select('dictionary_items.category')
      .where('candidate_occupations.user_id', '=', userId)
      .where('candidate_occupations.is_primary', '=', true)
      .executeTakeFirst();

    return row?.category ?? null;
  }

  private project(
    aggregate: ProfileAggregate,
    isStarted: boolean,
  ): CandidateProfile {
    const definition = this.schemas.definition('candidate_profile');
    const category = aggregate.row.category;

    return {
      isStarted,
      aggregate,
      // Recomputed for the response rather than read from the stored counters: the
      // stored ones exist so *search* need not compute them (§7.1), and the two are
      // written together in `patch`. Recomputing here means a schema change shows up
      // in the missing-field list immediately instead of at the next save.
      completeness: computeCompleteness(
        completenessEntriesFor(definition, category),
        filledCodes(definition, category, aggregate),
      ),
      fields: toFields(definition, category, aggregate),
    };
  }
}
