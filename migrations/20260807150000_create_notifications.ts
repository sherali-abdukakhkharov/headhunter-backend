import { type Kysely, sql } from 'kysely';

/**
 * M9 schema: in-app notifications, their preferences, and device tokens (§9.2).
 *
 * **The row stores a message key and its parameters, never rendered text**, and that is
 * the decision everything else here follows from. §3.2 requires all four interface
 * variants, and `users.locale` can change *after* a notification is written - a candidate
 * who switches to Russian would otherwise scroll back through a list frozen in Uzbek. The
 * text is therefore resolved at read time from `infra/i18n/messages.ts`, the same catalog
 * and the same `x-lang` resolution every error message uses, so a notification cannot be
 * the one user-facing string written at a throw site (CLAUDE.md).
 *
 * `params` holds what the sentence interpolates - a vacancy title, an employer's name -
 * and `target_type` / `target_id` are the deep link, so tapping a notification opens the
 * thing it is about without the client parsing prose.
 *
 * **Preferences are per category, and one category cannot be turned off.** §9.2: "settings
 * may allow the user to disable non-critical categories, while security and account
 * notices remain enabled". `account` is that category, and the column that would let it be
 * disabled does not exist for it - the service refuses the write rather than storing a
 * preference nothing honours.
 *
 * Absence means enabled: a user who has never opened the settings screen gets everything,
 * which is the only default that does not silently lose the first notification.
 */
// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function up(db: Kysely<any>): Promise<void> {
  // §9.2's nine rows, as ten codes: "interview created or changed" is one line in the
  // specification and one *setting*, but two different sentences to a candidate, and a
  // notification that says "changed" about a new interview is a small lie.
  await db.schema
    .createType('notification_event')
    .asEnum([
      'application_created',
      'application_status_changed',
      'invitation_received',
      'invitation_responded',
      'message_received',
      'interview_scheduled',
      'interview_changed',
      'vacancy_moderated',
      'verification_decided',
      'account_action',
    ])
    .execute();

  // What a preference can switch off. Four are the user's choice; `account` is not.
  await db.schema
    .createType('notification_category')
    .asEnum([
      'applications',
      'invitations',
      'messages',
      'interviews',
      'account',
    ])
    .execute();

  await db.schema
    .createTable('notifications')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('event', sql`notification_event`, (col) => col.notNull())
    // Denormalized from the event on purpose: the mapping is a code decision, and a
    // notification already written must keep the category it was filtered by even if that
    // mapping is ever revised.
    .addColumn('category', sql`notification_category`, (col) => col.notNull())
    // The deep link. Not a foreign key, for the same reason `complaints.target_id` is not:
    // it points at one of several tables and must survive the target being removed.
    .addColumn('target_type', 'text')
    .addColumn('target_id', 'uuid')
    // What the sentence interpolates. Never the sentence itself - see the header.
    .addColumn('params', 'jsonb')
    .addColumn('read_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // The list, newest first - the only way this table is read in full.
  await sql`
    CREATE INDEX notifications_user_created_idx
      ON notifications (user_id, created_at DESC)
  `.execute(db);

  // The unread badge, which is polled far more often than the list is opened.
  await sql`
    CREATE INDEX notifications_unread_idx
      ON notifications (user_id)
      WHERE read_at IS NULL
  `.execute(db);

  await db.schema
    .createTable('notification_preferences')
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('category', sql`notification_category`, (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull())
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint('notification_preferences_pkey', [
      'user_id',
      'category',
    ])
    // §9.2's "security and account notices remain enabled", in the database rather than
    // only in the service: a row that disabled them cannot exist, so no write path - and
    // no manual fix - can produce a user who is not told they have been restricted.
    .addCheckConstraint(
      'notification_preferences_account_always_on',
      sql`category <> 'account' OR enabled`,
    )
    .execute();

  // --- device tokens (§9.2's push half) ------------------------------------
  await db.schema
    .createTable('device_tokens')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('user_id', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    // FCM's registration token. Unique across users, not per user: a phone handed to
    // somebody else keeps its token, and two accounts claiming it would push one person's
    // notifications to the other. The later registration wins.
    .addColumn('token', 'text', (col) => col.notNull().unique())
    .addColumn('platform', 'text', (col) => col.notNull())
    .addColumn('app_version', 'text')
    .addColumn('last_seen_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    // Set when FCM answers UNREGISTERED for it. Kept rather than deleted so a device that
    // reappears is recognised, and so "this user has no working device" is answerable.
    .addColumn('disabled_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'device_tokens_platform',
      sql`platform IN ('android', 'ios')`,
    )
    .execute();

  // Dispatch reads every live token of one user, and nothing else.
  await sql`
    CREATE INDEX device_tokens_user_live_idx
      ON device_tokens (user_id)
      WHERE disabled_at IS NULL
  `.execute(db);

  await db
    .updateTable('app_meta')
    .set({ value: '17', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}

// Kysely<any> is the required migration signature: the schema differs at every
// migration point, so the generated DB type cannot be used here.
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('device_tokens').execute();
  await db.schema.dropTable('notification_preferences').execute();
  await db.schema.dropTable('notifications').execute();
  await db.schema.dropType('notification_category').execute();
  await db.schema.dropType('notification_event').execute();

  await db
    .updateTable('app_meta')
    .set({ value: '16', updated_at: sql`now()` })
    .where('key', '=', 'schema_version')
    .execute();
}
