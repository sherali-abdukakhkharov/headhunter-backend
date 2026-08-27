import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { BadRequestError } from '@infra/api/exceptions/localized.exception';
import { type Database, KYSELY } from '@infra/db/database.module';
import type { AppEnv } from '@infra/env-schema';

/** The three numbers §10.5 lets an administrator set. */
export interface Pricing {
  /** What one Coin costs, in whole so'm. */
  coinPriceUzs: number;
  /** What a Candidate Unlock costs, in Coins (§6.6, BR-16). */
  candidateUnlockCoins: number;
  /** Coins a new employer is granted once (§6.6). */
  registrationBonusCoins: number;
}

/** The database keys, which are also what the audit entry names. */
const KEYS = {
  coinPriceUzs: 'coin_price_uzs',
  candidateUnlockCoins: 'candidate_unlock_coins',
  registrationBonusCoins: 'employer_registration_bonus_coins',
} as const;

/**
 * §10.5's money settings: Coin price, unlock cost, registration bonus.
 *
 * ## The environment variable is the default, the table holds only changes
 *
 * A fresh deployment behaves exactly as it did when these were environment variables
 * alone, an absent row means "nobody has changed this" rather than "unconfigured", and
 * deleting a row reverts to the *declared* default rather than to whatever somebody
 * remembers it used to be.
 *
 * ## Read per call, never cached
 *
 * These used to be constructor fields on `WalletService`, which is what made them
 * un-editable: a value read once at boot cannot change until the next one. A price the
 * administrator changed and the API kept quoting for hours would be worse than not
 * offering the screen.
 *
 * One indexed read of at most three rows, on paths that are already writing to the
 * ledger inside a transaction. If it ever matters, cache it *with* an invalidation —
 * not by moving it back into the constructor.
 *
 * ## Repricing never rewrites the past, and that is not this class's doing
 *
 * §10.5's "affects future transactions only" is already true and stays true without
 * anything here defending it: every `wallet_transactions` row and every `payment_orders`
 * row stores the price it was quoted at. This class decides what the *next* transaction
 * costs; what an earlier one cost is written down where it happened.
 */
@Injectable()
export class PricingService {
  private readonly defaults: Pricing;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    config: ConfigService<AppEnv, true>,
  ) {
    this.defaults = {
      coinPriceUzs: config.get('COIN_PRICE_UZS', { infer: true }),
      candidateUnlockCoins: config.get('CANDIDATE_UNLOCK_COINS', {
        infer: true,
      }),
      registrationBonusCoins: config.get('EMPLOYER_REGISTRATION_BONUS_COINS', {
        infer: true,
      }),
    };
  }

  /** Today's prices: whatever has been set, falling back to the declared default. */
  async current(): Promise<Pricing> {
    const rows = await this.db
      .selectFrom('platform_settings')
      .select(['key', 'value_int'])
      .where('key', 'in', Object.values(KEYS))
      .execute();

    const stored = new Map(rows.map((row) => [row.key, Number(row.value_int)]));

    return {
      coinPriceUzs: stored.get(KEYS.coinPriceUzs) ?? this.defaults.coinPriceUzs,
      candidateUnlockCoins:
        stored.get(KEYS.candidateUnlockCoins) ??
        this.defaults.candidateUnlockCoins,
      registrationBonusCoins:
        stored.get(KEYS.registrationBonusCoins) ??
        this.defaults.registrationBonusCoins,
    };
  }

  /** The values a deployment declared, for a screen that shows what a reset would give. */
  declared(): Pricing {
    return { ...this.defaults };
  }

  /**
   * Sets one or more, returning what changed so the caller can audit it.
   *
   * Only the keys actually supplied are written: a screen that submits every field would
   * otherwise record three changes when somebody edited one, and an audit entry that
   * names three numbers nobody touched is worse than none.
   *
   * The bounds are the env schema's, restated because a value typed into a screen has to
   * meet the same floor as one typed into a file. A **free unlock** in particular would
   * make BR-16's entitlement meaningless, which is why the schema refuses zero there.
   */
  async update(
    actorUserId: string,
    changes: Partial<Pricing>,
  ): Promise<Partial<Pricing>> {
    const bounds: Record<keyof Pricing, { min: number; message: string }> = {
      coinPriceUzs: {
        min: 1,
        message:
          'A Coin cannot be free: the ledger prices every purchase in so’m.',
      },
      candidateUnlockCoins: {
        min: 1,
        message:
          'A free unlock makes BR-16’s entitlement meaningless — §6.6 exists to charge for it.',
      },
      registrationBonusCoins: {
        min: 0,
        message: 'A negative bonus would be a charge for registering.',
      },
    };

    const applied: Partial<Pricing> = {};

    for (const key of Object.keys(KEYS) as (keyof Pricing)[]) {
      const value = changes[key];
      if (value === undefined) continue;

      if (!Number.isInteger(value) || value < bounds[key].min) {
        throw new BadRequestError('admin.pricing_out_of_range', {
          setting: key,
          minimum: bounds[key].min,
          reason: bounds[key].message,
        });
      }

      await this.db
        .insertInto('platform_settings')
        .values({
          key: KEYS[key],
          value_int: value,
          updated_by_user_id: actorUserId,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet({
            value_int: value,
            updated_by_user_id: actorUserId,
            updated_at: new Date(),
          }),
        )
        .execute();

      applied[key] = value;
    }

    return applied;
  }

  /**
   * Drops a setting so the declared default applies again.
   *
   * Reverting by *deleting* rather than by writing the default back: the two differ the
   * next time the deployment changes its mind about the default, and only one of them
   * follows it.
   */
  async reset(key: keyof Pricing): Promise<void> {
    await this.db
      .deleteFrom('platform_settings')
      .where('key', '=', KEYS[key])
      .execute();
  }
}
