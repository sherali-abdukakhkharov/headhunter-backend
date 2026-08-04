import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
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
  controllers: [AuthController],
  providers: [AuthService, OtpService, SessionService, TokenService],
  exports: [TokenService, SessionService],
})
export class AuthModule {}
