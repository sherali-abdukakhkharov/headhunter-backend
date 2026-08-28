import { ConfigService } from '@nestjs/config';

import type { Database } from '@infra/db/database.module';
import { demoPhone } from '@infra/phone/demo-phone';

import { DemoAccountService } from './demo-account.service';

/**
 * The two gates in front of the fixed-code lookup.
 *
 * The assertions that matter are the ones counting **queries**, not the ones checking
 * return values. "Returns null for a real number" would still pass if the service read
 * `demo_accounts` for every login on the instance; what makes this safe to leave in the
 * code permanently is that a real number never reaches the table at all.
 */
describe('DemoAccountService', () => {
  function build(enabled: boolean, row?: { code: string; label: string }) {
    const queries: string[] = [];

    const db = {
      selectFrom(table: string) {
        queries.push(table);

        return {
          select: () => ({
            where: () => ({
              executeTakeFirst: () => Promise.resolve(row),
            }),
          }),
        };
      },
    } as unknown as Database;

    const config = {
      get: () => enabled,
    } as unknown as ConfigService<never, true>;

    return {
      service: new DemoAccountService(db, config),
      queries,
    };
  }

  it('never queries for a number outside the reserved range', async () => {
    const { service, queries } = build(true, { code: '111111', label: 'x' });

    expect(await service.find('+998901234567')).toBeNull();
    expect(queries).toEqual([]);
  });

  it('never queries when the flag is off', async () => {
    const { service, queries } = build(false, { code: '111111', label: 'x' });

    expect(await service.find(demoPhone('1000001'))).toBeNull();
    expect(queries).toEqual([]);
  });

  it('returns the fixed code for a seeded number', async () => {
    const { service, queries } = build(true, {
      code: '111111',
      label: 'Aziza Karimova',
    });

    expect(await service.find(demoPhone('1000001'))).toEqual({
      code: '111111',
      label: 'Aziza Karimova',
    });
    expect(queries).toEqual(['demo_accounts']);
  });

  it('returns null for a reserved number with no row', async () => {
    // The rollback leaves the range reserved and the rows gone. The caller turns this
    // into a refusal rather than an SMS to a number that cannot receive one.
    const { service } = build(true, undefined);

    expect(await service.find(demoPhone('1000001'))).toBeNull();
  });

  it('reports the range as reserved even with the flag off', () => {
    // Switching the feature off does not make an unallocatable number reachable, so
    // the caller must still refuse rather than pay for a message.
    const { service } = build(false);

    expect(service.isReserved(demoPhone('1000001'))).toBe(true);
    expect(service.isReserved('+998901234567')).toBe(false);
  });
});
