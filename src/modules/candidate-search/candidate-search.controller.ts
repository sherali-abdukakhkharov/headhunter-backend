import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';
import { CandidateViewService } from '@modules/applications/candidate-view.service';
import { CandidateForEmployerDto } from '@modules/applications/dto/applications.dto';

import {
  type CandidateCard,
  CandidateSearchService,
} from './candidate-search.service';
import {
  CandidateCardDto,
  CandidateCountDto,
  CandidateSearchFiltersDto,
  CandidateSearchRequestDto,
  CandidateSearchResultDto,
  PageQueryDto,
  SaveNoteDto,
} from './dto/candidate-search.dto';
import type { CandidateSearchFilters } from './search-filters';

/**
 * Employer-facing candidate search (§7) and what it produces: saves, shortlists, notes.
 *
 * Every route requires the `employer` role *and* a verified employer profile - the role
 * guard does the first, and the service's `assertVerified` does the second on every call
 * (§7, BR-03). Two separate checks because they refuse different things: one is "you are
 * not acting as an employer", the other "your employer profile is not verified yet".
 *
 * The two search routes are `POST` and the reason is the request, not the semantics: the
 * language filter is a nested array and §7.1 has eleven groups. They are reads, they have
 * no side effects, and they are rate limited as §12.5 requires of search.
 */
@ApiTags('candidate-search')
@ApiBearerAuth()
@RequireRole('employer')
@Controller()
export class CandidateSearchController {
  private readonly timeZone: string;

  constructor(
    private readonly search: CandidateSearchService,
    private readonly candidateView: CandidateViewService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Post('candidate-search')
  @RateLimit('search')
  @ApiOperation({
    summary: 'Structured candidate search (§7.1, §7.3)',
    description:
      'Verified employers only. Every result is a searchable, complete profile (BR-02), ' +
      'and **no card carries a phone number or a CV** (§11.1) — a card is not a hiring ' +
      'interaction, so BR-09 never opens for one. `matchScore` is the weighted share of ' +
      'the filters each candidate satisfies, and `matchBreakdown` says which groups made ' +
      'it up.',
  })
  @ApiOkResponse({ type: CandidateSearchResultDto })
  @ApiForbiddenResponse({
    description:
      '`employer.profile_incomplete` or `employer.not_verified` (§7, BR-03); ' +
      '`search.restriction_not_justified` for an unjustified age or gender filter ' +
      '(BR-12); `search.occupation_required` when occupation experience is filtered ' +
      'without an occupation.',
  })
  async searchCandidates(
    @ActiveUser() user: CurrentUser,
    @Body() dto: CandidateSearchRequestDto,
  ): Promise<CandidateSearchResultDto> {
    const { items, groups } = await this.search.search(user.id, {
      filters: dto.filters ?? {},
      sort: dto.sort ?? 'match',
      limit: dto.limit ?? 20,
      offset: dto.offset ?? 0,
      ...(dto.vacancyId ? { vacancyId: dto.vacancyId } : {}),
    });

    return {
      items: items.map((item) => this.toDto(item)),
      groups: groups.map((group) => ({
        group: group.code,
        weight: group.weight,
        asked: group.asked,
        matched: 0,
      })),
    };
  }

  @Post('candidate-search/count')
  @RateLimit('search')
  @ApiOperation({
    summary: 'How many candidates match, before opening the list (§7.2)',
    description:
      'Capped at 200. `isExact: false` means "200+", which is the honest answer to a ' +
      'filter set matching thousands — §7.2 asks for this "where technically reasonable", ' +
      'and an exact count of a huge set is the part that is not.',
  })
  @ApiOkResponse({ type: CandidateCountDto })
  async count(
    @ActiveUser() user: CurrentUser,
    @Body() dto: CandidateSearchRequestDto,
  ): Promise<CandidateCountDto> {
    return this.search.count(user.id, dto.filters ?? {});
  }

  @Get('candidate-search/prefill/:vacancyId')
  @ApiOperation({
    summary: 'The vacancy’s requirements as an editable filter set (UAT-06)',
    description:
      'Mandatory requirements become filters; **preferred ones deliberately do not** — a ' +
      'preference that excluded candidates would not be a preference, and the match score ' +
      'rewards them instead. Mandatory skills prefill as match-all, which may match ' +
      'nobody: that is what §7.2’s count is for. BR-12 restrictions come across with the ' +
      'justification the vacancy already carries.',
  })
  @ApiOkResponse({ type: CandidateSearchFiltersDto })
  @ApiNotFoundResponse({
    description: '`vacancy.not_found` — including another employer’s.',
  })
  async prefill(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
  ): Promise<CandidateSearchFilters> {
    return this.search.prefill(user.id, vacancyId);
  }

  @Get('candidate-search/candidates/:candidateUserId')
  @ApiOperation({
    summary: '§7.3’s "View profile", as much of it as BR-09 allows',
    description:
      'Readable while the candidate is searchable, or whenever a hiring interaction ' +
      'exists — an applicant stays readable after hiding their profile. `phone` and the ' +
      'files are present only where BR-09 allows, and `exposureReason` says which rule ' +
      'decided. Every call is logged (§11.1).',
  })
  @ApiOkResponse({ type: CandidateForEmployerDto })
  @ApiNotFoundResponse({
    description:
      '`candidate.profile_not_found` — unknown, or not findable and no interaction.',
  })
  async candidate(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<CandidateForEmployerDto> {
    return this.candidateView.forCandidate(user.id, candidateUserId);
  }

  @Get('candidate-search/candidates/:candidateUserId/photo')
  @RateLimit('files')
  @ApiOperation({
    summary: 'The candidate’s profile photo (§7.3)',
    description:
      'The one candidate file an employer may read without a hiring interaction, and it ' +
      'is narrow on purpose: only the file whose purpose is `photo`, only for a ' +
      'searchable profile, only for a verified employer. A photo uploaded to be found by ' +
      'is not §5.4’s authorized CV; every other file still needs BR-09.',
  })
  @ApiProduces('image/jpeg', 'image/png')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ description: '`file.not_found`.' })
  async photo(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.search.photo(user.id, candidateUserId);

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');

    response.end(bytes);
  }

