import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import {
  DeletionRequestedResponseDto,
  LocaleResponseDto,
  RequestDeletionDto,
  UpdateLocaleDto,
  UserProfileResponseDto,
} from './dto/users.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users/me')
export class UsersController {
  private readonly timeZone: string;

  constructor(
    private readonly users: UsersService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get()
  @ApiOperation({
    summary: 'The signed-in account',
    description:
      'Identity, locale, account status and granted roles. Roles come from the ' +
      'database rather than the token, so a role granted since the token was ' +
      'issued is visible here before the next refresh.',
  })
  @ApiOkResponse({ type: UserProfileResponseDto })
  async me(@ActiveUser() user: CurrentUser): Promise<UserProfileResponseDto> {
    const profile = await this.users.findProfile(user.id);

    return {
      id: profile.id,
      phone: profile.phone,
      locale: profile.locale,
      status: profile.status,
      roles: profile.roles,
      createdAt: formatWithOffset(profile.createdAt, this.timeZone),
    };
  }

  @Patch('locale')
  @ApiOperation({
    summary: 'Change the interface language (§3.2)',
    description:
      'Stored on the account, so the choice follows the user to every ' +
      'signed-in device rather than staying on the install that changed it.',
  })
  @ApiOkResponse({ type: LocaleResponseDto })
  async updateLocale(
    @ActiveUser() user: CurrentUser,
    @Body() dto: UpdateLocaleDto,
  ): Promise<LocaleResponseDto> {
    return { locale: await this.users.updateLocale(user.id, dto.locale) };
  }

  @Post('deletion-request')
  @ApiOperation({
    summary: 'Request account deletion (BR-14)',
    description:
      'Moves the account to `deletion_requested` and writes a status-history ' +
      'row. No purge date is returned: the retention period is still an open ' +
      'client question.',
  })
  @ApiOkResponse({ type: DeletionRequestedResponseDto })
  async requestDeletion(
    @ActiveUser() user: CurrentUser,
    @Body() dto: RequestDeletionDto,
  ): Promise<DeletionRequestedResponseDto> {
    const requestedAt = await this.users.requestDeletion(
      user.id,
      dto.reason ?? null,
    );

    return {
      requestedAt: formatWithOffset(requestedAt, this.timeZone),
      purgeAfter: null,
    };
  }
}
