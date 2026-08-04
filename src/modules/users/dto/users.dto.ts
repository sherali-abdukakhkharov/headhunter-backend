import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import type {
  AccountStatus,
  LocaleCode,
  UserRole,
} from '@infra/db/database.types';

const LOCALES: LocaleCode[] = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'];

export class UpdateLocaleDto {
  @ApiProperty({
    enum: LOCALES,
    description:
      'Canonical BCP-47 code (docs/API_CONTRACTS.md §1). The house aliases ' +
      '`uz`/`oz` are accepted on the `x-lang` header, not here: this value is ' +
      'persisted, so it is stored in exactly one form.',
  })
  @IsIn(LOCALES)
  locale!: LocaleCode;
}

export class RequestDeletionDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UserProfileResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    example: '+998901234567',
    description: 'E.164. Returned only to the account owner (§11.1, BR-09).',
  })
  phone!: string;

  @ApiProperty({ enum: LOCALES })
  locale!: LocaleCode;

  @ApiProperty({
    enum: ['active', 'restricted', 'blocked', 'deletion_requested'],
    description:
      'A restricted or blocked account is refused every mutation (BR-10); the ' +
      'client reads this to explain why rather than guessing from a 403.',
  })
  status!: AccountStatus;

  @ApiProperty({ enum: ['candidate', 'employer', 'admin'], isArray: true })
  roles!: UserRole[];

  @ApiProperty({ example: '2026-08-12T14:00:00+05:00' })
  createdAt!: string;
}

export class LocaleResponseDto {
  @ApiProperty({ enum: LOCALES })
  locale!: LocaleCode;
}

export class DeletionRequestedResponseDto {
  @ApiProperty({ example: '2026-08-12T14:00:00+05:00' })
  requestedAt!: string;

  @ApiProperty({
    description:
      'Retention period is not yet defined (BR-14 defers to the approved ' +
      'privacy policy), so no purge date is returned yet.',
    nullable: true,
  })
  purgeAfter!: string | null;
}
