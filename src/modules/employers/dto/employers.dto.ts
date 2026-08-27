import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import type {
  EmployerType,
  VerificationStatus,
} from '@infra/db/database.types';

export const EMPLOYER_TYPES: EmployerType[] = ['company', 'individual'];

export const VERIFICATION_STATUSES: VerificationStatus[] = [
  'not_submitted',
  'under_review',
  'verified',
  'rejected',
  'changes_required',
];

export class UpsertEmployerDto {
  @ApiProperty({
    enum: EMPLOYER_TYPES,
    description:
      'Chosen once. It decides which fields apply (§6.1) and what verification ' +
      'asks for, so a later change would strand the other type’s answers and the ' +
      'evidence verification was granted against - `employer.type_immutable`.',
  })
  @IsIn(EMPLOYER_TYPES)
  type!: EmployerType;

  @ApiPropertyOptional({
    description:
      'The number a candidate should call. Deliberately separate from the login ' +
      'phone: the verified identity (BR-01) must not be overwritten by a business ' +
      'contact detail.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  contactPhone?: string;

  @ApiPropertyOptional({ description: '`region` dictionary id.' })
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({
    description: '`region` dictionary id under `regionId`.',
  })
  @IsOptional()
  @IsUUID()
  districtId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({
    description:
      'A company description, or for an individual employer the "short description ' +
      'of the requested work" of §6.1.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Individual employers.' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  fullName?: string;

  @ApiPropertyOptional({ description: 'Companies: the registered name.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({
    description:
      'Companies: the name shown on a vacancy card, which often differs.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  publicName?: string;

  @ApiPropertyOptional({ description: 'Companies: `industry` dictionary id.' })
  @IsOptional()
  @IsUUID()
  industryId?: string;

  @ApiPropertyOptional({ description: 'Companies: §6.1’s contact person.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactPersonName?: string;

  @ApiPropertyOptional({
    description:
      'Companies: a stored file of purpose `logo`, uploaded via `/files`.',
  })
  @IsOptional()
  @IsUUID()
  logoFileId?: string;
}

export class MissingEmployerFieldDto {
  @ApiProperty({
    description: 'Response field name, so the client can focus it.',
  })
  field!: string;
}

export class EmployerProfileDto {
  @ApiProperty({ enum: EMPLOYER_TYPES })
  type!: EmployerType;

  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) districtId!: string | null;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiPropertyOptional({ nullable: true }) legalName!: string | null;
  @ApiPropertyOptional({ nullable: true }) publicName!: string | null;
  @ApiPropertyOptional({ nullable: true }) industryId!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactPersonName!: string | null;
  @ApiPropertyOptional({ nullable: true }) logoFileId!: string | null;

  @ApiProperty({
    enum: VERIFICATION_STATUSES,
    description: 'The five states of §6.1, shown to the employer as-is.',
  })
  verificationStatus!: VerificationStatus;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The administrator’s reason for a rejection or a correction request. Human ' +
      'text, already in the language it was written in - not a translatable key.',
  })
  verificationReason!: string | null;

  @ApiPropertyOptional({ nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({
    description: 'Over the fields §6.1 requires for this employer type.',
  })
  completenessPercent!: number;

  @ApiProperty({
    description:
      'BR-03’s condition: an employer may not submit a vacancy or send an ' +
      'invitation until this is true.',
  })
  isComplete!: boolean;

  @ApiProperty({
    description:
      'Both BR-03 conditions together: complete **and** verified. §7 requires this ' +
      'for candidate search.',
  })
  canPublish!: boolean;

  @ApiProperty({ type: [MissingEmployerFieldDto] })
  missingFields!: MissingEmployerFieldDto[];

  @ApiProperty() updatedAt!: string;
}

export class SubmitVerificationDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Stored file ids, uploaded through `POST /files` with the purpose the ' +
      'verification state lists as required. Must belong to the caller.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(10)
  fileIds?: string[];
}

export class RequiredEvidenceDto {
  @ApiProperty({ example: 'company_registration' }) purposeCode!: string;

  @ApiProperty({
    description:
      'Whether a submission is refused without it. What each type must provide is ' +
      'still an open client decision (§6.1 "if required by policy"), so read this ' +
      'rather than hardcoding a list.',
  })
  required!: boolean;
}

export class UploadPolicyDto {
  @ApiProperty({
    type: [String],
    example: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'],
    description:
      'Extensions `POST /files` accepts, for the picker’s filter. The server ' +
      'also checks the leading bytes, so this is a convenience, not the gate.',
  })
  acceptedExtensions!: string[];

  @ApiProperty({
    example: 10485760,
    description:
      '`FILE_MAX_SIZE_BYTES` — a deployment setting, which is why it is served. ' +
      'A client that hardcodes it either bounces files this instance would take ' +
      'or promises ones it would refuse.',
  })
  maxSizeBytes!: number;
}

export class VerificationSubmissionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: VERIFICATION_STATUSES }) status!: VerificationStatus;
  @ApiProperty() submittedAt!: string;
  @ApiPropertyOptional({ nullable: true }) decidedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty({ type: [String] }) fileIds!: string[];
}

export class VerificationStateDto {
  @ApiProperty({ enum: VERIFICATION_STATUSES }) status!: VerificationStatus;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiPropertyOptional({ nullable: true }) verifiedAt!: string | null;

  @ApiProperty({ type: [RequiredEvidenceDto] })
  requiredEvidence!: RequiredEvidenceDto[];

  @ApiProperty({
    type: [VerificationSubmissionDto],
    description: 'Newest first. Past attempts and why they were refused.',
  })
  submissions!: VerificationSubmissionDto[];

  @ApiProperty({
    type: UploadPolicyDto,
    description:
      'What the evidence in `requiredEvidence` may be uploaded as. Here rather ' +
      'than on each row because the policy is per deployment, not per document.',
  })
  upload!: UploadPolicyDto;
}
