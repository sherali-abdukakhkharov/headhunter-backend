import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { AppEnv } from '@infra/env-schema';

import type { DB } from './database.types';

/** DI token for the Kysely instance. */
export const KYSELY = 'KYSELY';

/** Typed Kysely handle for this database. Inject with `@Inject(KYSELY)`. */
export type Database = Kysely<DB>;

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): Database => {
        const pool = new Pool({
          host: config.get('DB_HOST', { infer: true }),
          port: config.get('DB_PORT', { infer: true }),
          database: config.get('DB_NAME', { infer: true }),
          user: config.get('DB_USER', { infer: true }),
          password: config.get('DB_PASSWORD', { infer: true }),
          max: 10,
          // Fail fast instead of queuing forever when Postgres is unreachable.
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
        });

        return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
      },
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /** Closes the connection pool so the process can exit cleanly. */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
