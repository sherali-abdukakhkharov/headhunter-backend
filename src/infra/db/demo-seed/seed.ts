import type { INestApplicationContext } from '@nestjs/common';
import { sql } from 'kysely';

import type { Database } from '@infra/db/database.module';
import { KYSELY } from '@infra/db/database.module';
import type { LocaleCode } from '@infra/db/database.types';
import { FilesService } from '@infra/files/files.service';
import { AdminModerationService } from '@modules/admin/moderation.service';
import { AuthService } from '@modules/auth/auth.service';
import { AttachmentsService } from '@modules/candidates/attachments.service';
import { CandidatesService } from '@modules/candidates/candidates.service';
import { HistoryService } from '@modules/candidates/history.service';
import { ChatService } from '@modules/chat/chat.service';
import { DiscoveryService } from '@modules/discovery/discovery.service';
import { EmployersService } from '@modules/employers/employers.service';
import { VerificationService } from '@modules/employers/verification.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import { ApplicationsService } from '@modules/applications/applications.service';
import { VacanciesService } from '@modules/vacancies/vacancies.service';
import { WalletService } from '@modules/wallet/wallet.service';

import { seedAdministrators } from '../admin-seed';
import { avatarPng, pdfDocument, type PdfBlock } from './documents';
import {
  DEMO_ADMIN,
  DEMO_CANDIDATES,
  DEMO_EMPLOYERS,
  type DemoCandidate,
  type DemoEmployer,
  type DemoVacancy,
} from './people';

/**
 * Writes the demo world, through the same services a request would.
 *
 * **The deliberate opposite of `load-seed.ts`.** That one writes raw
 * `INSERT ... SELECT generate_series` because fifty thousand profiles through the
 * validator is hours of work to produce rows nobody reads; what it needs is volume.
 * This needs the reverse — ten accounts whose *content* is the whole point, and which
 * must be indistinguishable from accounts a person made. So every row here goes
 * through the production write path: profiles through `CandidatesService.patch` and
 * its validator, vacancies through submit and a real moderation decision, uploads
 * through `FilesService.store` and out to the Telegram file store.
 *
 * That costs about a minute and buys three things a direct insert cannot:
 * completeness percentages that match what the screens compute, status histories that
 * exist because the transition actually happened, and — the one that matters — proof
 * that the paths still work. A seeder that writes rows directly is a seeder that keeps
 * working after the code it is meant to demonstrate has broken.
 */

/** How far a `console.log` line indents, so a long run reads as a tree. */
function step(message: string): void {
  console.log(`  ${message}`);
}

/**
 * Dictionary codes resolved to the ids this database happens to have.
 *
 * Loaded once, whole. The alternative — a query per lookup — is a few hundred
 * round trips, and every one of them would be a chance to silently resolve to
 * nothing: the fixture is written in codes precisely so a missing one is a named
 * failure rather than an empty column.
 */
class Dictionary {
  private readonly byTypeAndCode = new Map<string, string>();

  static async load(db: Database): Promise<Dictionary> {
    const rows = await db
      .selectFrom('dictionary_items')
      .select(['id', 'type_code', 'code'])
      .where('is_active', '=', true)
      .execute();

    const dictionary = new Dictionary();

    for (const row of rows) {
      dictionary.byTypeAndCode.set(`${row.type_code}:${row.code}`, row.id);
    }

    return dictionary;
  }

  /** Resolves, or throws naming the code — never returns a value that binds nothing. */
  id(type: string, code: string): string {
    const found = this.byTypeAndCode.get(`${type}:${code}`);

    if (!found) {
      throw new Error(
        `Dictionary ${type} has no code "${code}". The fixture in people.ts ` +
          `refers to it; either the dictionary seed changed or the code is a typo.`,
      );
    }

    return found;
  }

  ids(type: string, codes: string[]): string[] {
    return codes.map((code) => this.id(type, code));
  }
}

