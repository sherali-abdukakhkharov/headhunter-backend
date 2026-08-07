import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type {
  NotificationCategory,
  NotificationEvent,
} from '@infra/db/database.types';

export const NOTIFICATION_CATEGORIES = [
  'applications',
  'invitations',
  'messages',
  'interviews',
  'account',
] as const;

const PLATFORMS = ['android', 'ios'] as const;

export class NotificationQueryDto {
  @ApiPropertyOptional({ description: 'Only what has not been read yet.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class NotificationDto {
  @ApiProperty() id!: string;

  @ApiProperty({
    description:
      'The §9.2 event, as a stable code. Branch on this rather than on the text.',
  })
  event!: NotificationEvent;

  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  category!: NotificationCategory;

  @ApiProperty({
    description:
      'Rendered **now**, in the language of this request (`x-lang`). The row stores a ' +
      'message key and its parameters rather than text, so a user who switches language ' +
      'sees their whole history in the new one (§3.2).',
  })
  text!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What tapping it should open — `vacancy`, `application`, `conversation`…',
  })
  targetType!: string | null;

  @ApiPropertyOptional({ nullable: true }) targetId!: string | null;
  @ApiProperty() isRead!: boolean;
  @ApiProperty() createdAt!: string;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] })
  items!: NotificationDto[];
}

export class UnreadCountDto {
  @ApiProperty({ description: 'What the badge shows.' })
  count!: number;
}

export class MarkedReadDto {
  @ApiProperty({ description: 'How many were still unread.' })
  marked!: number;
}

export class NotificationPreferenceDto {
  @ApiProperty({ enum: NOTIFICATION_CATEGORIES })
  category!: NotificationCategory;

  @ApiProperty() enabled!: boolean;

  @ApiProperty({
    description:
      'False for `account`. §9.2: "security and account notices remain enabled" — it is ' +
      'listed so the settings screen can show it greyed out rather than omitting it, ' +
      'because a user who cannot find it will assume it is off.',
  })
  canDisable!: boolean;
}

export class NotificationPreferencesDto {
  @ApiProperty({ type: [NotificationPreferenceDto] })
  items!: NotificationPreferenceDto[];
}

export class SetPreferenceDto {
  @ApiProperty({
    description:
      'False switches the category off. Refused for `account` with ' +
      '`notification.category_not_disableable`, and a CHECK constraint refuses the row ' +
      'underneath.',
  })
  @IsBoolean()
  enabled!: boolean;
}

export class RegisterDeviceDto {
  @ApiProperty({
    description:
      'The FCM registration token. Re-register it whenever the SDK rotates it — a token ' +
      'is unique across users, so registering one that belonged to another account moves ' +
      'it, which is what a shared or resold phone needs.',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  token!: string;

  @ApiProperty({ enum: PLATFORMS })
  @IsIn(PLATFORMS)
  platform!: 'android' | 'ios';

  @ApiPropertyOptional({
    description: 'For support, when a bug is version-specific.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}
