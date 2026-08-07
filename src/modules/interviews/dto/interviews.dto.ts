import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { InterviewStatus, InterviewType } from '@infra/db/database.types';

export const INTERVIEW_TYPES = ['phone', 'in_person', 'external_link'] as const;

export const INTERVIEW_STATUSES = [
  'scheduled',
  'confirmed',
  'reschedule_requested',
  'cancelled',
] as const;

/** §8.3's two candidate actions. */
export const CANDIDATE_RESPONSE_STATUSES = [
  'confirmed',
  'reschedule_requested',
] as const;

/**
 * §8.3's interview, in full.
 *
 * Used for scheduling **and** for rescheduling, because the fields are interdependent: a
 * type change decides which of `location` and `meetingLink` may exist at all, so a
 * partial update would let a phone interview keep the address of the in-person one it
 * used to be.
 */
export class InterviewInputDto {
  @ApiProperty({
    enum: INTERVIEW_TYPES,
    description:
      '§8.3’s three types. The type decides which detail is required, and the server ' +
      'refuses the others: `in_person` needs `location`, `external_link` needs ' +
      '`meetingLink`, `phone` needs neither and permits neither.',
  })
  @IsIn(INTERVIEW_TYPES)
  type!: InterviewType;

  @ApiProperty({
    description:
      'When, as an instant. Stored as `timestamptz` and returned with the platform ' +
      'offset (API_CONTRACTS §2), so "14:00" means the same moment to both sides.',
    example: '2026-08-20T14:00:00+05:00',
  })
  @IsISO8601()
  scheduledAt!: string;

  @ApiPropertyOptional({ description: '`in_person` only: where to go.' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({
    description:
      '`external_link` only. A plain string: §2.4 puts a built-in video engine out of ' +
      'scope, so this is somebody else’s meeting URL and nothing more.',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  meetingLink?: string;

  @ApiPropertyOptional({
    description: '§8.3’s "documents or preparation notes".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;
}

export class RespondToInterviewDto {
  @ApiProperty({
    enum: CANDIDATE_RESPONSE_STATUSES,
    description:
      '§8.3’s "confirm or request another time". A candidate who confirmed may still ' +
      'ask for another time afterwards - plans change - but may not say the same thing ' +
      'twice.',
  })
  @IsIn(CANDIDATE_RESPONSE_STATUSES)
  status!: InterviewStatus;

  @ApiPropertyOptional({
    description:
      'The candidate’s reply. Where "request another time" says *which* time, and it is ' +
      'kept as the reason on the BR-08 history row.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note?: string;
}

export class CancelInterviewDto {
  @ApiPropertyOptional({ description: 'Shown to the candidate.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class InterviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty({ enum: INTERVIEW_TYPES }) type!: InterviewType;
  @ApiProperty() scheduledAt!: string;
  @ApiPropertyOptional({ nullable: true }) location!: string | null;
  @ApiPropertyOptional({ nullable: true }) meetingLink!: string | null;
  @ApiPropertyOptional({ nullable: true }) instructions!: string | null;
  @ApiProperty({ enum: INTERVIEW_STATUSES }) status!: InterviewStatus;
  @ApiPropertyOptional({ nullable: true }) responseNote!: string | null;
  @ApiPropertyOptional({ nullable: true }) respondedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class InterviewListDto {
  @ApiProperty({ type: [InterviewDto] })
  items!: InterviewDto[];
}

export class InterviewHistoryEntryDto {
  @ApiPropertyOptional({ enum: INTERVIEW_STATUSES, nullable: true })
  fromStatus!: InterviewStatus | null;

  @ApiProperty({ enum: INTERVIEW_STATUSES })
  toStatus!: InterviewStatus;

  @ApiPropertyOptional({ nullable: true }) actorRole!: string | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class InterviewHistoryDto {
  @ApiProperty({ type: [InterviewHistoryEntryDto] })
  items!: InterviewHistoryEntryDto[];
}