/** Everything the seeder needs, resolved from the booted application once. */
interface Services {
  db: Database;
  dictionary: Dictionary;
  auth: AuthService;
  candidates: CandidatesService;
  history: HistoryService;
  attachments: AttachmentsService;
  employers: EmployersService;
  verification: VerificationService;
  moderation: AdminModerationService;
  vacancies: VacanciesService;
  applications: ApplicationsService;
  invitations: InvitationsService;
  discovery: DiscoveryService;
  chat: ChatService;
  wallet: WalletService;
  files: FilesService;
}

/** The device a seeded session claims to be, so the session list is not blank. */
const SEED_DEVICE = {
  fingerprint: 'demo-seed',
  name: 'Demo seed',
  platform: 'android',
  appVersion: 'seed',
};

export async function seedDemoWorld(
  app: INestApplicationContext,
): Promise<void> {
  const db = app.get<Database>(KYSELY);

  const services: Services = {
    db,
    dictionary: await Dictionary.load(db),
    auth: app.get(AuthService),
    candidates: app.get(CandidatesService),
    history: app.get(HistoryService),
    attachments: app.get(AttachmentsService),
    employers: app.get(EmployersService),
    verification: app.get(VerificationService),
    moderation: app.get(AdminModerationService),
    vacancies: app.get(VacanciesService),
    applications: app.get(ApplicationsService),
    invitations: app.get(InvitationsService),
    discovery: app.get(DiscoveryService),
    chat: app.get(ChatService),
    wallet: app.get(WalletService),
    files: app.get(FilesService),
  };

  console.log('Administrator');
  const adminId = await seedAdmin(services);

  console.log('Candidates');
  const candidateIds = new Map<string, string>();

  for (const person of DEMO_CANDIDATES) {
    candidateIds.set(person.key, await seedCandidate(services, person));
  }

  console.log('Employers');
  const employerIds = new Map<string, string>();
  const vacancyIds = new Map<string, string>();

  for (const employer of DEMO_EMPLOYERS) {
    const userId = await seedEmployer(services, employer, adminId, vacancyIds);
    employerIds.set(employer.key, userId);
  }

  console.log('What they are in the middle of');
  await seedInteractions(services, {
    adminId,
    candidateIds,
    employerIds,
    vacancyIds,
  });
}

// --- accounts -------------------------------------------------------------------

/**
 * Creates the account behind a phone number, through the login path.
 *
 * `completePhoneVerification` is what `POST /auth/otp/verify` calls, so the row it
 * writes is identical to a real registration's — including the
 * `account_status_history` entry BR-08 needs, which a direct insert would omit and
 * nobody would notice until an administrator opened the account's history.
 */
async function createAccount(
  services: Services,
  phone: string,
  locale: LocaleCode,
  roles: ('candidate' | 'employer')[],
): Promise<string> {
  await services.auth.completePhoneVerification(phone, locale, SEED_DEVICE);

  const user = await services.db
    .selectFrom('users')
    .select('id')
    .where('phone', '=', phone)
    .executeTakeFirstOrThrow();

  if (roles.length > 0) {
    await services.auth.selectRoles(user.id, roles);
  }

  return user.id;
}

/** Records the fixed code, which is the only thing that makes the account reachable. */
async function recordDemoLogin(
  services: Services,
  phone: string,
  code: string,
  label: string,
): Promise<void> {
  await services.db
    .insertInto('demo_accounts')
    .values({ phone, code, label })
    .onConflict((oc) => oc.column('phone').doUpdateSet({ code, label }))
    .execute();
}

/**
 * The administrator, through the existing configured-administrator seeder.
 *
 * Reused rather than reimplemented: `admin-seed.ts` already creates the account,
 * grants the role that no route grants (§10), writes the name, and is idempotent and
 * tested. The demo administrator is exactly a configured administrator that happens
 * to be configured from a fixture instead of from an environment variable.
 */
