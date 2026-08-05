import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import { type Database, KYSELY } from '@infra/db/database.module';
import type { DB } from '@infra/db/database.types';

import { HealthService } from './health.service';

/**
 * Simulates an unreachable database by refusing to hand out a connection -
 * the same way the real pg driver fails when Postgres is down.
 */
class UnreachableDriver extends DummyDriver {
  override acquireConnection(): Promise<never> {
    return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
  }
}

/**
 * A real Kysely instance over a dummy driver: queries are genuinely compiled
 * (so a malformed query would still fail the test) but nothing connects.
 */
function buildDb(behaviour: 'reachable' | 'unreachable'): Database {
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        behaviour === 'reachable' ? new DummyDriver() : new UnreachableDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

async function buildService(
  behaviour: 'reachable' | 'unreachable',
): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: KYSELY, useValue: buildDb(behaviour) },
      {
        provide: ConfigService,
        useValue: { get: () => 'Asia/Tashkent' },
      },
    ],
  }).compile();

  return moduleRef.get(HealthService);
}

describe('HealthService', () => {
  it('reports ok when the database responds', async () => {
    const service = await buildService('reachable');

    const result = await service.check();

    expect(result.status).toBe('ok');
    expect(result.database).toBe('up');
    expect(result.version).toBeDefined();
    // docs/API_CONTRACTS.md §2: explicit numeric offset, never `Z`. Asserted
    // here because health is the endpoint most likely to be written with a
    // convenient `toISOString()`.
    expect(result.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/,
    );
    expect(result.timestamp).not.toContain('Z');
  });

  it('reports degraded instead of throwing when the database is down', async () => {
    const service = await buildService('unreachable');

    const result = await service.check();

    expect(result.status).toBe('degraded');
    expect(result.database).toBe('down');
    // Still a well-formed response - monitoring needs the payload, not a 500.
    expect(result.version).toBeDefined();
  });
});
