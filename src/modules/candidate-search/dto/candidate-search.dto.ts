import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import type { DictionaryCategory } from '@infra/db/database.types';
// The four statuses declared once, the same way `CATEGORIES` is: a second copy here would
// be a list that can disagree with `POST /invitations` about what it can answer.
import { INVITATION_STATUSES } from '@modules/invitations/dto/invitations.dto';
import { CATEGORIES } from '@modules/schemas/dto/schemas.dto';

import type { CandidateSearchSort } from '../search-filters';

export const SORTS = [
  'match',
  'recent',
  'experience',
  'salary',
  'proximity',
] as const;
const MATCH_MODES = ['all', 'any'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class LanguageFilterDto {
  @ApiProperty({ description: '`language` dictionary id.' })
  @IsUUID()
  itemId!: string;

  @ApiPropertyOptional({
    description:
      'The rank of the lowest acceptable `language_level`. A rank rather than an id ' +
      'because §7.1 asks for a floor, and a floor is a comparison.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  minLevelRank?: number;

  @ApiPropertyOptional({ description: '§7.1’s "certificate availability".' })
  @IsOptional()
  @IsBoolean()
  requireCertificate?: boolean;
}

/**
 * §7.1's eleven filter groups.
 *
 * Sent as a body rather than a query string, and the whole request is a `POST`: the
 * language filter is a nested array of objects, and encoding that into query parameters
 * would trade a documented DTO for hand-rolled parsing on both sides. The call is a read
 * with no side effects; the method is about the shape of the request, not its meaning.
 */
export class CandidateSearchFiltersDto {
  // --- occupation and category -------------------------------------------
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  occupationIds?: string[];

  @ApiPropertyOptional({
    description: 'Match the candidate’s primary occupation only.',
  })
  @IsOptional()
  @IsBoolean()
  primaryOnly?: boolean;

  @ApiPropertyOptional({ enum: CATEGORIES })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: DictionaryCategory;

  @ApiPropertyOptional({
    type: [String],
    description: '§7.1’s "professional level where applicable".',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  occupationLevelIds?: string[];

  // --- skills -------------------------------------------------------------
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  skillIds?: string[];

  @ApiPropertyOptional({
    enum: MATCH_MODES,
    default: 'any',
    description:
      '§7.1’s "match all or match any". `any` by default: a vacancy naming eight skills ' +
      'would otherwise match nobody, and §7.2’s count tells you before you open the list.',
  })
  @IsOptional()
  @IsIn(MATCH_MODES)
  skillsMatchMode?: 'all' | 'any';

  @ApiPropertyOptional({
    description: '§7.1’s "proficiency", as a rank floor.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  skillMinLevelRank?: number;

  // --- experience ---------------------------------------------------------
  @ApiPropertyOptional({ description: 'Total years of work history.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(70)
  experienceYearsMin?: number;

  @ApiPropertyOptional({
    description:
      'Years in the occupations named by `occupationIds`, which this filter therefore ' +
      'requires — `search.occupation_required` without them.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(70)
  occupationExperienceYearsMin?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      '§7.1’s "current/last role", as the occupation of the current job.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  currentOccupationIds?: string[];

  // --- languages ----------------------------------------------------------
  @ApiPropertyOptional({ type: [LanguageFilterDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LanguageFilterDto)
  languages?: LanguageFilterDto[];

  // --- education ----------------------------------------------------------
  @ApiPropertyOptional({
    type: [String],
    description:
      'Acceptable `education_level` ids. A set rather than a floor: the education row ' +
      'stores no rank, and §7.1 asks for the level rather than a minimum.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  educationLevelIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      '§7.1’s "specialization where relevant", as `specialization` dictionary ids — any ' +
      'of them matches. Ids and not text, because a substring match on prose cannot ' +
      'behave identically in four interface variants (§3.3, BR-13).',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  specializationIds?: string[];

  // --- location -----------------------------------------------------------
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  districtIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  willingToRelocate?: boolean;

  @ApiPropertyOptional({
    description:
      '§7.1’s travel readiness. Remote-work readiness is **not** here: it is a ' +
      '`work_format` id, so it belongs in `workFormatIds` where every selectable value ' +
      'lives (BR-13).',
  })
  @IsOptional()
  @IsBoolean()
  willingToTravel?: boolean;

  @ApiPropertyOptional({
    description:
      'Where to be near, for `sort: "proximity"` — a district id. Separate from ' +
      '`districtIds` on purpose: filtering by district excludes everyone else, leaving a ' +
      'proximity sort nothing to order. Prefilled from the vacancy’s district (UAT-06).',
  })
  @IsOptional()
  @IsUUID()
  proximityDistrictId?: string;

  // --- work preferences ---------------------------------------------------
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  employmentTypeIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  workFormatIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  shiftIds?: string[];

  @ApiPropertyOptional({
    description:
      'The employer’s ceiling: a candidate expecting more is filtered out. A candidate ' +
      'whose expectation is negotiable passes, for the same reason a negotiable vacancy ' +
      'passes a candidate’s salary floor.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salaryMax?: number;

  @ApiPropertyOptional({ description: 'The floor of the employer’s range.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salaryMin?: number;

  // --- availability -------------------------------------------------------
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @Matches(DATE)
  availableBy?: string;

  @ApiPropertyOptional({
    description:
      '§7.1’s "immediately" — the same test against today in Asia/Tashkent.',
  })
  @IsOptional()
  @IsBoolean()
  availableImmediately?: boolean;

  // --- physical / seasonal attributes -------------------------------------
  @ApiPropertyOptional({
    type: [String],
    description:
      'Licence, transport, tool and readiness ids — one `attribute` type.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  attributeIds?: string[];

  @ApiPropertyOptional({ enum: MATCH_MODES, default: 'any' })
  @IsOptional()
  @IsIn(MATCH_MODES)
  attributesMatchMode?: 'all' | 'any';

  @ApiPropertyOptional({
    description: 'Candidates who can bring a crew of at least n.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  crewSizeMin?: number;

  // --- profile status -----------------------------------------------------
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  minCompleteness?: number;

  @ApiPropertyOptional({
    example: '2026-07-01',
    description:
      '§7.1’s "recently updated", against `last_meaningful_update_at`.',
  })
  @IsOptional()
  @Matches(DATE)
  updatedSince?: string;

  // --- conditional filters (BR-12) ---------------------------------------
  @ApiPropertyOptional({
    description:
      'BR-12. Permitted only with `restrictionJustificationId`; every use is logged.',
  })
  @IsOptional()
  @IsInt()
  @Min(14)
  @Max(99)
  ageMin?: number;

  @ApiPropertyOptional({ description: 'BR-12. See `ageMin`.' })
  @IsOptional()
  @IsInt()
  @Min(14)
  @Max(99)
  ageMax?: number;

  @ApiPropertyOptional({ description: 'BR-12. `gender` dictionary id.' })
  @IsOptional()
  @IsUUID()
  genderId?: string;

  @ApiPropertyOptional({
    description:
      'A `restriction_justification` id, required as soon as an age or gender filter is ' +
      'used, and it must be one the declaration permits for those kinds — the same rule ' +
      'a vacancy’s restriction is held to. `search.restriction_not_justified` otherwise.',
  })
  @IsOptional()
  @IsUUID()
  restrictionJustificationId?: string;
}

export class CandidateSearchRequestDto {
  @ApiPropertyOptional({ type: CandidateSearchFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CandidateSearchFiltersDto)
  filters?: CandidateSearchFiltersDto;

  @ApiPropertyOptional({
    enum: SORTS,
    default: 'match',
    description:
      '§7.3’s options. `proximity` is tiered — same district, then same region, then ' +
      'the rest — measured against the location this request filters on: there are no ' +
      'coordinates in this data model, so a kilometre figure would be invented. With no ' +
      'location filter there is nothing to be near, and the order falls through to ' +
      'recency.',
  })
  @IsOptional()
  @IsIn(SORTS)
  sort?: CandidateSearchSort;

  @ApiPropertyOptional({
    description:
      'The vacancy the search was opened from (UAT-06). Decides `isShortlisted` on each ' +
      'card; it does **not** re-apply the vacancy’s filters, which the client already ' +
      'holds and may have edited.',
  })
  @IsOptional()
  @IsUUID()
  vacancyId?: string;

  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

export class MatchBreakdownDto {
  @ApiProperty({
    description:
      'One of `occupation`, `skills`, `languages`, `location`, `preferences`, ' +
      '`attributes` — the groups the filters actually asked about.',
  })
  group!: string;

  @ApiProperty() weight!: number;
  @ApiProperty({ description: 'How many items this group asked for.' })
  asked!: number;
  @ApiProperty({ description: 'How many of them the candidate has.' })
  matched!: number;
}

export class CandidateSkillDto {
  @ApiProperty() itemId!: string;
  @ApiProperty() levelId!: string;
  @ApiProperty({
    description: 'The level’s rank, so a client can sort or compare.',
  })
  levelRank!: number;
}

export class CandidateLanguageDto extends CandidateSkillDto {
  @ApiProperty() hasCertificate!: boolean;
}

/**
 * §7.3's candidate card.
 *
 * **There is no phone number and no CV here, by construction** (§11.1): a card is not a
 * hiring interaction, so BR-09 does not open. The profile view does carry them where an
 * application or an accepted invitation allows it.
 */
export class CandidateCardDto {
  @ApiProperty() candidateUserId!: string;
  @ApiPropertyOptional({ nullable: true }) fullName!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) districtId!: string | null;
  @ApiPropertyOptional({ nullable: true }) settlement!: string | null;

  @ApiPropertyOptional({ enum: CATEGORIES, nullable: true })
  category!: DictionaryCategory | null;

  @ApiPropertyOptional({ nullable: true }) primaryOccupationId!: string | null;
  @ApiPropertyOptional({ nullable: true }) occupationLevelId!: string | null;
  @ApiPropertyOptional({ nullable: true }) currentRoleTitle!: string | null;
  @ApiPropertyOptional({ nullable: true }) currentOccupationId!: string | null;

  @ApiProperty({
    description:
      'Total years of history, summed from the experience rows. Overlapping jobs count ' +
      'twice, which is a known roughness rather than a hidden one.',
  })
  experienceYears!: number;

  @ApiProperty({
    type: [CandidateSkillDto],
    description: 'The strongest ten (§7.3).',
  })
  skills!: CandidateSkillDto[];

  @ApiProperty({ type: [CandidateLanguageDto] })
  languages!: CandidateLanguageDto[];

  @ApiPropertyOptional({ nullable: true }) salaryFrom!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryTo!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryPeriodId!: string | null;
  @ApiProperty() salaryIsNegotiable!: boolean;
  @ApiPropertyOptional({ nullable: true }) availableFrom!: string | null;
  @ApiProperty() completenessPercent!: number;
  @ApiPropertyOptional({ nullable: true }) lastMeaningfulUpdateAt!:
    | string
    | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Path to the profile photo on this API, or null. The one candidate file a card may ' +
      'carry: a photo uploaded to be found by is not §5.4’s authorized CV.',
  })
  photoPath!: string | null;

  @ApiProperty() isSaved!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      '§7.3’s private employer note. Never visible to the candidate.',
  })
  note!: string | null;

  @ApiProperty({ description: 'False unless the request named a `vacancyId`.' })
  isShortlisted!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The candidate’s stage on any of this employer’s vacancies, or null.',
  })
  applicationStatus!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: INVITATION_STATUSES,
    description:
      'The invitation occupying BR-07’s slot for **this** search, or null when the slot is ' +
      'free — so an employer can be offered Invite exactly when it is valid, the way the ' +
      'candidate’s feed uses `applicationStatus`.\n\n' +
      '**Scoped like `isShortlisted`, not like `applicationStatus`.** BR-07’s slot is ' +
      '(employer, candidate, vacancy): with a `vacancyId` this is the invitation for that ' +
      'vacancy, and without one it is the *general* invitation, which is what a search ' +
      'with no vacancy context is about to send. It is deliberately **not** "have I ever ' +
      'invited them" — an employer who invited this candidate to a different vacancy may ' +
      'invite them to this one, and a card that said `sent` there would disable a button ' +
      'the server would have accepted.\n\n' +
      '**Only `sent` and `details_requested` block.** Those two are the states BR-07’s ' +
      'partial index covers, so `POST /invitations` answers `409 ' +
      '`invitation.already_invited`` for them. `accepted` and `declined` free the slot — ' +
      'render them as history ("invited, accepted") and keep Invite enabled. The `409` ' +
      'still has to be handled either way: the slot can be taken between this search and ' +
      'the tap.',
  })
  invitationStatus!: string | null;

  @ApiProperty({ description: '§7.3’s overall requirement match, 0–100.' })
  matchScore!: number;

  @ApiProperty({ type: [MatchBreakdownDto] })
  matchBreakdown!: MatchBreakdownDto[];
}

export class CandidateSearchResultDto {
  @ApiProperty({ type: [CandidateCardDto] })
  items!: CandidateCardDto[];

  @ApiProperty({
    type: [MatchBreakdownDto],
    description:
      'The scoring groups this request used, with their weights and asked-for counts — ' +
      'the same objects each card’s breakdown is measured against. `matched` is 0 here.',
  })
  groups!: MatchBreakdownDto[];
}

export class CandidateCountDto {
  @ApiProperty({
    description: `Capped at 200 (§7.2 "where technically reasonable").`,
  })
  count!: number;

  @ApiProperty({
    description: 'False when the cap was hit, so the client can render "200+".',
  })
  isExact!: boolean;
}

/** Paging for the two list routes, which carry nothing else. */
export class PageQueryDto {
  @ApiPropertyOptional({ default: 20, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class SaveNoteDto {
  @ApiPropertyOptional({
    nullable: true,
    description: '§7.3’s private note. Null clears it.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string | null;
}