async function seedAdmin(services: Services): Promise<string> {
  await seedAdministrators(services.db, [
    { phone: DEMO_ADMIN.phone, fullName: DEMO_ADMIN.fullName },
  ]);

  const user = await services.db
    .updateTable('users')
    .set({ locale: DEMO_ADMIN.locale })
    .where('phone', '=', DEMO_ADMIN.phone)
    .returning('id')
    .executeTakeFirstOrThrow();

  await recordDemoLogin(
    services,
    DEMO_ADMIN.phone,
    DEMO_ADMIN.code,
    DEMO_ADMIN.fullName,
  );

  step(`${DEMO_ADMIN.fullName}`);

  return user.id;
}

// --- candidates -----------------------------------------------------------------

async function seedCandidate(
  services: Services,
  person: DemoCandidate,
): Promise<string> {
  const { dictionary } = services;
  const userId = await createAccount(services, person.phone, person.locale, [
    'candidate',
  ]);

  // Written in two patches rather than one, and not for convenience: the profile's
  // *category* comes from its primary occupation, and the category decides which
  // fields exist. A single body carrying both the occupation and its category's
  // fields is validated against whichever category the profile had before the call.
  await services.candidates.patch(userId, {
    full_name: person.fullName,
    date_of_birth: person.dateOfBirth,
    gender_id: dictionary.id('gender', person.genderCode),
    region_id: dictionary.id('region', person.regionCode),
    district_id: dictionary.id('region', person.districtCode),
    settlement: person.settlement,
    primary_occupation_id: dictionary.id('occupation', person.occupationCode),
  });

  const rest: Record<string, unknown> = {
    occupation_level_id: dictionary.id(
      'skill_level',
      person.occupationLevelCode,
    ),
    additional_occupation_ids: dictionary.ids(
      'occupation',
      person.additionalOccupationCodes,
    ),
    willing_to_relocate: person.willingToRelocate,
    willing_to_travel: person.willingToTravel,
    skills: person.skills.map((skill) => ({
      itemId: dictionary.id('skill', skill.code),
      levelId: dictionary.id('skill_level', skill.levelCode),
    })),
    languages: person.languages.map((language) => ({
      itemId: dictionary.id('language', language.code),
      levelId: dictionary.id('language_level', language.levelCode),
    })),
    employment_type_ids: dictionary.ids(
      'employment_type',
      person.employmentTypeCodes,
    ),
    work_format_ids: dictionary.ids('work_format', person.workFormatCodes),
  };

  if (person.salaryTo > 0) {
    rest.salary = {
      from: person.salaryFrom,
      to: person.salaryTo,
      periodId: dictionary.id('payment_period', person.salaryPeriodCode),
      isNegotiable: false,
    };
  }

  if (person.availableFrom) {
    rest.available_from = person.availableFrom;
  }

  for (const [code, value] of Object.entries(person.attributes)) {
    // A dictionary-backed field names its own dictionary; see `DemoAttribute`.
    rest[code] =
      typeof value === 'object'
        ? dictionary.ids(value.dictionary, value.codes)
        : value;
  }

  await services.candidates.patch(userId, rest);

  for (const job of person.experience) {
    await services.history.addExperience(userId, {
      employerName: job.employerName,
      roleTitle: job.roleTitle,
      occupationId: job.occupationCode
        ? dictionary.id('occupation', job.occupationCode)
        : undefined,
      startedOn: job.startedOn,
      endedOn: job.endedOn ?? null,
      isCurrent: job.isCurrent ?? false,
      responsibilities: job.responsibilities,
    });
  }

  for (const school of person.education) {
    await services.history.addEducation(userId, {
      levelId: dictionary.id('education_level', school.levelCode),
      institution: school.institution,
      specialization: school.specialization,
      graduationYear: school.graduationYear,
    });
  }

  if (person.wantsPhoto) {
    await services.attachments.upload(userId, 'photo', {
      bytes: avatarPng(person.initials, person.ground),
      originalName: `${slug(person.fullName)}-photo.png`,
      mimeType: 'image/png',
    });
  }

  if (person.wantsCv) {
    await services.attachments.upload(userId, 'cv', {
      bytes: pdfDocument(curriculumVitae(person)),
      originalName: `${slug(person.fullName)}-cv.pdf`,
      mimeType: 'application/pdf',
    });
  }

  await services.candidates.setVisibility(userId, person.visibility);
  await recordDemoLogin(services, person.phone, person.code, person.fullName);

  const profile = await services.candidates.read(userId);
  step(
    `${person.fullName} — ${profile.completeness.percent}% complete, ` +
      `${person.visibility}`,
  );

  return userId;
}

