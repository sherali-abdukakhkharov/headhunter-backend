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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
      'wallet existed sees a balance rather than an error — **and that read grants BR-15’s ' +
      'one-time bonus if it is still owed**, which is how an employer who registered before ' +
      'the wallet shipped receives it. It cannot grant a second: the bonus is a unique ' +
      'index, so logging out, reinstalling, changing device or switching roles all reach the ' +
      'same single row.',
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
      'Returns the cost **and the current balance**, so the confirmation sheet §6.6 ' +
      'describes — cost, balance, and what would be left — can be built from one request.',
  })
  @ApiOkResponse({ type: UnlockStateDto })
  async unlockState(
    @ActiveUser() user: CurrentUser,
    @Param('candidateUserId', ParseUUIDPipe) candidateUserId: string,
  ): Promise<UnlockStateDto> {
    const unlock = await this.wallet.unlockFor(user.id, candidateUserId);
    // The wallet read rather than a bare balance query: it is the one path that creates the
    // row and settles BR-15 for an employer who has never opened the Wallet screen, and
    // reaching this route before that one is entirely possible.
    const wallet = await this.wallet.read(user.id);

    return {
      unlocked: unlock !== null,
      unlock: unlock ? this.unlockDto(unlock) : null,
      pricing: wallet.pricing,
      balanceCoins: wallet.balanceCoins,
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
      'routes to top-up on (§6.6).\n\n' +
      '**A verified employer only** (§7). An unverified one is refused *before* any Coins ' +
      'move, with `employer.not_verified` or `employer.profile_incomplete` — the same codes ' +
      'every other §7-gated route returns, so route them to verification rather than to ' +
      'top-up. Buying access that `expose()` would then refuse is taking money for nothing.',
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
  @ApiForbiddenResponse({
    description:
      '`employer.not_verified` or `employer.profile_incomplete` — §7 requires verification ' +
      'before an employer may see any candidate, so it is required before buying access to ' +
      'one. Nothing was charged.',
  })
  @ApiNotFoundResponse({
    description:
      '`candidate.profile_not_found` — no candidate profile with that id. Nothing was ' +
      'charged.',
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
