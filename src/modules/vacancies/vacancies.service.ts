import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import {
  type FieldViolation,
  ValidationFailedException,
} from '@infra/api/exceptions/validation-failed.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DictionaryCategory,
  UserRole,
  VacancyStatus,
} from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatDateOnly } from '@infra/time/format';
import { EmployersService } from '@modules/employers/employers.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { requiredForSearchable } from '@modules/schemas/schema-resolver';
import { SchemasService } from '@modules/schemas/schemas.service';

import { isJustificationValid } from './age-gender-justifications';
import {
  type VacancyAggregate,
  applyVacancyFields,
  loadVacancy,
  toVacancyFields,
  filledVacancyCodes,
} from './vacancy-state';
import {
  AUTO_APPROVED_REASON,
  RESTRICTION_CHANGED_REASON,
  canSubmitFrom,
  canTransition,
  isEditable,
  isOpenForApplications,
  restrictionKinds,
} from './vacancy-status';

export interface Vacancy {
  aggregate: VacancyAggregate;
  fields: Record<string, unknown>;
  isOpenForApplications: boolean;
  missingForSubmit: string[];
}

/** BR-12 fields: touching one on a live vacancy sends it back for review. */
const RESTRICTION_FIELDS = [
  'age_min',
  'age_max',
  'gender_id',
  'restriction_justification_id',
];

/**
 * Vacancies and their status machine (§6.3, §6.4).
 *
 * The write path mirrors the candidate profile's, because it is the same mechanism:
 * validate the whole body against the category's field schema **before** opening a
 * transaction, then apply and derive inside one. A throw after a write inside a
 * transaction destroys the write and leaves only the exception - the trap MEMORY.md
 * records from M1.
 */
