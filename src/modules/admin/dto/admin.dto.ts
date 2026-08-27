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
  PaymentOrderStatus,
  PaymentProvider,
  UserRole,
} from '@infra/db/database.types';
import { PaymentOrderDto } from '@modules/payments/dto/payment.dto';
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
const PAYMENT_PROVIDERS = ['click', 'payme'] as const;
const PAYMENT_STATUSES = [
  'created',
  'pending',
  'paid',
  'failed',
  'cancelled',
  'reversed',
] as const;
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

/**
 * §10.4's search filters. Every one is optional; several combine with AND.
 *
 * Results are ordered **newest registration first** and paged with `limit`/`offset`, so a
 * filter narrow enough to matter beats a large page: an old account matching a broad filter
 * sits past the page rather than outside it.
 */
export class UserSearchQueryDto extends AdminPageDto {
  @ApiPropertyOptional({
    description:
      'A partial phone number (§10.4) — a **substring**, not a prefix, because a number is ' +
      'remembered by its last digits. At least 3 characters.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description:
      'A case-insensitive **substring**, at least 2 characters, matched against every ' +
      'place a user can have a name: a candidate’s profile name, an individual employer’s ' +
      'own name, a company’s public name, a company’s legal name, and the account’s own ' +
      '`full_name` — which in practice only seeded administrators have, and which is what ' +
      'lets an administrator find a colleague. An administrator should not have to know ' +
      'which kind of account it is. One match in any of the five returns the row, and the ' +
      '`name` in the response is resolved by the same order of preference.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    enum: ROLES,
    description:
      'A user who **holds** this role, not a user whose only role it is — a user may hold ' +
      'several (§2.3), and a candidate who also employs is matched by either.',
  })
  @IsOptional()
  @IsIn(ROLES)
  role?: UserRole;

  @ApiPropertyOptional({ enum: STATUSES, description: 'Exact match.' })
  @IsOptional()
  @IsIn(STATUSES)
  status?: AccountStatus;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description:
      '**Inclusive**, and a calendar date in the platform zone (`Asia/Tashkent`, §8.3) — ' +
      'so an account registered at 02:00 on this date is included. Not resolved in UTC: ' +
      'that would start the day at 05:00 local and file the small hours under the day ' +
      'before.',
  })
  @IsOptional()
  @Matches(DATE)
  registeredFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-07',
    description:
      '**Inclusive**, same zone — the whole of this date counts, so `registeredFrom` and ' +
      '`registeredTo` set to the same day means that one day.',
  })
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
    description:
      'The vacancy row as stored, plus the three keys that identify its employer. ' +
      '`employer_name` is a company’s public name, else the individual’s own — the same ' +
      'resolution the moderation queue shows. `employer_phone` is the account number, ' +
      'which is also §10.4’s search key. `employer_contact_phone` is the number the ' +
      'employer published for their company; it is a different field and may be a ' +
      'different number, and §6.1 makes it mandatory for a complete profile, so a vacancy ' +
      'that reached review has one. §10.2 lists contact information among what a moderator ' +
      'reviews, and the row alone carries only an `employer_user_id`. **There is no e-mail ' +
      'address:** this product has no such column anywhere — login is phone + OTP (§4.1). ' +
      'Timestamps carry §2’s explicit offset like every other response.',
  })
  vacancy!: Record<string, unknown>;

  @ApiProperty({
    description: 'Its structured requirements, keyed by schema field code.',
  })
  requirements!: Record<string, unknown>[];
}

/**
 * §10.5's Payment Order search.
 *
 * The six axes the section names — employer, provider, status, date, internal
 * order id, provider transaction id — all optional and all ANDed: a search
 * screen narrows rather than choosing between axes.
 */
