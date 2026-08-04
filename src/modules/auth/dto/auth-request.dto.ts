import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import type {
  LocaleCode,
  OtpPurpose,
  UserRole,
} from '@infra/db/database.types';

const LOCALES: LocaleCode[] = ['uz-Latn', 'uz-Cyrl', 'ru', 'en'];
const SEND_PURPOSES: OtpPurpose[] = ['registration', 'login', 'phone_change'];
const SELF_ASSIGNABLE_ROLES: UserRole[] = ['candidate', 'employer'];

/** Device fields shared by every call that opens or rotates a session. */
export class DeviceInfoDto {
  @ApiPropertyOptional({ description: 'Stable per-install device identifier' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceFingerprint?: string;

  @ApiPropertyOptional({ example: 'Pixel 8' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceName?: string;

  @ApiPropertyOptional({ enum: ['android', 'ios'] })
  @IsOptional()
  @IsIn(['android', 'ios'])
  platform?: 'android' | 'ios';

  @ApiPropertyOptional({ example: '1.0.3' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}

export class SendOtpDto {
  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  phone!: string;

  @ApiPropertyOptional({
    enum: SEND_PURPOSES,
    default: 'login',
    description:
      'Registration and login are the same flow for a phone-only identity; ' +
      'the server decides which happened. Pass `phone_change` only from an ' +
      'authenticated phone-change flow.',
  })
  @IsOptional()
  @IsIn(SEND_PURPOSES)
  purpose?: OtpPurpose;
}

export class VerifyOtpDto extends DeviceInfoDto {
  @ApiProperty({ example: '+998901234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(24)
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(8)
  code!: string;

  @ApiPropertyOptional({ enum: SEND_PURPOSES, default: 'login' })
  @IsOptional()
  @IsIn(SEND_PURPOSES)
  purpose?: OtpPurpose;

  @ApiPropertyOptional({
    enum: LOCALES,
    default: 'uz-Latn',
    description: 'Interface language chosen before registration (§3.1).',
  })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: LocaleCode;
}

export class RefreshDto extends DeviceInfoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class SelectRolesDto {
  @ApiProperty({
    enum: SELF_ASSIGNABLE_ROLES,
    isArray: true,
    example: ['candidate'],
    description:
      'One account may hold several roles (§2.3). `admin` is granted by an ' +
      'administrator, never self-assigned.',
  })
  @IsIn(SELF_ASSIGNABLE_ROLES, { each: true })
  roles!: UserRole[];
}

export class SwitchRoleDto {
  @ApiProperty({ enum: ['candidate', 'employer', 'admin'] })
  @IsIn(['candidate', 'employer', 'admin'])
  role!: UserRole;
}