/** The CV a candidate would have uploaded, written from the profile they filled in. */
function curriculumVitae(person: DemoCandidate): PdfBlock[] {
  const blocks: PdfBlock[] = [
    { kind: 'title', text: person.fullName },
    { kind: 'muted', text: `${person.headline} — ${person.settlement}` },
    { kind: 'muted', text: 'JobBridge demo profile. Not a real person.' },
    { kind: 'gap' },
  ];

  if (person.summary) {
    blocks.push({ kind: 'heading', text: 'Summary' });

    for (const line of wrap(person.summary, 78)) {
      blocks.push({ kind: 'line', text: line });
    }
  }

  if (person.experience.length > 0) {
    blocks.push({ kind: 'heading', text: 'Experience' });

    for (const job of person.experience) {
      const until = job.isCurrent ? 'present' : (job.endedOn ?? '');
      blocks.push({
        kind: 'line',
        text: `${job.startedOn} - ${until}   ${job.roleTitle}, ${job.employerName}`,
      });

      for (const line of wrap(job.responsibilities, 88)) {
        blocks.push({ kind: 'muted', text: line });
      }
    }
  }

  if (person.education.length > 0) {
    blocks.push({ kind: 'heading', text: 'Education' });

    for (const school of person.education) {
      blocks.push({
        kind: 'line',
        text: `${school.graduationYear}   ${school.specialization}, ${school.institution}`,
      });
    }
  }

  if (person.skills.length > 0) {
    blocks.push({ kind: 'heading', text: 'Skills' });

    for (const line of wrap(
      person.skills.map((s) => `${s.code} (${s.levelCode})`).join(', '),
      78,
    )) {
      blocks.push({ kind: 'line', text: line });
    }
  }

  blocks.push({ kind: 'heading', text: 'Languages' });
  blocks.push({
    kind: 'line',
    text: person.languages.map((l) => `${l.code} (${l.levelCode})`).join(', '),
  });

  return blocks;
}

// --- employers ------------------------------------------------------------------

