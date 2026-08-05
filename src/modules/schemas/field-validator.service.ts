import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { FieldViolation } from '@infra/api/exceptions/validation-failed.exception';
import type { DictionaryCategory } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatDateOnly } from '@infra/time/format';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';

import type { ParsedFields } from './field-values';
import { type StoredScalars, idsIn, parseField } from './field-validator';
import { fieldsFor } from './schema-resolver';
import type { FieldSchemaDefinition } from './schema-types';

export interface ValidationResult {
  values: ParsedFields;
  violations: FieldViolation[];
}

/**
 * Validates a schema-driven write (API_CONTRACTS.md §4.6).
 *
 * Everything that touches the database happens here and the rules stay pure in
 * `field-validator.ts`. Two things this orchestration is responsible for:
 *
 * - **One dictionary lookup per request.** Every id in the body is resolved in a
 *   single query, so a profile save with eight dictionary fields is one round trip
 *   rather than eight.
 * - **Validating before anything is written.** The whole result - values *and*
 *   violations - is produced ahead of the transaction, so the write path never has
 *   to throw once it has started writing. That is the M1 trap this codebase already
 *   paid for: Kysely rolls back a rejected callback, so a throw inside a
 *   transaction undoes the very row that was meant to record the failure.
 */
@Injectable()
export class FieldValidatorService {
  private readonly timeZone: string;

  constructor(
    private readonly dictionaries: DictionariesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * @param category the profile's category, or `null` before an occupation has
   *   been chosen - in which case only the fields common to all five categories
   *   exist, and a category-specific code is reported as unknown. That is not an
   *   edge case: the first save of a new profile is exactly this state.
   * @param stored scalar values already on the profile, so a `parentFieldCode`
   *   rule still applies when the request does not resend the parent.
   */
  async validate(
    definition: FieldSchemaDefinition,
    category: DictionaryCategory | null,
    input: Record<string, unknown>,
    stored: StoredScalars,
  ): Promise<ValidationResult> {
    const known = fieldsFor(definition, category);
    const violations: FieldViolation[] = [];
    const targets: { code: string; raw: unknown }[] = [];

    for (const [code, raw] of Object.entries(input)) {
      if (!known.some((field) => field.code === code)) {
        // A field the category does not have. Reported rather than ignored: a
        // silently dropped value looks saved to the user and is not.
        violations.push({
          field: code,
          rule: 'unknownField',
          messageKey: 'validation.unknown_field',
        });
        continue;
      }

      targets.push({ code, raw });
    }

    const facts = await this.dictionaries.lookupForValidation([
      ...new Set(
        targets.flatMap(({ code, raw }) => {
          const field = known.find((candidate) => candidate.code === code);
          return field ? idsIn(field, raw) : [];
        }),
      ),
    ]);

    const context = {
      stored,
      today: formatDateOnly(new Date(), this.timeZone),
    };
    const values: ParsedFields = new Map();

    for (const { code, raw } of targets) {
      const field = known.find((candidate) => candidate.code === code);

      if (!field) {
        continue;
      }

      const result = parseField(field, raw, facts, context);

      if (result.violations.length > 0) {
        violations.push(...result.violations);
        continue;
      }

      if (result.value) {
        values.set(code, result.value);
      }
    }

    return { values, violations };
  }
}
