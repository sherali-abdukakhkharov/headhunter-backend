import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { Public } from '@infra/api/decorators/public.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import type { AppEnv } from '@infra/env-schema';
import { normalizePhone } from '@infra/phone/phone';
import { formatWithOffset } from '@infra/time/format';

import { AuthService } from './auth.service';
import {
  LogoutDto,
  RefreshDto,
  SelectRolesDto,
  SendOtpDto,
  SwitchRoleDto,
  VerifyOtpDto,
} from './dto/auth-request.dto';
import {
  AccessTokenResponseDto,
  AuthTokensResponseDto,
  OtpSentResponseDto,
  RolesResponseDto,
  SessionResponseDto,
} from './dto/auth-response.dto';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import type { DeviceInfo } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly timeZone: string;

  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Public()
  @RateLimit('otp')
  @Post('otp/send')
  @ApiOperation({
    summary: 'Send a login or registration code',
    description:
      'Registration and login are one flow for a phone-only identity (§4.1). ' +
      'TTL, resend delay and attempt limits are server configuration (§4.2). ' +
      'Rate limited per phone and per IP; a 429 carries `Retry-After`.',
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
    summary: 'Resend the code',
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
    summary: 'Verify a code and open a session',
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

  @Public()
  @RateLimit('auth')
  @Post('refresh')
  @ApiOperation({
    summary: 'Rotate the refresh token',
    description:
      'Rotation is mandatory: the presented token is revoked and replaced. ' +
      'Presenting an already-used token revokes **every** session in that ' +
      'rotation family, so the client must single-flight refresh.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  refresh(@Body() dto: RefreshDto): Promise<AuthTokensResponseDto> {
    return this.auth.refresh(dto.refreshToken, deviceFrom(dto));
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke this device’s session',
    description:
      'Idempotent, and deliberately public: a client whose access token has ' +
      'already expired must still be able to log out.',
  })
  @ApiNoContentResponse()
  async logout(@Body() dto: LogoutDto): Promise<void> {
    await this.sessions.revokeByToken(dto.refreshToken);
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every session for this account (§4.2)' })
  @ApiNoContentResponse()
  async logoutAll(@ActiveUser() user: CurrentUser): Promise<void> {
    await this.sessions.revokeAllForUser(user.id, 'logout_all');
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions (§4.2)' })
  @ApiOkResponse({ type: SessionResponseDto, isArray: true })
  async listSessions(
    @ActiveUser() user: CurrentUser,
  ): Promise<SessionResponseDto[]> {
    const rows = await this.sessions.listActive(user.id);

    return rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      platform: row.platform,
      appVersion: row.app_version,
      createdAt: formatWithOffset(row.created_at, this.timeZone),
      lastUsedAt: formatWithOffset(row.last_used_at, this.timeZone),
      expiresAt: formatWithOffset(row.expires_at, this.timeZone),
      isCurrent: row.id === user.sessionId,
    }));
  }

  @ApiBearerAuth()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one session (§4.2)' })
  @ApiNoContentResponse()
  async revokeSession(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const revoked = await this.sessions.revokeById(user.id, id);

    // 404 rather than 403 for someone else's session id: confirming that an id
    // exists but belongs to another account is information we do not owe.
    if (!revoked) {
      throw new NotFoundError('auth.session_not_found');
    }
  }

  @ApiBearerAuth()
  @Post('roles')
  @ApiOperation({
    summary: 'Select roles at the end of registration (§2.3)',
    description:
      'Additive and idempotent. The new roles reach the token on the next ' +
      'refresh or role switch.',
  })
  @ApiOkResponse({ type: RolesResponseDto })
  async selectRoles(
    @ActiveUser() user: CurrentUser,
    @Body() dto: SelectRolesDto,
  ): Promise<RolesResponseDto> {
    return { roles: await this.auth.selectRoles(user.id, dto.roles) };
  }

  @ApiBearerAuth()
  @Post('active-role')
  @ApiOperation({
    summary: 'Switch the acting role',
    description:
      'Returns a new access token carrying the requested role. The grant is ' +
      'verified in the database, not against the presented token’s claims.',
  })
  @ApiOkResponse({ type: AccessTokenResponseDto })
  switchRole(
    @ActiveUser() user: CurrentUser,
    @Body() dto: SwitchRoleDto,
  ): Promise<AccessTokenResponseDto> {
    return this.auth.switchActiveRole(user.id, user.sessionId, dto.role);
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
