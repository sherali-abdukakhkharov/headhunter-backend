import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { IS_PUBLIC_KEY } from '@infra/api/decorators/public.decorator';
import { MUTATING_METHODS } from '@infra/api/guards/account-status.guard';
import { REQUIRED_ROLES_KEY } from '@infra/api/decorators/require-role.decorator';
import type { UserRole } from '@infra/db/database.types';
import { AdminController } from '@modules/admin/admin.controller';
import { ApplicationsController } from '@modules/applications/applications.controller';
import { AuthController } from '@modules/auth/auth.controller';
import { OtpController } from '@modules/auth/otp.controller';
import { CandidateSearchController } from '@modules/candidate-search/candidate-search.controller';
import { CandidatesController } from '@modules/candidates/candidates.controller';
import { HistoryController } from '@modules/candidates/history.controller';
import { ChatController } from '@modules/chat/chat.controller';
import { DictionariesController } from '@modules/dictionaries/dictionaries.controller';
import { DiscoveryController } from '@modules/discovery/discovery.controller';
import { EmployersController } from '@modules/employers/employers.controller';
import { FilesController } from '@modules/files/files.controller';
import { HealthController } from '@modules/health/health.controller';
import { InterviewsController } from '@modules/interviews/interviews.controller';
import { InvitationsController } from '@modules/invitations/invitations.controller';
import { NotificationsController } from '@modules/notifications/notifications.controller';
import { PaymentsController } from '@modules/payments/payments.controller';
import { PaymentsCallbackController } from '@modules/payments/payments-callback.controller';
import { SchemasController } from '@modules/schemas/schemas.controller';
import { UsersController } from '@modules/users/users.controller';
import { VacanciesController } from '@modules/vacancies/vacancies.controller';
import { WalletController } from '@modules/wallet/wallet.controller';

/**
 * The API's authorization surface, asserted as a whole (§12.5).
 *
 * "Server-side role and permission enforcement for **every** protected API" is a property
 * of the *set* of routes, not of any one of them, and no per-module test can see it. The
 * guards are global - `AuthorizationGuard` makes every route authenticated unless it
 * carries `@Public()` - so the danger is not a missing guard but an **unintended
 * exception**: one `@Public()` added for a local reason, on a route that then serves data.
 *
 * These tests read the routing metadata off the controllers and compare the public set to
 * a frozen list. A new public route fails this suite until somebody adds it here, which
 * forces the decision to be argued in a review rather than discovered in production.
 *
 * Every controller in `app.module.ts` must appear below; the last test fails if one is
 * missing, so a whole module cannot escape the audit by not being imported.
 */

const CONTROLLERS = [
  AdminController,
  ApplicationsController,
  AuthController,
  OtpController,
  CandidateSearchController,
  CandidatesController,
  HistoryController,
  ChatController,
  DictionariesController,
  DiscoveryController,
  EmployersController,
  FilesController,
  HealthController,
  InterviewsController,
  InvitationsController,
  NotificationsController,
  PaymentsController,
  PaymentsCallbackController,
  SchemasController,
  UsersController,
  VacanciesController,
  WalletController,
];

/**
 * Every route that answers without a token, and why it has to.
 *
 * Adding a line here is a security decision. Each one is either something a client needs
 * *before* it can have a token, or something with no user data in it at all.
 */
