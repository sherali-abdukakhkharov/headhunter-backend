import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import type { AppEnv } from '@infra/env-schema';
import { WalletModule } from '@modules/wallet/wallet.module';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpController } from './otp.controller';
import { OtpEnabledGuard } from './otp-enabled.guard';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { EskizSmsSender } from './sms/eskiz-sms.sender';
import { LoggingSmsSender } from './sms/logging-sms.sender';
import { SmsSender } from './sms/sms-sender';
import { TelegramOidcService } from './telegram-oidc.service';
import { TokenService } from './token.service';

/**
 * Auth, sessions and roles (M1).
 *
 * `TokenService` and `SessionService` are exported because the global
 * `AuthorizationGuard` depends on them - the guard is registered in
 * `AppModule`, so it resolves them from this module's exports rather than
 * duplicating the providers.
 *
 * **The SMS sender is chosen at boot from the configuration**, the same seam
 * `NotificationsModule` uses for push: with an Eskiz account it is the real provider,
 * without one it is a logging sender that reports failure and never claims a delivery.
 * Everything upstream - the TTL, the supersession, the attempt limit, `verify` - is
 * identical either way, which is what makes connecting the provider a configuration
 * change rather than a code change (docs/SMS_PROVIDER.md).
 */
@Module({
  // Secret and expiry are passed per call in TokenService, so the module itself
  // needs no async configuration.
  // WalletModule for BR-15's registration bonus, granted in the same transaction as
  // the employer role.
  imports: [JwtModule.register({}), WalletModule],
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
    {
      provide: SmsSender,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>): SmsSender => {
        const email = config.get('ESKIZ_EMAIL', { infer: true });

        if (!email) {
          // Announced at boot rather than discovered by the first user who cannot log
          // in, the way the fixed OTP code announces itself.
          new Logger('AuthModule').warn(
            'ESKIZ_EMAIL is not set: login codes are issued and stored but not sent. ' +
              'OTP_STATIC_CODE and OTP_ECHO_IN_RESPONSE are how anybody signs in.',
          );

          return new LoggingSmsSender();
        }

        return new EskizSmsSender(config);
      },
    },
  ],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
