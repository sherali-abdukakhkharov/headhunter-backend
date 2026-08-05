import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Experience and education (§5.1).
 *
 * These two are the `editor: "bespoke"` sections of API_CONTRACTS.md §4.1: repeating
 * records with their own screens, so they get ordinary typed DTOs instead of going
 * through the field engine. That is also why validation here is class-validator
 * rather than the schema validator - there is no dynamic field set to validate
 * against.
 */

/** ISO calendar date, matching the `date` kind on the wire (§4.2). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ExperienceInputDto {
  @ApiPropertyOptional({
    description:
      'Optional, because §5.1 asks for "simplified entry for informal or seasonal ' +
      'work" - a seasonal worker often cannot name an employer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  employerName?: string;

  @ApiProperty({ description: 'The one required field: what the person did.' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  roleTitle!: string;

  @ApiPropertyOptional({
    description:
      '`occupation` dictionary id, so §7.1’s "years in the selected occupation" ' +
      'can be computed rather than guessed from the title text.',
  })
  @IsOptional()
  @IsUUID()
  occupationId?: string;

  @ApiProperty({ example: '2024-03-01' })
  @Matches(ISO_DATE)
  startedOn!: string;

  @ApiPropertyOptional({ example: '2025-08-31', nullable: true })
  @IsOptional()
  @Matches(ISO_DATE)
  endedOn?: string | null;

  @ApiPropertyOptional({
    description: 'Still working here. Mutually exclusive with `endedOn`.',
  })
  @IsOptional()
  @IsBoolean()
  isCurrent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  responsibilities?: string;
}

export class ExperienceDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional({ nullable: true }) employerName!: string | null;
  @ApiProperty() roleTitle!: string;
  @ApiPropertyOptional({ nullable: true }) occupationId!: string | null;
  @ApiProperty() startedOn!: string;
  @ApiPropertyOptional({ nullable: true }) endedOn!: string | null;
  @ApiProperty() isCurrent!: boolean;
  @ApiPropertyOptional({ nullable: true }) responsibilities!: string | null;
}

export class ExperienceListDto {
  @ApiProperty({ type: [ExperienceDto] })
  items!: ExperienceDto[];
}

export class EducationInputDto {
  @ApiProperty({ description: '`education_level` dictionary id.' })
  @IsUUID()
  levelId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  institution?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  specialization?: string;

  @ApiPropertyOptional({
    description:
      'An expected graduation up to ten years out is accepted; the column carries ' +
      'the same bound as a CHECK.',
  })
  @IsOptional()
  @IsInt()
  @Min(1940)
  @Max(2100)
  graduationYear?: number;
}

export class EducationDto {
  @ApiProperty() id!: string;
  @ApiProperty() levelId!: string;
  @ApiPropertyOptional({ nullable: true }) institution!: string | null;
  @ApiPropertyOptional({ nullable: true }) specialization!: string | null;
  @ApiPropertyOptional({ nullable: true }) graduationYear!: number | null;
}

export class EducationListDto {
  @ApiProperty({ type: [EducationDto] })
  items!: EducationDto[];
}
