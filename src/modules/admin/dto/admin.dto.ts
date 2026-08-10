import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type {
  AccountStatus,
  ComplaintTarget,
  DictionaryCategory,
  LocaleCode,
  UserRole,
} from '@infra/db/database.types';
import { CATEGORIES } from '@modules/schemas/dto/schemas.dto';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROLES = ['candidate', 'employer', 'admin'] as const;
const STATUSES = [
  'active',
  'restricted',
  'blocked',
  'deletion_requested',
] as const;
const COMPLAINT_TARGETS = ['vacancy', 'user', 'profile', 'message'] as const;
const LOCALES = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'] as const;

/** Paging shared by every queue in §10. */
export class AdminPageDto {
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class DashboardQueryDto {
  @ApiPropertyOptional({
    description:
      'Start of §10.1’s "selected period", inclusive. Defaults to 30 days ago.',
    example: '2026-07-08',
  })
  @IsOptional()
  @Matches(DATE)
  from?: string;

  @ApiPropertyOptional({
    description: 'End of the period, **inclusive**. Defaults to today.',
    example: '2026-08-07',
  })
  @IsOptional()
  @Matches(DATE)
  to?: string;
}

export class VerificationDecisionDto {
  @ApiProperty({
    enum: ['verified', 'rejected', 'changes_required'],
    description: '§10.2’s three outcomes.',
  })
  @IsIn(['verified', 'rejected', 'changes_required'])
  decision!: 'verified' | 'rejected' | 'changes_required';

