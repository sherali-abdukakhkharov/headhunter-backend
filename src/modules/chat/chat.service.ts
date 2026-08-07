import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { UserRole } from '@infra/db/database.types';
import { type StoredFile, FilesService } from '@infra/files/files.service';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';

export interface Conversation {
  id: string;
  employerUserId: string;
  candidateUserId: string;
  /** The other participant, from the caller's side - what a list actually renders. */
  counterpartUserId: string;
  counterpartName: string | null;
  lastMessageAt: Date | null;
  lastMessageBody: string | null;
  unreadCount: number;
  /** §9.1: a conversation whose interaction has ended is history, not a channel. */
  canSend: boolean;
  isBlocked: boolean;
  blockedByMe: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  senderUserId: string;
  body: string | null;
  fileId: string | null;
  fileName: string | null;
  /** Present only when the message carries one; scoped to this conversation. */
  downloadPath: string | null;
  /** §9.1's read state: has the *other* participant read this message? */
  isReadByRecipient: boolean;
  createdAt: Date;
}

interface ConversationRow {
  id: string;
  employer_user_id: string;
  candidate_user_id: string;
  last_message_at: Date | null;
  employer_read_at: Date | null;
  candidate_read_at: Date | null;
  counterpart_name: string | null;
  last_message_body: string | null;
  unread_count: string;
  blocked_by_me: boolean;
  blocked_by_anyone: boolean;
}

