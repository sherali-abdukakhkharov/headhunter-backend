import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { type Database, KYSELY } from '@infra/db/database.module';
import type {
  DictionaryCategory,
  LocaleCode,
  SchemaTarget,
} from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';

import { CANDIDATE_PROFILE_SCHEMA } from './candidate-profile.schema';
import { VACANCY_SCHEMA } from './vacancy.schema';
import {
  attachmentsFor,
  isRequiredIn,
  requiredForSearchable,
  sectionsFor,
} from './schema-resolver';
import type { FieldSchemaDefinition } from './schema-types';
import type { FieldSchemaDto, SchemaAttachmentDto } from './dto/schemas.dto';

/** Both targets of the frozen `schema_versions` table (API_CONTRACTS.md §3.3). */
const DEFINITIONS: Partial<Record<SchemaTarget, FieldSchemaDefinition>> = {
  candidate_profile: CANDIDATE_PROFILE_SCHEMA,
  vacancy: VACANCY_SCHEMA,
};

@Injectable()
export class SchemasService {
  private readonly logger = new Logger(SchemasService.name);
  private readonly maxFileBytes: number;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly dictionaries: DictionariesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.maxFileBytes = config.get('FILE_MAX_SIZE_BYTES', { infer: true });
  }

  definition(target: SchemaTarget): FieldSchemaDefinition {
    const definition = DEFINITIONS[target];

    if (!definition) {
      // Unreachable from a route: the only target with a controller is the one
      // that has a definition. A throw beats returning an empty form.
      throw new Error(`No field schema is declared for target ${target}`);
    }

    return definition;
  }

  /**
   * The published version, read from `schema_versions` rather than from the
   * declaration.
   *
   * The table is what `GET /dictionaries/manifest` publishes, so serving the ETag
   * from the same row is what makes "the manifest says 7" and "this response is
   * version 7" the same fact. `pnpm seed` copies the declared version in; a
   * mismatch is therefore a missed seed run, and it is logged rather than
   * silently preferred either way.
   */
  async version(
    target: SchemaTarget,
    category: DictionaryCategory,
  ): Promise<number> {
    const row = await this.db
      .selectFrom('schema_versions')
      .select('version')
      .where('target', '=', target)
      .where('category', '=', category)
      .executeTakeFirst();

    const declared = this.definition(target).version;
    const published = row?.version ?? declared;

    if (published !== declared) {
      this.logger.warn(
        `${target}/${category} schema is declared at version ${declared} but ` +
          `published as ${published}. Run \`pnpm seed\` to publish it.`,
      );
    }

    return published;
  }

  /** The full form for one category, in one locale (API_CONTRACTS.md §4). */
  async fieldSchema(
    target: SchemaTarget,
    category: DictionaryCategory,
    locale: LocaleCode,
  ): Promise<FieldSchemaDto> {
    const definition = this.definition(target);

    return {
      target,
      category,
      schemaVersion: await this.version(target, category),
      locale,
      sections: sectionsFor(definition, category).map((section) => ({
        code: section.code,
        source: section.source,
        label: section.labels[locale],
        repeating: section.repeating,
        editor: section.editor,
        ...(section.endpoint ? { endpoint: section.endpoint } : {}),
        fields: section.fields.map((field) => ({
          code: field.code,
          kind: field.kind,
          label: field.labels[locale],
          required: isRequiredIn(field, category),
          ...(field.dictionaryType
            ? { dictionaryType: field.dictionaryType }
            : {}),
          ...(field.group ? { group: field.group } : {}),
          ...(field.parentFieldCode
            ? { parentFieldCode: field.parentFieldCode }
            : {}),
          ...(field.levelDictionaryType
            ? { levelDictionaryType: field.levelDictionaryType }
            : {}),
          ...(field.extras
            ? {
                extras: field.extras.map((extra) => ({
                  code: extra.code,
                  kind: extra.kind,
                  label: extra.labels[locale],
                  ...(extra.validation ? { validation: extra.validation } : {}),
                })),
              }
            : {}),
          ...(field.currency ? { currency: field.currency } : {}),
          ...(field.periodDictionaryType
            ? { periodDictionaryType: field.periodDictionaryType }
            : {}),
          ...(field.allowNegotiable
            ? { allowNegotiable: field.allowNegotiable }
            : {}),
          ...(field.validation ? { validation: field.validation } : {}),
        })),
      })),
      attachments: await this.attachments(definition, category, locale),
      requiredForSearchable: requiredForSearchable(definition, category),
    };
  }

  /**
   * Attachment slots, with the `file_purpose` id and label resolved.
   *
   * The label goes through `DictionariesService` like every other label, so the
   * §3.2 fallback chain and its warning apply here too - an attachment slot is a
   * heading in the form, and a technical key must never surface as one.
   */
  private async attachments(
    definition: FieldSchemaDefinition,
    category: DictionaryCategory,
    locale: LocaleCode,
  ): Promise<SchemaAttachmentDto[]> {
    const purposes = await this.dictionaries.delta(
      'file_purpose',
      locale,
      null,
    );
    const byCode = new Map(purposes.items.map((item) => [item.code, item]));
    const slots: SchemaAttachmentDto[] = [];

    for (const attachment of attachmentsFor(definition, category)) {
      const purpose = byCode.get(attachment.purposeCode);

      if (!purpose) {
        // The dictionary is seeded content, so a declared purpose that is not
        // there means the seed and this file disagree. Omitted rather than served
        // with a null id: a client cannot upload against an id that does not
        // exist, and a loud log is what gets it fixed.
        this.logger.error(
          `Attachment purpose "${attachment.purposeCode}" is declared in the ` +
            `${definition.target} schema but missing from the file_purpose ` +
            `dictionary. Run \`pnpm seed\`.`,
        );
        continue;
      }

      slots.push({
        purposeId: purpose.id,
        code: purpose.code,
        label: purpose.label,
        required: attachment.required ?? false,
        accept: attachment.accept,
        maxSizeBytes: this.maxFileBytes,
        maxCount: attachment.maxCount,
      });
    }

    return slots;
  }
}