  @ApiPropertyOptional({
    description:
      '**Mandatory for anything but an approval** (§10.2, §6.1) — the employer has to know ' +
      'what to fix. `employer.verification_reason_required` otherwise.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason?: string;
}

export class ModerationDecisionDto {
  @ApiProperty({
    enum: ['active', 'rejected'],
    description:
      '§10.2’s approve or reject. Approving publishes it (BR-04), which for a BR-12 ' +
      'restricted vacancy is the only way it can ever publish.',
  })
  @IsIn(['active', 'rejected'])
  decision!: 'active' | 'rejected';

  @ApiPropertyOptional({
    description:
      '**Mandatory on rejection** — `vacancy.moderation_reason_required`.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason?: string;
}

export class VacancyAdminStatusDto {
  @ApiProperty({
    enum: ['paused', 'closed'],
    description: '§10.2’s "pause, or remove a vacancy with an audit record".',
  })
  @IsIn(['paused', 'closed'])
  status!: 'paused' | 'closed';

  @ApiProperty({
    description: 'Mandatory: the employer is owed an explanation.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}

export class ComplaintReviewDto {
  @ApiProperty({
    enum: ['actioned', 'dismissed'],
    description: 'Whether the complaint led to an action.',
  })
  @IsIn(['actioned', 'dismissed'])
  outcome!: 'actioned' | 'dismissed';

  @ApiProperty({
    description:
      'What was decided and why. Mandatory: a review with no resolution is a status ' +
      'change nobody can account for.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  resolution!: string;
}

export class ComplaintQueryDto extends AdminPageDto {
  @ApiPropertyOptional({
    enum: COMPLAINT_TARGETS,
    description:
      '§10.2 reviews reported users, vacancies, messages and profiles.',
  })
  @IsOptional()
  @IsIn(COMPLAINT_TARGETS)
  targetType?: ComplaintTarget;
}

export class UserSearchQueryDto extends AdminPageDto {
  @ApiPropertyOptional({ description: 'A partial phone number (§10.4).' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Matched against a candidate’s name, an individual employer’s own name and a ' +
      'company’s public or legal name — an administrator should not have to know which ' +
      'kind of account it is.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  role?: UserRole;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES)
  status?: AccountStatus;

  @ApiPropertyOptional({ example: '2026-01-01' })
  @IsOptional()
  @Matches(DATE)
  registeredFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-07' })
  @IsOptional()
  @Matches(DATE)
  registeredTo?: string;
}

export class WarnUserDto {
  @ApiProperty({
    description:
      'Mandatory (§10.4). A warning changes no account status, so this reason and the ' +
      'audit row are the entire record of it.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}

export class UserStatusDto {
  @ApiProperty({
    enum: ['active', 'restricted', 'blocked'],
    description:
      '§10.4’s restrict, block and unblock (`active`). A blocked account is refused every ' +
      'mutation by BR-10’s guard, and so is a restricted one.',
  })
  @IsIn(['active', 'restricted', 'blocked'])
  status!: 'active' | 'restricted' | 'blocked';

  @ApiProperty({ description: 'Mandatory for all three (§10.4).' })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;

  @ApiPropertyOptional({
    description:
      'What makes §10.4’s restriction *temporary*: the guard lifts it once this passes, ' +
      'writing the BR-08 history row for the change. Ignored for the other two statuses.',
    example: '2026-09-01T00:00:00+05:00',
  })
  @IsOptional()
  @IsISO8601()
  restrictedUntil?: string;
}

export class DictionaryLabelsDto {
  @ApiProperty({
    description:
      'All four interface variants, keyed by locale. The database refuses to **activate** ' +
      'an item missing any of them (§3.2), so a partial set is only useful on a draft.',
    example: {
      'uz-Latn': 'Payvandchi',
      'uz-Cyrl': 'Пайвандчи',
      ru: 'Сварщик',
      en: 'Welder',
    },
  })
  @IsObject()
  labels!: Partial<Record<LocaleCode, string>>;
}

export class CreateDictionaryItemDto extends DictionaryLabelsDto {
  @ApiProperty({
    description:
      'Stable code, unique within the type. Never shown to a user (BR-13).',
    example: 'welder',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'code must be lowercase letters, digits and underscores',
  })
  code!: string;

  @ApiPropertyOptional({
    enum: CATEGORIES,
    description: '§10.3’s "assign category" — occupations and work types only.',
  })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: DictionaryCategory;

  @ApiPropertyOptional({
    description: 'Second grouping: attribute groups, skill families.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  group?: string;

  @ApiPropertyOptional({
    description: 'Ordered scales only, and uniform per type.',
  })
  @IsOptional()
  @IsInt()
  rank?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'A district’s region (§10.3’s regions row).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Inactive by default: a new item with no labels must not appear in a picker. ' +
      'Activate it once the four labels are in.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateDictionaryItemDto {
  @ApiPropertyOptional({ enum: CATEGORIES })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: DictionaryCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  group?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  rank?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    description:
      'Any subset of the four labels; the others are left as they are.',
  })
  @IsOptional()
  @IsObject()
  labels?: Partial<Record<LocaleCode, string>>;
}

export class SetActiveDto {
  @ApiProperty({
    description:
      'Activation fails with a constraint error if any of the four labels is missing — ' +
      'that rule is a deferrable trigger, so it holds against every write path (§3.2).',
  })
  @IsBoolean()
  isActive!: boolean;
}

export class MergeDictionaryItemsDto {
  @ApiProperty({
    description:
      'The item that survives. The one in the path is deactivated and points at it through ' +
      '`merged_into_id`, so historical references still resolve (§10.3, BR-13).',
  })
  @IsUUID()
  survivorId!: string;
}

export class AuditQueryDto extends AdminPageDto {
  @ApiPropertyOptional({
    description: '"What has this administrator done" (§10.4).',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({
    enum: ['user', 'employer', 'vacancy', 'complaint', 'dictionary_item'],
    description:
      '"What was done to this thing" — the other question asked of the log.',
  })
  @IsOptional()
  @IsIn(['user', 'employer', 'vacancy', 'complaint', 'dictionary_item'])
  targetType?:
    | 'user'
    | 'employer'
    | 'vacancy'
    | 'complaint'
    | 'dictionary_item';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetId?: string;
}

// --- responses -------------------------------------------------------------
// Typed like every other response in this product (CLAUDE.md): the Swagger document is
// the contract the Flutter client is written against, and an admin screen is no less a
// client screen for being behind a role.

class CountPairDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'Registered inside the selected period.' })
  new!: number;
}

class PeriodDto {
  @ApiProperty({ example: '2026-07-08' }) from!: string;
  @ApiProperty({ example: '2026-08-07', description: 'Inclusive.' })
  to!: string;
}

export class DashboardDto {
  @ApiProperty({ type: PeriodDto }) period!: PeriodDto;
  @ApiProperty({ type: CountPairDto }) candidates!: CountPairDto;
  @ApiProperty({ type: CountPairDto }) employers!: CountPairDto;

  @ApiProperty({
    description: '§10.1: profiles awaiting verification. Current state.',
  })
  awaitingVerification!: number;

  @ApiProperty({ description: 'Vacancies awaiting moderation. Current state.' })
  awaitingModeration!: number;

  @ApiProperty({ description: 'Published inside the period.' })
  activeVacancies!: number;
  @ApiProperty({ description: 'Submitted inside the period.' })
  applications!: number;
  @ApiProperty() openComplaints!: number;
  @ApiProperty() restrictedUsers!: number;
  @ApiProperty() blockedUsers!: number;
}

export class EvidenceFileDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: '`file_purpose` code.' }) purposeCode!: string;
  @ApiProperty() fileName!: string;

  @ApiProperty({
    description:
      'Where to fetch it on this API. Never a storage URL (ARCHITECTURE.md §9).',
  })
  path!: string;
}

export class VerificationQueueItemDto {
  @ApiProperty() employerUserId!: string;
  @ApiProperty({
    description:
      '`company` or `individual` — §6.1 gives them different fields.',
  })
  type!: string;
  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiPropertyOptional({ nullable: true }) legalName!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ type: [EvidenceFileDto] }) files!: EvidenceFileDto[];
}

export class VerificationQueueDto {
  @ApiProperty({ type: [VerificationQueueItemDto] })
  items!: VerificationQueueItemDto[];
}

export class RestrictionDto {
  @ApiPropertyOptional({ nullable: true }) ageMin!: number | null;
  @ApiPropertyOptional({ nullable: true }) ageMax!: number | null;
  @ApiPropertyOptional({ nullable: true }) genderId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The BR-12 reason the employer chose, from the enumerated list.',
  })
  justificationId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Their elaboration, if any.',
  })
  justificationNote!: string | null;
}

export class ModerationQueueItemDto {
  @ApiProperty() vacancyId!: string;
  @ApiProperty() employerUserId!: string;
  @ApiPropertyOptional({ nullable: true }) employerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) title!: string | null;
  @ApiProperty() submittedAt!: string;

  @ApiPropertyOptional({
    type: RestrictionDto,
    nullable: true,
    description:
      'Present when the vacancy carries a BR-12 age or gender restriction — which §10.2 ' +
      'requires to be reviewed, and which is why it cannot publish without this queue.',
  })
  restriction!: RestrictionDto | null;
}

export class ModerationQueueDto {
  @ApiProperty({ type: [ModerationQueueItemDto] })
  items!: ModerationQueueItemDto[];
}

export class VacancyReviewDto {
  @ApiProperty({
    description: 'The vacancy row as stored, for review (§10.2).',
  })
  vacancy!: Record<string, unknown>;

  @ApiProperty({
    description: 'Its structured requirements, keyed by schema field code.',
  })
  requirements!: Record<string, unknown>[];
}

export class ComplaintDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: COMPLAINT_TARGETS }) targetType!: ComplaintTarget;
  @ApiProperty() targetId!: string;
  @ApiProperty() reporterUserId!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['open', 'actioned', 'dismissed'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) resolution!: string | null;
  @ApiProperty() createdAt!: string;
}

export class ComplaintListDto {
  @ApiProperty({ type: [ComplaintDto] })
  items!: ComplaintDto[];
}

export class ComplaintDetailDto {
  @ApiProperty({ type: ComplaintDto }) complaint!: ComplaintDto;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Enough of the reported thing to judge it, resolved per kind: the message body, the ' +
      'vacancy’s title and status, or the person’s name and account state. Null if it is ' +
      'gone — a complaint outlives its target on purpose.',
  })
  target!: Record<string, unknown> | null;
}

