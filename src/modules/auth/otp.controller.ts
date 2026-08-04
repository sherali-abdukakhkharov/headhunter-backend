import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '@infra/api/decorators/public.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import type { AppEnv } from '@infra/env-schema';
import { normalizePhone } from '@infra/phone/phone';
import { formatWithOffset } from '@infra/time/format';

import { AuthService } from './auth.service';
import { SendOtpDto, VerifyOtpDto } from './dto/auth-request.dto';
import {
  AuthTokensResponseDto,
  OtpSentResponseDto,
} from './dto/auth-response.dto';
import { OtpEnabledGuard } from './otp-enabled.guard';
import { OtpService } from './otp.service';
import type { DeviceInfo } from './session.service';

/**
 * Phone + OTP login (§4.1).
 *
 * **Switched off for the MVP.** The client chose Telegram login instead
 * (2026-08-05), so every route here answers 404 unless `OTP_LOGIN_ENABLED=true`.
 *
 * Kept whole rather than deleted, and in its own controller rather than commented
 * out, for three reasons: §4.1 still specifies phone + OTP, so this is a deferral
 * and not a removal; the schema, service and 12 integration tests all still run, so
 * it cannot rot silently while switched off; and turning it back on is one
 * environment variable rather than a revert.
 *
 * It is a second front door when it *is* on - both paths converge on the same
 * `AuthService` session issuance, and an account can hold both credentials.
 */
@ApiTags('auth (otp - disabled for MVP)')
@Controller('auth')
@UseGuards(OtpEnabledGuard)
export class OtpController {
  private readonly timeZone: string;

  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Public()
  @RateLimit('otp')
  @Post('otp/send')
  @ApiOperation({
    deprecated: true,
    summary:
      'Send a login or registration code (disabled unless OTP_LOGIN_ENABLED)',
    description:
      'Registration and login are one flow for a phone-only identity (§4.1). ' +
      'TTL, resend delay and attempt limits are server configuration (§4.2). ' +
      'Rate limited per phone and per IP; a 429 carries `Retry-After`.\n\n' +
      '**Not part of the MVP.** Use `POST /auth/telegram`.',
  })
  @ApiOkResponse({ type: OtpSentResponseDto })
  async sendOtp(
    @Body() dto: SendOtpDto,
    @Req() request: Request,
  ): Promise<OtpSentResponseDto> {
    const result = await this.otp.send(
      normalizePhone(dto.phone),
      dto.purpose ?? 'login',
      request.ip ?? null,
    );

    return {
      expiresAt: formatWithOffset(result.expiresAt, this.timeZone),
      resendAvailableAt: formatWithOffset(
        result.resendAvailableAt,
        this.timeZone,
      ),
      ...(result.devCode ? { devCode: result.devCode } : {}),
    };
  }

  @Public()
  @RateLimit('otp')
  @Post('otp/resend')
  @ApiOperation({
    deprecated: true,
    summary: 'Resend the code (disabled unless OTP_LOGIN_ENABLED)',
    description:
      'Identical to send: the resend delay is enforced there, and a new code ' +
      'supersedes the previous one so only one is ever valid.',
  })
  @ApiOkResponse({ type: OtpSentResponseDto })
  resendOtp(
    @Body() dto: SendOtpDto,
    @Req() request: Request,
  ): Promise<OtpSentResponseDto> {
    return this.sendOtp(dto, request);
  }

  @Public()
  @RateLimit('auth')
  @Post('otp/verify')
  @ApiOperation({
    deprecated: true,
    summary:
      'Verify a code and open a session (disabled unless OTP_LOGIN_ENABLED)',
    description:
      'Creates the account when the phone is new. `isNewUser` tells the client ' +
      'to route into role selection rather than the home screen.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthTokensResponseDto> {
    const phone = normalizePhone(dto.phone);

    await this.otp.verify(phone, dto.purpose ?? 'login', dto.code);

    return this.auth.completePhoneVerification(
      phone,
      dto.locale ?? 'uz-Latn',
      deviceFrom(dto),
    );
  }
}

function deviceFrom(dto: {
  deviceFingerprint?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
}): DeviceInfo {
  return {
    fingerprint: dto.deviceFingerprint,
    name: dto.deviceName,
    platform: dto.platform,
    appVersion: dto.appVersion,
  };
}
