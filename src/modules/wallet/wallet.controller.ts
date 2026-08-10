import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  ActiveUser,
  type CurrentUser,
} from '@infra/api/decorators/current-user.decorator';
import { RequireRole } from '@infra/api/decorators/require-role.decorator';
import type { AppEnv } from '@infra/env-schema';
import { formatWithOffset } from '@infra/time/format';

import {
  UnlockDto,
  UnlockRequestDto,
  UnlockStateDto,
  WalletDto,
  WalletPageDto,
  WalletTransactionListDto,
} from './dto/wallet.dto';
import type { UnlockView, WalletTransactionView } from './wallet.service';
import { WalletService } from './wallet.service';

/**
 * The employer's Coin wallet (§6.6, §6.2's Wallet tile).
 *
 * Employer-only, because a wallet belongs to an employer acting as one: a multi-role
 * account switching to `candidate` has no business reading its own balance from that side
 * (§2.3). Nothing here is public, and nothing here is reachable by an administrator - §10.5
 * has its own routes under `/admin`, so an administrator reading a wallet is logged as an
 * administrator rather than looking like the employer.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@RequireRole('employer')
@Controller('wallet')
export class WalletController {
  private readonly timeZone: string;

  constructor(
    private readonly wallet: WalletService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.timeZone = config.get('PLATFORM_TIME_ZONE', { infer: true });
  }

  @Get()
  @ApiOperation({
    summary: 'Balance and current pricing (§6.6)',
    description:
      'The Coin balance, its UZS value at today’s price, and the prices themselves. ' +
      '**The client must read the prices from here rather than hard-coding them** - §6.6 ' +
      'makes them server-side configuration, and §10.5 allows changing them.\n\n' +
      'A wallet is created on first read, so an employer who registered before the ' +
      'wallet existed sees a zero balance rather than an error. That read never grants ' +
      'the registration bonus: the bonus belongs to the role being granted (BR-15).',
  })
  @ApiOkResponse({ type: WalletDto })
  async read(@ActiveUser() user: CurrentUser): Promise<WalletDto> {
    const wallet = await this.wallet.read(user.id);

    return {
      balanceCoins: wallet.balanceCoins,
      balanceValueUzs: wallet.balanceValueUzs,
      pricing: wallet.pricing,
      registrationBonusAt: wallet.registrationBonusAt
        ? formatWithOffset(wallet.registrationBonusAt, this.timeZone)
        : null,
    };
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'The Coin ledger (§6.6, BR-24)',
    description:
      'Newest first. **Append-only**: three database triggers refuse `UPDATE`, `DELETE` ' +
      'and `TRUNCATE` on this table, so a correction appears as a further `reversal` or ' +
      '`admin_adjustment` entry rather than by changing what is here (BR-24).',
  })
  @ApiOkResponse({ type: WalletTransactionListDto })
  async transactions(
    @ActiveUser() user: CurrentUser,
    @Query() query: WalletPageDto,
  ): Promise<WalletTransactionListDto> {
    const items = await this.wallet.transactions(
      user.id,
      query.limit ?? 20,
      query.offset ?? 0,
    );

    return { items: items.map((item) => this.transactionDto(item)) };
  }

  @Get('unlocks/:candidateUserId')
  @ApiOperation({
    summary: 'Whether this candidate is already unlocked (§6.6)',
    description:
      'What the client needs to render either “Unlock contact — 2 Coins” or the ' +
      'unlocked state, without guessing and without attempting a purchase to find out. ' +
      'Returns the current pricing alongside, so the confirmation sheet §6.6 describes ' +
      'can be built from one request.',
  })
  @ApiOkResponse({ type: UnlockStateDto })
  async unlockState(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<UnlockStateDto> {
    const unlock = await this.wallet.unlockFor(user.id, candidateUserId);

    return {
      unlocked: unlock !== null,
      unlock: unlock ? this.unlockDto(unlock) : null,
      pricing: this.wallet.pricing(),
    };
  }

  @Post('unlocks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Buy a Candidate Unlock (§6.6, BR-16, BR-18)',
    description:
      'Debits the Coins and creates the entitlement **atomically** (BR-18): charging ' +
      'without access, or access without charging, are both worse than failing.\n\n' +
      '**Calling twice is free.** One employer-candidate pair is charged once (BR-16), ' +
      'enforced by that pair being a primary key rather than by a check - so a double ' +
      'tap, a retry, or a revisit next month all return the original entitlement with ' +
      '`charged: false`. No `Idempotency-Key` is needed, because the pair *is* the key.\n\n' +
      'Answers **402** when the balance is too low, which is the status the client ' +
      'routes to top-up on (§6.6).',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: UnlockDto,
    description: 'The entitlement, whether this call created it or found it.',
  })
  @ApiResponse({
    status: HttpStatus.PAYMENT_REQUIRED,
    description:
      'Fewer Coins than an unlock costs. The body carries `required` and `balance`.',
  })
  @ApiConflictResponse({
    description:
      'A multi-role account tried to unlock its own candidate profile.',
  })
  async unlock(
    @ActiveUser() user: CurrentUser,
    @Body() dto: UnlockRequestDto,
  ): Promise<UnlockDto> {
    return this.unlockDto(
      await this.wallet.unlock(user.id, dto.candidateUserId),
    );
  }

  private unlockDto(unlock: UnlockView): UnlockDto {
    return {
      candidateUserId: unlock.candidateUserId,
      costCoins: unlock.costCoins,
      createdAt: formatWithOffset(unlock.createdAt, this.timeZone),
      charged: unlock.charged,
    };
  }

  private transactionDto(item: WalletTransactionView) {
    return {
      id: item.id,
      kind: item.kind,
      amountCoins: item.amountCoins,
      balanceAfter: item.balanceAfter,
      amountUzs: item.amountUzs,
      referenceId: item.referenceId,
      reason: item.reason,
      createdAt: formatWithOffset(item.createdAt, this.timeZone),
    };
  }
}