async function seedEmployer(
  services: Services,
  employer: DemoEmployer,
  adminId: string,
  vacancyIds: Map<string, string>,
): Promise<string> {
  const { dictionary } = services;
  const userId = await createAccount(
    services,
    employer.phone,
    employer.locale,
    ['employer'],
  );

  const logoFileId = employer.wantsLogo
    ? (
        await services.files.store(userId, 'logo', {
          bytes: avatarPng(employer.initials, employer.ground, 384),
          originalName: `${slug(employer.publicName ?? employer.contactName)}-logo.png`,
          mimeType: 'image/png',
        })
      ).id
    : null;

  await services.employers.upsert(userId, employer.type, {
    contactPhone: employer.contactPhone,
    regionId: dictionary.id('region', employer.regionCode),
    districtId: dictionary.id('region', employer.districtCode),
    address: employer.address,
    description: employer.description,
    fullName: employer.contactName,
    legalName: employer.legalName ?? null,
    publicName: employer.publicName ?? null,
    industryId: employer.industryCode
      ? dictionary.id('industry', employer.industryCode)
      : null,
    contactPersonName: employer.contactName,
    logoFileId,
  });

  // Evidence first, then the submission that points at it — the order the client
  // uses, and the order `VerificationService.submit` requires: it checks that every
  // required purpose is present among files this user owns.
  const evidence: string[] = [];
  const required =
    employer.type === 'company'
      ? ['company_registration', 'id_document']
      : ['id_document'];

  for (const purposeCode of required) {
    const stored = await services.files.store(userId, purposeCode, {
      bytes: pdfDocument(evidenceDocument(employer, purposeCode)),
      originalName: `${slug(employer.publicName ?? employer.contactName)}-${purposeCode}.pdf`,
      mimeType: 'application/pdf',
    });

    evidence.push(stored.id);
  }

  await services.verification.submit(userId, evidence);

  if (employer.verification === 'verified') {
    // The real administrator decision, not a status written into the column: it is
    // what leaves the history row, the audit entry and the employer's notification.
    await services.moderation.decideVerification(
      adminId,
      userId,
      'verified',
      null,
    );
  }

  await recordDemoLogin(
    services,
    employer.phone,
    employer.code,
    `${employer.publicName ?? employer.contactName} (${employer.contactName})`,
  );

  step(
    `${employer.publicName ?? employer.contactName} — ${employer.type}, ` +
      `${employer.verification}`,
  );

  for (const vacancy of employer.vacancies) {
    vacancyIds.set(
      vacancy.key,
      await seedVacancy(services, userId, vacancy, adminId),
    );
  }

  return userId;
}

/** The registration certificate or ID page an employer would have photographed. */
function evidenceDocument(
  employer: DemoEmployer,
  purposeCode: string,
): PdfBlock[] {
  const name = employer.legalName ?? employer.contactName;

  if (purposeCode === 'company_registration') {
    return [
      { kind: 'title', text: 'Certificate of State Registration' },
      {
        kind: 'muted',
        text: 'DEMO DOCUMENT — generated for JobBridge testing',
      },
      { kind: 'gap' },
      { kind: 'line', text: `Legal entity: ${name}` },
      { kind: 'line', text: `Trading name: ${employer.publicName ?? '-'}` },
      { kind: 'line', text: `Address: ${employer.address}` },
      { kind: 'line', text: 'Registration number: DEMO-0000000' },
      { kind: 'line', text: 'Taxpayer identification number: 000 000 000' },
      { kind: 'gap' },
      {
        kind: 'muted',
        text: 'This document is generated fixture data. It certifies nothing.',
      },
    ];
  }

  return [
    { kind: 'title', text: 'Identity document' },
    { kind: 'muted', text: 'DEMO DOCUMENT — generated for JobBridge testing' },
    { kind: 'gap' },
    { kind: 'line', text: `Holder: ${employer.contactName}` },
    { kind: 'line', text: 'Document: AA 0000000' },
    { kind: 'line', text: 'Issued by: DEMO' },
    { kind: 'gap' },
    {
      kind: 'muted',
      text: 'This document is generated fixture data. It identifies nobody.',
    },
  ];
}