  // --- saved candidates (§7.3) ---------------------------------------------

  @Get('candidate-search/saved')
  @ApiOperation({
    summary: 'Saved candidates (§7.3)',
    description:
      'The same cards, and **still behind BR-02’s gate**: a candidate who hides their ' +
      'profile leaves every employer’s saved list. Otherwise "hide me from search" would ' +
      'be defeated by whoever saved them first. The save itself survives, so they return ' +
      'if they choose to.',
  })
  @ApiOkResponse({ type: CandidateSearchResultDto })
  async saved(
    @ActiveUser() user: CurrentUser,
    @Query() query: PageQueryDto,
  ): Promise<CandidateSearchResultDto> {
    const items = await this.search.listSaved(
      user.id,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return { items: items.map((item) => this.toDto(item)), groups: [] };
  }

  @Put('candidate-search/saved/:candidateUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Save a candidate (§7.3)',
    description: 'Idempotent: saving twice is saving once.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: '`candidate.profile_not_found`.' })
  async save(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<void> {
    await this.search.save(user.id, candidateUserId);
  }

  @Delete('candidate-search/saved/:candidateUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a saved candidate' })
  @ApiNoContentResponse()
  async unsave(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<void> {
    await this.search.unsave(user.id, candidateUserId);
  }

  @Put('candidate-search/saved/:candidateUserId/note')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Write the private employer note (§7.3)',
    description:
      'Saves the candidate if they were not saved yet — the note is about the save. ' +
      '**Never visible to the candidate**, and no candidate-facing read touches the table.',
  })
  @ApiNoContentResponse()
  async setNote(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
    @Body() dto: SaveNoteDto,
  ): Promise<void> {
    await this.search.setNote(user.id, candidateUserId, dto.note ?? null);
  }

  // --- vacancy shortlists (§7.3) -------------------------------------------

  @Get('vacancies/:vacancyId/shortlist')
  @ApiOperation({ summary: 'One vacancy’s shortlist (§7.3)' })
  @ApiOkResponse({ type: CandidateSearchResultDto })
  @ApiNotFoundResponse({ description: '`vacancy.not_found`.' })
  async shortlist(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
    @Query() query: PageQueryDto,
  ): Promise<CandidateSearchResultDto> {
    const items = await this.search.listShortlist(
      user.id,
      vacancyId,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return { items: items.map((item) => this.toDto(item)), groups: [] };
  }

  @Put('vacancies/:vacancyId/shortlist/:candidateUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Add a candidate to this vacancy’s shortlist (§7.3)',
    description:
      'Not conditional on having saved them: §7.3 describes the flow a user takes, and ' +
      'failing a two-tap action for a rule nobody depends on would be noise.',
  })
  @ApiNoContentResponse()
  async addToShortlist(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<void> {
    await this.search.shortlist(user.id, vacancyId, candidateUserId);
  }

  @Delete('vacancies/:vacancyId/shortlist/:candidateUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a candidate from a shortlist' })
  @ApiNoContentResponse()
  async removeFromShortlist(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<void> {
    await this.search.unshortlist(user.id, vacancyId, candidateUserId);
  }

  private toDto(card: CandidateCard): CandidateCardDto {
    return {
      ...card,
      lastMeaningfulUpdateAt: card.lastMeaningfulUpdateAt
        ? formatWithOffset(card.lastMeaningfulUpdateAt, this.timeZone)
        : null,
    };
  }
}
