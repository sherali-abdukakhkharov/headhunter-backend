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
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
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
  type DiscoveryFilters,
  type FeedItem,
  DiscoveryService,
} from './discovery.service';
import {
  FeedDto,
  FeedQueryDto,
  ReportVacancyDto,
  VacancyDetailDto,
} from './dto/discovery.dto';

/**
 * The candidate's view of vacancies (§5.5, §5.6).
 *
 * Every read here starts from one visibility predicate - active, deadline not passed -
 * so BR-04 and BR-11 hold for the feed, the detail and the filters alike. The employer's
 * own view of the same rows is `/vacancies`, a different module with different rules.
 */
@ApiTags('discovery')
@ApiBearerAuth()
@RequireRole('candidate')
@Controller('discovery')
export class DiscoveryController {
  private readonly timeZone: string;

  constructor(
    private readonly discovery: DiscoveryService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get('recommended')
  @ApiOperation({
    summary: 'Recommended vacancies (§5.5)',
    description:
      'Rule-based on the candidate’s own occupations, region and category — not a ' +
      'model (ARCHITECTURE.md §12 defers that). A candidate with no profile gets the ' +
      'recent feed rather than an empty one.',
  })
  @ApiOkResponse({ type: FeedDto })
  async recommended(
    @ActiveUser() user: CurrentUser,
    @Query() query: FeedQueryDto,
  ): Promise<FeedDto> {
    const items = await this.discovery.recommended(user.id, filters(query));

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('recent')
  @ApiOperation({ summary: 'Recently published vacancies (§5.5)' })
  @ApiOkResponse({ type: FeedDto })
  async recent(
    @ActiveUser() user: CurrentUser,
    @Query() query: FeedQueryDto,
  ): Promise<FeedDto> {
    const items = await this.discovery.recent(user.id, filters(query));

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('saved')
  @ApiOperation({
    summary: 'Saved vacancies (§5.5)',
    description:
      'Deliberately **not** filtered by visibility: a candidate who saved something ' +
      'needs to see that it closed rather than have it vanish. BR-11 removes a closed ' +
      'vacancy from discovery, and a personal list is not discovery.',
  })
  @ApiOkResponse({ type: FeedDto })
  async saved(
    @ActiveUser() user: CurrentUser,
    @Query() query: FeedQueryDto,
  ): Promise<FeedDto> {
    const items = await this.discovery.saved(user.id, filters(query));

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('vacancies/:id')
  @ApiOperation({
    summary: 'Vacancy detail (§5.6)',
    description:
      'Includes the employer’s verification status and the structured requirements. ' +
      'Visible only while the vacancy is (BR-04, BR-11).',
  })
  @ApiOkResponse({ type: VacancyDetailDto })
  @ApiNotFoundResponse({
    description: '`vacancy.not_found` — unknown, or no longer visible.',
  })
  async detail(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VacancyDetailDto> {
    const detail = await this.discovery.detail(user.id, id);

    return { ...detail, item: this.toDto(detail.item) };
  }

  @Put('vacancies/:id/saved')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Save a vacancy (§5.6)',
    description: 'Idempotent: saving twice is saving once.',
  })
  @ApiNoContentResponse()
  async save(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.discovery.save(user.id, id);
  }

  @Delete('vacancies/:id/saved')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a saved vacancy' })
  @ApiNoContentResponse()
  async unsave(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.discovery.unsave(user.id, id);
  }

  @Post('vacancies/:id/report')
  @ApiOperation({
    summary: 'Report a vacancy (§5.6)',
    description:
      'Filed as a complaint for M10’s review queue. One open report per person per ' +
      'vacancy — tapping Report twice is not two complaints.',
  })
  @ApiOkResponse({ schema: { properties: { id: { type: 'string' } } } })
  @ApiConflictResponse({ description: '`complaint.already_reported`.' })
  async report(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportVacancyDto,
  ): Promise<{ id: string }> {
    return { id: await this.discovery.report(user.id, id, dto.reason) };
  }

  private toDto(item: FeedItem) {
    return {
      ...item,
      publishedAt: item.publishedAt
        ? formatWithOffset(item.publishedAt, this.timeZone)
        : null,
    };
  }
}

function filters(query: FeedQueryDto): DiscoveryFilters {
  return {
    ...query,
    limit: query.limit ?? 20,
    offset: query.offset ?? 0,
  };
}
