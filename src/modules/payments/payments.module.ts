import { Module } from '@nestjs/common';

import { WalletModule } from '@modules/wallet/wallet.module';

import { PaymentOrdersService } from './payment-orders.service';
import { PaymentsController } from './payments.controller';
import { PaymentsCallbackController } from './payments-callback.controller';
import { ClickProvider } from './providers/click.provider';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { PaymeProvider } from './providers/payme.provider';

/**
 * Coin top-up through Payme and CLICK (M13, §6.7, §12.6, §12.7).
 *
 * **Both adapters are always registered, configured or not.** Which of them a deployment can
 * actually sell through is `PaymentProviderRegistry.available()`, and an adapter with no
 * credentials can only refuse - it has nothing to verify a signature against. That is the
 * seam shape `SmsSender` and `PushSender` established: the flow is complete and testable
 * before a merchant account exists, and connecting one is configuration rather than code
 * (docs/PAYMENTS.md).
 *
 * `WalletModule` because a top-up ends in the ledger, and the credit has to happen in the
 * same transaction as the order reaching `paid`. The dependency points this way on purpose:
 * the wallet knows nothing about payments, which is what §12.7 means by keeping the ledger
 * provider-agnostic - a store build adds a fourth adapter here and changes nothing there.
 *
 * Two controllers rather than one, because their authentication models have nothing in
 * common: `PaymentsController` is employer-only and bearer-authenticated, and
 * `PaymentsCallbackController` is public and authenticated by each provider's own scheme.
 * Keeping them apart is what makes it true that no route an employer's client can reach is
 * on the credit path.
 */
@Module({
  imports: [WalletModule],
  controllers: [PaymentsController, PaymentsCallbackController],
  providers: [
    PaymentOrdersService,
    PaymentProviderRegistry,
    PaymeProvider,
    ClickProvider,
  ],
  exports: [PaymentOrdersService],
})
export class PaymentsModule {}
