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

  @ApiProperty({
    example: 6,
    description:
      'Digits in the code, from `OTP_LENGTH`. §4.2 makes this configuration, ' +
      'and until it was published the client hard-coded six — so changing the ' +
      'setting would have silently given every app an input that refuses the ' +
      'code it was sent.',
  })
  codeLength!: number;

  @ApiProperty({
    example: 5,
    description:
      'How many wrong guesses this code allows before it is locked out and a ' +
      'new one must be requested (`OTP_MAX_ATTEMPTS`, §4.2).\n\n' +
      '**This is the limit, not the number remaining, and that is on ' +
      'purpose.** `POST /auth/otp/verify` answers `auth.otp_invalid` ' +
      'identically for "no code", "expired" and "wrong code", so that probing ' +
      'a phone number cannot reveal whether a code is pending for it. ' +
      'Attaching a remaining-attempt count to that refusal would undo exactly ' +
      'that: a number with a live code would answer with a counter and a ' +
      'number without one would not, which is the oracle the shared message ' +
      'exists to close.\n\n' +
      'The limit leaks nothing — it is policy, and an attacker learns it by ' +
      'guessing wrong five times. The client counts its own attempts against ' +
      'it, which is accurate for the person actually typing and is the only ' +
      'party the countdown is for. The server stays authoritative: it answers ' +
      '`auth.otp_too_many_attempts` whatever the client believed.',
  })
  maxAttempts!: number;

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
