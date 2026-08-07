import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
  CancelInterviewDto,
  InterviewDto,
  InterviewHistoryDto,
  InterviewInputDto,
  InterviewListDto,
  RespondToInterviewDto,
} from './dto/interviews.dto';
import { type Interview, InterviewsService } from './interviews.service';

/**
 * Interview scheduling (§8.3).
 *
 * The employer schedules, reschedules and cancels; the candidate confirms or asks for
 * another time. Both read. As with applications, the two sides share one controller
 * because they share one resource and one status machine, and the role guards are per
 * route.
 */
@ApiTags('interviews')
@ApiBearerAuth()
@Controller()
export class InterviewsController {
  private readonly timeZone: string;

  constructor(
    private readonly interviews: InterviewsService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- employer ------------------------------------------------------------

  @Post('applications/:id/interviews')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Schedule an interview (§8.3)',
    description:
      'Moves the application to §8.1’s `interview` stage **in the same transaction**, ' +
      'with its BR-08 history row: the stage table says the candidate is told "date, ' +
      'time, type and location/link" when that stage is set, and that is this. An ' +
      'application already at or past the stage is left where it is; a terminal one is ' +
      'refused.',
  })
  @ApiOkResponse({ type: InterviewDto })
  @ApiUnprocessableEntityResponse({
    description:
      '`interview.detail_required` against `location` or `meetingLink` — §8.3’s ' +
      'conditional requirement, which a CHECK constraint enforces underneath.',
  })
  @ApiConflictResponse({
    description:
      '`application.final` — a withdrawn, rejected or hired application.',
  })
  @ApiNotFoundResponse({
    description: '`application.not_found` — including another employer’s.',
  })
  async schedule(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Body() dto: InterviewInputDto,
  ): Promise<InterviewDto> {
    return this.toDto(
      await this.interviews.schedule(user.id, applicationId, {
        ...dto,
        scheduledAt: new Date(dto.scheduledAt),
      }),
    );
  }

  @Put('interviews/:id')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Reschedule or correct an interview (§8.3)',
    description:
      'A full replacement, not a patch: the type decides which of `location` and ' +
      '`meetingLink` may exist, so a partial update could leave a phone interview ' +
      'holding the address of the in-person one it used to be. **Always resets the ' +
      'candidate’s answer** — a new time has not been confirmed, whatever was said about ' +
      'the old one.',
  })
  @ApiOkResponse({ type: InterviewDto })
  @ApiConflictResponse({ description: '`interview.final`.' })
  async reschedule(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InterviewInputDto,
  ): Promise<InterviewDto> {
    return this.toDto(
      await this.interviews.reschedule(user.id, id, {
        ...dto,
        scheduledAt: new Date(dto.scheduledAt),
      }),
    );
  }

  @Post('interviews/:id/cancel')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Call an interview off',
    description:
      'Not one of §8.3’s statuses, and here because the alternative is a stale interview ' +
      'nobody can retract — an employer whose plans change would otherwise have to ' +
      'reschedule to a fiction. Terminal.',
  })
  @ApiOkResponse({ type: InterviewDto })
  async cancel(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelInterviewDto,
  ): Promise<InterviewDto> {
    return this.toDto(
      await this.interviews.cancel(user.id, id, dto.reason ?? null),
    );
  }

  // --- candidate -----------------------------------------------------------

  @Get('interviews/mine')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'The caller’s interviews across every application',
    description:
      'Not in §8.3, which describes one interview — but a candidate with four ' +
      'applications needs one list of where to be and when. Cancelled ones are left out.',
  })
  @ApiOkResponse({ type: InterviewListDto })
  async mine(@ActiveUser() user: CurrentUser): Promise<InterviewListDto> {
    const items = await this.interviews.listForCandidate(user.id);

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Post('interviews/:id/respond')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'Confirm, or request another time (§8.3)',
    description:
      'The candidate’s alone. `confirmed` is **not** terminal: a candidate who confirms ' +
      'and then finds a clash must be able to say so. Saying the same thing twice is ' +
      'refused, because a second identical history row records that nothing happened.',
  })
  @ApiOkResponse({ type: InterviewDto })
  @ApiConflictResponse({
    description: '`interview.final` or `interview.response_not_allowed`.',
  })
  async respond(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToInterviewDto,
  ): Promise<InterviewDto> {
    return this.toDto(
      await this.interviews.respond(user.id, id, dto.status, dto.note ?? null),
    );
  }

  // --- both ----------------------------------------------------------------

  @Get('applications/:id/interviews')
  @ApiOperation({ summary: 'One application’s interviews, for either side' })
  @ApiOkResponse({ type: InterviewListDto })
  @ApiNotFoundResponse({ description: '`application.not_found`.' })
  async forApplication(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) applicationId: string,
  ): Promise<InterviewListDto> {
    const items = await this.interviews.listForApplication(
      user.id,
      user.activeRole,
      applicationId,
    );

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('interviews/:id/history')
  @ApiOperation({
    summary: 'BR-08’s trail for one interview',
    description:
      'Every status change with its time and actor role, readable by both sides — the ' +
      'same trail both are held to.',
  })
  @ApiOkResponse({ type: InterviewHistoryDto })
  async history(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InterviewHistoryDto> {
    // Participation is checked through the application the interview belongs to, which
    // is the only thing that decides who may read it.
    const interview = await this.interviews.byId(id);
    await this.interviews.listForApplication(
      user.id,
      user.activeRole,
      interview.applicationId,
    );

    const items = await this.interviews.history(id);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  private toDto(interview: Interview): InterviewDto {
    return {
      ...interview,
      scheduledAt: formatWithOffset(interview.scheduledAt, this.timeZone),
      respondedAt: interview.respondedAt
        ? formatWithOffset(interview.respondedAt, this.timeZone)
        : null,
      createdAt: formatWithOffset(interview.createdAt, this.timeZone),
      updatedAt: formatWithOffset(interview.updatedAt, this.timeZone),
    };
  }
}