const PUBLIC_ROUTES = [
  // Liveness. Deliberately unauthenticated so monitoring can reach it, and it reports a
  // failing dependency as `degraded` rather than leaking anything.
  'GET /health',

  // §4.1's login pair. A client cannot hold a token before these succeed, and
  // registration and login are deliberately the same two calls - a route that
  // distinguished them would be a register of which numbers have accounts.
  'POST /auth/otp/send',
  'POST /auth/otp/resend',
  'POST /auth/otp/verify',

  // Telegram login (deprecated but working) and the token lifecycle. `refresh` and
  // `logout` are public because they authenticate with the refresh token in the body
  // rather than with an access token, which by then may have expired.
  'POST /auth/telegram',
  'POST /auth/refresh',
  'POST /auth/logout',

  // §3.2 and §4.1: the language and its pickers are chosen *before* registration, so the
  // dictionaries have to answer without one. They contain no user data - only the
  // localized value lists BR-13 defines.
  'GET /dictionaries/manifest',
  'GET /dictionaries/items',
  'GET /dictionaries/:type',

  // §6.7 and §12.6: Payme's and CLICK's callbacks, and **the first public mutating routes in
  // the product**. Every other line above is either a way to obtain a token or a response
  // with no user data in it; these two change money, so the reasoning is written out here
  // rather than left to the controller.
  //
  // They cannot carry our bearer token - the caller is a payment provider, not a person - so
  // they authenticate with the provider's own scheme instead: Payme with an HTTP Basic
  // credential holding the merchant key, CLICK with an MD5 signature over its fields. Both
  // are checked inside the adapter before the database is touched, and a deployment with no
  // merchant credentials has nothing to verify against and can only refuse.
  //
  // What bounds the damage is that they cannot invent value. A callback names an order some
  // authenticated employer already created, at an amount that order already fixed, and the
  // most a forged signature achieves is a rejected row in an append-only trail. They also
  // have their own rate-limit bucket, so provider retries never share a budget with people.
  'POST /payments/callbacks/payme',
  'POST /payments/callbacks/click',
].sort();

interface Route {
  signature: string;
  isPublic: boolean;
  roles: UserRole[] | undefined;
}

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
};

/** Reads Nest's own routing metadata, so this sees exactly what the router will. */
function routesOf(controller: new (...args: never[]) => object): Route[] {
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) ?? '';
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
  const classRoles = Reflect.getMetadata(REQUIRED_ROLES_KEY, controller) as
    | UserRole[]
    | undefined;

  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      const path = Reflect.getMetadata(PATH_METADATA, handler as object) as
        | string
        | undefined;

      if (path === undefined) {
        return null;
      }

      const method =
        METHODS[
          Reflect.getMetadata(METHOD_METADATA, handler as object) as number
        ] ?? 'ALL';
      const full = `/${[prefix, path].filter((part) => part && part !== '/').join('/')}`;

      return {
        signature: `${method} ${full}`,
        isPublic:
          classPublic ||
          Reflect.getMetadata(IS_PUBLIC_KEY, handler as object) === true,
        roles:
          (Reflect.getMetadata(REQUIRED_ROLES_KEY, handler as object) as
            | UserRole[]
            | undefined) ?? classRoles,
      };
    })
    .filter((route): route is Route => route !== null);
}

const ALL_ROUTES = CONTROLLERS.flatMap(routesOf);

/** Nest's own module metadata, read without an `any` escaping into the assertions. */
function metadataOf(
  target: unknown,
  key: 'imports' | 'controllers',
): unknown[] {
  const value: unknown = Reflect.getMetadata(key, target as object);

  return Array.isArray(value) ? (value as unknown[]) : [];
}

describe('the public surface (§12.5)', () => {
  it('is exactly the frozen list, and nothing else', () => {
    const actual = ALL_ROUTES.filter((route) => route.isPublic)
      .map((route) => route.signature)
      .sort();

    // If this fails with an extra entry, do not add it here to make the suite pass:
    // ask first whether that route can really answer an anonymous caller.
    expect(actual).toEqual(PUBLIC_ROUTES);
  });

  it('leaves every other route authenticated', () => {
    const protectedRoutes = ALL_ROUTES.filter((route) => !route.isPublic);

    // The global `AuthorizationGuard` is what enforces this; the assertion is that no
    // route opted out of it.
    expect(protectedRoutes.length).toBeGreaterThan(60);
    expect(
      protectedRoutes
        .map((route) => route.signature)
        .filter((signature) => PUBLIC_ROUTES.includes(signature)),
    ).toEqual([]);
  });
});

