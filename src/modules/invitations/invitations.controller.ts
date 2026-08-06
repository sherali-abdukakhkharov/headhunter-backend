import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
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
import type { Response } from 'express';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { InvitationStatus } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';
import { CandidateViewService } from '@modules/applications/candidate-view.service';

import {
  CreateInvitationDto,
  InvitationCountsDto,
  InvitationDto,
  InvitationHistoryDto,
  InvitationListDto,
  RespondToInvitationDto,
} from './dto/invitations.dto';
import { type Invitation, InvitationsService } from './invitations.service';

/**
 * Direct employer invitations (§8.2).
 *
 * Both sides in one controller, as with applications: it is one resource with one status
 * machine, and the role guards are per route. The asymmetry is the whole of §8.2 - the
 * employer creates, the candidate answers - so `POST /invitations` is employer-only and
 * `POST /invitations/:id/respond` is candidate-only.
 */
@ApiTags('invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationsController {
  private readonly timeZone: string;

  constructor(
    private readonly invitations: InvitationsService,
    private readonly candidateView: CandidateViewService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- employer ------------------------------------------------------------

  @Post()
  @RequireRole('employer')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. A retry with the same key and the same body returns the original ' +
      'invitation instead of a conflict (§12.4) — which is what makes a lost response ' +
      'safe. A different body under the same key is a 409.',
  })
  @ApiOperation({
    summary: 'Invite a candidate to a vacancy, or generally (§8.2)',
    description:
      'Verified employers only (BR-03), and only a **search-visible** candidate — an ' +
      'employer cannot invite somebody they could not have found, which is BR-02’s gate ' +
      'again. A vacancy invitation needs an **active** vacancy, checked with the same ' +
      'definition of "open" the apply route uses (BR-06), so an invitation cannot ' +
      'advertise something that would refuse the application. One open invitation per ' +
      'candidate per vacancy; answering frees the slot.',
  })
  @ApiOkResponse({ type: InvitationDto })
  @ApiBadRequestResponse({
    description:
      '`invitation.shape_invalid` — exactly one of `vacancyId` and `occupationId`; ' +
      '`invitation.dictionary_item_invalid`.',
  })
  @ApiForbiddenResponse({
    description:
      '`employer.profile_incomplete` or `employer.not_verified` (BR-03).',
  })
  @ApiConflictResponse({
    description:
      '`invitation.already_invited` or `invitation.vacancy_not_open`.',
  })
  async invite(
    @ActiveUser() user: CurrentUser,
    @Body() dto: CreateInvitationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<InvitationDto> {
    return this.toDto(
      await this.invitations.invite(user.id, dto, idempotencyKey),
    );
  }

  @Get('sent')
  @RequireRole('employer')
  @ApiOperation({ summary: 'Invitations the caller has sent (§8.2)' })
  @ApiQuery({ name: 'vacancyId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiOkResponse({ type: InvitationListDto })
  async sent(
    @ActiveUser() user: CurrentUser,
    @Query('vacancyId') vacancyId?: string,
    @Query('status') status?: InvitationStatus,
  ): Promise<InvitationListDto> {
    const items = await this.invitations.listSent(user.id, {
      ...(vacancyId ? { vacancyId } : {}),
      ...(status ? { status } : {}),
    });

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get('counts/:vacancyId')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Invitations for one vacancy, by status (§7.4)',
    description:
      '§7.4 tracks "invited, accepted, interviewed and hired counts against the target". ' +
      'The first two are here; the last two are application stages and come from ' +
      '`/vacancies/{id}/applications/counts`.',
  })
  @ApiOkResponse({ type: InvitationCountsDto })
  @ApiNotFoundResponse({ description: '`vacancy.not_found`.' })
  async counts(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
  ): Promise<InvitationCountsDto> {
    return {
      byStatus: await this.invitations.countsForVacancy(user.id, vacancyId),
    };
  }

  @Get(':id/files/:fileId/content')
  @RequireRole('employer')
  @ApiOperation({
    summary: 'Download a file of a candidate who accepted (§8.2, BR-09)',
    description:
      'The invitation’s counterpart to the application-scoped download, and separate for ' +
      'the same reason: the entitlement comes from the interaction, so the route that ' +
      'serves the bytes has to be the one that can see it. BR-09 is re-evaluated per ' +
      'download rather than trusted from a path the client is holding. Every download is ' +
      'logged (§11.1).',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({
    description:
      '`file.not_found` — unknown, not this candidate’s, the invitation is not yours, or ' +
      'it has not been accepted. One code for all of them.',
  })
  async downloadFile(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.candidateView.downloadForInvitation(
      user.id,
      id,
      fileId,
    );

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

  // --- candidate -----------------------------------------------------------

  @Get('received')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'Invitations the caller has received (§8.2)',
    description:
      'Deliberately **not** filtered by the vacancy’s visibility: an invitation to a ' +
      'vacancy that has since closed still has to be readable, for the same reason a ' +
      'saved vacancy does — a candidate needs to see what became of something addressed ' +
      'to them.',
  })
  @ApiOkResponse({ type: InvitationListDto })
  async received(@ActiveUser() user: CurrentUser): Promise<InvitationListDto> {
    const items = await this.invitations.listReceived(user.id);

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Post(':id/respond')
  @RequireRole('candidate')
  @ApiOperation({
    summary: 'Accept, decline, or request details (§8.2)',
    description:
      'The candidate’s alone. `details_requested` is a question rather than an ending — ' +
      'accepting or declining afterwards is allowed, asking twice is not. Acceptance is ' +
      'what opens BR-09’s second interaction, so it reveals the contact details this ' +
      'employer was previously refused.',
  })
  @ApiOkResponse({ type: InvitationDto })
  @ApiNotFoundResponse({
    description: '`invitation.not_found` — including somebody else’s.',
  })
  @ApiConflictResponse({
    description: '`invitation.final` or `invitation.response_not_allowed`.',
  })
  async respond(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToInvitationDto,
  ): Promise<InvitationDto> {
    return this.toDto(
      await this.invitations.respond(user.id, id, dto.status, dto.note ?? null),
    );
  }

  // --- both ----------------------------------------------------------------

  @Get(':id')
  @ApiOperation({
    summary: 'One invitation, for either side of it',
  })
  @ApiOkResponse({ type: InvitationDto })
  @ApiNotFoundResponse({ description: '`invitation.not_found`.' })
  async byId(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationDto> {
    return this.toDto(
      await this.invitations.forParticipant(user.id, user.activeRole, id),
    );
  }

  @Get(':id/history')
  @ApiOperation({
    summary: 'BR-08’s trail for one invitation',
    description:
      'Every status change with its time and actor role, readable by both sides — the ' +
      'same trail both are held to.',
  })
  @ApiOkResponse({ type: InvitationHistoryDto })
  async history(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InvitationHistoryDto> {
    // Participation is checked first: the history of somebody else's invitation is not
    // readable, and a 404 says nothing about whether it exists.
    await this.invitations.forParticipant(user.id, user.activeRole, id);

    const items = await this.invitations.history(id);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  private toDto(invitation: Invitation): InvitationDto {
    return {
      ...invitation,
      respondedAt: invitation.respondedAt
        ? formatWithOffset(invitation.respondedAt, this.timeZone)
        : null,
      createdAt: formatWithOffset(invitation.createdAt, this.timeZone),
      updatedAt: formatWithOffset(invitation.updatedAt, this.timeZone),
    };
  }
}
