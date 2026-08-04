import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
} from 'class-validator';

import type {
  DictionaryCategory,
  LocaleCode,
  SchemaTarget,
} from '@infra/db/database.types';

const CATEGORIES: DictionaryCategory[] = [
  'professional',
  'service_operations',
  'physical_industrial',
  'seasonal_agricultural',
  'temporary_shift',
];

const LOCALES: LocaleCode[] = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'];

export class DeltaQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Return only what changed after this revision. Omit for the full set. ' +
      'Take the value from the previous response’s `version`, never from a ' +
      'local counter.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  since?: number;
}

export class ItemsQueryDto {
  @ApiProperty({
    required: false,
    description:
      'Comma-separated ids. Resolves inactive and merged items too, which is ' +
      'the point: a historical record must render a label, never a code.',
    example: 'b1f2c3d4-0000-4000-8000-000000000001',
  })
  @Transform(({ value }): string[] =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [],
  )
  @IsArray()
  // Empty or absent becomes `[]` and fails here, so a malformed query is a 400
  // rather than a silently empty result the client would render as "no data".
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  ids!: string[];
}

export class DictionaryItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    example: 'call_centre_operator',
    description:
      'Stable machine code. Diagnostics and deep links only - never displayed ' +
      'to a user (§3.2).',
  })
  code!: string;

  @ApiProperty({
    example: 'Call-markaz operatori',
    description: 'Resolved for the request locale via the §3.2 fallback chain.',
  })
  label!: string;

  @ApiProperty({
    enum: CATEGORIES,
    nullable: true,
    description: 'Set on occupations and work types (§2.1); null elsewhere.',
  })
  category!: DictionaryCategory | null;

  @ApiProperty({
    nullable: true,
    example: 'tools',
    description:
      'Second grouping, used by `attribute` items only (§6.3 additional ' +
      'structured requirements) and referenced by a schema field’s `group`.',
  })
  group!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Parent item, e.g. the region a district belongs to.',
  })
  parentId!: string | null;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({
    nullable: true,
    description:
      'Non-null only on the ordered scales (`skill_level`, `language_level`), ' +
      'where it is the value a “≥ C1” comparison uses (§7.4).',
  })
  rank!: number | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({
    nullable: true,
    description: 'The surviving item when this one was merged away (§10.3).',
  })
  mergedIntoId!: string | null;
}

export class RemovedItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    enum: ['inactive', 'merged'],
    description:
      'Drop the id from pickers. It still resolves forever through ' +
      '`GET /dictionaries/items`.',
  })
  reason!: 'inactive' | 'merged';

  @ApiProperty({ nullable: true })
  mergedIntoId!: string | null;
}

export class DictionaryDeltaDto {
  @ApiProperty({ example: 'skill' })
  type!: string;

  @ApiProperty({
    enum: LOCALES,
    description:
      'Canonical form of the resolved locale. Key the client cache off this, ' +
      'not off the value sent in `x-lang` (docs/API_CONTRACTS.md §1).',
  })
  locale!: LocaleCode;

  @ApiProperty({
    example: 1187,
    description: 'Pass back as `since` on the next request.',
  })
  version!: number;

  @ApiProperty({ nullable: true, example: 1150 })
  since!: number | null;

  @ApiProperty({ description: 'True when this response is the whole set.' })
  isFull!: boolean;

  @ApiProperty({ type: DictionaryItemDto, isArray: true })
  items!: DictionaryItemDto[];

  @ApiProperty({ type: RemovedItemDto, isArray: true })
  removed!: RemovedItemDto[];
}

export class TypeVersionDto {
  @ApiProperty({ example: 'occupation' })
  type!: string;

  @ApiProperty({ example: 1187 })
  version!: number;

  @ApiProperty({
    example: 412,
    description: 'Active items only - what a picker would show.',
  })
  count!: number;
}

export class SchemaVersionDto {
  @ApiProperty({ enum: ['candidate_profile', 'vacancy'] })
  target!: SchemaTarget;

  @ApiProperty({ enum: CATEGORIES })
  category!: DictionaryCategory;

  @ApiProperty({ example: 7 })
  version!: number;
}

export class DictionaryManifestDto {
  @ApiProperty({
    example: 1187,
    description: 'Newest revision anywhere in the dictionaries.',
  })
  version!: number;

  @ApiProperty({ type: TypeVersionDto, isArray: true })
  types!: TypeVersionDto[];

  @ApiProperty({
    type: SchemaVersionDto,
    isArray: true,
    description:
      'Ten entries: five §2.1 categories × two targets. Versions are ' +
      'locale-independent, so a label edit in any locale bumps all four.',
  })
  schemas!: SchemaVersionDto[];
}

export class DictionaryItemsDto {
  @ApiProperty({ enum: LOCALES })
  locale!: LocaleCode;

  @ApiProperty({ type: DictionaryItemDto, isArray: true })
  items!: DictionaryItemDto[];
}
