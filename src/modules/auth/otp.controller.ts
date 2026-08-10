import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '@infra/api/decorators/public.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import { XLang } from '@infra/api/decorators/x-lang.decorator';
import { resolveClientIp } from '@infra/api/client-ip';
import type { LocaleCode } from '@infra/db/database.types';
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
 * Phone + OTP login (§4.1) — **the MVP login path.**
 *
 * Client direction 2026-08-05 (second): Telegram login is deprecated and phone +
 * OTP is what ships, which is what §4.1 and UAT-01 specified all along. The flow
 * was kept whole behind `OTP_LOGIN_ENABLED` through the Telegram period, so
 * turning it back on was one environment variable rather than a revert.
 *
 * **There is no SMS provider yet.** `OTP_STATIC_CODE` fixes the issued code so the
 * flow is end-to-end testable in the meantime; see `OtpService.send` for why that
 * backdoor sits at the code-generation step and nowhere else. Connecting a
 * provider is a change to delivery only — no route, DTO or client change.
 *
 * `POST /auth/telegram` still works and still converges on the same `AuthService`
 * session issuance; an account can hold both credentials.
 */
@ApiTags('auth (otp)')
@Controller('auth')
@UseGuards(OtpEnabledGuard)
export class OtpController {
  private readonly timeZone: string;
  private readonly clientIpHeader: string | null;

  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
    // Lower-cased once, as the rate-limit guard does: Node exposes headers lower-cased,
    // and a mismatch would silently store the tunnel's address as the caller's.
    this.clientIpHeader =
      config.get('CLIENT_IP_HEADER', { infer: true }).toLowerCase() || null;
  }

  @Public()
  @RateLimit('otp')
  @Post('otp/send')
  @ApiOperation({
    summary: 'Send a login or registration code',
    description:
      'Registration and login are one flow for a phone-only identity (§4.1). ' +
      'TTL, resend delay and attempt limits are server configuration (§4.2). ' +
      'Rate limited per phone and per IP; a 429 carries `Retry-After`.\n\n' +
      '**No SMS is sent yet** - no provider is connected. Set `OTP_STATIC_CODE` ' +
      'to issue a fixed code, and `OTP_ECHO_IN_RESPONSE` to return it as ' +
      '`devCode`. Both are refused when `NODE_ENV=production`.',
  })
  @ApiOkResponse({ type: OtpSentResponseDto })
  async sendOtp(
    @Body() dto: SendOtpDto,
    @Req() request: Request,
    @XLang() locale: LocaleCode,
  ): Promise<OtpSentResponseDto> {
    // The code is sent in the language the client is asking in - the one screen where
    // the recipient has not yet got an account whose locale we could read.
    const result = await this.otp.send(
      normalizePhone(dto.phone),
      dto.purpose ?? 'login',
      resolveClientIp(request, this.clientIpHeader),
      locale,
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
    summary: 'Resend the code',
    description:
      'Identical to send: the resend delay is enforced there, and a new code ' +
      'supersedes the previous one so only one is ever valid.',
  })
  @ApiOkResponse({ type: OtpSentResponseDto })
  resendOtp(
    @Body() dto: SendOtpDto,
    @Req() request: Request,
    @XLang() locale: LocaleCode,
  ): Promise<OtpSentResponseDto> {
    return this.sendOtp(dto, request, locale);
  }

  @Public()
  @RateLimit('auth')
  @Post('otp/verify')
  @ApiOperation({
    summary: 'Verify a code and open a session',
    description:
      'Creates the account when the phone is new. `isNewUser` tells the client ' +
      'to route into role selection rather than the home screen.\n\n' +
      'Verifying a code is what makes the phone number verified, so an account ' +
      'reaching a session through this route always satisfies **BR-01**.',
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
