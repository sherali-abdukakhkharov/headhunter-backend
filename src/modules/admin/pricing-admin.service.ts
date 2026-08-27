import { Inject, Injectable } from '@nestjs/common';

import { type Database, KYSELY } from '@infra/db/database.module';
import { type Pricing, PricingService } from '@modules/wallet/pricing.service';

import { AUDIT_ACTIONS, AuditService } from './audit.service';

export interface PricingView {
  current: Pricing;
  /** What the deployment declared, so a screen can say what a reset would give. */
  declared: Pricing;
}

/**
 * §10.5's pricing editor: the same shape as [AdminWalletsService], for the same
 * reason — the controller stays a mapper and the decision is somewhere a test can
 * reach it.
 *
 * ## One audit row per setting that actually moved
 *
 * A screen that submits all three fields would otherwise record three decisions
 * when somebody edited one, and a log that says three numbers changed when one
 * did is the kind of noise that stops people reading it. So the before-values are
 * read first and each unchanged field is dropped.
 *
 * ## Nothing here reaches backwards
 *
 * §10.5's "affects future transactions only" needs no defending: every
 * `wallet_transactions` row and every `payment_orders` row stores the price it was
 * quoted at. This changes what the *next* transaction costs.
 */
@Injectable()
export class PricingAdminService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly pricing: PricingService,
    private readonly audit: AuditService,
  ) {}

  async read(): Promise<PricingView> {
    return {
      current: await this.pricing.current(),
      declared: this.pricing.declared(),
    };
  }

  async update(
    actorUserId: string,
    changes: Partial<Pricing>,
    reason?: string | null,
  ): Promise<PricingView> {
    const previous = await this.pricing.current();
    const applied = await this.pricing.update(actorUserId, changes);

    for (const [setting, to] of Object.entries(applied)) {
      const from = previous[setting as keyof Pricing];
      if (from === to) continue;

      await this.db.transaction().execute((trx) =>
        this.audit.record(trx, {
          actorUserId,
          action: AUDIT_ACTIONS.pricingChanged,
          targetType: 'platform_setting',
          // A setting is named by its key and `target_id` is a uuid column, so
          // the key travels in `details` with the numbers it sits between.
          targetId: null,
          reason: reason ?? null,
          details: { setting, from, to },
        }),
      );
    }

    return this.read();
  }
}
