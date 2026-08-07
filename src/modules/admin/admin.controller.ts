import {
  Body,
  Controller,
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
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatDateOnly, formatWithOffset } from '@infra/time/format';

import { AuditService } from './audit.service';
import { DashboardService } from './dashboard.service';
import { DictionaryAdminService } from './dictionary-admin.service';
import {
  AdminPageDto,
  AdminUserDetailDto,
  AdminUserDto,
  AdminUserListDto,
  AuditLogDto,
  AuditQueryDto,
  ComplaintDetailDto,
  ComplaintListDto,
  ComplaintQueryDto,
  ComplaintReviewDto,
  CreateDictionaryItemDto,
  CreatedIdDto,
  DashboardDto,
  DashboardQueryDto,
  MergeDictionaryItemsDto,
  ModerationDecisionDto,
  ModerationQueueDto,
  SetActiveDto,
  UpdateDictionaryItemDto,
  UserSearchQueryDto,
  UserStatusDto,
  VacancyAdminStatusDto,
  VacancyReviewDto,
  VerificationDecisionDto,
  VerificationQueueDto,
  WarnUserDto,
} from './dto/admin.dto';
import { AdminModerationService } from './moderation.service';
import { type AdminUserRow, AdminUsersService } from './users-admin.service';

/**
 * §10's administration, as ordinary API routes behind a role.
 *
 * There is **no web panel** (§2.4, ARCHITECTURE.md §1): administration is a role inside
 * the mobile app, so these are normal endpoints with `@RequireRole('admin')` and nothing
 * else distinguishes them. One controller for the whole of §10 because it is one screen
 * group with one guard; the services behind it are split by the four sections.
 *
 * Every decision here writes an audit row (§10.4), and every read of protected data is
 * logged (§11.1).
 */
@ApiTags('admin')
@ApiBearerAuth()
@RequireRole('admin')
@Controller('admin')
export class AdminController {
  private readonly timeZone: string;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly moderation: AdminModerationService,
    private readonly users: AdminUsersService,
    private readonly dictionaries: DictionaryAdminService,
    private readonly audit: AuditService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  // --- §10.1 dashboard -----------------------------------------------------