async function seedVacancy(
  services: Services,
  employerUserId: string,
  vacancy: DemoVacancy,
  adminId: string,
): Promise<string> {
  const { dictionary } = services;
  const created = (await services.vacancies.create(employerUserId)).aggregate
    .row;

  // Two patches, for the reason the candidate profile needs two: the occupation
  // decides the category, and the category decides which fields are known.
  await services.vacancies.patch(employerUserId, created.id, {
    occupation_id: dictionary.id('occupation', vacancy.occupationCode),
  });

  const body: Record<string, unknown> = {
    title: vacancy.title,
    description: vacancy.description,
    worker_count: vacancy.workerCount,
    region_id: dictionary.id('region', vacancy.regionCode),
    district_id: dictionary.id('region', vacancy.districtCode),
    address: vacancy.address,
    employment_type_ids: dictionary.ids(
      'employment_type',
      vacancy.employmentTypeCodes,
    ),
    work_format_ids: dictionary.ids('work_format', vacancy.workFormatCodes),
    salary: {
      from: vacancy.salaryFrom,
      to: vacancy.salaryTo,
      periodId: dictionary.id('payment_period', vacancy.salaryPeriodCode),
      isNegotiable: false,
    },
  };

  if (vacancy.shiftCodes) {
    body.shift_ids = dictionary.ids('shift', vacancy.shiftCodes);
  }

  if (vacancy.hoursPerDay !== undefined) {
    body.hours_per_day = vacancy.hoursPerDay;
  }

  if (vacancy.startsOn) body.starts_on = vacancy.startsOn;
  if (vacancy.endsOn) body.ends_on = vacancy.endsOn;
  if (vacancy.deadlineOn) body.deadline_on = vacancy.deadlineOn;

  if (vacancy.skills) {
    body.skills = vacancy.skills.map((skill) => ({
      itemId: dictionary.id('skill', skill.code),
      levelId: dictionary.id('skill_level', skill.levelCode),
      is_mandatory: skill.mandatory,
    }));
  }

  if (vacancy.languages) {
    body.languages = vacancy.languages.map((language) => ({
      itemId: dictionary.id('language', language.code),
      levelId: dictionary.id('language_level', language.levelCode),
      is_mandatory: language.mandatory,
    }));
  }

  await services.vacancies.patch(employerUserId, created.id, body);

  if (vacancy.land === 'draft') {
    step(`  ${vacancy.title} — draft`);

    return created.id;
  }

  await services.vacancies.submit(employerUserId, created.id);

  if (vacancy.land === 'under_moderation') {
    step(`  ${vacancy.title} — waiting for moderation`);

    return created.id;
  }

  await services.moderation.moderateVacancy(
    adminId,
    created.id,
    'active',
    null,
  );

  if (vacancy.land === 'paused') {
    await services.vacancies.changeStatus(
      employerUserId,
      created.id,
      'paused',
      null,
    );
  }

  step(`  ${vacancy.title} — ${vacancy.land}`);

  return created.id;
}

// --- what they are in the middle of ----------------------------------------------

interface World {
  adminId: string;
  candidateIds: Map<string, string>;
  employerIds: Map<string, string>;
  vacancyIds: Map<string, string>;
}

/**
 * The state a tester actually needs: queues that are not empty, applications part-way
 * through, and a conversation with something in it.
 *
 * All of it through the real transitions, so every screen that reads a history — the
 * application timeline, the employer's audit trail, the candidate's own record of what
 * they applied to — has something true to show.
 */