@Injectable()
export class VacanciesService {
  private readonly logger = new Logger(VacanciesService.name);
  private readonly moderationEnabled: boolean;
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly schemas: SchemasService,
    private readonly validator: FieldValidatorService,
    private readonly employers: EmployersService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.moderationEnabled = config.get('MODERATION_ENABLED', { infer: true });
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * Creates an empty draft.
   *
   * BR-03 is checked here rather than only at submit, so an employer who cannot
   * publish finds out before filling in a form. `assertVerified` is the one place that
   * rule lives.
   */
  async create(employerUserId: string): Promise<Vacancy> {
    await this.employers.assertVerified(employerUserId);

    const row = await this.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('vacancies')
        .values({ employer_user_id: employerUserId })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('vacancy_status_history')
        .values({
          vacancy_id: created.id,
          from_status: null,
          to_status: 'draft',
          actor_user_id: employerUserId,
          actor_role: 'employer',
        })
        .execute();

      return created;
    });

    return this.read(employerUserId, row.id);
  }

  /** The employer's own vacancies, every status - BR-11 keeps closed ones in history. */
  async listMine(employerUserId: string): Promise<Vacancy[]> {
    const rows = await this.db
      .selectFrom('vacancies')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .orderBy('updated_at', 'desc')
      .execute();

    const vacancies: Vacancy[] = [];

    for (const row of rows) {
      vacancies.push(await this.read(employerUserId, row.id));
    }

    return vacancies;
  }

  async read(employerUserId: string, vacancyId: string): Promise<Vacancy> {
    const aggregate = await loadVacancy(this.db, vacancyId);

    // 404 rather than 403 for another employer's vacancy: confirming that an id exists
    // but belongs to someone else is information we do not owe (§11.1).
    if (!aggregate || aggregate.row.employer_user_id !== employerUserId) {
      throw new NotFoundError('vacancy.not_found');
    }

    return this.project(aggregate);
  }

  async patch(
    employerUserId: string,
    vacancyId: string,
    input: Record<string, unknown>,
  ): Promise<Vacancy> {
    const definition = this.schemas.definition('vacancy');
    const current = await this.read(employerUserId, vacancyId);
    const status = current.aggregate.row.status;

    if (!isEditable(status)) {
      throw new ConflictError(
        status === 'under_moderation'
          ? 'vacancy.under_moderation'
          : 'vacancy.not_editable',
      );
    }

    const category = await this.effectiveCategory(current.aggregate, input);
    const stored = new Map<string, string | null>([
      ['region_id', current.aggregate.row.region_id],
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

    const touchesRestriction = Object.keys(input).some((code) =>
      RESTRICTION_FIELDS.includes(code),
    );

    const aggregate = await this.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('vacancies')
        .select('id')
        .where('id', '=', vacancyId)
        .forUpdate()
        .execute();

      await applyVacancyFields(trx, definition, category, vacancyId, values);

      const derivedCategory = await this.categoryOfOccupation(trx, vacancyId);

      await trx
        .updateTable('vacancies')
        .set({ category: derivedCategory, updated_at: sql`now()` })
        .where('id', '=', vacancyId)
        .execute();

      // A rejected vacancy that the employer edits becomes a draft again: fixing it is
      // what "rejected → draft" means (§6.4), and leaving it `rejected` would make the
      // moderator's old reason look current.
      if (status === 'rejected') {
        await this.applyStatus(trx, vacancyId, status, 'draft', {
          actor: { userId: employerUserId, role: 'employer' },
        });
        await trx
          .updateTable('vacancies')
          .set({ moderation_reason: null })
          .where('id', '=', vacancyId)
          .execute();
      }

      // BR-12: a live vacancy whose restriction changed has not been reviewed as it
      // now reads, so it leaves discovery until it is. Not optional on the flag - see
      // MODERATION_ENABLED.
      if (
        touchesRestriction &&
        (status === 'active' || status === 'paused') &&
        restrictionKinds(await this.restrictionOf(trx, vacancyId)).length > 0
      ) {
        await this.applyStatus(trx, vacancyId, status, 'under_moderation', {
          reason: RESTRICTION_CHANGED_REASON,
          actor: { userId: employerUserId, role: 'employer' },
        });
      }

      const written = await loadVacancy(trx, vacancyId);

      if (!written) {
        throw new Error(`Vacancy ${vacancyId} vanished mid-write`);
      }

      return written;
    });

    return this.project(aggregate);
  }

  /**
   * Submits a draft for publication (§6.4, BR-04, BR-12).
   *
   * Three gates, in order: the employer may publish at all (BR-03), the form is
   * complete for its category, and any BR-12 restriction carries a justification the
   * enumerated list actually supports.
   */
  async submit(employerUserId: string, vacancyId: string): Promise<Vacancy> {
    await this.employers.assertVerified(employerUserId);

    // `read` already computes `missingForSubmit` from the category's schema, so the
    // completeness check below needs no second resolution of the definition.
    const current = await this.read(employerUserId, vacancyId);
    const { row } = current.aggregate;

    if (!canSubmitFrom(row.status)) {
      throw new ConflictError('vacancy.not_submittable');
    }

    if (current.missingForSubmit.length > 0) {
      // Per-field violations rather than one opaque refusal, so the client can focus
      // each unfilled field - the same shape a body validation failure produces.
      throw new ValidationFailedException(
        current.missingForSubmit.map(
          (code): FieldViolation => ({
            field: code,
            rule: 'required',
            messageKey: 'validation.required',
          }),
        ),
      );
    }

    const today = formatDateOnly(new Date(), this.timeZone);

    if (row.deadline_on !== null && row.deadline_on < today) {
      // Publishing something that BR-06 would refuse every application to.
      throw new ForbiddenError('vacancy.deadline_passed');
    }

    const kinds = restrictionKinds(row);

    if (kinds.length > 0) {
      const code = await this.justificationCodeOf(
        row.restriction_justification_id,
      );

      if (!code || !isJustificationValid(code, kinds)) {
        throw new ForbiddenError('vacancy.restriction_not_justified');
      }
    }

    // BR-12 overrides the flag: "administrator review" is part of the rule, not an
    // optimisation. An ordinary vacancy may be auto-approved when no moderator exists;
    // a restricted one waits, even though that means it cannot publish until M10.
    const target: VacancyStatus =
      this.moderationEnabled || kinds.length > 0
        ? 'under_moderation'
        : 'active';

    if (target === 'active') {
      this.logger.warn(
        `Vacancy ${vacancyId} auto-approved: MODERATION_ENABLED is off, so no ` +
          'moderator reviewed it.',
      );
    }

    const aggregate = await this.db.transaction().execute(async (trx) => {
      await this.applyStatus(trx, vacancyId, row.status, target, {
        reason: target === 'active' ? AUTO_APPROVED_REASON : null,
        actor: { userId: employerUserId, role: 'employer' },
      });

      const written = await loadVacancy(trx, vacancyId);

      if (!written) {
        throw new Error(`Vacancy ${vacancyId} vanished mid-write`);
      }

      return written;
    });

    return this.project(aggregate);
  }

  /**
   * A moderator's decision (§6.4, §10.2, BR-04).
   *
   * Lives with the machine rather than in the admin module: M10 adds the queue and the
   * route, not a second copy of the transition rules. A rejection without a reason is
   * one the employer cannot act on, so it is refused.
   */
  async moderate(
    vacancyId: string,
    decision: 'active' | 'rejected',
    actor: { userId: string; role: UserRole },
    reason: string | null,
  ): Promise<Vacancy> {
    const aggregate = await loadVacancy(this.db, vacancyId);

    if (!aggregate) {
      throw new NotFoundError('vacancy.not_found');
    }

    if (aggregate.row.status !== 'under_moderation') {
      throw new ConflictError('vacancy.not_under_moderation');
    }

    if (decision === 'rejected' && !reason?.trim()) {
      throw new ForbiddenError('vacancy.moderation_reason_required');
    }

    const written = await this.db.transaction().execute(async (trx) => {
      await this.applyStatus(trx, vacancyId, aggregate.row.status, decision, {
        reason,
        actor,
      });

      return loadVacancy(trx, vacancyId);
    });

    if (!written) {
      throw new Error(`Vacancy ${vacancyId} vanished mid-write`);
    }

    return this.project(written);
  }

  /** `active ↔ paused`, and `→ closed` with a reason (BR-11). */
  async changeStatus(
    employerUserId: string,
    vacancyId: string,
    to: Extract<VacancyStatus, 'active' | 'paused' | 'closed'>,
    reason: string | null,
  ): Promise<Vacancy> {
    const current = await this.read(employerUserId, vacancyId);
    const from = current.aggregate.row.status;

    if (!canTransition(from, to)) {
      throw new ConflictError('vacancy.transition_not_allowed');
    }

    const written = await this.db.transaction().execute(async (trx) => {
      await this.applyStatus(trx, vacancyId, from, to, {
        reason,
        actor: { userId: employerUserId, role: 'employer' },
      });

      if (to === 'closed') {
        await trx
          .updateTable('vacancies')
          .set({ closure_reason: reason })
          .where('id', '=', vacancyId)
          .execute();
      }

      return loadVacancy(trx, vacancyId);
    });

    if (!written) {
      throw new Error(`Vacancy ${vacancyId} vanished mid-write`);
    }

    return this.project(written);
  }

  /**
   * The one place `vacancies.status` changes, always with its BR-08 history row.
   *
   * Private and transaction-scoped: a caller able to set the status without writing
   * history could produce exactly the state BR-08 exists to prevent. It also owns the
   * timestamp columns, because the CHECK constraints require them to agree with the
   * status - `published_at` on first publication, `closed_at` when closed.
   */
  private async applyStatus(
    trx: Database,
    vacancyId: string,
    from: VacancyStatus,
    to: VacancyStatus,
    options: {
      reason?: string | null;
      actor?: { userId: string; role: UserRole };
    },
  ): Promise<void> {
    if (!canTransition(from, to)) {
      // Unreachable through a route - every caller checks first - so this is a
      // programming error, and one worth failing loudly rather than writing a
      // transition the machine forbids.
      throw new Error(`Illegal vacancy transition ${from} → ${to}`);
    }

    await trx
      .updateTable('vacancies')
      .set({
        status: to,
        // Set once, on first publication: §5.5 sorts discovery by it, so a pause and
        // resume must not make an old vacancy look new.
        published_at:
          to === 'active' ? sql`COALESCE(published_at, now())` : undefined,
        closed_at: to === 'closed' ? sql`now()` : null,
        moderation_reason:
          to === 'rejected' || to === 'under_moderation'
            ? (options.reason ?? null)
            : null,
        updated_at: sql`now()`,
      })
      .where('id', '=', vacancyId)
      .execute();

    await trx
      .insertInto('vacancy_status_history')
      .values({
        vacancy_id: vacancyId,
        from_status: from,
        to_status: to,
        actor_user_id: options.actor?.userId ?? null,
        actor_role: options.actor?.role ?? null,
        reason: options.reason ?? null,
      })
      .execute();
  }

  private async effectiveCategory(
    aggregate: VacancyAggregate,
    input: Record<string, unknown>,
  ): Promise<DictionaryCategory | null> {
    const incoming = input.occupation_id;

    if (typeof incoming === 'string' && incoming !== '') {
      const item = await this.db
        .selectFrom('dictionary_items')
        .select('category')
        .where('id', '=', incoming)
        .executeTakeFirst();

      if (item?.category) {
        return item.category;
      }
    }

    return aggregate.row.category;
  }

  private async categoryOfOccupation(
    db: Database,
    vacancyId: string,
  ): Promise<DictionaryCategory | null> {
    const row = await db
      .selectFrom('vacancies')
      .innerJoin(
        'dictionary_items',
        'dictionary_items.id',
        'vacancies.occupation_id',
      )
      .select('dictionary_items.category')
      .where('vacancies.id', '=', vacancyId)
      .executeTakeFirst();

    return row?.category ?? null;
  }

  private async restrictionOf(
    db: Database,
    vacancyId: string,
  ): Promise<{
    age_min: number | null;
    age_max: number | null;
    gender_id: string | null;
  }> {
    return db
      .selectFrom('vacancies')
      .select(['age_min', 'age_max', 'gender_id'])
      .where('id', '=', vacancyId)
      .executeTakeFirstOrThrow();
  }

  /**
   * The justification's code, resolved from its dictionary id.
   *
   * Validated against the declaration in `age-gender-justifications.ts` rather than
   * against the dictionary row's own metadata: a dictionary row is admin-editable
   * (§10.3), and widening BR-12 must not be something an administrator can do by
   * editing content.
   */
  private async justificationCodeOf(
    itemId: string | null,
  ): Promise<string | null> {
    if (!itemId) {
      return null;
    }

    const row = await this.db
      .selectFrom('dictionary_items')
      .select('code')
      .where('id', '=', itemId)
      .where('type_code', '=', 'restriction_justification')
      .executeTakeFirst();

    return row?.code ?? null;
  }

  private project(aggregate: VacancyAggregate): Vacancy {
    const definition = this.schemas.definition('vacancy');
    const category = aggregate.row.category;
    const filled = filledVacancyCodes(definition, category, aggregate);

    return {
      aggregate,
      fields: toVacancyFields(definition, category, aggregate),
      isOpenForApplications: isOpenForApplications(
        aggregate.row.status,
        aggregate.row.deadline_on,
        formatDateOnly(new Date(), this.timeZone),
      ),
      // What still blocks publication. Derived from the same `requiredIn` declarations
      // the form's `required` flags come from, so the two cannot disagree.
      missingForSubmit: requiredForSearchable(definition, category).filter(
        (code) => !filled.has(code),
      ),
    };
  }
}
