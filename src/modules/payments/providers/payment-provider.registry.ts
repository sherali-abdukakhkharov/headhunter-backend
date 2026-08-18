import { Injectable, Logger } from '@nestjs/common';

import { ClickProvider } from './click.provider';
import type { PaymentProvider, PaymentProviderId } from './payment-provider';
import { PaymeProvider } from './payme.provider';

/**
 * The payment adapters, and which of them this deployment can actually use.
 *
 * **Every adapter is registered whether or not it is configured**, and that is the design
 * rather than an oversight. A callback route has to be able to answer a request for a
 * provider with no credentials - recording the event and refusing in that provider's own
 * format - and an adapter with no secret cannot return a verified command, so refusing is
 * the only thing it is able to do. That is the `LoggingSmsSender` rule ("never claim a
 * success") reached by construction instead of by a second class per provider.
 *
 * `available()` is the narrower question, and it is the one the top-up route asks: an
 * employer must never be offered a checkout that cannot be honoured. §6.7 lets the client
 * present the providers from the Wallet top-up flow, so the client reads this list rather
 * than hard-coding two buttons - which is also how a §12.7 storefront decision becomes a
 * configuration change.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger(PaymentProviderRegistry.name);

  private readonly providers: ReadonlyMap<PaymentProviderId, PaymentProvider>;

  constructor(payme: PaymeProvider, click: ClickProvider) {
    this.providers = new Map<PaymentProviderId, PaymentProvider>([
      [payme.id, payme],
      [click.id, click],
    ]);

    const available = this.available();

    if (available.length === 0) {
      // Announced at boot rather than discovered by the first employer who tries to buy
      // Coins, the same way a missing Eskiz account announces itself.
      this.logger.warn(
        'No payment provider is configured: Coin top-up is unavailable and every ' +
          'callback will be refused. Set PAYME_MERCHANT_ID and PAYME_MERCHANT_KEY, or ' +
          'CLICK_SERVICE_ID, CLICK_MERCHANT_ID and CLICK_SECRET_KEY.',
      );
    } else {
      this.logger.log(`Payment providers configured: ${available.join(', ')}`);
    }
  }

  /** The adapter, configured or not. Present for every provider the enum names. */
  get(id: PaymentProviderId): PaymentProvider {
    const provider = this.providers.get(id);

    if (!provider) {
      // Unreachable while the map is built from the same enum the route validates against.
      // Thrown rather than returned so a missing adapter cannot look like a refusal.
      throw new Error(`No adapter registered for payment provider ${id}`);
    }

    return provider;
  }

  /** The providers an employer may be offered, in a stable order for the client. */
  available(): PaymentProviderId[] {
    return [...this.providers.values()]
      .filter((provider) => provider.configured)
      .map((provider) => provider.id);
  }

  isAvailable(id: PaymentProviderId): boolean {
    return this.get(id).configured;
  }
}
