import { randomUUID } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@infra/api/exceptions/localized.exception';
import type { Database } from '@infra/db/database.module';
import { createIntTestDb, fixturePhone } from '@infra/db/testing/int-db';
import type { AppEnv } from '@infra/env-schema';
import { IdempotencyService } from '@infra/idempotency/idempotency.service';
import { HiringInteractionService } from '@infra/privacy/hiring-interaction.service';
import { ApplicationsService } from '@modules/applications/applications.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { DictionariesService } from '@modules/dictionaries/dictionaries.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import { FieldValidatorService } from '@modules/schemas/field-validator.service';
import { SchemasService } from '@modules/schemas/schemas.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { NotificationsService } from '@modules/notifications/notifications.service';
import { NoopPushSender } from '@modules/notifications/push/noop-push.sender';
import { PushDispatcher } from '@modules/notifications/push/push-dispatcher.service';

import { MESSAGE_ATTACHMENT_PURPOSE, ChatService } from './chat.service';

/**
 * Gated chat against a real Postgres (§9.1).
 *
 * Everything here is database-shaped, which is why there is no unit suite beside it: the
 * gate is a query across two other modules' tables, read state is a timestamp comparison,
 * the unread count is an aggregate, and "one thread between two people" is a unique
 * constraint. Over `DummyDriver` all of it would compile and none of it would be checked.
 */

let db: Database;
let destroy: () => Promise<void>;
let employers: EmployersService;
let candidates: CandidatesService;
let vacancies: VacanciesService;
let applications: ApplicationsService;
let invitations: InvitationsService;
let chat: ChatService;

/**
 * The real notifications service over a no-op sender.
 *
 * Real rather than stubbed, so every one of these suites also exercises the notification
 * write M9 added to the flow it covers; no-op sender, so nothing reaches FCM.
 */
let notifications: NotificationsService;

const users: string[] = [];

const config = {
  get: (key: string) =>
    key === 'PLATFORM_TIME_ZONE'
      ? 'Asia/Tashkent'
      : key === 'MODERATION_ENABLED' || key === 'EMPLOYER_VERIFICATION_ENABLED'
        ? false
        : key === 'FILE_MAX_SIZE_BYTES'
          ? 10_485_760
          : undefined,
} as unknown as ConfigService<AppEnv, true>;

/** What `filesStub.store` was last called with. */
let lastStore: { ownerUserId: string; purposeCode: string } | null = null;

const filesStub = {
  readAsAuthorized: (ownerUserId: string, fileId: string) =>
    Promise.resolve({
      file: {
        id: fileId,
        purposeId: 'p',
        fileName: 'plan.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        createdAt: new Date(),
      },
      bytes: Buffer.from(ownerUserId.slice(0, 3)),
    }),

  // Stubbed rather than real: the real one uploads to Telegram, and what these tests
  // are about is which purpose the chat module asks for and who it lets ask.
  store: async (
    ownerUserId: string,
    purposeCode: string,
    upload: { originalName: string; mimeType: string },
  ) => {
    lastStore = { ownerUserId, purposeCode };

    // A real row, not a minted id: `assertOwnFile` on the send path is a real query,
    // and it is the thing that binds an upload to the message that carries it. A stub
    // returning an id nothing owns would make the two calls untestable together.
    const id = await storedFile(ownerUserId, purposeCode, upload.originalName);

    return {
      id,
      purposeId: 'p',
      fileName: upload.originalName,
      mimeType: upload.mimeType,
      sizeBytes: 128,
      createdAt: new Date(),
    };
  },
} as never;

