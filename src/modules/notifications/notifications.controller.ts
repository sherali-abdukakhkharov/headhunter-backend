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
  Put,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { XLang } from '@infra/api/decorators/x-lang.decorator';
import type {
  LocaleCode,
  NotificationCategory,
} from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import { DevicesService } from './devices.service';
import {
  MarkedReadDto,
  NotificationListDto,
  NotificationPreferencesDto,
  NotificationQueryDto,
  RegisterDeviceDto,
  SetPreferenceDto,
  UnreadCountDto,
} from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * §9.2's notifications, for the person they belong to.
 *
 * No role guard: every role receives notifications, and each route is scoped to the
 * caller's own rows. The list is rendered in the request's `x-lang` rather than in
 * whatever language the event happened in - the row stores a key, not a sentence.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  private readonly timeZone: string;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly devices: DevicesService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get()
  @ApiOperation({
    summary: 'The caller’s notifications, newest first (§9.2)',
    description:
      'Each item’s `text` is rendered in this request’s language, so switching language ' +
      'reads the whole history in the new one. Branch on `event` and follow ' +
      '`targetType`/`targetId` rather than parsing the sentence.',
  })
  @ApiOkResponse({ type: NotificationListDto })
  async list(
    @ActiveUser() user: CurrentUser,
    @XLang() locale: LocaleCode,
    @Query() query: NotificationQueryDto,
  ): Promise<NotificationListDto> {
    const items = await this.notifications.list(
      user.id,
      locale,
      { ...(query.unreadOnly ? { unreadOnly: true } : {}) },
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: formatWithOffset(item.createdAt, this.timeZone),
      })),
    };
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'The badge (§9.2)',
    description:
      'One indexed count over a partial index, because this is polled far more often ' +
      'than the list is opened.',
  })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(@ActiveUser() user: CurrentUser): Promise<UnreadCountDto> {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one as read' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: '`notification.not_found` — including somebody else’s.',
  })
  async markRead(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }

  @Put('read')
  @ApiOperation({ summary: 'Mark everything as read' })
  @ApiOkResponse({ type: MarkedReadDto })
  async markAllRead(@ActiveUser() user: CurrentUser): Promise<MarkedReadDto> {
    return { marked: await this.notifications.markAllRead(user.id) };
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'Which categories are on (§9.2)',
    description:
      'Every category, including the one that cannot be switched off — flagged with ' +
      '`canDisable: false` so the screen can grey it out. A user who cannot find ' +
      '"account notices" in the list will assume they are off.',
  })
  @ApiOkResponse({ type: NotificationPreferencesDto })
  async preferences(
    @ActiveUser() user: CurrentUser,
  ): Promise<NotificationPreferencesDto> {
    return { items: await this.notifications.preferences(user.id) };
  }

  @Put('preferences/:category')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Switch a category on or off (§9.2)',
    description:
      'A disabled category stores nothing at all — not a hidden row — so the badge cannot ' +
      'count notifications the user asked not to receive. `account` is refused: §9.2 keeps ' +
      'security and account notices enabled, and a CHECK constraint refuses the row too.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description: '`notification.category_not_disableable`.',
  })
  async setPreference(
    @ActiveUser() user: CurrentUser,
    @Param('category') category: NotificationCategory,
    @Body() dto: SetPreferenceDto,
  ): Promise<void> {
    await this.notifications.setPreference(user.id, category, dto.enabled);
  }

  @Post('devices')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Register this device for push (§9.2)',
    description:
      'Idempotent, and re-registering a token that belonged to another account **moves** ' +
      'it: a token identifies an app installation, not a person, and phones in this ' +
      'market are handed on. Call it after every SDK token refresh.',
  })
  @ApiNoContentResponse()
  async registerDevice(
    @ActiveUser() user: CurrentUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<void> {
    await this.devices.register(user.id, dto);
  }

  @Delete('devices/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Stop pushing to this device',
    description:
      'Sign-out for one device. Deleted rather than kept: it is a decision.',
  })
  @ApiNoContentResponse()
  async unregisterDevice(
    @ActiveUser() user: CurrentUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.devices.unregister(user.id, token);
  }
}
