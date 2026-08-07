import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import { type CandidateProfile, CandidatesService } from './candidates.service';
import {
  CandidateProfileDto,
  PatchProfileDto,
  SetVisibilityDto,
} from './dto/candidates.dto';

/**
 * The candidate's own profile (§5.1, §5.3, BR-02).
 *
 * `@RequireRole('candidate')` rather than a plain authenticated check: an account may
 * hold several roles (§2.3), so the question is always "may this user, acting as
 * candidate, do this" - and an employer switching roles must not be able to write a
 * candidate profile in passing.
 */
@ApiTags('candidates')
@ApiBearerAuth()
@RequireRole('candidate')
@Controller('candidates/me')
export class CandidatesController {
  private readonly timeZone: string;

  constructor(
    private readonly candidates: CandidatesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get('profile')
  @ApiOperation({
    summary: 'The caller’s candidate profile',
    description:
      'Always succeeds for a candidate: before the first save every field is ' +
      'present and empty and `isStarted` is false, so the form has one code path. ' +
      '`fields` is keyed by the codes of `GET /schemas/candidate-profile` and is ' +
      'shaped exactly as `PATCH` accepts.',
  })
  @ApiOkResponse({ type: CandidateProfileDto })
  async profile(@ActiveUser() user: CurrentUser): Promise<CandidateProfileDto> {
    return this.toDto(await this.candidates.read(user.id));
  }

  @Patch('profile')
  @ApiOperation({
    summary: 'Write profile fields',
    description:
      'Partial by field code. The server re-validates against the same schema the ' +
      'client rendered (§4.2), so a stale client schema produces a clean 422 and ' +
      'never a corrupt row. Completeness and the derived category are recomputed ' +
      'from what was stored, in the same transaction.',
  })
  @ApiOkResponse({ type: CandidateProfileDto })
  @ApiUnprocessableEntityResponse({
    description:
      '`errors[]` carries one entry per rejected field: `code` is the schema field ' +
      'code, `rule` the rule that rejected it (§4.6).',
  })
  async patchProfile(
    @ActiveUser() user: CurrentUser,
    @Body() dto: PatchProfileDto,
  ): Promise<CandidateProfileDto> {
    return this.toDto(await this.candidates.patch(user.id, dto.fields));
  }

  @Put('visibility')
  @ApiOperation({
    summary: 'Set search visibility',
    description:
      'Its own route rather than a schema field, for two reasons: §4.2’s `kind` ' +
      'union has no `enum` member, and this is the one write that must **not** ' +
      'refresh `lastMeaningfulUpdateAt` (§5.3) - a privacy toggle cannot be used to ' +
      'make a stale profile look maintained. Allowed while incomplete: BR-02 gates ' +
      'the effect, not the setting.',
  })
  @ApiOkResponse({ type: CandidateProfileDto })
  async visibility(
    @ActiveUser() user: CurrentUser,
    @Body() dto: SetVisibilityDto,
  ): Promise<CandidateProfileDto> {
    return this.toDto(
      await this.candidates.setVisibility(user.id, dto.visibility),
    );
  }

  private toDto(profile: CandidateProfile): CandidateProfileDto {
    const { row } = profile.aggregate;

    return {
      isStarted: profile.isStarted,
      category: row.category,
      visibility: row.visibility,
      completenessPercent: profile.completeness.percent,
      isComplete: profile.completeness.isComplete,
      // BR-02 in one field, computed in one place: a client that ANDed these itself
      // would be a second implementation of the rule that decides who is findable.
      isSearchable:
        profile.completeness.isComplete && row.visibility === 'searchable',
      missingFields: profile.completeness.missing,
      fields: profile.fields,
      lastMeaningfulUpdateAt: row.last_meaningful_update_at
        ? formatWithOffset(row.last_meaningful_update_at, this.timeZone)
        : null,
      updatedAt: row.updated_at
        ? formatWithOffset(row.updated_at, this.timeZone)
        : null,
    };
  }
}
