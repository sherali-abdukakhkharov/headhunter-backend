import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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

import {
  ChangeVacancyStatusDto,
  ModerateVacancyDto,
  PatchVacancyDto,
  VacancyDto,
  VacancyListDto,
} from './dto/vacancies.dto';
import { type Vacancy, VacanciesService } from './vacancies.service';

/**
 * The employer's own vacancies (§6.3, §6.4).
 *
 * Discovery - what a *candidate* sees - is a separate module (M6): different
 * authorization, different filters, different ranking. Merging them produces a
 * permission-shaped mess (ARCHITECTURE.md §2).
 */
@ApiTags('vacancies')
@ApiBearerAuth()
@Controller('vacancies')
export class VacanciesController {
  private readonly timeZone: string;

  constructor(
    private readonly vacancies: VacanciesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Post()
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Create a draft vacancy',
    description:
      'BR-03 is checked here as well as at submit, so an employer who cannot publish ' +
      'finds out before filling in the form.',
  })
  @ApiOkResponse({ type: VacancyDto })
  @ApiForbiddenResponse({
    description:
      '`employer.profile_incomplete` or `employer.not_verified` (BR-03).',
  })
  async create(@ActiveUser() user: CurrentUser): Promise<VacancyDto> {
    return this.toDto(await this.vacancies.create(user.id));
  }

  @Get('mine')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'The caller’s vacancies, every status',
    description:
      'Includes closed ones: BR-11 removes a closed vacancy from discovery and keeps ' +
      'it in the employer’s history.',
  })
  @ApiOkResponse({ type: VacancyListDto })
  async listMine(@ActiveUser() user: CurrentUser): Promise<VacancyListDto> {
    const items = await this.vacancies.listMine(user.id);

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get(':id')
  @RequireRole('employer')
  @ApiOperation({ summary: 'One of the caller’s vacancies' })
  @ApiOkResponse({ type: VacancyDto })
  @ApiNotFoundResponse({
    description:
      '`vacancy.not_found` — also the answer for another employer’s vacancy, because ' +
      'confirming that an id exists is information we do not owe (§11.1).',
  })
  async read(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VacancyDto> {
    return this.toDto(await this.vacancies.read(user.id, id));
  }

  @Patch(':id')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Write vacancy fields',
    description:
      'Partial by field code, re-validated server-side against the same schema the ' +
      'client rendered (§4.2). Editing a rejected vacancy returns it to `draft`; ' +
      'changing an age or gender restriction on a live one sends it back for review ' +
      '(BR-12).',
  })
  @ApiOkResponse({ type: VacancyDto })
  @ApiUnprocessableEntityResponse({
    description: 'One entry per rejected field (§4.6).',
  })
  @ApiConflictResponse({
    description: '`vacancy.under_moderation` or `vacancy.not_editable`.',
  })
  async patch(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PatchVacancyDto,
  ): Promise<VacancyDto> {
    return this.toDto(await this.vacancies.patch(user.id, id, dto.fields));
  }

  @Post(':id/submit')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Submit for publication',
    description:
      'Requires a verified employer (BR-03), every required field for the category, a ' +
      'deadline that has not passed, and — for any age or gender restriction — a ' +
      'justification the enumerated list supports (BR-12). ' +
      '**While `MODERATION_ENABLED` is off an ordinary vacancy is published ' +
      'immediately**, recorded with a null actor and an `auto_approved_no_moderator` ' +
      'reason. A vacancy carrying a BR-12 restriction still goes to review regardless, ' +
      'because BR-12 requires it — which means it cannot publish until the admin ' +
      'module (M10) exists.',
  })
  @ApiOkResponse({ type: VacancyDto })
  @ApiUnprocessableEntityResponse({
    description:
      'One `required` violation per unfilled field, so each can be focused.',
  })
  @ApiForbiddenResponse({
    description:
      '`vacancy.deadline_passed` or `vacancy.restriction_not_justified`.',
  })
  @ApiConflictResponse({ description: '`vacancy.not_submittable`.' })
  async submit(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<VacancyDto> {
    return this.toDto(await this.vacancies.submit(user.id, id));
  }

  @Put(':id/status')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Pause, resume or close',
    description:
      'Closing is terminal (BR-11): the vacancy leaves discovery and stays in history. ' +
      'Every change writes a BR-08 audit row.',
  })
  @ApiOkResponse({ type: VacancyDto })
  @ApiConflictResponse({ description: '`vacancy.transition_not_allowed`.' })
  async changeStatus(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeVacancyStatusDto,
  ): Promise<VacancyDto> {
    return this.toDto(
      await this.vacancies.changeStatus(
        user.id,
        id,
        dto.status,
        dto.reason ?? null,
      ),
    );
  }

  @Post(':id/moderation')
  @RequireRole('admin')
  @ApiOperation({
    summary: 'Approve or reject a submitted vacancy (BR-04)',
    description:
      'The administrator side of §6.4. The queue that lists what is waiting is M10; ' +
      'this is the decision itself, kept with the transition rules and their audit ' +
      'rows rather than duplicated in the admin module. A rejection requires a reason.',
  })
  @ApiOkResponse({ type: VacancyDto })
  @ApiForbiddenResponse({
    description: '`vacancy.moderation_reason_required`.',
  })
  @ApiConflictResponse({ description: '`vacancy.not_under_moderation`.' })
  async moderate(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateVacancyDto,
  ): Promise<VacancyDto> {
    return this.toDto(
      await this.vacancies.moderate(
        id,
        dto.decision,
        { userId: user.id, role: 'admin' },
        dto.reason ?? null,
      ),
    );
  }

  private toDto(vacancy: Vacancy): VacancyDto {
    const { row } = vacancy.aggregate;

    return {
      id: row.id,
      category: row.category,
      status: row.status,
      moderationReason: row.moderation_reason,
      fields: vacancy.fields,
      missingForSubmit: vacancy.missingForSubmit,
      isOpenForApplications: vacancy.isOpenForApplications,
      hiredCount: row.hired_count,
      publishedAt: row.published_at
        ? formatWithOffset(row.published_at, this.timeZone)
        : null,
      closedAt: row.closed_at
        ? formatWithOffset(row.closed_at, this.timeZone)
        : null,
      closureReason: row.closure_reason,
      updatedAt: formatWithOffset(row.updated_at, this.timeZone),
    };
  }
}