async function seedInteractions(
  services: Services,
  world: World,
): Promise<void> {
  const candidate = (key: string) => must(world.candidateIds, key);
  const employer = (key: string) => must(world.employerIds, key);
  const vacancy = (key: string) => must(world.vacancyIds, key);

  // Four applications on the main vacancy, walked to four different stages, so the
  // employer's pipeline has a column in each state rather than a list of new ones.
  const interviewing = await services.applications.apply(
    candidate('c_professional'),
    vacancy('v_backend'),
    'I have been building payment services on NestJS for three years and would ' +
      'like to work on the Payme integration.',
  );

  await services.applications.moveStage(
    employer('e_verified'),
    interviewing.id,
    'viewed',
    null,
  );
  await services.applications.moveStage(
    employer('e_verified'),
    interviewing.id,
    'shortlisted',
    null,
  );
  await services.applications.moveStage(
    employer('e_verified'),
    interviewing.id,
    'interview',
    null,
  );

  const viewed = await services.applications.apply(
    candidate('c_accountant'),
    vacancy('v_backend'),
    'Готов рассмотреть переход в ИТ-компанию; опыт автоматизации отчётности.',
  );

  await services.applications.moveStage(
    employer('e_verified'),
    viewed.id,
    'viewed',
    null,
  );

  const rejected = await services.applications.apply(
    candidate('c_industrial'),
    vacancy('v_backend'),
    'Men payvandchiman, lekin dasturlashni o‘rganyapman.',
  );

  await services.applications.moveStage(
    employer('e_verified'),
    rejected.id,
    'rejected',
    'The role needs commercial backend experience.',
  );

  // A hire, on the individual employer's seasonal vacancy: `hired` is terminal and
  // increments the vacancy's counter, which nothing else here exercises.
  const hired = await services.applications.apply(
    candidate('c_service'),
    vacancy('v_harvest'),
    'Men mavsumga tayyorman, Quvada yashayman.',
  );

  await services.applications.moveStage(
    employer('e_individual'),
    hired.id,
    'viewed',
    null,
  );
  await services.applications.moveStage(
    employer('e_individual'),
    hired.id,
    'offer',
    null,
  );
  await services.applications.moveStage(
    employer('e_individual'),
    hired.id,
    'hired',
    null,
  );

  // And one left untouched, so there is a genuinely new application to open.
  await services.applications.apply(
    candidate('c_seasonal'),
    vacancy('v_harvest'),
    'Traktorchiman, sakkiz kishilik brigadam bor.',
  );

  step('5 applications across 5 stages');

  // §8: an invitation the candidate has not answered yet.
  await services.invitations.invite(employer('e_verified'), {
    candidateUserId: candidate('c_accountant'),
    vacancyId: vacancy('v_backend'),
    message:
      'Мы увидели ваш профиль. Готовы обсудить позицию аналитика данных?',
  });

  step('1 invitation awaiting an answer');

  // §6.6: a paid unlock, so the employer's wallet has a spend as well as its bonus
  // and the candidate's contacts are actually released to them.
  await services.wallet.unlock(
    employer('e_verified'),
    candidate('c_professional'),
  );

  step('1 candidate unlocked, paid from the registration bonus');

  // §9: a conversation with something in it. Only possible after the application
  // above, which is what §9.1 gates a conversation on.
  const conversation = await services.chat.open(
    employer('e_verified'),
    'employer',
    candidate('c_professional'),
  );

  const script: [string, 'employer' | 'candidate', string][] = [
    [
      employer('e_verified'),
      'employer',
      'Salom Aziza! Rezyumengiz bilan tanishdik. Payments jamoasi uchun ' +
        'suhbatlashsak bo‘ladimi?',
    ],
    [
      candidate('c_professional'),
      'candidate',
      'Salom! Albatta, qiziqarli. Qaysi kun qulay bo‘ladi?',
    ],
    [
      employer('e_verified'),
      'employer',
      'Payshanba kuni soat 15:00 da onlayn uchrashsak. Havolani yuboraman.',
    ],
    [
      candidate('c_professional'),
      'candidate',
      'Kelishdik, rahmat. Payshanba 15:00 da tayyor bo‘laman.',
    ],
  ];

  for (const [userId, role, body] of script) {
    await services.chat.send(userId, role, conversation.id, { body });
  }

  step('1 conversation, 4 messages');

  // §10.2's complaint queue, from the account with nothing else to do.
  await services.discovery.report(
    candidate('c_incomplete'),
    vacancy('v_harvest'),
    'The pay in the description does not match what was said by phone.',
  );

  step('1 complaint awaiting review');
}

// --- helpers ---------------------------------------------------------------------

function must<K, V>(map: Map<K, V>, key: K): V {
  const found = map.get(key);

  if (found === undefined) {
    throw new Error(`Demo fixture is missing "${String(key)}"`);
  }

  return found;
}

/** A file name that survives `safeFileName` unchanged, so the stored name is readable. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Greedy wrap, because the PDF writer places one line at a time. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }

  if (line) lines.push(line);

  return lines;
}

/** Exported for the teardown, which counts what it is about to remove. */
export async function countDemoRows(db: Database): Promise<number> {
  const row = await db
    .selectFrom('users')
    .select(sql<string>`count(*)`.as('count'))
    .where('phone', 'like', '+99801%')
    .executeTakeFirstOrThrow();

  return Number(row.count);
}
