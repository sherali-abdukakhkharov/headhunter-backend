import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import type { HealthResponseDto } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeZone: string;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  /**
   * Reports service and dependency health.
   *
   * Never throws: a failing dependency is reported as `down` with an overall
   * status of `degraded`, so monitoring can distinguish "the service is up but
   * Postgres is unreachable" from "the service is not responding at all".
   */
  async check(): Promise<HealthResponseDto> {
    const database = await this.checkDatabase();

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      version: process.env.npm_package_version ?? '0.0.1',
      // Not `toISOString()`: that emits `Z`, and docs/API_CONTRACTS.md §2 freezes
      // every timestamp in every response to an explicit numeric offset. Health
      // is no exception - one endpoint allowed to differ is how the rule stops
      // being a rule.
      timestamp: formatWithOffset(new Date(), this.timeZone),
    };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    try {
      await sql`select 1`.execute(this.db);
      return 'up';
    } catch (error) {
      this.logger.error('Database health check failed', error);
      return 'down';
    }
  }
}