  @Get('dashboard')
  @ApiOperation({
    summary: 'Administrator dashboard counters (§10.1)',
    description:
      'Totals and queue lengths in one request. The period counts are "newly registered" ' +
      'and "active vacancies and applications for the selected period"; a queue length is ' +
      'current state, because what matters about a queue is how long it is now. `to` is ' +
      'inclusive. Defaults to the last 30 days.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        period: { from: '2026-07-08', to: '2026-08-07' },
        candidates: { total: 1420, new: 96 },
        employers: { total: 260, new: 14 },
        awaitingVerification: 7,
        awaitingModeration: 3,
        activeVacancies: 88,
        applications: 412,
        openComplaints: 2,
        restrictedUsers: 1,
        blockedUsers: 4,
      },
    },
  })
  async counters(@Query() query: DashboardQueryDto): Promise<DashboardDto> {
    const today = formatDateOnly(new Date(), this.timeZone);
    const from = query.from ?? thirtyDaysBefore(today);

    return this.dashboard.counters(from, query.to ?? today);
  }

  // --- §10.2 employer verification -----------------------------------------

  @Get('verification')
  @ApiOperation({
    summary: 'Employers awaiting verification (§10.2)',
    description:
      'Oldest submission first — a queue that is not FIFO is a queue somebody waits in. ' +
      'Each item carries its evidence as paths on this API; there is no storage URL to ' +
      'hand out (ARCHITECTURE.md §9).',
  })
  async verificationQueue(
    @Query() page: AdminPageDto,
  ): Promise<VerificationQueueDto> {
    const items = await this.moderation.verificationQueue(
      page.limit ?? 20,
      page.offset ?? 0,
    );

    return {
      items: items.map((item) => ({
        ...item,
        submittedAt: formatWithOffset(item.submittedAt, this.timeZone),
      })),
    };
  }

  @Post('verification/:employerUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Approve, reject, or request changes (§10.2)',
    description:
      'M4 holds the transitions, the mandatory reason and the BR-08 history row; this ' +
      'route supplies the administrator and the audit entry. Approving is what makes BR-03 ' +
      'pass for that employer, so it unblocks their vacancies and invitations.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description: '`employer.verification_reason_required` for a non-approval.',
  })
  @ApiConflictResponse({
    description:
      '`employer.verification_not_pending` — somebody decided it already.',
  })
  async decideVerification(
    @ActiveUser() user: CurrentUser,
    @Param('employerUserId', ParseUUIDPipe) employerUserId: string,
    @Body() dto: VerificationDecisionDto,
  ): Promise<void> {
    await this.moderation.decideVerification(
      user.id,
      employerUserId,
      dto.decision,
      dto.reason ?? null,
    );
  }

  @Get('employers/:employerUserId/evidence/:fileId')
  @ApiOperation({
    summary: 'Download a piece of verification evidence (§10.2, §11.1)',
    description:
      'The file must belong to a submission of that employer: an administrator may read ' +
      'evidence, not any file whose id they can name. Every download is logged, because ' +
      '§11.1 requires access to protected data to be.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ description: '`file.not_found`.' })
  async evidence(
    @ActiveUser() user: CurrentUser,
    @Param('employerUserId', ParseUUIDPipe) employerUserId: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.moderation.downloadEvidence(
      user.id,
      employerUserId,
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

  // --- §10.2 vacancy moderation --------------------------------------------

  @Get('moderation')
  @ApiOperation({
    summary: 'Vacancies awaiting moderation (§10.2, BR-04)',
    description:
      'Oldest first, and each item says whether it carries a BR-12 age or gender ' +
      'restriction — §10.2 requires those to be reviewed, and a restricted vacancy cannot ' +
      'publish any other way.',
  })
  async moderationQueue(
    @Query() page: AdminPageDto,
  ): Promise<ModerationQueueDto> {
    const items = await this.moderation.moderationQueue(
      page.limit ?? 20,
      page.offset ?? 0,
    );

    return {
      items: items.map((item) => ({
        ...item,
        submittedAt: formatWithOffset(item.submittedAt, this.timeZone),
      })),
    };
  }

  @Get('moderation/:vacancyId')
  @ApiOperation({
    summary: 'The vacancy, its requirements and its restriction (§10.2)',
  })
  @ApiNotFoundResponse({ description: '`vacancy.not_found`.' })
  async vacancyForReview(
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
  ): Promise<VacancyReviewDto> {
    const aggregate = await this.moderation.vacancyForReview(vacancyId);

    return {
      vacancy: { ...aggregate.row },
      requirements: aggregate.requirements.map((requirement) => ({
        ...requirement,
      })),
    };
  }

  @Post('moderation/:vacancyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Approve or reject a vacancy (§10.2, BR-04, BR-12)',
    description:
      'M5 holds the transitions and the mandatory rejection reason. Approving a BR-12 ' +
      'restricted vacancy is the **only** way it can publish — that is the point of ' +
      'making review part of the rule rather than an optimisation.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: '`vacancy.not_under_moderation`.' })
  async moderateVacancy(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
    @Body() dto: ModerationDecisionDto,
  ): Promise<void> {
    await this.moderation.moderateVacancy(
      user.id,
      vacancyId,
      dto.decision,
      dto.reason ?? null,
    );
  }

  @Put('vacancies/:vacancyId/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Pause or remove a live vacancy (§10.2)',
    description:
      'For a vacancy that is already published — a complaint upheld, a policy breach. ' +
      'Same transition table and BR-08 history row as the employer’s own status change; ' +
      'only the actor and the missing ownership check differ.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: '`vacancy.transition_not_allowed`.' })
  async administrateVacancy(
    @ActiveUser() user: CurrentUser,
    @Param('vacancyId', ParseUUIDPipe) vacancyId: string,
    @Body() dto: VacancyAdminStatusDto,
  ): Promise<void> {
    await this.moderation.administrateVacancy(
      user.id,
      vacancyId,
      dto.status,
      dto.reason,
    );
  }

  // --- §10.2 complaints ----------------------------------------------------

  @Get('complaints')
  @ApiOperation({
    summary: 'Open complaints (§10.2)',
    description:
      'Over all four target kinds — users, vacancies, messages and profiles — from the one ' +
      'generic table M6 created, so there is one queue rather than four.',
  })
  async complaintQueue(
    @Query() query: ComplaintQueryDto,
  ): Promise<ComplaintListDto> {
    const items = await this.moderation.complaintQueue(
      query.targetType,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  @Get('complaints/:id')
  @ApiOperation({
    summary: 'One complaint, with enough of its target to judge it (§10.2)',
    description:
      'The target is resolved per kind — the message that was reported, the vacancy’s ' +
      'title, the person’s name and account state. Deliberately small: this is a review ' +
      'screen, and the full record is one link away.',
  })
  @ApiNotFoundResponse({ description: '`complaint.not_found`.' })
  async complaint(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ComplaintDetailDto> {
    const { complaint, target } = await this.moderation.complaint(id);

    return {
      complaint: {
        ...complaint,
        createdAt: formatWithOffset(complaint.createdAt, this.timeZone),
      },
      target,
    };
  }

  @Post('complaints/:id/review')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Resolve a complaint (§10.2)',
    description:
      'The resolution is mandatory, and the audit row is written **in the same ' +
      'transaction** — nothing else records a complaint review, so unlike a verification ' +
      'decision there is no BR-08 row standing behind it.',
  })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      '`complaint.not_open` — unknown, or somebody reviewed it first.',
  })
  async reviewComplaint(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ComplaintReviewDto,
  ): Promise<void> {
    await this.moderation.reviewComplaint(
      user.id,
      id,
      dto.outcome,
      dto.resolution,
    );
  }

  // --- §10.4 users ---------------------------------------------------------

  @Get('users')
  @ApiOperation({
    summary: 'Find users (§10.4)',
    description:
      'By partial phone, name, role, status or registration date. The name is matched ' +
      'against a candidate’s profile, an individual employer’s own name and a company’s ' +
      'public or legal name. Every search is logged (§11.1).',
  })
  async searchUsers(
    @ActiveUser() user: CurrentUser,
    @Query() query: UserSearchQueryDto,
  ): Promise<AdminUserListDto> {
    const items = await this.users.search(
      user.id,
      query,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return { items: items.map((item) => this.userDto(item)) };
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'One user, with their moderation history (§10.4)',
    description:
      'BR-08’s account status trail and the complaints filed about them — the two halves ' +
      'of §10.4’s "relevant moderation history".',
  })
  @ApiNotFoundResponse({ description: '`user.not_found`.' })
  async user(
    @ActiveUser() user: CurrentUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AdminUserDetailDto> {
    const detail = await this.users.detail(user.id, userId);

    return {
      ...this.userDto(detail),
      statusHistory: detail.statusHistory.map((entry) => ({
        ...entry,
        createdAt: formatWithOffset(entry.createdAt, this.timeZone),
      })),
      complaints: detail.complaints.map((entry) => ({
        ...entry,
        createdAt: formatWithOffset(entry.createdAt, this.timeZone),
      })),
    };
  }

  @Post('users/:userId/warn')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Warn a user (§10.4)',
    description:
      'Changes no account status: the audit row **is** the record, which is the clearest ' +
      'answer to why an audit log exists when six tables already record status changes. ' +
      'M9 adds the notification that tells them.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: '`admin.reason_required`.' })
  async warn(
    @ActiveUser() user: CurrentUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: WarnUserDto,
  ): Promise<void> {
    await this.users.warn(user.id, userId, dto.reason);
  }

  @Put('users/:userId/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Restrict, block or unblock a user (§10.4, UAT-14)',
    description:
      'A mandatory reason, an `account_status_history` row (BR-08) and an audit row, in ' +
      'one transaction. `restrictedUntil` makes a restriction temporary — BR-10’s guard ' +
      'lifts it when the date passes. An administrator cannot target themselves, because ' +
      'no route would undo it.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description: '`admin.reason_required` or `admin.cannot_target_self`.',
  })
  @ApiConflictResponse({
    description:
      '`admin.status_unchanged` — already in that state, or awaiting deletion, which ' +
      'BR-14 owns.',
  })
  async setUserStatus(
    @ActiveUser() user: CurrentUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UserStatusDto,
  ): Promise<void> {
    await this.users.changeStatus(
      user.id,
      userId,
      dto.status,
      dto.reason,
      dto.restrictedUntil ? new Date(dto.restrictedUntil) : null,
    );
  }

  // --- §10.3 dictionaries --------------------------------------------------

  @Post('dictionaries/:typeCode/items')
  @ApiOperation({
    summary: 'Create a dictionary item (§10.3)',
    description:
      'Inactive unless you say otherwise, because an item with no labels must not reach a ' +
      'picker. Activation is refused by the database while any of the four labels is ' +
      'missing (§3.2).',
  })
  @ApiOkResponse({ schema: { properties: { id: { type: 'string' } } } })
  @ApiConflictResponse({ description: '`dictionary.code_taken`.' })
  @ApiNotFoundResponse({ description: '`dictionary.type_not_found`.' })
  async createItem(
    @ActiveUser() user: CurrentUser,
    @Param('typeCode') typeCode: string,
    @Body() dto: CreateDictionaryItemDto,
  ): Promise<CreatedIdDto> {
    return {
      id: await this.dictionaries.create(user.id, typeCode, {
        code: dto.code,
        labels: dto.labels,
        category: dto.category ?? null,
        group: dto.group ?? null,
        rank: dto.rank ?? null,
        ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
        parentId: dto.parentId ?? null,
        ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
      }),
    };
  }

  @Put('dictionaries/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Edit an item’s metadata or labels (§10.3)',
    description:
      'Any subset. Every write bumps the global dictionary revision through a trigger, so ' +
      'clients learn of the change through the delta they already poll.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: '`dictionary.item_not_found`.' })
  async updateItem(
    @ActiveUser() user: CurrentUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateDictionaryItemDto,
  ): Promise<void> {
    await this.dictionaries.update(user.id, itemId, dto);
  }

  @Put('dictionaries/items/:itemId/active')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Activate or deactivate an item (§10.3)',
    description:
      'Deactivating keeps it resolvable for historical records — it only leaves the ' +
      'pickers. **Nothing is ever hard-deleted** (BR-13).',
  })
  @ApiNoContentResponse()
  @ApiUnprocessableEntityResponse({
    description:
      'Activation with a missing locale fails on the deferrable constraint that derives ' +
      'the required set from the `locale_code` enum.',
  })
  @ApiConflictResponse({ description: '`dictionary.state_unchanged`.' })
  async setItemActive(
    @ActiveUser() user: CurrentUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: SetActiveDto,
  ): Promise<void> {
    await this.dictionaries.setActive(user.id, itemId, dto.isActive);
  }

  @Post('dictionaries/items/:itemId/merge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Merge a duplicate into a survivor (§10.3)',
    description:
      'The item in the path loses: it is deactivated and points at the survivor, so every ' +
      'profile and vacancy that referenced it still resolves through ' +
      '`GET /dictionaries/items?ids=`. Nothing is rewritten — that would be a migration ' +
      'disguised as an edit — and both revisions bump, so one delta carries both sides.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description:
      '`dictionary.merge_into_itself` or `dictionary.merge_type_mismatch`.',
  })
  @ApiConflictResponse({ description: '`dictionary.survivor_already_merged`.' })
  async mergeItems(
    @ActiveUser() user: CurrentUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: MergeDictionaryItemsDto,
  ): Promise<void> {
    await this.dictionaries.merge(user.id, itemId, dto.survivorId);
  }

  // --- §10.4 audit ---------------------------------------------------------

  @Get('audit')
  @ApiOperation({
    summary: 'The audit log (§10.4)',
    description:
      '"Available to authorized administrators", newest first, filterable by actor or by ' +
      'target. **Append-only in the database**: three statement-level triggers refuse ' +
      '`UPDATE`, `DELETE` and `TRUNCATE`, so immutability is a property of the table ' +
      'rather than of this module having no write path.',
  })
  async auditLog(@Query() query: AuditQueryDto): Promise<AuditLogDto> {
    const items = await this.audit.list(
      query,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return {
      items: items.map((item) => ({
        ...item,
        reason: item.reason ?? null,
        details: item.details ?? null,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  private userDto(row: AdminUserRow): AdminUserDto {
    return {
      userId: row.userId,
      phone: row.phone,
      name: row.name,
      roles: row.roles,
      status: row.status,
      restrictedUntil: row.restrictedUntil
        ? formatWithOffset(row.restrictedUntil, this.timeZone)
        : null,
      createdAt: formatWithOffset(row.createdAt, this.timeZone),
      lastLoginAt: row.lastLoginAt
        ? formatWithOffset(row.lastLoginAt, this.timeZone)
        : null,
    };
  }
}

/** The dashboard's default window: a month back from today, in calendar dates. */
function thirtyDaysBefore(today: string): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 30);

  return date.toISOString().slice(0, 10);
}
