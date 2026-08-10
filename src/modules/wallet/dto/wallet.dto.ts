import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** §6.6's prices, as the client must read them rather than hard-code them. */
export class WalletPricingDto {
  @ApiProperty({
    example: 10000,
    description:
      'UZS per Coin. Server configuration (§6.6); never assume this value.',
  })
  coinPriceUzs!: number;

  @ApiProperty({ example: 2, description: 'Coins one Candidate Unlock costs.' })
  candidateUnlockCoins!: number;

  @ApiProperty({
    example: 20000,
    description:
      'What one unlock costs in UZS at the current price, so the confirmation sheet ' +
      'in §6.6 does not have to multiply.',
  })
  candidateUnlockUzs!: number;
}

export class WalletDto {
  @ApiProperty({ example: 8 })
  balanceCoins!: number;

  @ApiProperty({
    example: 80000,
    description:
      'The balance in UZS **at today’s price**, for display only. It is not stored: ' +
      'repricing must not restate history (§10.5).',
  })
  balanceValueUzs!: number;

  @ApiProperty({ type: WalletPricingDto })
  pricing!: WalletPricingDto;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When the one-time registration bonus was granted (BR-15), or null.',
  })
  registrationBonusAt!: string | null;
}

export class WalletTransactionDto {
  @ApiProperty() id!: string;

  @ApiProperty({
    enum: [
      'registration_bonus',
      'top_up',
      'candidate_unlock',
      'admin_adjustment',
      'reversal',
    ],
  })
  kind!: string;

  @ApiProperty({
    example: -2,
    description:
      'Signed: a debit is negative, so the ledger sums to the balance.',
  })
  amountCoins!: number;

  @ApiProperty({ example: 8 })
  balanceAfter!: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The UZS value **at the time of the transaction**, never recomputed.',
  })
  amountUzs!: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What it was for: the candidate for an unlock, the payment order for a top-up.',
  })
  referenceId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Mandatory on an administrator adjustment (§10.5).',
  })
  reason!: string | null;

  @ApiProperty() createdAt!: string;
}

export class WalletTransactionListDto {
  @ApiProperty({ type: [WalletTransactionDto] })
  items!: WalletTransactionDto[];
}

export class UnlockDto {
  @ApiProperty() candidateUserId!: string;

  @ApiProperty({ example: 2 })
  costCoins!: number;

  @ApiProperty() createdAt!: string;

  @ApiProperty({
    description:
      'True when this request created the entitlement and Coins were debited. **False ' +
      'when it already existed** - BR-16 charges one employer-candidate pair once, so a ' +
      'repeated call is free and returns the original.',
  })
  charged!: boolean;
}

export class UnlockStateDto {
  @ApiProperty({
    description: 'Whether this employer already holds the entitlement.',
  })
  unlocked!: boolean;

  @ApiPropertyOptional({ type: UnlockDto, nullable: true })
  unlock!: UnlockDto | null;

  @ApiProperty({ type: WalletPricingDto })
  pricing!: WalletPricingDto;
}

export class UnlockRequestDto {
  @ApiProperty({ description: 'The candidate to unlock contact access for.' })
  @IsString()
  candidateUserId!: string;
}

export class WalletPageDto {
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

/** §10.5's manual adjustment. */
export class WalletAdjustmentDto {
  @ApiProperty({
    example: 5,
    description:
      'Signed Coins to apply. Negative debits. Zero is refused - an adjustment that ' +
      'changes nothing is a ledger row with no meaning.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(-100_000)
  @Max(100_000)
  amountCoins!: number;

  @ApiProperty({
    description:
      'Mandatory (§10.5), and enforced by a database check as well as here: an ' +
      'adjustment nobody explained is indistinguishable from a mistake.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminWalletDto {
  @ApiProperty() userId!: string;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiPropertyOptional({ nullable: true }) name!: string | null;
  @ApiProperty() balanceCoins!: number;
  @ApiPropertyOptional({ nullable: true }) registrationBonusAt!: string | null;
  @ApiProperty() unlockCount!: number;
}

export class AdminWalletListDto {
  @ApiProperty({ type: [AdminWalletDto] })
  items!: AdminWalletDto[];
}

export class AdminWalletDetailDto extends AdminWalletDto {
  @ApiProperty({ type: [WalletTransactionDto] })
  transactions!: WalletTransactionDto[];
}