export class AdminUserDto {
  @ApiProperty() userId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Visible to an administrator, which is BR-09’s `admin` branch rather than an ' +
      'exception to it (§10.4 searches by phone). Every read is logged (§11.1).',
  })
  phone!: string | null;

  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiProperty({ enum: ROLES, isArray: true }) roles!: UserRole[];
  @ApiProperty({ enum: STATUSES }) status!: AccountStatus;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When a restriction ends. BR-10’s guard lifts it once this passes.',
  })
  restrictedUntil!: string | null;

  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ nullable: true }) lastLoginAt!: string | null;
}

export class AdminUserListDto {
  @ApiProperty({ type: [AdminUserDto] })
  items!: AdminUserDto[];
}

export class StatusHistoryEntryDto {
  @ApiPropertyOptional({ enum: STATUSES, nullable: true })
  fromStatus!: AccountStatus | null;
  @ApiProperty({ enum: STATUSES }) toStatus!: AccountStatus;
  @ApiPropertyOptional({ enum: ROLES, nullable: true })
  actorRole!: UserRole | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;
  @ApiProperty() createdAt!: string;
}

export class UserComplaintDto {
  @ApiProperty() id!: string;
  @ApiProperty() reason!: string;
  @ApiProperty() status!: string;
  @ApiProperty() createdAt!: string;
}

