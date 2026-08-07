import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import { type Conversation, type Message, ChatService } from './chat.service';
import {
  BlockConversationDto,
  ConversationDto,
  ConversationListDto,
  MessageDto,
  MessageListDto,
  MessagePageDto,
  OpenConversationDto,
  ReportMessageDto,
  SendMessageDto,
} from './dto/chat.dto';

/**
 * Gated chat (§9.1).
 *
 * No role guard on the controller: both sides use the same routes, and which side the
 * caller is on comes from their active role (§2.3). Participation is checked per request
 * by the service, which answers 404 for a conversation that is not theirs.
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller('conversations')
export class ChatController {
  private readonly timeZone: string;

  constructor(
    private readonly chat: ChatService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Post()
  @ApiOperation({
    summary:
      'Open the conversation with someone, or return the existing one (§9.1)',
    description:
      'Requires a **permitted hiring interaction** — a live application or an accepted ' +
      'invitation. The same question BR-09 asks, from the same service, so an employer ' +
      'who may see a phone number and one who may send a message are the same employer. ' +
      'Idempotent: there is only ever one thread between two people.',
  })
  @ApiOkResponse({ type: ConversationDto })
  @ApiForbiddenResponse({
    description:
      '`chat.no_interaction` — nothing permits this conversation (§9.1).',
  })
  async open(
    @ActiveUser() user: CurrentUser,
    @Body() dto: OpenConversationDto,
  ): Promise<ConversationDto> {
    return this.toDto(
      await this.chat.open(user.id, user.activeRole, dto.counterpartUserId),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'The caller’s conversations, most recently active first',
  })
  @ApiOkResponse({ type: ConversationListDto })
  async list(@ActiveUser() user: CurrentUser): Promise<ConversationListDto> {
    const items = await this.chat.list(user.id, user.activeRole);

    return { items: items.map((item) => this.toDto(item)) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One conversation' })
  @ApiOkResponse({ type: ConversationDto })
  @ApiNotFoundResponse({
    description: '`chat.conversation_not_found` — including somebody else’s.',
  })
  async byId(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConversationDto> {
    return this.toDto(await this.chat.read(user.id, user.activeRole, id));
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'A page of the thread, newest first (§9.1)',
    description:
      'Readable whether or not sending is: §9.1 keeps closed and blocked interactions in ' +
      'history. Scroll back with `before`.',
  })
  @ApiOkResponse({ type: MessageListDto })
  async messages(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: MessagePageDto,
  ): Promise<MessageListDto> {
    const items = await this.chat.messages(user.id, user.activeRole, id, {
      ...(page.limit ? { limit: page.limit } : {}),
      ...(page.before ? { before: new Date(page.before) } : {}),
    });

    return { items: items.map((item) => this.toMessageDto(item)) };
  }

  @Post(':id/messages')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. A retry with the same key and body returns the original message instead ' +
      'of sending a second one (§12.4).',
  })
  @ApiOperation({
    summary: 'Send a message (§9.1)',
    description:
      'The gate is re-asked here rather than trusted from when the conversation opened: ' +
      'an interaction can end while a client holds the screen, and a withdrawal or a ' +
      'declined invitation turns the thread into history mid-conversation. An attachment ' +
      'must be a file the sender owns.',
  })
  @ApiOkResponse({ type: MessageDto })
  @ApiForbiddenResponse({ description: '`chat.blocked`.' })
  @ApiConflictResponse({
    description:
      '`chat.read_only` — the hiring interaction has ended (§9.1). The thread stays ' +
      'readable.',
  })
  async send(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MessageDto> {
    return this.toMessageDto(
      await this.chat.send(user.id, user.activeRole, id, dto, idempotencyKey),
    );
  }

  @Put(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Mark everything up to now as read (§9.1)',
    description:
      'Read state is one timestamp per participant, so this is idempotent and cheap. The ' +
      'other side sees it as `isReadByRecipient` on the messages they sent.',
  })
  @ApiNoContentResponse()
  async markRead(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.chat.markRead(user.id, user.activeRole, id);
  }

  @Post(':id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Block this conversation (§9.1)',
    description:
      'Read-only for **both** sides while it stands, whoever set it: a block that let the ' +
      'blocker keep writing would be a mute. The messages stay readable, because §9.1 ' +
      'keeps blocked interactions in history and a moderator needs them.',
  })
  @ApiNoContentResponse()
  async block(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockConversationDto,
  ): Promise<void> {
    await this.chat.block(user.id, user.activeRole, id, dto.reason ?? null);
  }

  @Delete(':id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove the caller’s own block' })
  @ApiNoContentResponse()
  async unblock(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.chat.unblock(user.id, user.activeRole, id);
  }

  @Post(':id/messages/:messageId/report')
  @ApiOperation({
    summary: 'Report a message (§9.1)',
    description:
      'Filed as a complaint with `target_type = "message"` — the same queue M10 reviews ' +
      'vacancy reports through. One open report per person per message.',
  })
  @ApiOkResponse({ schema: { properties: { id: { type: 'string' } } } })
  @ApiConflictResponse({ description: '`complaint.already_reported`.' })
  async report(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: ReportMessageDto,
  ): Promise<{ id: string }> {
    return {
      id: await this.chat.report(
        user.id,
        user.activeRole,
        messageId,
        dto.reason,
      ),
    };
  }

  @Get(':id/messages/:messageId/file')
  @ApiOperation({
    summary: 'Download a message attachment (§9.1)',
    description:
      'The third entitlement-bearing download route, and the same rule as the other two: ' +
      'the entitlement comes from the conversation, so the route that serves the bytes is ' +
      'the one that can see it. `/files/{id}/content` stays owner-only.',
  })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ description: '`file.not_found`.' })
  async downloadAttachment(
    @ActiveUser() user: CurrentUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { file, bytes } = await this.chat.downloadAttachment(
      user.id,
      user.activeRole,
      id,
      messageId,
    );

    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(bytes.length));
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');

    response.end(bytes);
  }

  private toDto(conversation: Conversation): ConversationDto {
    return {
      ...conversation,
      lastMessageAt: conversation.lastMessageAt
        ? formatWithOffset(conversation.lastMessageAt, this.timeZone)
        : null,
    };
  }

  private toMessageDto(message: Message): MessageDto {
    return {
      ...message,
      createdAt: formatWithOffset(message.createdAt, this.timeZone),
    };
  }
}
