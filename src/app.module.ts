import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AccountStatusGuard } from '@infra/api/guards/account-status.guard';
import { AuthorizationGuard } from '@infra/api/guards/authorization.guard';
import { RateLimitGuard } from '@infra/api/guards/rate-limit.guard';
import { RoleGuard } from '@infra/api/guards/role.guard';
import { DatabaseModule } from '@infra/db/database.module';
import { type AppEnv, envSchema } from '@infra/env-schema';
import { RateLimitModule } from '@infra/rate-limit/rate-limit.module';
import { AuthModule } from '@modules/auth/auth.module';
import { CandidateSearchModule } from '@modules/candidate-search/candidate-search.module';
import { CandidatesModule } from '@modules/candidates/candidates.module';
import { ApplicationsModule } from '@modules/applications/applications.module';
import { DictionariesModule } from '@modules/dictionaries/dictionaries.module';
import { DiscoveryModule } from '@modules/discovery/discovery.module';
import { EmployersModule } from '@modules/employers/employers.module';
import { FilesHttpModule } from '@modules/files/files.module';
import { ChatModule } from '@modules/chat/chat.module';
import { HealthModule } from '@modules/health/health.module';
import { InterviewsModule } from '@modules/interviews/interviews.module';
import { InvitationsModule } from '@modules/invitations/invitations.module';
import { SchemasModule } from '@modules/schemas/schemas.module';
import { UsersModule } from '@modules/users/users.module';
import { VacanciesModule } from '@modules/vacancies/vacancies.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validationSchema: envSchema,
      validationOptions: {
        // Report every bad variable at once rather than one per restart.
        abortEarly: false,
      },
    }),

    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Human-readable logs locally; raw JSON everywhere else so log
          // aggregators can parse them. Keyed off `LOG_PRETTY` rather than
          // `NODE_ENV`: `pino-pretty` is a devDependency, so the container - which
          // runs `NODE_ENV=development` deliberately, for the fixed OTP code - would
          // otherwise crash at boot on a transport it does not carry.
          transport: config.get('LOG_PRETTY', { infer: true })
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
          // Health polling would otherwise dominate log volume.
          autoLogging: {
            ignore: (req: { url?: string }) => req.url === '/health',
          },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),

    DatabaseModule,
    RateLimitModule,
    AuthModule,
    UsersModule,
    DictionariesModule,
    SchemasModule,
    CandidatesModule,
    EmployersModule,
    VacanciesModule,
    DiscoveryModule,
    ApplicationsModule,
    CandidateSearchModule,
    InvitationsModule,
    ChatModule,
    InterviewsModule,
    FilesHttpModule,
    HealthModule,
  ],
  providers: [
    // Order matters and is the guard stack of ARCHITECTURE.md §8: rate limit →
    // authenticated → role → account status. Nest runs global guards in
    // registration order, and each of the last three reads what the first ones
    // set.
    //
    // Rate limiting goes first so a flood is refused before it costs a JWT
    // verification and a session lookup - see RateLimitGuard for what that
    // ordering rules out.
    //
    // Global rather than per controller so protection is the default: a new
    // route is authenticated unless it carries @Public(), and BR-10's blocked
    // check covers every mutating route without each module remembering to ask.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthorizationGuard },
    { provide: APP_GUARD, useClass: RoleGuard },
    { provide: APP_GUARD, useClass: AccountStatusGuard },
  ],
})
export class AppModule {}
