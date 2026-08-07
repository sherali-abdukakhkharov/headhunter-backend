import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class OpenConversationDto {
  @ApiProperty({
    description:
      'The other person. Which side of the conversation each of you is on follows from ' +
      'your active role, so a multi-role account (§2.3) can hold both kinds of thread.',
  })
  @IsUUID()
  counterpartUserId!: string;
}

export class SendMessageDto {
  @ApiPropertyOptional({
    description:
      'The text. Optional only when the message carries an attachment.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body?: string;

  @ApiPropertyOptional({
    description:
      'An attachment the **sender owns** — a file id from their own uploads (§9.1 ' +
      '"approved attachments"). One per message.',
  })
  @IsOptional()
  @IsUUID()
  fileId?: string;
}

export class MessagePageDto {
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Messages older than this instant — the cursor for scrolling back.',
  })
  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class BlockConversationDto {
  @ApiPropertyOptional({
    description: 'Why, for the moderator who reviews it (§9.1).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ReportMessageDto {
  @ApiProperty({
    description:
      'Free text: somebody reporting a message should not have to find their objection ' +
      'on a list. Filed as a `complaints` row for M10’s queue.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class ConversationDto {
  @ApiProperty() id!: string;
  @ApiProperty() employerUserId!: string;
  @ApiProperty() candidateUserId!: string;

  @ApiProperty({
    description: 'The other participant, from the caller’s side.',
  })
  counterpartUserId!: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The candidate’s name, or the employer’s public name — never a legal name.',
  })
  counterpartName!: string | null;

  @ApiPropertyOptional({ nullable: true }) lastMessageAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) lastMessageBody!: string | null;

  @ApiProperty({
    description: 'Messages from the other side the caller has not read.',
  })
  unreadCount!: number;

  @ApiProperty({
    description:
      '§9.1: false once the hiring interaction has ended or either side has blocked. The ' +
      'thread stays readable — it becomes history, not nothing.',
  })
  canSend!: boolean;

  @ApiProperty() isBlocked!: boolean;
  @ApiProperty({ description: 'Whether it was the caller who blocked.' })
  blockedByMe!: boolean;
}

export class ConversationListDto {
  @ApiProperty({ type: [ConversationDto] })
  items!: ConversationDto[];
}

export class MessageDto {
  @ApiProperty() id!: string;
  @ApiProperty() conversationId!: string;
  @ApiProperty() senderUserId!: string;
  @ApiPropertyOptional({ nullable: true }) body!: string | null;
  @ApiPropertyOptional({ nullable: true }) fileId!: string | null;
  @ApiPropertyOptional({ nullable: true }) fileName!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where to fetch the attachment, scoped to this conversation. Never a storage URL ' +
      '(ARCHITECTURE.md §9), and never `/files/{id}/content`, which stays owner-only.',
  })
  downloadPath!: string | null;

  @ApiProperty({
    description:
      '§9.1’s read state, for messages the caller **sent**: has the other side read it? ' +
      'There is no `delivered` state — delivery is a property of push (M9), and a field ' +
      'set at the same moment as `createdAt` would be a fake answer.',
  })
  isReadByRecipient!: boolean;

  @ApiProperty() createdAt!: string;
}

export class MessageListDto {
  @ApiProperty({ type: [MessageDto], description: 'Newest first.' })
  items!: MessageDto[];
}
