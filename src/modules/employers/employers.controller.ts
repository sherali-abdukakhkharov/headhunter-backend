import { FilesService } from '@infra/files/files.service';
import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import {
  EmployerProfileDto,
  SubmitVerificationDto,
  UpsertEmployerDto,
  VerificationStateDto,
} from './dto/employers.dto';
import { type EmployerProfile, EmployersService } from './employers.service';
import {
  type VerificationState,
  VerificationService,
} from './verification.service';

/**
 * The employer's own profile and verification (§6.1, BR-03).
 *
 * `@RequireRole('employer')` throughout: an account may hold both roles (§2.3), and a
 * user acting as a candidate must not be able to write an employer profile in
 * passing.
 */
@ApiTags('employers')
@ApiBearerAuth()
@RequireRole('employer')
@Controller('employers/me')
export class EmployersController {
  private readonly timeZone: string;

  constructor(
    private readonly employers: EmployersService,
    private readonly verification: VerificationService,
    // For the upload policy only: the accepted extensions and the size cap this
    // deployment enforces, so the app's picker matches what /files will take.
    private readonly files: FilesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get()
  @ApiOperation({
    summary: 'The caller’s employer profile',
    description:
      'A 404 before the first `PUT`, unlike the candidate profile: `type` decides ' +
      'which fields exist, so there is no neutral empty employer to render.',
  })
  @ApiOkResponse({ type: EmployerProfileDto })
  @ApiNotFoundResponse({
    description: '`employer.profile_not_found` - nothing created yet.',
  })
  async profile(@ActiveUser() user: CurrentUser): Promise<EmployerProfileDto> {
    return this.toDto(await this.employers.findMine(user.id));
  }

  @Put()
  @ApiOperation({
    summary: 'Create or replace the employer profile',
    description:
      'A full replacement rather than a patch: the form is one screen per §6.1 and ' +
      'submits whole. `type` is fixed after creation. Completeness is recomputed in ' +
      'the same transaction, because BR-03 reads it on every vacancy submission.',
  })
  @ApiOkResponse({ type: EmployerProfileDto })
  @ApiForbiddenResponse({ description: '`employer.type_immutable`.' })
  async upsert(
    @ActiveUser() user: CurrentUser,
    @Body() dto: UpsertEmployerDto,
  ): Promise<EmployerProfileDto> {
    const profile = await this.employers.upsert(user.id, dto.type, {
      contactPhone: dto.contactPhone ?? null,
      regionId: dto.regionId ?? null,
      districtId: dto.districtId ?? null,
      address: dto.address ?? null,
      description: dto.description ?? null,
      fullName: dto.fullName ?? null,
      legalName: dto.legalName ?? null,
      publicName: dto.publicName ?? null,
      industryId: dto.industryId ?? null,
      contactPersonName: dto.contactPersonName ?? null,
      logoFileId: dto.logoFileId ?? null,
    });

    return this.toDto(profile);
  }

  @Get('verification')
  @ApiOperation({
    summary: 'Verification state and past attempts',
    description:
      '`requiredEvidence` is served rather than hardcoded: which documents each ' +
      'employer type must provide is still an open client decision (§6.1, "if ' +
      'required by policy"), so the answer arrives as data.',
  })
  @ApiOkResponse({ type: VerificationStateDto })
  async verificationState(
    @ActiveUser() user: CurrentUser,
  ): Promise<VerificationStateDto> {
    return this.toVerificationDto(await this.verification.state(user.id));
  }

  @Post('verification')
  @ApiOperation({
    summary: 'Submit for verification',
    description:
      'Requires a complete profile and every document `requiredEvidence` marks ' +
      'required, each owned by the caller. Writes a BR-08 history row. **While the ' +
      'admin module is out of scope, `EMPLOYER_VERIFICATION_ENABLED` is off and this ' +
      'approves immediately** - recorded with a null actor and an ' +
      '`auto_verified_no_reviewer` reason, so the history never claims a person ' +
      'reviewed it.',
  })
  @ApiOkResponse({ type: VerificationStateDto })
  @ApiForbiddenResponse({
    description:
      '`employer.profile_incomplete` or `employer.verification_evidence_missing`.',
  })
  @ApiConflictResponse({
    description: '`employer.verification_not_submittable`.',
  })
  async submit(
    @ActiveUser() user: CurrentUser,
    @Body() dto: SubmitVerificationDto,
  ): Promise<VerificationStateDto> {
    const state = await this.verification.submit(user.id, dto.fileIds ?? []);

    return this.toVerificationDto(state);
  }

  private toDto(profile: EmployerProfile): EmployerProfileDto {
    return {
      type: profile.type,
      contactPhone: profile.contactPhone,
      regionId: profile.regionId,
      districtId: profile.districtId,
      address: profile.address,
      description: profile.description,
      fullName: profile.fullName,
      legalName: profile.legalName,
      publicName: profile.publicName,
      industryId: profile.industryId,
      contactPersonName: profile.contactPersonName,
      logoFileId: profile.logoFileId,
      verificationStatus: profile.verificationStatus,
      verificationReason: profile.verificationReason,
      verifiedAt: profile.verifiedAt
        ? formatWithOffset(profile.verifiedAt, this.timeZone)
        : null,
      completenessPercent: profile.completenessPercent,
      isComplete: profile.isComplete,
      // BR-03 in one field, computed in one place - a client that ANDed these itself
      // would be a second implementation of the rule that decides who may publish.
      canPublish:
        profile.isComplete && profile.verificationStatus === 'verified',
      missingFields: this.employers.missingFields(profile),
      updatedAt: formatWithOffset(profile.updatedAt, this.timeZone),
    };
  }

  private toVerificationDto(state: VerificationState): VerificationStateDto {
    return {
      status: state.status,
      reason: state.reason,
      verifiedAt: state.verifiedAt
        ? formatWithOffset(state.verifiedAt, this.timeZone)
        : null,
      requiredEvidence: state.requiredEvidence,
      upload: this.files.policy(),
      submissions: state.submissions.map((submission) => ({
        id: submission.id,
        status: submission.status,
        submittedAt: formatWithOffset(submission.submittedAt, this.timeZone),
        decidedAt: submission.decidedAt
          ? formatWithOffset(submission.decidedAt, this.timeZone)
          : null,
        reason: submission.reason,
        fileIds: submission.fileIds,
      })),
    };
  }
}
