import {
  Body,
  Controller,
  Get,
  Headers,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import type { ApplicationStatus } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import type { Response } from 'express';
import { formatWithOffset } from '@infra/time/format';

import { type Application, ApplicationsService } from './applications.service';
import { CandidateViewService } from './candidate-view.service';
import {
  AddNoteDto,
  ApplicationCountsDto,
  ApplicationDto,
  ApplicationListDto,
  ApplicationNoteDto,
  ApplicationNoteListDto,
  ApplyDto,
  CandidateForEmployerDto,
  MoveStageDto,
  StageHistoryDto,
} from './dto/applications.dto';

/**
 * Applications, from both sides (§5.6, §6.5, §8.1).
 *
 * The candidate routes and the employer routes live in one controller because they are
 * one resource with one status machine; the role guards are per route, and each employer
 * route re-checks that the application belongs to a vacancy of theirs.
 */
@ApiTags('applications')
@ApiBearerAuth()
@Controller()
export class ApplicationsController {
  private readonly timeZone: string;

  constructor(
    private readonly applications: ApplicationsService,
    private readonly candidateView: CandidateViewService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- candidate -----------------------------------------------------------

  @Post('vacancies/:id/applications')
  @RequireRole('candidate')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. A retry with the same key and the same body returns the original ' +
      'application instead of failing (§12.4); a different body under the same key is a ' +
      '409. Separate from BR-07, which prevents the duplicate itself.',
  })
  @ApiOperation({
    summary: 'Apply to a vacancy (§5.6)',
    description:
      'BR-06, BR-07 and BR-08 are enforced in one transaction: the vacancy is read ' +
      '`FOR SHARE` so it cannot close underneath the insert, the partial unique index ' +
      'is what stops a concurrent double-tap, and the `submitted` history row is written ' +
      'with the application.',
  })
  @ApiOkResponse({ type: ApplicationDto })
  @ApiForbiddenResponse({
    description: '`candidate.profile_required` (BR-02).',
  })
  @ApiConflictResponse({
    description:
      '`application.already_applied` (BR-07) or `application.vacancy_closed` (BR-06, ' +
      'and BR-04/BR-11 — from the candidate’s side they are one fact).',
  })
  async apply(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) vacancyId: string,
    @Body() dto: ApplyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ApplicationDto> {
    const application = await this.applications.apply(
      user.id,
      vacancyId,
      dto.coverNote ?? null,
      idempotencyKey,
    );

    return this.toDto(application);
  }

  @Get('applications/mine')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'The caller’s applications and their stages (§5.6)',
  })
  @ApiOkResponse({ type: ApplicationListDto })
  async mine(@ActiveUser() user: CurrentUser): Promise<ApplicationListDto> {
    const items = await this.applications.listForCandidate(user.id);

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Post('applications/:id/withdraw')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'Withdraw an application (§5.6)',
    description:
      'Allowed up to an accepted offer, which `hired` being terminal expresses. Frees ' +
      'the BR-07 slot, so the candidate may apply again later.',
  })
  @ApiOkResponse({ type: ApplicationDto })
  @ApiConflictResponse({ description: '`application.final`.' })
  async withdraw(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationDto> {
    return this.toDto(await this.applications.withdraw(user.id, id));
  }

  // --- employer ------------------------------------------------------------

  @Get('vacancies/:id/applications')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Applications to one of the caller’s vacancies (§6.5)',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiOkResponse({ type: ApplicationListDto })
  @ApiNotFoundResponse({
    description: '`vacancy.not_found` — including another employer’s.',
  })
  async forVacancy(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) vacancyId: string,
    @Query('status') status?: ApplicationStatus,
  ): Promise<ApplicationListDto> {
    const items = await this.applications.listForVacancy(
      user.id,
      vacancyId,
      status,
    );

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('vacancies/:id/applications/counts')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Hires against the requirement, and a stage breakdown (§6.5)',
  })
  @ApiOkResponse({ type: ApplicationCountsDto })
  async counts(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) vacancyId: string,
  ): Promise<ApplicationCountsDto> {
    return this.applications.countsForVacancy(user.id, vacancyId);
  }

  @Put('applications/:id/stage')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Move an application through the stages (§8.1, §6.5)',
    description:
      'Forward moves may skip a stage — real hiring does — but never go backwards: a ' +
      'candidate told they were shortlisted and then returned to `viewed` has been told ' +
      'something false. `hired` increments the vacancy’s counter in the same ' +
      'transaction (§6.5).',
  })
  @ApiOkResponse({ type: ApplicationDto })
  @ApiConflictResponse({
    description: '`application.final` or `application.transition_not_allowed`.',
  })
  async moveStage(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveStageDto,
  ): Promise<ApplicationDto> {
    return this.toDto(
      await this.applications.moveStage(
        user.id,
        id,
        dto.status,
        dto.reason ?? null,
      ),
    );
  }

  @Get('applications/:id/candidate')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'The applicant, as much of them as BR-09 allows (§6.5)',
    description:
      'The candidate’s profile and "authorized CV". `phone` is present only where the ' +
      'candidate’s privacy settings **and** a hiring interaction both allow it, and ' +
      '`exposureReason` says which rule decided. Every call is logged (§11.1).',
  })
  @ApiOkResponse({ type: CandidateForEmployerDto })
  @ApiNotFoundResponse({ description: '`application.not_found`.' })
  async candidate(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CandidateForEmployerDto> {
    return this.candidateView.forApplication(user.id, id);
  }

  @Get('applications/:id/files/:fileId/content')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Download an applicant’s file (§6.5, §5.4)',
    description:
      '§6.5’s "authorized CV". BR-09 is re-evaluated on every download rather than ' +
      'trusted from the listing call, because a client may hold a path from a moment ' +
      'when the interaction still existed — so a candidate who withdraws stops the ' +
      'download working. Streamed through this API after the check; there is no storage ' +
      'URL to leak (§11.1). Every download is logged.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({
    description:
      '`file.not_found` — unknown, not this candidate’s, or BR-09 does not allow it. One ' +
      'code for all three: which it was is not information we owe.',
  })
  async downloadFile(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.candidateView.downloadForApplication(
      user.id,
      id,
      fileId,
    );

    this.streamFile(response, file, bytes);
  }

  @Get('unlocks/:candidateUserId/files/:fileId/content')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Download a file through a Candidate Unlock (§6.6, §11.1)',
    description:
      'The unlock’s counterpart to `/applications/:id/files/...`, and it exists for the ' +
      'same reason: a file’s `downloadPath` is scoped to whatever entitled the employer to ' +
      'it, so a third kind of entitlement needs a third route. Keyed on the **candidate**, ' +
      'because an unlock has no id of its own — the pair is its primary key (BR-16).\n\n' +
      '**Use the `downloadPath` the candidate view gave you rather than building this.** An ' +
      'employer who also holds an application is served through that instead, which is the ' +
      'stronger claim; both work, but only one is the path they were handed.\n\n' +
      'The entitlement is re-evaluated here, like the other two.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({
    description:
      '`file.not_found` — no unlock for this candidate, no such file, or not theirs. One ' +
      'code for all of them: which it was is not information we owe (§11.1).',
  })
  async downloadUnlockedFile(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.candidateView.downloadForUnlock(
      user.id,
      candidateUserId,
      fileId,
    );

    this.streamFile(response, file, bytes);
  }

  @Post('applications/:id/notes')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Add an internal note (§6.5)',
    description:
      '**Not visible to the candidate.** No candidate-facing read returns these.',
  })
  @ApiOkResponse({ type: ApplicationNoteDto })
  async addNote(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddNoteDto,
  ): Promise<ApplicationNoteDto> {
    const note = await this.applications.addNote(user.id, id, dto.note);

    return {
      ...note,
      createdAt: formatWithOffset(note.createdAt, this.timeZone),
    };
  }

  @Get('applications/:id/notes')
  @RequireRole('employer')
  @ApiOperation({ summary: 'Internal notes on an application (§6.5)' })
  @ApiOkResponse({ type: ApplicationNoteListDto })
  async listNotes(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplicationNoteListDto> {
    const items = await this.applications.listNotes(user.id, id);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  // --- both ----------------------------------------------------------------

  @Get('applications/:id/history')
  @ApiOperation({
    summary: 'BR-08’s stage history',
    description:
      'Every status change with its time and actor role. Readable by the candidate who ' +
      'applied and by the employer who owns the vacancy - the same trail both sides are ' +
      'held to.',
  })
  @ApiOkResponse({ type: StageHistoryDto })
  async history(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<StageHistoryDto> {
    await this.assertParticipant(user, id);

    const items = await this.applications.history(id);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  /**
   * Either side of this application, and nobody else.
   *
   * Checked here rather than by a role guard because the route serves both roles: the
   * guard cannot express "the candidate who applied **or** the employer who owns the
   * vacancy".
   */
  private async assertParticipant(
    user: CurrentUser,
    applicationId: string,
  ): Promise<void> {
    const application = await this.applications.byId(applicationId);

    if (user.activeRole === 'candidate') {
      if (application.candidateUserId !== user.id) {
        throw new NotFoundError('application.not_found');
      }

      return;
    }

    // Employer: reuse the ownership check that every other employer route uses.
    await this.applications.listForVacancy(user.id, application.vacancyId);
  }

  private toDto(application: Application): ApplicationDto {
    return {
      ...application,
      createdAt: formatWithOffset(application.createdAt, this.timeZone),
      updatedAt: formatWithOffset(application.updatedAt, this.timeZone),
    };
  }

  /**
   * The response for a candidate's file, whichever entitlement served it.
   *
   * Extracted when the unlock made this the third copy in the product - the threshold
   * CLAUDE.md names. `InvitationsController` keeps its own, because moving it there would
   * mean one controller importing another's helper for six header lines; if a fourth
   * entitlement ever appears, this belongs in `infra/files` instead.
   *
   * Two of the headers are the security-relevant ones and are easy to drop by accident:
   * `nosniff`, so an uploaded document cannot render as a page in the caller's origin, and
   * `no-store`, because these bytes are private to one entitlement and no intermediary may
   * keep them.
   */
  private streamFile(
    response: Response,
    file: { mimeType: string; fileName: string },
    bytes: Buffer,
  ): void {
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');

    response.end(bytes);
  }
}