beforeAll(() => {
  ({ db, destroy } = createIntTestDb());

  notifications = new NotificationsService(
    db,
    new PushDispatcher(db, new NoopPushSender()),
  );

  const dictionaries = new DictionariesService(db);
  const schemas = new SchemasService(db, dictionaries, config);
  const validator = new FieldValidatorService(dictionaries, config);

  employers = new EmployersService(db);
  candidates = new CandidatesService(db, schemas, validator);
  vacancies = new VacanciesService(
    db,
    schemas,
    validator,
    employers,
    notifications,
    config,
  );
  applications = new ApplicationsService(
    db,
    new IdempotencyService(db),
    notifications,
    config,
  );
  invitations = new InvitationsService(
    db,
    employers,
    dictionaries,
    new IdempotencyService(db),
    notifications,
    config,
  );
  chat = new ChatService(
    db,
    new HiringInteractionService(db),
    filesStub,
    new IdempotencyService(db),
    notifications,
  );
});

afterAll(async () => {
  for (const id of users) {
    await db.deleteFrom('employers').where('user_id', '=', id).execute();
    await db
      .deleteFrom('stored_files')
      .where('owner_user_id', '=', id)
      .execute();
    await db.deleteFrom('users').where('id', '=', id).execute();
  }

  await destroy();
});

