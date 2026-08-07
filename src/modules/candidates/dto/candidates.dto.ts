import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmptyObject, IsObject } from 'class-validator';

import type {
  DictionaryCategory,
  ProfileVisibility,
} from '@infra/db/database.types';
import { CATEGORIES } from '@modules/schemas/dto/schemas.dto';

/** §5.1 Privacy - the three explicit settings, frozen with the enum. */
export const VISIBILITIES: ProfileVisibility[] = [
  'searchable',
  'hidden',
  'visible_after_apply',
];

export class PatchProfileDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Field codes from `GET /schemas/candidate-profile`, each carrying the value ' +
      'shape its `kind` declares (§4.2). Partial: only the codes present are ' +
      'written. `null` clears a field - requiredness gates searchability (BR-02), ' +
      'never the save. A list field states the whole list, so removing one entry ' +
      'means sending the others.',
    example: {
      full_name: 'Anvar Karimov',
      region_id: '6f1c…',
      skills: [{ itemId: 'a1…', levelId: 'b2…' }],
      salary: {
        from: 5000000,
        to: 8000000,
        periodId: 'c3…',
        isNegotiable: false,
      },
    },
  })
  @IsObject()
  // An empty body would refresh `last_meaningful_update_at` while writing nothing,
  // which is exactly the staleness §5.3 is trying to prevent.
  @IsNotEmptyObject()
  fields!: Record<string, unknown>;
}

export class SetVisibilityDto {
  @ApiProperty({
    enum: VISIBILITIES,
    description:
      '`searchable` - visible in employer search; `hidden` - excluded from it ' +
      'while the candidate can still browse and apply; `visible_after_apply` - ' +
      'visible only to employers whose vacancy the candidate applied to.',
  })
  @IsIn(VISIBILITIES)
  visibility!: ProfileVisibility;
}

export class MissingFieldDto {
  @ApiProperty({ description: 'Field code, or a bespoke section’s code.' })
  code!: string;

  @ApiProperty({ description: 'Section to open - §5.3’s "direct edit link".' })
  section!: string;

  @ApiProperty({
    description:
      'True when BR-02 blocks searchability on it. False entries are prompts, ' +
      'not blockers.',
  })
  required!: boolean;
}

export class CandidateProfileDto {
  @ApiProperty({
    description:
      'False until the first save. Every other field is still present and empty, ' +
      'so the form renders identically for a new and an existing profile.',
  })
  isStarted!: boolean;

  @ApiPropertyOptional({
    enum: CATEGORIES,
    nullable: true,
    description:
      'Derived from the primary occupation, and what to pass to ' +
      '`GET /schemas/candidate-profile`. Null until one is chosen, when only the ' +
      'fields common to all categories exist.',
  })
  category!: DictionaryCategory | null;

  @ApiProperty({ enum: VISIBILITIES })
  visibility!: ProfileVisibility;

  @ApiProperty({
    description:
      'Measured over every field of the category plus experience and education ' +
      '(§5.3). Stored server-side; recomputing it client-side guarantees the two ' +
      'disagree.',
  })
  completenessPercent!: number;

  @ApiProperty({
    description: 'Every required field is filled. BR-02’s first condition.',
  })
  isComplete!: boolean;

  @ApiProperty({
    description:
      'BR-02 in full: complete **and** visibility is `searchable`. What decides ' +
      'whether an employer can find this profile.',
  })
  isSearchable!: boolean;

  @ApiProperty({ type: [MissingFieldDto] })
  missingFields!: MissingFieldDto[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Current values by field code, in the same shape `PATCH` accepts - read, ' +
      'edit one value, send it back.',
  })
  fields!: Record<string, unknown>;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Last change to actual profile content (§5.3). A privacy toggle does not ' +
      'move it, so it cannot be used to look freshly maintained.',
  })
  lastMeaningfulUpdateAt!: string | null;

  @ApiPropertyOptional({ nullable: true })
  updatedAt!: string | null;
}
