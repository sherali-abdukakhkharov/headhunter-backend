import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import type {
  PaymentOrderStatus,
  PaymentProvider,
} from '@infra/db/database.types';

/** The two providers §6.7 requires. Kept as a literal so the DTO validates against it. */
const PROVIDERS: PaymentProvider[] = ['payme', 'click'];

export class TopUpRequestDto {
  @ApiProperty({
    enum: PROVIDERS,
    description:
      'Which provider to pay through. Must be one of the providers ' +
      '`GET /payments/providers` currently lists - a provider with no merchant account ' +
      'configured is refused rather than offered a checkout that cannot complete.',
  })
  @IsIn(PROVIDERS)
  provider!: PaymentProvider;

  @ApiProperty({
    example: 10,
    description:
      'How many Coins to buy. **The client sends a Coin count and never a total**: ' +
      '§12.3.1 requires the payable amount to be calculated server-side from the current ' +
      'Coin price, so an amount in the request would be ignored if it were accepted at all.',
  })
  @IsInt()
  @Min(1)
  coins!: number;
}

export class PaymentOrderDto {
  @ApiProperty({
    description:
      'The internal Payment Order id (§6.7). Quote it in a support request.',
  })
  id!: string;

  @ApiProperty({ enum: PROVIDERS })
  provider!: PaymentProvider;

  @ApiProperty({ example: 10 })
  coins!: number;

  @ApiProperty({
    example: 10000,
    description:
      'The Coin price this order was quoted at, which is not necessarily today’s. ' +
      '§10.5: repricing affects future transactions only.',
  })
  coinPriceUzs!: number;

  @ApiProperty({
    example: 100000,
    description:
      'What the provider will charge, in UZS. Always `coins × coinPriceUzs`.',
  })
  amountUzs!: number;

  @ApiProperty({
    enum: ['created', 'pending', 'paid', 'failed', 'cancelled', 'reversed'],
    description:
      '§6.7’s statuses. **Only `paid` means the Coins arrived**, and it is reached from a ' +
      'verified provider callback - never from the client returning to the app. A client ' +
      'that treats its own success redirect as payment will show a balance that does not ' +
      'exist.',
  })
  status!: PaymentOrderStatus;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The provider’s transaction id once it has opened one. For support.',
  })
  providerTransactionId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Why a `failed`, `cancelled` or `reversed` order ended that way, as the provider ' +
      'reported it (§12.6’s "clear status and retry option").',
  })
  failureCode!: string | null;

  @ApiProperty({ description: 'ISO 8601 with the platform offset.' })
  createdAt!: string;

  @ApiPropertyOptional({ nullable: true })
  paidAt!: string | null;

  @ApiProperty()
  updatedAt!: string;
}

export class CheckoutDto {
  @ApiProperty({ enum: PROVIDERS })
  provider!: PaymentProvider;

  @ApiProperty({
    description:
      'The URL to open for payment: a provider payment page, payment link or deep link. ' +
      'It carries no secret (BR-22) and no card data ever reaches this API.',
  })
  url!: string;

  @ApiProperty({ example: 100000 })
  amountUzs!: number;
}

export class TopUpDto {
  @ApiProperty({ type: PaymentOrderDto })
  order!: PaymentOrderDto;

  @ApiProperty({
    type: CheckoutDto,
    description:
      'Open this, then poll `GET /payments/orders/{id}` (or reopen the wallet) until the ' +
      'status settles. §6.7: a client-side success redirect is not sufficient to credit ' +
      'Coins, so the app must read the status from here.',
  })
  checkout!: CheckoutDto;
}

export class PaymentOrderListDto {
  @ApiProperty({ type: [PaymentOrderDto] })
  items!: PaymentOrderDto[];
}

/**
 * Paging for the order history.
 *
 * A fourth copy of the same three fields, after `AdminPageDto`, `MessagePageDto` and
 * `WalletPageDto`. Kept per module on purpose: the shapes are identical today, and the
 * moment one of them needs a cursor or a different ceiling a shared base class would have to
 * be un-shared. The bound is what matters, and each copy states its own.
 */
export class PaymentPageDto {
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class PaymentProvidersDto {
  @ApiProperty({
    enum: PROVIDERS,
    isArray: true,
    description:
      'The providers this deployment can actually take money through - the ones with a ' +
      'merchant account configured. **Render the top-up options from this list**, because ' +
      'an empty list is a valid answer and §12.7 may make the answer per-storefront.',
  })
  providers!: PaymentProvider[];

  @ApiProperty({ example: 1 })
  minCoins!: number;

  @ApiProperty({ example: 1000 })
  maxCoins!: number;

  @ApiProperty({
    example: 10000,
    description: 'Today’s Coin price. The same value `GET /wallet` reports.',
  })
  coinPriceUzs!: number;
}
