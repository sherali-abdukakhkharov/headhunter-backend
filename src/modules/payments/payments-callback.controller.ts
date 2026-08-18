import { Body, Controller, Headers, Post, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { Public } from '@infra/api/decorators/public.decorator';
import { RateLimit } from '@infra/api/decorators/rate-limit.decorator';

import { PaymentOrdersService } from './payment-orders.service';

/**
 * Payme's and CLICK's inbound callbacks (§6.7, §12.6).
 *
 * **These are the first public *mutating* routes in the product**, and that deserved a
 * decision rather than a shrug. Everything else that answers without a token either exists
 * so a client can *get* a token (`/auth/otp/*`) or has no user data in it (`/health`, the
 * dictionaries). These change money.
 *
 * Four things make that acceptable, and all four are testable:
 *
 * 1. **They are authenticated, just not by our scheme.** Payme sends an HTTP Basic
 *    credential holding the merchant key; CLICK signs every field with the merchant secret.
 *    Both are verified inside the adapter *before* anything is read from the database, and
 *    an unconfigured provider has nothing to verify against and so can only refuse.
 * 2. **They cannot invent value.** A callback names an order that an authenticated employer
 *    already created, and the amount is compared against what that order says. There is no
 *    request an attacker can send that credits Coins nobody ordered; the most a forged
 *    signature could achieve is a rejected event in the trail.
 * 3. **Every call is recorded**, verified or not, and the trail is append-only. A refused
 *    callback is a row, which is how a support conversation or an incident review sees it.
 * 4. **Their own rate-limit bucket** (`payments`), deliberately loose. The caller is a
 *    provider retrying in good faith - BR-19 makes that harmless - and throttling one out of
 *    delivering a `PerformTransaction` would leave money taken with no Coins credited.
 *
 * They are registered in `api-surface.spec.ts`'s frozen public list with that reasoning, so
 * a future public route cannot slip in beside them unnoticed.
 *
 * **No localization.** A provider is not a person: these responses carry each provider's own
 * error vocabulary and never read `x-lang`. They also always answer 200, because both
 * providers read the error out of the body and an HTTP error would make them retry a request
 * that has already been decided.
 *
 * They are excluded from the published OpenAPI document on purpose. The audience is Payme
 * and CLICK, whose own specifications define these shapes; putting them in the client's
 * contract would invite a client to call them.
 */
@ApiTags('payments')
@Controller('payments/callbacks')
export class PaymentsCallbackController {
  constructor(private readonly orders: PaymentOrdersService) {}

  @Post('payme')
  @Public()
  @RateLimit('payments')
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Payme Merchant API callback (§12.6)' })
  async payme(
    @Headers() headers: Record<string, string | undefined>,
    // `unknown`, so the global ValidationPipe has no metatype to validate against and
    // `forbidNonWhitelisted` cannot strip a field Payme added. The adapter is the only thing
    // that decides what this body means.
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    return this.dispatch('payme', headers, body, response);
  }

  @Post('click')
  @Public()
  @RateLimit('payments')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'CLICK Shop API callback: Prepare and Complete (§12.6)',
  })
  async click(
    @Headers() headers: Record<string, string | undefined>,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    // CLICK posts form-encoded, which Nest's default body parser already handles, so both
    // providers arrive here as a plain object either way.
    return this.dispatch('click', headers, body, response);
  }

  private async dispatch(
    provider: 'payme' | 'click',
    headers: Record<string, string | undefined>,
    body: unknown,
    response: Response,
  ): Promise<unknown> {
    const result = await this.orders.handleCallback(provider, {
      headers,
      body,
    });

    response.status(result.status);

    return result.body;
  }
}
