import { type Kysely, sql } from 'kysely';

/**
 * M8 schema, first half: gated chat (§9.1).
 *
 * "Chat becomes available after an application, invitation, or other permitted hiring
 * interaction." The load-bearing consequence is what is **not** in this schema: there is
 * no column recording that a conversation is permitted. Permission is a live question
 * asked of `applications` and `invitations` on every send, because the interaction can
 * end after the conversation starts - §9.1's "closed or blocked interactions remain in
 * history but may become read-only" is exactly that case, and a stored flag would have to
 * be un-set by whatever ends the interaction, from four different places.
 *
 * Three more decisions worth stating.
 *
 * - **One conversation per (employer, candidate) pair**, not per vacancy. A candidate who
 *   applies to two of an employer's vacancies is one person to talk to; §9.1 describes a
 *   chat between two people, and the vacancy context is already visible in the
 *   application list. A unique constraint makes "start a chat" idempotent.
 * - **Read state is two timestamps on the conversation, not a `message_reads` table.**
 *   There are exactly two participants, so "has the other side read this" is one
 *   comparison against one column, and an unread count is one indexed query. A join table
 *   would carry a row per message per person to answer the same question.
 * - **There is no `delivered` state**, and that is deliberate. §9.1 asks for sent,
 *   delivered and read "where supported by the backend" - delivery is a property of push,
 *   which is M9, and a column set at the same moment as `created_at` would be a fake
 *   answer to a real question. It arrives with the dispatcher that can honestly set it.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // conversations -----------------------------------------------------------
  await db.schema
    .createTable('conversations')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('employer_user_id', 'uuid', (col) =>
      col.notNull().references('employers.user_id').onDelete('cascade'),
    )
    .addColumn('candidate_user_id', 'uuid', (col) =>
      col
        .notNull()
        .references('candidate_profiles.user_id')
        .onDelete('cascade'),
    )
    // Which interaction opened it, kept for the history §9.1 requires rather than for
    // authorization - the live check reads the interaction tables. Nullable and
    // `set null`, because the conversation outlives the vacancy it started from.
    .addColumn('opened_by_vacancy_id', 'uuid', (col) =>
      col.references('vacancies.id').onDelete('set null'),
    )
    // Sorting the list by activity without touching `messages` per row.
    .addColumn('last_message_at', 'timestamptz')
    // §9.1's read state, per participant. Everything up to this instant has been read.
    .addColumn('employer_read_at', 'timestamptz')
    .addColumn('candidate_read_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('conversations_pair_key', [
      'employer_user_id',
      'candidate_user_id',
    ])
    .execute();

  // Each side's list, most recently active first.
  await sql`
    CREATE INDEX conversations_employer_active_idx
      ON conversations (employer_user_id, last_message_at DESC NULLS LAST)
  `.execute(db);

  await sql`
    CREATE INDEX conversations_candidate_active_idx
      ON conversations (candidate_user_id, last_message_at DESC NULLS LAST)
  `.execute(db);

  // messages ----------------------------------------------------------------
  await db.schema
    .createTable('messages')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('sender_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('body', 'text')
    // §9.1's "approved attachments". One per message: a message with three files is three
    // messages, and the alternative is a join table for a case nothing in the
    // specification asks for.
    //
    // RESTRICT, like verification evidence: a file must not vanish from under a message
    // that quotes it. A purge therefore deletes the conversation before the files, the
    // same ordering M4 recorded for submissions.
    .addColumn('file_id', 'uuid', (col) =>
      col.references('stored_files.id').onDelete('restrict'),
    )
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // A message says something or carries something. An empty one is a bug in a client,
    // and it would show up in the other person's list as a mystery.
    .addCheckConstraint(
      'messages_not_empty',
      sql`(body IS NOT NULL AND length(btrim(body)) > 0) OR file_id IS NOT NULL`,
    )
    .execute();

  // The thread itself, and the unread count, which reads the same index backwards.
  await sql`
    CREATE INDEX messages_conversation_created_idx
      ON messages (conversation_id, created_at DESC)
  `.execute(db);

  // conversation_blocks -----------------------------------------------------
  // §9.1's "allow reporting and blocking". Reporting is a `complaints` row with
  // `target_type = 'message'` - the generic complaints table M6 created for exactly this.
  await db.schema
    .createTable('conversation_blocks')
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('blocked_by_user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Blocking twice is blocking once.
    .addPrimaryKeyConstraint('conversation_blocks_pkey', [
      'conversation_id',
      'blocked_by_user_id',
    ])
    .execute();

  await db
    .updateTable('app_meta')
    .set({ value: '13', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('conversation_blocks').execute();
  await db.schema.dropTable('messages').execute();
  await db.schema.dropTable('conversations').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '12', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
