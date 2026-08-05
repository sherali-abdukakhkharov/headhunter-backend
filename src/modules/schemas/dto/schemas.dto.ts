import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import type {
  DictionaryCategory,
  LocaleCode,
  SchemaTarget,
} from '@infra/db/database.types';

import type { FieldKind } from '../schema-types';

/** The five §2.1 work categories - frozen (docs/API_CONTRACTS.md §3.2). */
export const CATEGORIES: DictionaryCategory[] = [
  'professional',
  'service_operations',
  'physical_industrial',
  'seasonal_agricultural',
  'temporary_shift',
];

export class SchemaQueryDto {
  @ApiProperty({
    enum: CATEGORIES,
    description:
      'Work category the form is for. Drives which fields exist and which are ' +
      'required (§5.2) - a candidate’s category comes from their primary ' +
      'occupation and is reported on the profile.',
  })
  @IsIn(CATEGORIES)
  category!: DictionaryCategory;
}

export class FieldValidationDto {
  @ApiPropertyOptional() min?: number;
  @ApiPropertyOptional() max?: number;
  @ApiPropertyOptional() minLength?: number;
  @ApiPropertyOptional() maxLength?: number;
  @ApiPropertyOptional() maxItems?: number;
  @ApiPropertyOptional({
    description: 'money_range: `from` must not exceed `to` (§4.3).',
  })
  requireFromLteTo?: boolean;
}

export class FieldExtraDto {
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['bool', 'text'] }) kind!: 'bool' | 'text';
  @ApiProperty() label!: string;
  @ApiPropertyOptional({ type: FieldValidationDto })
  validation?: FieldValidationDto;
}

export class SchemaFieldDto {
  @ApiProperty({
    description: 'Key in the `PATCH` body’s `fields` object (§4.6).',
  })
  code!: string;

  @ApiProperty({
    description:
      'Closed union of 13 members (§4.2). An unknown value must be skipped and ' +
      'logged, never crash the form - that is what lets the server add a field ' +
      'type without a lockstep app release.',
  })
  kind!: FieldKind;

  @ApiProperty({ description: 'Resolved for the request’s `x-lang`.' })
  label!: string;

  @ApiProperty({
    description:
      'Required before the profile may become searchable (BR-02), for this ' +
      'category only.',
  })
  required!: boolean;

  @ApiPropertyOptional({
    description:
      'Dictionary type to load options from, for the `dictionary_*` kinds.',
  })
  dictionaryType?: string;

  @ApiPropertyOptional({
    description:
      '`attribute` items only: offer just this `group` (§3.4) - `licence`, ' +
      '`transport`, `tools` or `readiness`.',
  })
  group?: string;

  @ApiPropertyOptional({
    description:
      'Restrict the options to the children of the item chosen in this field - ' +
      'a district within the selected region.',
  })
  parentFieldCode?: string;

  @ApiPropertyOptional({
    description: '`dictionary_leveled` only: the ordered scale (§4.4).',
  })
  levelDictionaryType?: string;

  @ApiPropertyOptional({ type: [FieldExtraDto] })
  extras?: FieldExtraDto[];

  @ApiPropertyOptional({
    description: 'money_range: never hardcode this client-side.',
  })
  currency?: string;

  @ApiPropertyOptional() periodDictionaryType?: string;
  @ApiPropertyOptional() allowNegotiable?: boolean;

  @ApiPropertyOptional({ type: FieldValidationDto })
  validation?: FieldValidationDto;
}

export class SchemaSectionDto {
  @ApiProperty() code!: string;

  @ApiProperty({
    enum: ['core', 'category'],
    description:
      'Where the value is stored server-side. Informational: the client renders ' +
      'both the same way (§4.1).',
  })
  source!: 'core' | 'category';

  @ApiProperty() label!: string;
  @ApiProperty() repeating!: boolean;

  @ApiProperty({
    enum: ['engine', 'bespoke'],
    description:
      '`bespoke` hands the section to a purpose-built widget; `fields` is then ' +
      'empty and `endpoint` names its sub-resource.',
  })
  editor!: 'engine' | 'bespoke';

  @ApiPropertyOptional() endpoint?: string;

  @ApiProperty({ type: [SchemaFieldDto] })
  fields!: SchemaFieldDto[];
}

export class SchemaAttachmentDto {
  @ApiProperty({
    description: '`file_purpose` dictionary id - what `POST` takes.',
  })
  purposeId!: string;

  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() required!: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Advisory mirror of the server rules; the server rejects violations regardless.',
  })
  accept!: string[];

  @ApiProperty() maxSizeBytes!: number;

  @ApiProperty({
    description:
      'Uploading beyond this supersedes the oldest file of the purpose.',
  })
  maxCount!: number;
}

export class FieldSchemaDto {
  @ApiProperty({ enum: ['candidate_profile', 'vacancy'] })
  target!: SchemaTarget;

  @ApiProperty({ enum: CATEGORIES })
  category!: DictionaryCategory;

  @ApiProperty({
    description:
      'Also published in `GET /dictionaries/manifest`, so one request tells a ' +
      'cold client whether any schema changed.',
  })
  schemaVersion!: number;

  @ApiProperty({ enum: ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] })
  locale!: LocaleCode;

  @ApiProperty({ type: [SchemaSectionDto] })
  sections!: SchemaSectionDto[];

  @ApiProperty({ type: [SchemaAttachmentDto] })
  attachments!: SchemaAttachmentDto[];

  @ApiProperty({
    type: [String],
    description:
      'Field codes that must be filled before the profile can be searchable ' +
      '(BR-02). Every code resolves to a field in `sections[].fields[]`, so a ' +
      'completeness prompt can always focus one.',
  })
  requiredForSearchable!: string[];
}
