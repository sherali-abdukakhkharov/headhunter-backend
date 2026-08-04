import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';

import type { HealthResponseDto } from './dto/health-response.dto';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(KYSELY) private readonly db: Database) {}

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
      timestamp: new Date().toISOString(),
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
