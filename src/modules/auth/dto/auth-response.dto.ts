import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { UserRole } from '@infra/db/database.types';

/**
 * Every timestamp here is an ISO-8601 string with an explicit numeric offset,
 * produced by `infra/time/format.ts` - never `Z` (docs/API_CONTRACTS.md §2).
 */
export class OtpSentResponseDto {
  @ApiProperty({ example: '2026-08-12T14:05:00+05:00' })
  expiresAt!: string;

  @ApiProperty({
    example: '2026-08-12T14:01:00+05:00',
    description: 'Earliest time a resend will be accepted (§4.2).',
  })
  resendAvailableAt!: string;

  @ApiPropertyOptional({
    description:
      'Development only, when OTP_ECHO_IN_RESPONSE is on. Boot refuses this ' +
      'flag in production.',
  })
  devCode?: string;
}

export class AuthTokensResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;

  @ApiProperty({ enum: ['candidate', 'employer', 'admin'], isArray: true })
  roles!: UserRole[];

  @ApiProperty({
    enum: ['candidate', 'employer', 'admin'],
    nullable: true,
    description:
      'Null when the account holds several roles and has not chosen one, or ' +
      'holds none yet. The client must call /auth/active-role before acting.',
  })
  activeRole!: UserRole | null;

  @ApiProperty({
    description: 'True when this verification created the account.',
  })
  isNewUser!: boolean;
}

export class AccessTokenResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ example: 900 })
  expiresInSeconds!: number;
}

export class RolesResponseDto {
  @ApiProperty({ enum: ['candidate', 'employer', 'admin'], isArray: true })
  roles!: UserRole[];
}

export class SessionResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  deviceName!: string | null;

  @ApiProperty({ nullable: true })
  platform!: string | null;

  @ApiProperty({ nullable: true })
  appVersion!: string | null;

  @ApiProperty({ example: '2026-08-12T14:00:00+05:00' })
  createdAt!: string;

  @ApiProperty({ example: '2026-08-12T14:30:00+05:00' })
  lastUsedAt!: string;

  @ApiProperty({ example: '2026-09-11T14:00:00+05:00' })
  expiresAt!: string;

  @ApiProperty({
    description: 'True for the session this request authenticated with.',
  })
  isCurrent!: boolean;
}
