import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
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
} from 'class-validator';

import type { DictionaryCategory } from '@infra/db/database.types';
import { CATEGORIES } from '@modules/schemas/dto/schemas.dto';

/** A comma-separated query list, which is how a mobile client sends id sets. */
const toArray = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').filter(Boolean) : value,
  );

export class FeedQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated `occupation` ids (§5.5).',
  })
  @IsOptional()
  @toArray()
  @IsArray()
  @IsUUID('4', { each: true })
  occupationIds?: string[];

  @ApiPropertyOptional({ enum: CATEGORIES })
  @IsOptional()
  @IsIn(CATEGORIES)
  category?: DictionaryCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  regionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  districtId?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated `employment_type` ids.',
  })
  @IsOptional()
  @toArray()
  @IsArray()
  @IsUUID('4', { each: true })
  employmentTypeIds?: string[];

  @ApiPropertyOptional({ description: 'Comma-separated `work_format` ids.' })
  @IsOptional()
  @toArray()
  @IsArray()
  @IsUUID('4', { each: true })
  workFormatIds?: string[];

  @ApiPropertyOptional({ description: 'Comma-separated `shift` ids.' })
  @IsOptional()
  @toArray()
  @IsArray()
  @IsUUID('4', { each: true })
  shiftIds?: string[];

  @ApiPropertyOptional({
    description:
      'Minimum pay. A negotiable vacancy passes this filter — it has not said no to ' +
      'the figure, and excluding it would hide much of the seasonal work.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  salaryFrom?: number;

  @ApiPropertyOptional({
    description: 'Published on or after this date (§5.5 "publication date").',
    example: '2026-08-01',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  publishedFrom?: string;

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

export class FeedEmployerDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'A company’s public name or an individual’s own name — never the legal name, ' +
      'which §6.1 keeps separately because the two differ.',
  })
  name!: string | null;

  @ApiProperty({
    description: '§5.6 shows verification status on the vacancy itself.',
  })
  isVerified!: boolean;
}

export class FeedItemDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ nullable: true }) title!: string | null;
  @ApiPropertyOptional({ enum: CATEGORIES, nullable: true })
  category!: DictionaryCategory | null;
  @ApiPropertyOptional({ nullable: true }) occupationId!: string | null;
  @ApiPropertyOptional({ nullable: true }) regionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) districtId!: string | null;
  @ApiPropertyOptional({ nullable: true }) workerCount!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryFrom!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryTo!: number | null;
  @ApiPropertyOptional({ nullable: true }) salaryPeriodId!: string | null;
  @ApiProperty() salaryIsNegotiable!: boolean;
  @ApiPropertyOptional({ nullable: true }) deadlineOn!: string | null;
  @ApiPropertyOptional({ nullable: true }) publishedAt!: string | null;

  @ApiProperty({ type: FeedEmployerDto })
  employer!: FeedEmployerDto;

  @ApiProperty() isSaved!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The caller’s own application stage for this vacancy, or null. Lets the card show ' +
      'Apply or the current status without a second request (§5.6).',
  })
  applicationStatus!: string | null;
}

export class FeedDto {
  @ApiProperty({ type: [FeedItemDto] })
  items!: FeedItemDto[];
}

export class VacancyRequirementDto {
  @ApiProperty({ description: 'Schema field code, e.g. `languages`.' })
  fieldCode!: string;

  @ApiPropertyOptional({ nullable: true }) itemId!: string | null;
  @ApiPropertyOptional({ nullable: true }) levelId!: string | null;

  @ApiProperty({ description: '§6.3’s mandatory/preferred flag.' })
  isMandatory!: boolean;

  @ApiPropertyOptional({ nullable: true }) valueBool!: boolean | null;
  @ApiPropertyOptional({ nullable: true }) valueInt!: number | null;
  @ApiPropertyOptional({ nullable: true }) valueText!: string | null;
}

export class VacancyDetailDto {
  @ApiProperty({ type: FeedItemDto })
  item!: FeedItemDto;

  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) address!: string | null;
  @ApiPropertyOptional({ nullable: true }) startsOn!: string | null;
  @ApiPropertyOptional({ nullable: true }) endsOn!: string | null;

  @ApiProperty({ type: [VacancyRequirementDto] })
  requirements!: VacancyRequirementDto[];
}

export class ReportVacancyDto {
  @ApiProperty({
    description:
      'Why it is being reported. Free text: a candidate reporting a fake vacancy ' +
      'should not have to find their objection on a list. M10 reviews it.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}
