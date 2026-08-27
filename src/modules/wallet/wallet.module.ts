import { Module } from '@nestjs/common';

import { EmployersModule } from '@modules/employers/employers.module';

import { WalletController } from './wallet.controller';
import { PricingService } from './pricing.service';
import { WalletService } from './wallet.service';

/**
 * The employer Coin wallet (M12, §6.6).
 *
 * Exported, because three other modules need the entitlement check and one needs the
 * bonus:
 *
 * - `AuthModule` grants BR-15's registration bonus inside the same transaction as the
 *   employer role, so an employer without a wallet cannot exist.
 * - `ApplicationsModule`, `ChatModule` and `InvitationsModule` ask `hasUnlock` before
 *   revealing contact details, a CV, or opening a conversation (§11.1, §9.1, §8.2).
 *
 * What it deliberately does **not** own: the payment orders that fill the wallet. Those
 * are M13's, behind a provider abstraction, and this module knows only that a `top_up`
 * transaction can arrive with a reference id. §12.7 requires that separation - the ledger
 * has to stay provider-agnostic so a store build can substitute Apple or Google billing
 * without touching Candidate Unlock.
 */
// `EmployersModule` for §7's verification gate on the purchase: an employer must not be able
// to buy access that `expose()` will then refuse. The dependency is safe in this direction -
// `EmployersModule` imports only `NotificationsModule`, so there is no path back here.
@Module({
  imports: [EmployersModule],
  controllers: [WalletController],
  providers: [PricingService, WalletService],
  exports: [PricingService, WalletService],
})
export class WalletModule {}
