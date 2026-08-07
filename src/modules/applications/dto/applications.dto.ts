import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { ApplicationStatus, UserRole } from '@infra/db/database.types';

import { EMPLOYER_STAGES } from '../application-status';

export const ALL_STAGES: ApplicationStatus[] = [
  'submitted',
  'viewed',
  'shortlisted',
  'interview',
  'offer',
  'hired',
  'rejected',
  'withdrawn',
];

export class ApplyDto {
  @ApiPropertyOptional({
    description:
      'An optional short message (§5.6). Optional on purpose: a candidate applying to ' +
      'twenty seasonal vacancies will not write twenty letters.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  coverNote?: string;
}

export class MoveStageDto {
  @ApiProperty({
    enum: EMPLOYER_STAGES,
    description:
      '§8.1’s employer-settable stages. Forward moves may skip — real hiring does — but ' +
      'never backwards, and `withdrawn` is the candidate’s alone.',
  })
  @IsIn(EMPLOYER_STAGES)
  status!: Exclude<ApplicationStatus, 'submitted' | 'withdrawn'>;

  @ApiPropertyOptional({
    description:
      'Shown to the candidate on a rejection (§8.1 "optional standard message"). ' +
      'Recorded in the BR-08 history whatever the stage.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class AddNoteDto {
  @ApiProperty({
    description:
      '§6.5’s internal note. **Never visible to the candidate** — it lives in its own ' +
      'table so that reading it is a deliberate act rather than one forgotten `select` ' +
      'away from being exposed.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}

export class ApplicationDto {
  @ApiProperty() id!: string;
  @ApiProperty() vacancyId!: string;
  @ApiProperty() candidateUserId!: string;

  @ApiProperty({ enum: ALL_STAGES })
  status!: ApplicationStatus;

  @ApiPropertyOptional({ nullable: true }) coverNote!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The employer’s reason, when rejected. Visible to the candidate.',
  })
  rejectionReason!: string | null;

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ApplicationListDto {
  @ApiProperty({ type: [ApplicationDto] })
  items!: ApplicationDto[];
}

export class StageHistoryEntryDto {
  @ApiPropertyOptional({ enum: ALL_STAGES, nullable: true })
  fromStatus!: ApplicationStatus | null;

  @ApiProperty({ enum: ALL_STAGES })
  toStatus!: ApplicationStatus;

  @ApiPropertyOptional({ nullable: true })
  actorRole!: UserRole | null;

  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class StageHistoryDto {
  @ApiProperty({
    type: [StageHistoryEntryDto],
    description:
      'BR-08: every status change with its time and actor, oldest first.',
  })
  items!: StageHistoryEntryDto[];
}

export class ApplicationNoteDto {
  @ApiProperty() id!: string;
  @ApiProperty() note!: string;
  @ApiProperty() createdAt!: string;
}

export class ApplicationNoteListDto {
  @ApiProperty({ type: [ApplicationNoteDto] })
  items!: ApplicationNoteDto[];
}

export class ApplicationCountsDto {
  @ApiPropertyOptional({
    nullable: true,
    description: 'BR-05’s required worker count.',
  })
  workerCount!: number | null;

  @ApiProperty({ description: '§6.5: hires against the requirement.' })
  hiredCount!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Applications per stage, for §6.5’s grouping.',
  })
  byStatus!: Record<string, number>;
}

export class CandidateForEmployerDto {
  @ApiProperty() candidateUserId!: string;

  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) districtId!: string | null;
  @ApiPropertyOptional({ nullable: true }) availableFrom!: string | null;
  @ApiProperty() completenessPercent!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'BR-09: present only where the candidate’s privacy settings **and** a hiring ' +
      'interaction both allow it. Null is a normal answer, not an error.',
  })
  phone!: string | null;

  @ApiProperty({
    description:
      'Whether this employer may download the candidate’s files (BR-09, §5.4). When ' +
      'false, `files` is empty.',
  })
  canViewFiles!: boolean;

  @ApiProperty({
    isArray: true,
    description:
      'The candidate’s CV and other attachments, each with a path on this API. Empty ' +
      'unless `canViewFiles`.',
    type: 'object',
    additionalProperties: true,
  })
  files!: {
    id: string;
    purposeCode: string;
    fileName: string;
    downloadPath: string;
  }[];

  @ApiProperty({
    description:
      'Why the decision went the way it did — a stable code, logged with the access ' +
      '(§11.1) and useful when a candidate asks why an employer could not call them.',
  })
  exposureReason!: string;
}
