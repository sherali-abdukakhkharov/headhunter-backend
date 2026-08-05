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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';

import { Public } from '@infra/api/decorators/public.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';
import { XLang } from '@infra/api/decorators/x-lang.decorator';
import { NotFoundError } from '@infra/api/exceptions/localized.exception';
import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import type { LocaleCode } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import { AuthService } from './auth.service';
import {
  LogoutDto,
  RefreshDto,
  SelectRolesDto,
  SwitchRoleDto,
  TelegramLoginDto,
} from './dto/auth-request.dto';
import {
  AccessTokenResponseDto,
  AuthTokensResponseDto,
  RolesResponseDto,
  SessionResponseDto,
} from './dto/auth-response.dto';
import { SessionService } from './session.service';
import { TelegramOidcService } from './telegram-oidc.service';
import type { DeviceInfo } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly timeZone: string;

  constructor(
    private readonly auth: AuthService,
    private readonly telegram: TelegramOidcService,
    private readonly sessions: SessionService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Public()
  @RateLimit('auth')
  @Post('telegram')
  @ApiOperation({
    deprecated: true,
    summary: 'Log in with Telegram (deprecated - use POST /auth/otp/verify)',
    description:
      '**Deprecated 2026-08-05.** The client reverted to §4.1 phone + OTP, and ' +
      'the app no longer calls this. It is kept working, not deleted: the JWKS ' +
      'verification and 22 integration tests are correct, and Telegram remains ' +
      'the obvious cheap-verification path if it is wanted again.\n\n' +
      'Send the `id_token` the Telegram Login SDK returned; ' +
      'it is verified against Telegram’s JWKS with this bot’s id as the audience ' +
      'before any account is touched.\n\n' +
      'Registration and login are the same call - the client cannot know which ' +
      'one it is doing, and asking it to would create a way to probe which ' +
      'Telegram accounts are registered. `isNewUser` tells the client to route ' +
      'into role selection rather than the home screen.\n\n' +
      'A token whose `phone` scope was declined is refused while ' +
      '`TELEGRAM_REQUIRE_PHONE` is on: an account with no phone number cannot ' +
      'take part in BR-09 contact exposure, and finding that out at login is ' +
      'better than after building a profile.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiHeader({
    name: 'x-lang',
    required: false,
    description:
      'Interface language. Becomes the account’s stored locale when this login ' +
      'creates it (§3.2); change it later with PATCH /users/me/locale.',
  })
  async telegramLogin(
    @Body() dto: TelegramLoginDto,
    @XLang() locale: LocaleCode,
  ): Promise<AuthTokensResponseDto> {
    const identity = await this.telegram.verify(dto.idToken);

    return this.auth.completeTelegramLogin(identity, locale, deviceFrom(dto));
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