export class AdminPaymentSearchDto extends AdminPageDto {
  @ApiPropertyOptional({ description: 'Whose orders to show.' })
  @IsOptional()
  @IsUUID()
  employerUserId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_PROVIDERS })
  @IsOptional()
  @IsIn(PAYMENT_PROVIDERS)
  provider?: PaymentProvider;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES)
  status?: PaymentOrderStatus;

  @ApiPropertyOptional({
    description:
      'Created on or after this calendar date in the platform zone, inclusive. A ' +
      'date rather than an instant: an administrator searching "the 5th" means the ' +
      'day as it was lived here, not a UTC window that starts at 05:00 the day before.',
    example: '2026-08-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({
    description: 'Created on or before this calendar date, inclusive.',
    example: '2026-08-31',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    description:
      'The internal Payment Order id, exactly. This is what a support request quotes.',
  })
  @IsOptional()
  @IsUUID()
  orderId?: string;

  @ApiPropertyOptional({
    description:
      'The provider’s own transaction id, exactly — not a prefix. It is quoted from a ' +
      'provider dashboard or a support ticket, so a partial match would answer a ' +
      'question nobody asked.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  providerTransactionId?: string;
}

export class AdminPaymentListDto {
  @ApiProperty({ type: [PaymentOrderDto], description: 'Newest first.' })
  items!: PaymentOrderDto[];
}

export class ComplaintDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: COMPLAINT_TARGETS }) targetType!: ComplaintTarget;
  @ApiProperty() targetId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What the reported thing **is**, in one line, so a queue of similar reports can ' +
      'be told apart without opening each row (MT-017). A vacancy’s title, a person’s ' +
      'name, and for a message **the sender’s name — not the body**: a reported message ' +
      'is private conversation content, and a detail screen showing it after a ' +
      'deliberate open is a different thing from a list showing twenty at once.\n\n' +
      'Null when the target has been deleted, which a complaint is meant to outlive. ' +
      'There is deliberately no separate `targetRef`: a short reference is `targetId` ' +
      'truncated, so it is formatting and belongs on the client rather than being a ' +
      'second field that can disagree with the first.',
  })
  targetSummary!: string | null;

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
      'gone — a complaint outlives its target on purpose. Its keys are columns, so they ' +
      'are snake_case; its timestamps carry §2’s explicit offset.',
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

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The actor’s display name, resolved here so a client does not fetch one account ' +
      'per row to get it — a fetch that returns a phone number, a status history and a ' +
      'complaint list for a string, and writes a §11.1 access log line every time. Null ' +
      'only for an administrator with no name anywhere, which a seeded account can be; ' +
      'the uuid is always present.',
  })
  actorName!: string | null;

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

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The target’s display name, and **only when `targetType` is `user`** — the other ' +
      'four target types are not accounts, so there is nothing to resolve. That is not a ' +
      'gap to fill later with a union over four more tables: a vacancy’s title and a ' +
      'dictionary item’s label are already in `details`, put there by the action that ' +
      'touched them.',
  })
  targetName!: string | null;

  @ApiPropertyOptional({ nullable: true }) reason!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What changed, when the reason is not enough on its own. Small by intent. ' +
      '**An opaque key/value bag — render it as text, do not parse the values.** The keys ' +
      'differ per `action` and are not enumerated anywhere, because this is a trail rather ' +
      'than a typed payload; a schema cannot express it and a client that guesses at one ' +
      'will be wrong for the next action added. Any timestamp inside carries §2’s explicit ' +
      'offset, formatted where it is written — a `jsonb` bag admits no read-side fix, ' +
      'since nothing downstream can tell a timestamp from any other string.',
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
      '`anonymize` when some record has to outlive the person, and there are two such ' +
      'records. §10.4 will not let an audit row lose who acted, and §6.7 keeps payment ' +
      'records for reconciliation while BR-24 forbids rewriting the ledger — so in either ' +
      'case the person is erased and the id survives.\n\n' +
      '**The decision is made on what the database refuses, not on how much history there ' +
      'is**: holding a wallet at all is enough, even with an empty ledger.',
  })
  action!: string;

  @ApiProperty({ description: 'Audit rows depending on this id surviving.' })
  auditRows!: number;

  @ApiProperty({
    description:
      'Wallet ledger rows that will be kept (BR-24). Zero with `anonymize` is normal: an ' +
      'employer can hold a wallet with no transactions in it.',
  })
  walletRows!: number;

  @ApiProperty({
    description: 'Payment Orders that will be kept for reconciliation (§6.7).',
  })
  paymentOrders!: number;
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

export class PricingValuesDto {
  @ApiProperty({ example: 1000, description: 'What one Coin costs, in so’m.' })
  coinPriceUzs!: number;

  @ApiProperty({
    example: 2,
    description: 'What a Candidate Unlock costs, in Coins (§6.6, BR-16).',
  })
  candidateUnlockCoins!: number;

  @ApiProperty({
    example: 10,
    description: 'Coins a new employer is granted once (§6.6, BR-15).',
  })
  registrationBonusCoins!: number;
}

export class AdminPricingDto {
  @ApiProperty({ type: PricingValuesDto })
  current!: PricingValuesDto;

  @ApiProperty({
    type: PricingValuesDto,
    description:
      'What this deployment declared in its environment. Shown so the screen can ' +
      'say what resetting a setting would give, and so an administrator can see ' +
      'which numbers have been changed from the default at all.',
  })
  declared!: PricingValuesDto;
}

/**
 * §10.5's pricing edit. Every field optional **on purpose**: only what is sent is
 * written, so a form that submits all three does not record three changes when
 * somebody edited one.
 */
export class UpdatePricingDto {
  @ApiPropertyOptional({ example: 1200, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  coinPriceUzs?: number;

  @ApiPropertyOptional({
    example: 3,
    minimum: 1,
    description:
      'At least one: a free unlock makes BR-16’s entitlement meaningless, which ' +
      'is the whole reason §6.6 charges for it.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  candidateUnlockCoins?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  registrationBonusCoins?: number;

  @ApiPropertyOptional({
    description:
      'Optional, unlike a wallet adjustment’s. A price change records its own ' +
      'from → to, which a balance adjustment cannot; a mandatory field people ' +
      'fill with a full stop is worse than none.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
