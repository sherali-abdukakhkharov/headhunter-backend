import { type CustomDecorator, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'is_public';

/**
 * Opens a route to unauthenticated callers.
 *
 * `AuthorizationGuard` is global, so protection is the default and every
 * exception is visible at the handler. Reserve this for the endpoints that
 * cannot require a token: health, and the OTP calls that issue the first one.
 */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);
