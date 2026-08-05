import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import type {
  DictionaryCategory,
  VacancyStatus,
} from '@infra/db/database.types';
import { CATEGORIES } from '@modules/schemas/dto/schemas.dto';

export const VACANCY_STATUSES: VacancyStatus[] = [
  'draft',
  'under_moderation',
  'active',
  'paused',
  'closed',
  'rejected',
];

/** Statuses an employer may move a vacancy to directly (§6.4). */
export const EMPLOYER_TRANSITIONS = ['active', 'paused', 'closed'] as const;

export class PatchVacancyDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Field codes from `GET /schemas/vacancy`, each carrying the value shape its ' +
      '`kind` declares (§4.2). Partial: only the codes present are written. A list ' +
      'field states the whole list. Editing a rejected vacancy returns it to `draft`; ' +
      'editing an age or gender restriction on a live one sends it back for review ' +
      '(BR-12).',
    example: {
      title: 'Call-centre operator',
      worker_count: 20,
      languages: [{ itemId: 'a1…', levelId: 'c1…', is_mandatory: true }],
    },
  })
  @IsObject()
  @IsNotEmptyObject()
  fields!: Record<string, unknown>;
}

export class ChangeVacancyStatusDto {
  @ApiProperty({
    enum: EMPLOYER_TRANSITIONS,
    description:
      '`paused` hides it from discovery temporarily; `active` resumes it; `closed` ' +
      'is terminal — BR-11 removes it from discovery and keeps it in history.',
  })
  @IsIn(EMPLOYER_TRANSITIONS)
  status!: (typeof EMPLOYER_TRANSITIONS)[number];

  @ApiPropertyOptional({
    description: 'Why it was closed. Shown in the employer’s history.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ModerateVacancyDto {
  @ApiProperty({
    enum: ['active', 'rejected'],
    description: 'BR-04: a vacancy is not visible until approved.',
  })
  @IsIn(['active', 'rejected'])
  decision!: 'active' | 'rejected';

  @ApiPropertyOptional({
    description:
      'Mandatory when rejecting — a refusal the employer cannot act on is not a decision.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class VacancyDto {
  @ApiProperty() id!: string;

  @ApiPropertyOptional({ enum: CATEGORIES, nullable: true })
  category!: DictionaryCategory | null;

  @ApiProperty({ enum: VACANCY_STATUSES })
  status!: VacancyStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The moderator’s reason for a rejection, as written.',
  })
  moderationReason!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Current values by field code, in the same shape `PATCH` accepts — read, edit ' +
      'one value, send it back.',
  })
  fields!: Record<string, unknown>;

  @ApiProperty({
    type: [String],
    description:
      'Required field codes still unfilled. `POST /submit` refuses while this is ' +
      'non-empty, with one 422 violation per code.',
  })
  missingForSubmit!: string[];

  @ApiProperty({
    description:
      'BR-06 in one field: active, and either no deadline or one that has not passed. ' +
      'What decides whether an application is accepted.',
  })
  isOpenForApplications!: boolean;

  @ApiProperty({ description: '§6.5: hires counted against `worker_count`.' })
  hiredCount!: number;

  @ApiPropertyOptional({ nullable: true }) publishedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closureReason!: string | null;
  @ApiProperty() updatedAt!: string;
}

export class VacancyListDto {
  @ApiProperty({ type: [VacancyDto] })
  items!: VacancyDto[];
}
