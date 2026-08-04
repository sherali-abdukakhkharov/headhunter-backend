import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpController } from './otp.controller';
import { OtpEnabledGuard } from './otp-enabled.guard';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { TelegramOidcService } from './telegram-oidc.service';
import { TokenService } from './token.service';

/**
 * Auth, sessions and roles (M1).
 *
 * `TokenService` and `SessionService` are exported because the global
 * `AuthorizationGuard` depends on them - the guard is registered in
 * `AppModule`, so it resolves them from this module's exports rather than
 * duplicating the providers.
 */
@Module({
  // Secret and expiry are passed per call in TokenService, so the module itself
  // needs no async configuration.
  imports: [JwtModule.register({})],
  // `OtpController` is registered even for the MVP, where every one of its routes
  // answers 404 via `OtpEnabledGuard`. Registering it conditionally would mean
  // reading process.env before the Joi schema has validated it, and would let the
  // OTP code drift out of compilation while switched off.
  controllers: [AuthController, OtpController],
  providers: [
    AuthService,
    OtpService,
    OtpEnabledGuard,
    SessionService,
    TelegramOidcService,
    TokenService,
  ],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