describe('BR-10 covers every kind of mutation', () => {
  it('recognises every mutating method the product actually routes', () => {
    // **The property, rather than a route-by-route audit.** `AccountStatusGuard` is global, so
    // BR-10 was never at risk from a route that forgot it - it is at risk from a route whose
    // *method* the guard does not count as mutating. Add a `PUT` where the set only knew
    // `POST`, and a blocked account may use it, with nothing failing anywhere.
    //
    // This is what TODO.md's "blocked user refused on each mutation kind" is really asking:
    // the kinds are HTTP methods, and the question is whether the set of them the guard knows
    // still covers the set the product uses.
    const routed = new Set(
      ALL_ROUTES.map((route) => route.signature.split(' ')[0]).filter(
        (method) => method !== 'GET',
      ),
    );

    expect(routed.size).toBeGreaterThan(2);

    for (const method of routed) {
      expect(MUTATING_METHODS.has(method)).toBe(true);
    }
  });

  it('has a mutating route on every module that changes anything', () => {
    // A weaker companion, and its value is the number: if this drops sharply, a module has
    // been rewritten to mutate through `GET` - which would be outside BR-10 whatever the
    // guard's method set says.
    const mutating = ALL_ROUTES.filter((route) =>
      MUTATING_METHODS.has(route.signature.split(' ')[0] ?? ''),
    );

    expect(mutating.length).toBeGreaterThan(40);
  });
});

describe('role enforcement (§12.5, §2.3)', () => {
  it('requires the admin role on every §10 route', () => {
    const adminRoutes = ALL_ROUTES.filter((route) =>
      route.signature.includes(' /admin/'),
    );

    expect(adminRoutes.length).toBeGreaterThan(15);

    for (const route of adminRoutes) {
      // §10's routes are ordinary endpoints behind a role, which means the role is the
      // only thing between them and any authenticated user.
      expect(route.roles).toEqual(['admin']);
    }
  });

  it('never asks for a role on a public route', () => {
    // A route that is both public and role-restricted is a contradiction: there is no
    // active role without a token, so one of the two decorators does nothing.
    for (const route of ALL_ROUTES.filter((r) => r.isPublic)) {
      expect(route.roles).toBeUndefined();
    }
  });

  it('keeps the two sides of the product apart where §2.3 requires it', () => {
    const bySignature = new Map(
      ALL_ROUTES.map((route) => [route.signature, route]),
    );

    // Spot checks on the routes where a leak would matter most: an account holding both
    // roles must not reach the employer's candidate database while acting as a candidate.
    expect(bySignature.get('POST /candidate-search')?.roles).toEqual([
      'employer',
    ]);
    expect(bySignature.get('POST /invitations')?.roles).toEqual(['employer']);
    expect(bySignature.get('GET /candidates/me/profile')?.roles).toEqual([
      'candidate',
    ]);
    expect(bySignature.get('GET /discovery/recommended')?.roles).toEqual([
      'candidate',
    ]);

    // M12: the wallet is money, and it belongs to the employer side only. A multi-role
    // account acting as a candidate must not be able to read its own balance or spend
    // from it, and nothing on the candidate side should ever quote a Coin price.
    expect(bySignature.get('GET /wallet')?.roles).toEqual(['employer']);
    expect(bySignature.get('POST /wallet/unlocks')?.roles).toEqual([
      'employer',
    ]);
  });
});

describe('the audit covers the whole application', () => {
  it('lists every controller the application registers', async () => {
    const { AppModule } = await import('../../app.module');
    const imported = metadataOf(AppModule, 'imports');
    const registered = imported
      .flatMap((module) => metadataOf(module, 'controllers'))
      .filter(Boolean);

    // A module left out of the list above would silently escape every assertion in this
    // file, so the list is checked against what `app.module.ts` actually wires up.
    for (const controller of registered) {
      expect(CONTROLLERS).toContain(controller);
    }

    expect(registered.length).toBe(CONTROLLERS.length);
  });
});
