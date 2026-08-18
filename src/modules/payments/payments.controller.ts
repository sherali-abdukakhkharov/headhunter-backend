import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import { XLang } from '@infra/api/decorators/x-lang.decorator';
import type { LocaleCode } from '@infra/db/database.types';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';
import { WalletService } from '@modules/wallet/wallet.service';

import {
  PaymentOrderDto,
  PaymentOrderListDto,
  PaymentPageDto,
  PaymentProvidersDto,
  TopUpDto,
  TopUpRequestDto,
} from './dto/payment.dto';
import type { PaymentOrderView } from './payment-orders.service';
import { PaymentOrdersService } from './payment-orders.service';

/**
 * Coin top-up, from the employer's side (§6.7).
 *
 * Employer-only, like the wallet itself, and deliberately thin: three reads and one write,
 * none of which can move money. The only thing that credits Coins is a verified provider
 * callback on `PaymentsCallbackController`, which is a different controller with a different
 * authentication model - and separating them is the point, because it means no route an
 * employer's own client can reach is on the credit path at all (§6.7).
 */
@ApiTags('payments')
@ApiBearerAuth()
@RequireRole('employer')
@Controller('payments')
export class PaymentsController {
  private readonly timeZone: string;

  constructor(
    private readonly orders: PaymentOrdersService,
    private readonly wallet: WalletService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get('providers')
  @ApiOperation({
    summary: 'What the top-up screen can offer (§6.7)',
    description:
      'The providers with a merchant account configured, the order bounds, and today’s ' +
      'Coin price. **Build the top-up screen from this** rather than hard-coding two ' +
      'buttons: an empty list is a valid answer on a deployment whose merchant accounts ' +
      'are not activated yet, and §12.7 may require a different channel per storefront - ' +
      'both of which are then a configuration change rather than an app release.',
  })
  @ApiOkResponse({ type: PaymentProvidersDto })
  providers(): PaymentProvidersDto {
    const { minCoins, maxCoins } = this.orders.bounds();

    return {
      providers: this.orders.availableProviders(),
      minCoins,
      maxCoins,
      coinPriceUzs: this.wallet.pricing().coinPriceUzs,
    };
  }

  @Post('orders')
  @ApiOperation({
    summary: 'Open a Payment Order and get its checkout (§6.7)',
    description:
      'Send a **Coin count**, not a total: §12.3.1 requires the payable amount to be ' +
      'calculated server-side from the current Coin price, and it is written onto the ' +
      'order so a later repricing cannot change what this checkout charges (§10.5).\n\n' +
      'Then open `checkout.url`. **Do not credit anything on the redirect back** - §6.7 is ' +
      'explicit that a client-side success redirect is not sufficient. Poll ' +
      '`GET /payments/orders/{id}` until the status settles; `paid` is the only status that ' +
      'means the Coins are in the wallet.\n\n' +
      'No `Idempotency-Key` here, for the same reason the unlock has none: a second tap is ' +
      'a second *intent* to pay, and two open orders are legitimate - only one of them can ' +
      'ever reach `paid` per provider transaction (BR-19). Abandoned orders simply stay ' +
      '`created`.',
  })
  @ApiCreatedResponse({ type: TopUpDto })
  @ApiConflictResponse({
    description:
      'That provider has no merchant account configured on this deployment ' +
      '(`payments.provider_unavailable`).',
  })
  async create(
    @ActiveUser() user: CurrentUser,
    @Body() body: TopUpRequestDto,
    @XLang() locale: LocaleCode,
  ): Promise<TopUpDto> {
    const { order, checkout } = await this.orders.create(
      user.id,
      body.provider,
      body.coins,
      locale,
    );

    return { order: this.toDto(order), checkout };
  }

  @Get('orders')
  @ApiOperation({
    summary: 'This employer’s Payment Orders, newest first (§6.7)',
    description:
      'The top-up history behind the Wallet screen, including the failed and cancelled ' +
      'orders §12.6 requires to be visible with a retry option.',
  })
  @ApiOkResponse({ type: PaymentOrderListDto })
  async list(
    @ActiveUser() user: CurrentUser,
    @Query() page: PaymentPageDto,
  ): Promise<PaymentOrderListDto> {
    const items = await this.orders.list(
      user.id,
      page.limit ?? 20,
      page.offset ?? 0,
    );

    return { items: items.map((order) => this.toDto(order)) };
  }

  @Get('orders/:orderId')
  @ApiOperation({
    summary: 'One Payment Order (§6.7)',
    description:
      'What the client polls after returning from a provider checkout. Scoped to the ' +
      'caller: an order id is an identifier, not an authorization.',
  })
  @ApiOkResponse({ type: PaymentOrderDto })
  @ApiNotFoundResponse({ description: 'No such order for this employer.' })
  async read(
    @ActiveUser() user: CurrentUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<PaymentOrderDto> {
    return this.toDto(await this.orders.read(user.id, orderId));
  }

  private toDto(order: PaymentOrderView): PaymentOrderDto {
    return {
      id: order.id,
      provider: order.provider,
      coins: order.coins,
      coinPriceUzs: order.coinPriceUzs,
      amountUzs: order.amountUzs,
      status: order.status,
      providerTransactionId: order.providerTransactionId,
      failureCode: order.failureCode,
      createdAt: formatWithOffset(order.createdAt, this.timeZone),
      paidAt:
        order.paidAt === null
          ? null
          : formatWithOffset(order.paidAt, this.timeZone),
      updatedAt: formatWithOffset(order.updatedAt, this.timeZone),
    };
  }
}