/**
 * Gated chat (§9.1).
 *
 * The gate is the whole design. §9.1: "Chat becomes available after an application,
 * invitation, or other permitted hiring interaction", and "closed or blocked interactions
 * remain in history but may become read-only". Both sentences are answered by asking
 * `HiringInteractionService` on **every send**, rather than by a flag written when the
 * conversation was created:
 *
 * - A flag would have to be un-set by everything that can end an interaction - a
 *   withdrawal, a declined invitation, a rejection - from four modules that have no reason
 *   to know chat exists. One of them would eventually forget, and the failure mode is a
 *   channel to somebody who has left.
 * - Asking live also makes the read-only rule free: the conversation and its messages are
 *   always readable, and only `send` consults the gate.
 *
 * The same service answers BR-09, which is the point of extracting it: an employer who may
 * read a candidate's phone number and an employer who may message them are the same
 * employer, and two definitions would eventually disagree.
 *
 * **Blocking** (§9.1) makes a conversation read-only for *both* sides, whoever blocked.
 * Letting the blocker keep sending would make "block" a mute, which is not what a person
 * reporting harassment is asking for.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly interactions: HiringInteractionService,
    private readonly files: FilesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Opens the conversation with this counterpart, or returns the existing one.
   *
   * Idempotent by the unique constraint on the pair: "start a chat" is a button somebody
   * taps twice, and there is only ever one thread between two people.
   */
  async open(
    userId: string,
    role: UserRole | null,
    counterpartUserId: string,
  ): Promise<Conversation> {
    const { employerUserId, candidateUserId } = sides(
      userId,
      role,
      counterpartUserId,
    );

    // §9.1's gate, at creation as well as at send: a conversation that could not accept a
    // message should not come into existence either.
    const interaction = await this.interactions.between(
      employerUserId,
      candidateUserId,
    );

    if (!interaction) {
      throw new ForbiddenError('chat.no_interaction');
    }

    const existing = await this.db
      .selectFrom('conversations')
      .select('id')
      .where('employer_user_id', '=', employerUserId)
      .where('candidate_user_id', '=', candidateUserId)
      .executeTakeFirst();

    if (existing) {
      return this.read(userId, role, existing.id);
    }

    const created = await this.db
      .insertInto('conversations')
      .values({
        employer_user_id: employerUserId,
        candidate_user_id: candidateUserId,
        opened_by_vacancy_id: await this.vacancyOf(interaction),
      })
      .onConflict((oc) =>
        oc
          .columns(['employer_user_id', 'candidate_user_id'])
          // A concurrent second tap loses the race and reads the winner's row rather
          // than failing: two people opening one thread is one thread.
          .doUpdateSet({ employer_user_id: employerUserId }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    return this.read(userId, role, created.id);
  }

  /** Both sides' conversation list, most recently active first (§9.1). */
  async list(userId: string, role: UserRole | null): Promise<Conversation[]> {
    const rows = await this.query(userId, role);

    return Promise.all(rows.map((row) => this.toConversation(row, userId)));
  }

  async read(
    userId: string,
    role: UserRole | null,
    conversationId: string,
  ): Promise<Conversation> {
    const rows = await this.query(userId, role, conversationId);
    const row = rows[0];

    // 404 for a conversation that is not the caller's: that one exists between two other
    // people is not information we owe (§11.1).
    if (!row) {
      throw new NotFoundError('chat.conversation_not_found');
    }

    return this.toConversation(row, userId);
  }

  /**
   * §9.1's message send.
   *
   * The gate is re-asked here rather than trusted from `open`, because an interaction can
   * end while a client holds the screen: a candidate withdraws, an invitation is declined,
   * and the thread becomes history mid-conversation. `Idempotency-Key` is what makes a
   * retry after a lost response safe (ARCHITECTURE.md §7 names message send explicitly).
   */
  async send(
    userId: string,
    role: UserRole | null,
    conversationId: string,
    input: { body?: string; fileId?: string },
    idempotencyKey?: string,
  ): Promise<Message> {
    const conversation = await this.read(userId, role, conversationId);

    if (conversation.isBlocked) {
      throw new ForbiddenError('chat.blocked');
    }

    if (!conversation.canSend) {
      throw new ConflictError('chat.read_only');
    }

    if (input.fileId) {
      await this.assertOwnFile(userId, input.fileId);
    }

    const id = await this.idempotency.run(
      idempotencyKey,
      userId,
      'chat.send',
      { conversationId, ...input },
      () => this.insertMessage(userId, conversationId, input),
    );

    const messages = await this.messages(userId, role, conversationId, {
      id,
    });
    const message = messages[0];

    if (!message) {
      throw new NotFoundError('chat.message_not_found');
    }

    return message;
  }

  private async insertMessage(
    senderUserId: string,
    conversationId: string,
    input: { body?: string; fileId?: string },
  ): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('messages')
        .values({
          conversation_id: conversationId,
          sender_user_id: senderUserId,
          body: input.body ?? null,
          file_id: input.fileId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Written with the message so a list cannot sort by an activity time the thread
      // does not have.
      await trx
        .updateTable('conversations')
        .set({ last_message_at: sql`now()` })
        .where('id', '=', conversationId)
        .execute();

      return created.id;
    });
  }

  /** One page of a thread, newest first (§9.1). Readable whether or not sending is. */
  async messages(
    userId: string,
    role: UserRole | null,
    conversationId: string,
    page: { limit?: number; before?: Date; id?: string } = {},
  ): Promise<Message[]> {
    const conversation = await this.read(userId, role, conversationId);
    const readAt =
      userId === conversation.employerUserId
        ? conversation.candidateUserId
        : conversation.employerUserId;

    let query = this.db
      .selectFrom('messages')
      .leftJoin('stored_files', 'stored_files.id', 'messages.file_id')
      .select([
        'messages.id',
        'messages.conversation_id',
        'messages.sender_user_id',
        'messages.body',
        'messages.file_id',
        'messages.created_at',
        'stored_files.file_name',
      ])
      .where('messages.conversation_id', '=', conversationId);

    if (page.id) {
      query = query.where('messages.id', '=', page.id);
    }

    if (page.before) {
      query = query.where('messages.created_at', '<', page.before);
    }

    const rows = await query
      .orderBy('messages.created_at', 'desc')
      .limit(page.limit ?? 50)
      .execute();

    // The counterpart's read timestamp decides §9.1's read state for messages *we* sent.
    const counterpartReadAt = await this.readTimestampOf(
      conversationId,
      readAt,
    );

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderUserId: row.sender_user_id,
      body: row.body,
      fileId: row.file_id,
      fileName: row.file_name,
      downloadPath: row.file_id
        ? `/conversations/${conversationId}/messages/${row.id}/file`
        : null,
      isReadByRecipient:
        row.sender_user_id === userId &&
        counterpartReadAt !== null &&
        counterpartReadAt >= row.created_at,
      createdAt: row.created_at,
    }));
  }

  /** §9.1's read state: everything up to now has been seen by this participant. */
  async markRead(
    userId: string,
    role: UserRole | null,
    conversationId: string,
  ): Promise<void> {
    const conversation = await this.read(userId, role, conversationId);
    const column =
      userId === conversation.employerUserId
        ? 'employer_read_at'
        : 'candidate_read_at';

    await this.db
      .updateTable('conversations')
      .set({ [column]: sql`now()` })
      .where('id', '=', conversationId)
      .execute();
  }

  /**
   * §9.1's block, and its removal.
   *
   * Read-only for both sides while it stands, whoever set it - a block that let the
   * blocker keep writing would be a mute, and that is not what somebody reporting
   * harassment is asking for. The messages stay readable: §9.1 keeps blocked interactions
   * in history, and a moderator reviewing the complaint needs them.
   */
  async block(
    userId: string,
    role: UserRole | null,
    conversationId: string,
    reason: string | null,
  ): Promise<void> {
    await this.read(userId, role, conversationId);

    await this.db
      .insertInto('conversation_blocks')
      .values({
        conversation_id: conversationId,
        blocked_by_user_id: userId,
        reason,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async unblock(
    userId: string,
    role: UserRole | null,
    conversationId: string,
  ): Promise<void> {
    await this.read(userId, role, conversationId);

    await this.db
      .deleteFrom('conversation_blocks')
      .where('conversation_id', '=', conversationId)
      .where('blocked_by_user_id', '=', userId)
      .execute();
  }

  /**
   * §9.1's "allow reporting", as a `complaints` row with `target_type = 'message'`.
   *
   * The generic complaints table M6 created for exactly this, so M10 reviews chat reports
   * through the same queue as vacancy reports rather than a second one.
   */
  async report(
    userId: string,
    role: UserRole | null,
    messageId: string,
    reason: string,
  ): Promise<string> {
    const message = await this.db
      .selectFrom('messages')
      .select(['id', 'conversation_id'])
      .where('id', '=', messageId)
      .executeTakeFirst();

    if (!message) {
      throw new NotFoundError('chat.message_not_found');
    }

    // Only a participant may report a message, and `read` is what checks that.
    await this.read(userId, role, message.conversation_id);

    const existing = await this.db
      .selectFrom('complaints')
      .select('id')
      .where('target_type', '=', 'message')
      .where('target_id', '=', messageId)
      .where('reporter_user_id', '=', userId)
      .where('status', '=', 'open')
      .executeTakeFirst();

    if (existing) {
      throw new ConflictError('complaint.already_reported');
    }

    const row = await this.db
      .insertInto('complaints')
      .values({
        target_type: 'message',
        target_id: messageId,
        reporter_user_id: userId,
        reason,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return row.id;
  }

  /**
   * The bytes of a message attachment, for the other participant.
   *
   * The third entitlement-bearing download route, and the same rule as the other two: the
   * entitlement comes from the conversation, so the route that serves it is the one that
   * can see it. `GET /files/:id/content` stays owner-only.
   */
  async downloadAttachment(
    userId: string,
    role: UserRole | null,
    conversationId: string,
    messageId: string,
  ): Promise<{ file: StoredFile; bytes: Buffer }> {
    await this.read(userId, role, conversationId);

    const message = await this.db
      .selectFrom('messages')
      .select(['file_id', 'sender_user_id'])
      .where('id', '=', messageId)
      .where('conversation_id', '=', conversationId)
      .executeTakeFirst();

    if (!message?.file_id) {
      throw new NotFoundError('file.not_found');
    }

    return this.files.readAsAuthorized(message.sender_user_id, message.file_id);
  }

  /**
   * The conversation list query, for one caller.
   *
   * One statement rather than a row per correlated read: the counterpart's name, the last
   * message, the unread count and both block flags all come back with the row, because a
   * chat list that needed four queries per thread would be the slowest screen in the app.
   */
  private async query(
    userId: string,
    role: UserRole | null,
    conversationId?: string,
  ): Promise<ConversationRow[]> {
    const isEmployer = role !== 'candidate';
    const mine = isEmployer
      ? sql`c.employer_user_id = ${userId}`
      : sql`c.candidate_user_id = ${userId}`;
    const readAt = isEmployer
      ? sql`c.employer_read_at`
      : sql`c.candidate_read_at`;
    const counterpartName = isEmployer
      ? sql`(SELECT cp.full_name FROM candidate_profiles cp WHERE cp.user_id = c.candidate_user_id)`
      : sql`(
          SELECT COALESCE(co.public_name, e.full_name) FROM employers e
          LEFT JOIN companies co ON co.employer_user_id = e.user_id
          WHERE e.user_id = c.employer_user_id
        )`;

    const result = await sql<ConversationRow>`
      SELECT c.id, c.employer_user_id, c.candidate_user_id, c.last_message_at,
        c.employer_read_at, c.candidate_read_at,
        ${counterpartName} AS counterpart_name,
        (
          SELECT m.body FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.created_at DESC LIMIT 1
        ) AS last_message_body,
        (
          SELECT count(*) FROM messages m
          WHERE m.conversation_id = c.id
            AND m.sender_user_id <> ${userId}
            AND (${readAt} IS NULL OR m.created_at > ${readAt})
        ) AS unread_count,
        EXISTS (
          SELECT 1 FROM conversation_blocks b
          WHERE b.conversation_id = c.id AND b.blocked_by_user_id = ${userId}
        ) AS blocked_by_me,
        EXISTS (
          SELECT 1 FROM conversation_blocks b WHERE b.conversation_id = c.id
        ) AS blocked_by_anyone
      FROM conversations c
      WHERE ${mine}
        ${conversationId ? sql`AND c.id = ${conversationId}::uuid` : sql``}
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT 100
    `.execute(this.db);

    return result.rows;
  }

  private async toConversation(
    row: ConversationRow,
    userId: string,
  ): Promise<Conversation> {
    // §9.1's read-only rule, asked live. A blocked conversation is read-only whoever set
    // the block.
    const interaction = await this.interactions.between(
      row.employer_user_id,
      row.candidate_user_id,
    );

    return {
      id: row.id,
      employerUserId: row.employer_user_id,
      candidateUserId: row.candidate_user_id,
      counterpartUserId:
        userId === row.employer_user_id
          ? row.candidate_user_id
          : row.employer_user_id,
      counterpartName: row.counterpart_name,
      lastMessageAt: row.last_message_at,
      lastMessageBody: row.last_message_body,
      unreadCount: Number(row.unread_count),
      canSend: interaction !== null && !row.blocked_by_anyone,
      isBlocked: row.blocked_by_anyone,
      blockedByMe: row.blocked_by_me,
    };
  }

  private async readTimestampOf(
    conversationId: string,
    participantUserId: string,
  ): Promise<Date | null> {
    const row = await this.db
      .selectFrom('conversations')
      .select(['employer_user_id', 'employer_read_at', 'candidate_read_at'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow();

    return row.employer_user_id === participantUserId
      ? row.employer_read_at
      : row.candidate_read_at;
  }

  /** An attachment is a file the sender owns - never one they merely know the id of. */
  private async assertOwnFile(userId: string, fileId: string): Promise<void> {
    const row = await this.db
      .selectFrom('stored_files')
      .select('id')
      .where('id', '=', fileId)
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundError('file.not_found');
    }
  }

  /** The vacancy an application-backed conversation started from, for its history. */
  private async vacancyOf(interaction: {
    kind: string;
    id: string;
  }): Promise<string | null> {
    if (interaction.kind === 'applications') {
      const row = await this.db
        .selectFrom('applications')
        .select('vacancy_id')
        .where('id', '=', interaction.id)
        .executeTakeFirst();

      return row?.vacancy_id ?? null;
    }

    const row = await this.db
      .selectFrom('invitations')
      .select('vacancy_id')
      .where('id', '=', interaction.id)
      .executeTakeFirst();

    return row?.vacancy_id ?? null;
  }
}

/**
 * Which side of the conversation the caller is on.
 *
 * A conversation is always (employer, candidate), so the caller's active role decides
 * which column they occupy - §2.3's multi-role account means the same person can be both
 * on different threads, and "what role is this user" is never the question (ARCHITECTURE
 * §8).
 */
function sides(
  userId: string,
  role: UserRole | null,
  counterpartUserId: string,
): { employerUserId: string; candidateUserId: string } {
  return role === 'candidate'
    ? { employerUserId: counterpartUserId, candidateUserId: userId }
    : { employerUserId: userId, candidateUserId: counterpartUserId };
}