export class AdminUserDetailDto extends AdminUserDto {
  @ApiProperty({
    type: [StatusHistoryEntryDto],
    description:
      'BR-08’s account trail — half of §10.4’s "relevant moderation history".',
  })
  statusHistory!: StatusHistoryEntryDto[];

  @ApiProperty({
    type: [UserComplaintDto],
    description: 'Complaints filed about this user — the other half.',
  })
  complaints!: UserComplaintDto[];
}

export class AuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() actorUserId!: string;

  @ApiProperty({
    description:
      'A dotted code from one exported constant, e.g. `user.blocked`, ' +
      '`vacancy.moderated`, `dictionary.items_merged`.',
  })
  action!: string;

  @ApiProperty({
    enum: ['user', 'employer', 'vacancy', 'complaint', 'dictionary_item'],
  })
  targetType!: string;

  @ApiPropertyOptional({ nullable: true }) targetId!: string | null;
  @ApiPropertyOptional({ nullable: true }) reason!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What changed, when the reason is not enough on its own. Small by intent.',
  })
  details!: Record<string, unknown> | null;

  @ApiProperty() createdAt!: string;
}

export class AuditLogDto {
  @ApiProperty({ type: [AuditEntryDto] })
  items!: AuditEntryDto[];
}

// --- BR-14 retention (§4.2) -------------------------------------------------

export class RetentionRuleDto {
  @ApiProperty({ description: 'Stable code, also used by the purge.' })
  code!: string;

  @ApiProperty() subject!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Days after the trigger. `null` means the data is kept indefinitely.',
  })
  days!: number | null;

  @ApiProperty() trigger!: string;

  @ApiProperty({ enum: ['purge', 'anonymize', 'keep'] })
  action!: string;

  @ApiProperty({
    enum: ['provisional', 'client_approved', 'required'],
    description:
      '**`provisional` means no lawyer has seen this number.** BR-14 defers to an ' +
      'approved privacy policy that does not exist yet, so the platform states its ' +
      'assumption here rather than hiding it in a document.',
  })
  provenance!: string;

  @ApiProperty({
    description: 'Why the period cannot be zero, or must be finite.',
  })
  legalBasis!: string;
}

export class RetentionPolicyDto {
  @ApiProperty({ type: [RetentionRuleDto] })
  rules!: RetentionRuleDto[];

  @ApiProperty({
    description:
      'Codes whose period is still an engineering default, not a client answer.',
  })
  provisional!: string[];
}

export class DueAccountDto {
  @ApiProperty() userId!: string;
  @ApiProperty() requestedAt!: string;

  @ApiProperty({
    enum: ['purge', 'anonymize'],
    description:
      '`anonymize` when the account is the actor on an audit row: §10.4 will not let ' +
      'that row lose who acted, so the person is erased and the actor id survives.',
  })
  action!: string;

  @ApiProperty({ description: 'Audit rows depending on this id surviving.' })
  auditRows!: number;
}

export class TransientCountDto {
  @ApiProperty() code!: string;
  @ApiProperty() rows!: number;
}

export class RetentionDueDto {
  @ApiProperty({ type: [DueAccountDto] })
  accounts!: DueAccountDto[];

  @ApiProperty({ type: [TransientCountDto] })
  transient!: TransientCountDto[];

  @ApiProperty() provisional!: string[];
}

export class PurgeFailureDto {
  @ApiProperty() userId!: string;
  @ApiProperty() error!: string;
}

export class RetentionOutcomeDto {
  @ApiProperty({ description: 'Accounts deleted outright.' })
  purged!: string[];

  @ApiProperty({
    description: 'Accounts whose identity was erased, id retained.',
  })
  anonymized!: string[];

  @ApiProperty({
    type: [PurgeFailureDto],
    description:
      'Reported rather than thrown: one account that cannot be purged must not roll ' +
      'back the others.',
  })
  failed!: PurgeFailureDto[];

  @ApiProperty({ type: [TransientCountDto] })
  transient!: TransientCountDto[];
}

export class CreatedIdDto {
  @ApiProperty()
  id!: string;
}

export { LOCALES };
