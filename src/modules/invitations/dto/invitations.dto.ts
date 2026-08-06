import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { InvitationStatus } from '@infra/db/database.types';

export const INVITATION_STATUSES = [
  'sent',
  'details_requested',
  'accepted',
  'declined',
] as const;

/** §8.2's three candidate actions. */
export const CANDIDATE_RESPONSE_STATUSES = [
  'accepted',
  'declined',
  'details_requested',
] as const;

/**
 * §8.2's invitation, in either of its two shapes.
 *
 * Exactly one of `vacancyId` and `occupationId` must be present, and the server refuses
 * the request otherwise (`invitation.shape_invalid`) - a rule class-validator cannot
 * express and a CHECK constraint enforces underneath.
 */
export class CreateInvitationDto {
  @ApiProperty({
    description: 'The candidate, who must be search-visible (§8.2).',
  })
  @IsUUID()
  candidateUserId!: string;

  @ApiPropertyOptional({
    description:
      'An **active** vacancy of the caller’s. Mutually exclusive with `occupationId`; the ' +
      'vacancy is where the occupation, place, schedule and pay come from.',
  })
  @IsOptional()
  @IsUUID()
  vacancyId?: string;

  @ApiPropertyOptional({
    description:
      'A general invitation’s occupation (§8.2). Mutually exclusive with `vacancyId`.',
  })
  @IsOptional()
  @IsUUID()
  occupationId?: string;

  @ApiPropertyOptional({ description: 'General invitations only.' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ description: 'General invitations only.' })
  @IsOptional()
  @IsUUID()
  districtId?: string;

  @ApiPropertyOptional({ description: '§8.2’s payment context.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryFrom?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryTo?: number;

  @ApiPropertyOptional({ description: '`payment_period` id.' })
  @IsOptional()
  @IsUUID()
  salaryPeriodId?: string;

  @ApiPropertyOptional({
    description:
      'Excludes a range, as everywhere else in this product: a negotiable figure and a ' +
      'stated one are different answers.',
  })
  @IsOptional()
  @IsBoolean()
  salaryIsNegotiable?: boolean;

  @ApiPropertyOptional({
    description:
      '§8.2’s schedule. Free text: a general invitation is a message, and the structured ' +
      'version of it is what publishing a vacancy is for.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  scheduleNote?: string;

  @ApiPropertyOptional({
    description: '§8.2’s contact context — what the employer wants to say.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  message?: string;
}

export class RespondToInvitationDto {
  @ApiProperty({
    enum: CANDIDATE_RESPONSE_STATUSES,
    description:
      '§8.2’s Accept, Decline or Request details. `details_requested` is not an ending: ' +
      'the candidate may still accept or decline afterwards, but may not ask twice.',
  })
  @IsIn(CANDIDATE_RESPONSE_STATUSES)
  status!: InvitationStatus;

  @ApiPropertyOptional({
    description:
      'The candidate’s reply. Where "Request details" puts its question, and it is kept ' +
      'as the reason on the BR-08 history row.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string;
}

export class InvitationDto {
  @ApiProperty() id!: string;
  @ApiProperty() employerUserId!: string;
  @ApiProperty() candidateUserId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Null for a general invitation, which carries its own details.',
  })
  vacancyId!: string | null;

  @ApiPropertyOptional({ nullable: true }) occupationId!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) districtId!: string | null;
  @ApiPropertyOptional({ nullable: true }) salaryFrom!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryTo!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryPeriodId!: string | null;
  @ApiProperty() salaryIsNegotiable!: boolean;
  @ApiPropertyOptional({ nullable: true }) scheduleNote!: string | null;
  @ApiPropertyOptional({ nullable: true }) message!: string | null;

  @ApiProperty({ enum: INVITATION_STATUSES })
  status!: InvitationStatus;

  @ApiPropertyOptional({ nullable: true }) responseNote!: string | null;
  @ApiPropertyOptional({ nullable: true }) respondedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class InvitationListDto {
  @ApiProperty({ type: [InvitationDto] })
  items!: InvitationDto[];
}

export class InvitationHistoryEntryDto {
  @ApiPropertyOptional({ enum: INVITATION_STATUSES, nullable: true })
  fromStatus!: InvitationStatus | null;

  @ApiProperty({ enum: INVITATION_STATUSES })
  toStatus!: InvitationStatus;

  @ApiPropertyOptional({ nullable: true }) actorRole!: string | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class InvitationHistoryDto {
  @ApiProperty({ type: [InvitationHistoryEntryDto] })
  items!: InvitationHistoryEntryDto[];
}

export class InvitationCountsDto {
  @ApiProperty({
    description:
      'Invitations for this vacancy by status (§7.4’s invited and accepted counts). ' +
      'Interviewed and hired are application stages — read them from ' +
      '`/vacancies/{id}/applications/counts`.',
    example: { sent: 12, accepted: 5, declined: 2 },
  })
  byStatus!: Record<string, number>;
}