async function seededId(type: string, code: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('code', '=', code)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function anyActive(type: string): Promise<string> {
  const row = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', type)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function region(): Promise<{ regionId: string; districtId: string }> {
  const parent = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('type_code', '=', 'region')
    .where('parent_id', 'is', null)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  const child = await db
    .selectFrom('dictionary_items')
    .select('id')
    .where('parent_id', '=', parent.id)
    .where('is_active', '=', true)
    .executeTakeFirstOrThrow();

  return { regionId: parent.id, districtId: child.id };
}

async function newUser(role: 'candidate' | 'employer'): Promise<string> {
  const phone = fixturePhone();
  const row = await db
    .insertInto('users')
    .values({ phone, locale: 'uz-Latn' })
    .returning('id')
    .executeTakeFirstOrThrow();

  await db.insertInto('user_roles').values({ user_id: row.id, role }).execute();
  users.push(row.id);

  return row.id;
}

async function newEmployer(): Promise<string> {
  const employerUserId = await newUser('employer');
  const { regionId } = await region();

  await employers.upsert(employerUserId, 'company', {
    contactPhone: '+998901234567',
    regionId,
    legalName: 'Uzum Market LLC',
    publicName: 'Uzum',
    industryId: await anyActive('industry'),
    contactPersonName: 'Anvar Karimov',
    description: 'Marketplace operator hiring call-centre staff.',
  });

  await new VerificationService(db, employers, notifications, config).submit(
    employerUserId,
    [await storedFile(employerUserId, 'company_registration')],
  );

  return employerUserId;
}

async function storedFile(
  ownerUserId: string,
  purposeCode: string,
  fileName = 'plan.pdf',
): Promise<string> {
  const unique = randomUUID();
  const row = await db
    .insertInto('stored_files')
    .values({
      owner_user_id: ownerUserId,
      purpose_id: await seededId('file_purpose', purposeCode),
      telegram_file_id: `fake-${unique}`,
      telegram_file_unique_id: unique,
      telegram_message_id: '1',
      file_name: fileName,
      mime_type: 'application/pdf',
      size_bytes: 128,
      sha256: unique.replace(/-/g, '').repeat(2).slice(0, 64),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

async function newCandidate(): Promise<string> {
  const userId = await newUser('candidate');
  const { regionId, districtId } = await region();

  await candidates.patch(userId, {
    full_name: 'Anvar Karimov',
    date_of_birth: '1996-04-12',
    region_id: regionId,
    district_id: districtId,
    primary_occupation_id: await seededId('occupation', 'call_centre_operator'),
  });
  await candidates.setVisibility(userId, 'searchable');

  return userId;
}

async function publishedVacancy(employerUserId: string): Promise<string> {
  const { regionId, districtId } = await region();
  const vacancyId = (await vacancies.create(employerUserId)).aggregate.row.id;

  await vacancies.patch(employerUserId, vacancyId, {
    occupation_id: await seededId('occupation', 'call_centre_operator'),
    title: 'Call-centre operator',
    description: 'Answer customer calls in Russian and Uzbek, politely.',
    worker_count: 3,
    region_id: regionId,
    district_id: districtId,
    employment_type_ids: [await seededId('employment_type', 'full_time')],
    salary: {
      from: 4_000_000,
      to: 6_000_000,
      periodId: await seededId('payment_period', 'monthly'),
      isNegotiable: false,
    },
  });
  await vacancies.submit(employerUserId, vacancyId);

  return vacancyId;
}

/** The state §9.1 opens chat in: a candidate who applied to this employer. */
async function applied(): Promise<{
  employerUserId: string;
  candidateUserId: string;
  applicationId: string;
}> {
  const employerUserId = await newEmployer();
  const candidateUserId = await newCandidate();
  const vacancyId = await publishedVacancy(employerUserId);
  const application = await applications.apply(
    candidateUserId,
    vacancyId,
    null,
  );

  return { employerUserId, candidateUserId, applicationId: application.id };
}

describe('§9.1’s gate', () => {
  it('refuses a conversation with no hiring interaction', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();

    // A verified employer who found somebody in search still may not message them: §9.1
    // opens chat *after* an application or invitation, not after a search.
    await expect(
      chat.open(employerUserId, 'employer', candidateUserId),
    ).rejects.toThrow(ForbiddenError);
  });

  it('opens once an application exists, from either side', async () => {
    const { employerUserId, candidateUserId } = await applied();

    const fromEmployer = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    const fromCandidate = await chat.open(
      candidateUserId,
      'candidate',
      employerUserId,
    );

    // One thread between two people, whoever taps first.
    expect(fromCandidate.id).toBe(fromEmployer.id);
    expect(fromEmployer.canSend).toBe(true);
  });

  it('opens on an accepted invitation, and not on a sent one', async () => {
    const employerUserId = await newEmployer();
    const candidateUserId = await newCandidate();
    const vacancyId = await publishedVacancy(employerUserId);
    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      vacancyId,
    });

    await expect(
      chat.open(employerUserId, 'employer', candidateUserId),
    ).rejects.toThrow(ForbiddenError);

    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    // §8.2: acceptance "enables the corresponding communication flow".
    await expect(
      chat.open(employerUserId, 'employer', candidateUserId),
    ).resolves.toMatchObject({ canSend: true });
  });

  it('never shows a conversation to somebody outside it', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    const stranger = await newEmployer();

    await expect(
      chat.read(stranger, 'employer', conversation.id),
    ).rejects.toThrow(NotFoundError);
    await expect(
      chat.messages(stranger, 'employer', conversation.id),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('sending and reading (§9.1)', () => {
  it('carries a message both ways and counts what the other side has not read', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );

    await chat.send(employerUserId, 'employer', conversation.id, {
      body: 'Could you start on Monday?',
    });
    await chat.send(candidateUserId, 'candidate', conversation.id, {
      body: 'Yes, Monday works.',
    });

    const forEmployer = await chat.read(
      employerUserId,
      'employer',
      conversation.id,
    );
    expect(forEmployer.unreadCount).toBe(1);
    expect(forEmployer.lastMessageBody).toBe('Yes, Monday works.');
    expect(forEmployer.lastMessageAt).not.toBeNull();

    await chat.markRead(employerUserId, 'employer', conversation.id);
    expect(
      (await chat.read(employerUserId, 'employer', conversation.id))
        .unreadCount,
    ).toBe(0);
  });

  it('reports read state on the sender’s own messages only', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    await chat.send(employerUserId, 'employer', conversation.id, {
      body: 'Are you available this week?',
    });

    const beforeRead = await chat.messages(
      employerUserId,
      'employer',
      conversation.id,
    );
    expect(beforeRead[0].isReadByRecipient).toBe(false);

    await chat.markRead(candidateUserId, 'candidate', conversation.id);

    const afterRead = await chat.messages(
      employerUserId,
      'employer',
      conversation.id,
    );
    expect(afterRead[0].isReadByRecipient).toBe(true);

    // The candidate looking at the same message sees no read flag on it: it is not
    // theirs, and §9.1's read state is about what the *other* side has seen.
    const asCandidate = await chat.messages(
      candidateUserId,
      'candidate',
      conversation.id,
    );
    expect(asCandidate[0].isReadByRecipient).toBe(false);
  });

  it('returns the thread newest first, and pages backwards', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    await chat.send(employerUserId, 'employer', conversation.id, {
      body: 'first',
    });
    const second = await chat.send(
      employerUserId,
      'employer',
      conversation.id,
      { body: 'second' },
    );

    const page = await chat.messages(
      employerUserId,
      'employer',
      conversation.id,
      { limit: 1 },
    );
    expect(page.map((m) => m.body)).toEqual(['second']);

    const older = await chat.messages(
      employerUserId,
      'employer',
      conversation.id,
      { before: second.createdAt },
    );
    expect(older.map((m) => m.body)).toEqual(['first']);
  });

  it('replays an interrupted send under the same idempotency key', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    const key = randomUUID();
    const body = { body: 'Sent once, retried twice.' };

    const first = await chat.send(
      employerUserId,
      'employer',
      conversation.id,
      body,
      key,
    );
    const replay = await chat.send(
      employerUserId,
      'employer',
      conversation.id,
      body,
      key,
    );

    expect(replay.id).toBe(first.id);
    expect(
      await chat.messages(employerUserId, 'employer', conversation.id),
    ).toHaveLength(1);
  });

  it('carries an attachment the sender owns, and refuses one they do not', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      candidateUserId,
      'candidate',
      employerUserId,
    );
    const own = await storedFile(candidateUserId, 'cv');
    const somebodyElses = await storedFile(await newCandidate(), 'cv');

    const message = await chat.send(
      candidateUserId,
      'candidate',
      conversation.id,
      { fileId: own },
    );

    expect(message.downloadPath).toBe(
      `/conversations/${conversation.id}/messages/${message.id}/file`,
    );

    // Knowing a file id is not owning it.
    await expect(
      chat.send(candidateUserId, 'candidate', conversation.id, {
        fileId: somebodyElses,
      }),
    ).rejects.toThrow(NotFoundError);

    // The recipient can read it - the entitlement comes from the conversation.
    await expect(
      chat.downloadAttachment(
        employerUserId,
        'employer',
        conversation.id,
        message.id,
      ),
    ).resolves.toMatchObject({ file: { mimeType: 'application/pdf' } });
  });

  it('refuses an attachment download to somebody outside the conversation', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      candidateUserId,
      'candidate',
      employerUserId,
    );
    const message = await chat.send(
      candidateUserId,
      'candidate',
      conversation.id,
      { fileId: await storedFile(candidateUserId, 'cv') },
    );
    const stranger = await newEmployer();

    await expect(
      chat.downloadAttachment(
        stranger,
        'employer',
        conversation.id,
        message.id,
      ),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('sending a file (§9.1 "approved attachments")', () => {
  const upload = {
    bytes: Buffer.from('%PDF-1.4'),
    originalName: 'offer.pdf',
    mimeType: 'application/pdf',
  };

  beforeEach(() => {
    lastStore = null;
  });

  /** An open conversation over a live application, which is what §9.1's gate wants. */
  async function conversation(): Promise<{
    employerUserId: string;
    candidateUserId: string;
    applicationId: string;
    conversationId: string;
  }> {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const opened = await chat.open(employerUserId, 'employer', candidateUserId);

    return {
      employerUserId,
      candidateUserId,
      applicationId,
      conversationId: opened.id,
    };
  }

  it('stores under the message purpose, not a profile one', async () => {
    const { employerUserId, conversationId } = await conversation();

    const stored = await chat.uploadAttachment(
      employerUserId,
      'employer',
      conversationId,
      upload,
    );

    expect(stored.fileName).toBe('offer.pdf');
    // The whole of this change. `evidence` would have worked and would have made one
    // code mean two authorization rules.
    expect(lastStore).toEqual({
      ownerUserId: employerUserId,
      purposeCode: MESSAGE_ATTACHMENT_PURPOSE,
    });
  });

  it('is offered to the candidate side too', async () => {
    const { candidateUserId, conversationId } = await conversation();

    await chat.uploadAttachment(
      candidateUserId,
      'candidate',
      conversationId,
      upload,
    );

    expect(lastStore?.ownerUserId).toBe(candidateUserId);
  });

  it('lets the uploaded file be sent, and only by its owner', async () => {
    const { employerUserId, candidateUserId, conversationId } =
      await conversation();

    const stored = await chat.uploadAttachment(
      employerUserId,
      'employer',
      conversationId,
      upload,
    );
    const message = await chat.send(
      employerUserId,
      'employer',
      conversationId,
      {
        fileId: stored.id,
      },
    );

    expect(message.fileId).toBe(stored.id);

    // `assertOwnFile` is what binds the two calls: an id is not an entitlement.
    await expect(
      chat.send(candidateUserId, 'candidate', conversationId, {
        fileId: stored.id,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses a stranger with the same 404 a read gets', async () => {
    const { conversationId } = await conversation();
    const stranger = await newCandidate();

    await expect(
      chat.uploadAttachment(stranger, 'candidate', conversationId, upload),
    ).rejects.toThrow(NotFoundError);
    // Nothing was stored, which is the half a thrown error does not prove.
    expect(lastStore).toBeNull();
  });

  it('refuses a blocked conversation', async () => {
    const { employerUserId, candidateUserId, conversationId } =
      await conversation();
    // The fourth argument is the moderator-facing reason, not a flag.
    await chat.block(candidateUserId, 'candidate', conversationId, null);

    await expect(
      chat.uploadAttachment(employerUserId, 'employer', conversationId, upload),
    ).rejects.toThrow(ForbiddenError);
    expect(lastStore).toBeNull();
  });

  it('refuses a thread that has become history', async () => {
    // The reason the gate is re-asked here rather than trusted from when the screen
    // opened: bytes accepted into a read-only thread could never be sent.
    const { candidateUserId, applicationId, conversationId } =
      await conversation();
    await applications.withdraw(candidateUserId, applicationId);

    await expect(
      chat.uploadAttachment(
        candidateUserId,
        'candidate',
        conversationId,
        upload,
      ),
    ).rejects.toThrow(ConflictError);
    expect(lastStore).toBeNull();
  });
});

describe('§9.1’s read-only rule', () => {
  it('closes sending when the candidate withdraws, and keeps the history', async () => {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    await chat.send(employerUserId, 'employer', conversation.id, {
      body: 'Are you still interested?',
    });

    await applications.withdraw(candidateUserId, applicationId);

    // The interaction ended, so the channel does - but "remain in history" is the other
    // half of the sentence, and the thread is still readable by both.
    const after = await chat.read(employerUserId, 'employer', conversation.id);
    expect(after.canSend).toBe(false);
    await expect(
      chat.send(employerUserId, 'employer', conversation.id, {
        body: 'Hello?',
      }),
    ).rejects.toThrow(ConflictError);
    expect(
      await chat.messages(candidateUserId, 'candidate', conversation.id),
    ).toHaveLength(1);
  });

  it('reopens when a new interaction begins', async () => {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    await applications.withdraw(candidateUserId, applicationId);

    const invitation = await invitations.invite(employerUserId, {
      candidateUserId,
      occupationId: await seededId('occupation', 'call_centre_operator'),
    });
    await invitations.respond(candidateUserId, invitation.id, 'accepted', null);

    // Asked live, so a new interaction restores the channel with no repair step. A stored
    // flag would have needed somebody to remember to set it back.
    expect(
      (await chat.read(employerUserId, 'employer', conversation.id)).canSend,
    ).toBe(true);
  });

  it('keeps a rejected applicant’s thread open, so a decision can be explained', async () => {
    const { employerUserId, candidateUserId, applicationId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );

    await applications.moveStage(
      employerUserId,
      applicationId,
      'rejected',
      'Looking for more phone experience.',
    );

    // Deliberate: only a withdrawal takes back the request to be contacted, and §8.1 gives
    // rejection an optional message. It is also exactly what BR-09 does with the phone
    // number, which is the point of one shared definition.
    expect(
      (await chat.read(employerUserId, 'employer', conversation.id)).canSend,
    ).toBe(true);
  });
});

describe('blocking and reporting (§9.1)', () => {
  it('makes the conversation read-only for both sides, whoever blocked', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      candidateUserId,
      'candidate',
      employerUserId,
    );

    await chat.block(candidateUserId, 'candidate', conversation.id, 'Rude.');

    // The blocker too: a block that let them keep writing would be a mute.
    await expect(
      chat.send(candidateUserId, 'candidate', conversation.id, { body: 'hi' }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      chat.send(employerUserId, 'employer', conversation.id, { body: 'hi' }),
    ).rejects.toThrow(ForbiddenError);

    const forEmployer = await chat.read(
      employerUserId,
      'employer',
      conversation.id,
    );
    expect(forEmployer.isBlocked).toBe(true);
    // Who blocked whom is not something the other side is told beyond the fact of it.
    expect(forEmployer.blockedByMe).toBe(false);
  });

  it('restores sending when the block is lifted', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      candidateUserId,
      'candidate',
      employerUserId,
    );
    await chat.block(candidateUserId, 'candidate', conversation.id, null);
    await chat.unblock(candidateUserId, 'candidate', conversation.id);

    await expect(
      chat.send(employerUserId, 'employer', conversation.id, {
        body: 'Sorry about that.',
      }),
    ).resolves.toMatchObject({ body: 'Sorry about that.' });
  });

  it('keeps a blocked thread readable, because a moderator needs it', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    await chat.send(employerUserId, 'employer', conversation.id, {
      body: 'Something objectionable.',
    });
    await chat.block(candidateUserId, 'candidate', conversation.id, 'Rude.');

    expect(
      await chat.messages(candidateUserId, 'candidate', conversation.id),
    ).toHaveLength(1);
  });

  it('files a report as a complaint, once per person per message', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    const message = await chat.send(
      employerUserId,
      'employer',
      conversation.id,
      { body: 'Something objectionable.' },
    );

    const complaintId = await chat.report(
      candidateUserId,
      'candidate',
      message.id,
      'This message is abusive.',
    );

    const complaint = await db
      .selectFrom('complaints')
      .select(['target_type', 'target_id', 'status'])
      .where('id', '=', complaintId)
      .executeTakeFirstOrThrow();

    // The generic complaints table M6 built, so M10 reviews chat reports through the same
    // queue as vacancy reports.
    expect(complaint).toEqual({
      target_type: 'message',
      target_id: message.id,
      status: 'open',
    });

    await expect(
      chat.report(candidateUserId, 'candidate', message.id, 'Again.'),
    ).rejects.toThrow(ConflictError);
  });

  it('refuses a report from somebody outside the conversation', async () => {
    const { employerUserId, candidateUserId } = await applied();
    const conversation = await chat.open(
      employerUserId,
      'employer',
      candidateUserId,
    );
    const message = await chat.send(
      employerUserId,
      'employer',
      conversation.id,
      { body: 'Private.' },
    );
    const stranger = await newCandidate();

    await expect(
      chat.report(stranger, 'candidate', message.id, 'Nosy.'),
    ).rejects.toThrow(NotFoundError);
  });
});
