import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { UserRole } from '@infra/db/database.types';

import type { CurrentUser } from '../decorators/current-user.decorator';
import { RoleGuard } from './role.guard';

function contextWith(user: CurrentUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function guardRequiring(roles: UserRole[] | undefined): RoleGuard {
  const reflector = {
    getAllAndOverride: () => roles,
  } as unknown as Reflector;

  return new RoleGuard(reflector);
}

const candidate: CurrentUser = {
  id: 'user-1',
  roles: ['candidate'],
  activeRole: 'candidate',
  sessionId: 'session-1',
};

describe('RoleGuard', () => {
  it('passes routes with no @RequireRole', () => {
    expect(guardRequiring(undefined).canActivate(contextWith(candidate))).toBe(
      true,
    );
  });

  it('passes when the active role is one of the required roles', () => {
    expect(
      guardRequiring(['candidate', 'admin']).canActivate(
        contextWith(candidate),
      ),
    ).toBe(true);
  });

  it('refuses when the active role is not required', () => {
    expect(() =>
      guardRequiring(['employer']).canActivate(contextWith(candidate)),
    ).toThrow(ForbiddenException);
  });

  it('refuses a role the account holds but is not acting as', () => {
    // The whole point of activeRole: holding employer does not grant employer
    // access while acting as a candidate, or the two sides of the product leak
    // into each other.
    const both: CurrentUser = {
      ...candidate,
      roles: ['candidate', 'employer'],
      activeRole: 'candidate',
    };

    expect(() =>
      guardRequiring(['employer']).canActivate(contextWith(both)),
    ).toThrow(ForbiddenException);
  });

  it('tells a multi-role caller with no active role what to do', () => {
    const undecided: CurrentUser = {
      ...candidate,
      roles: ['candidate', 'employer'],
      activeRole: null,
    };

    expect(() =>
      guardRequiring(['employer']).canActivate(contextWith(undecided)),
    ).toThrow(/active-role/);
  });

  it('refuses an unauthenticated request on a role-guarded route', () => {
    expect(() =>
      guardRequiring(['candidate']).canActivate(contextWith(undefined)),
    ).toThrow(UnauthorizedException);
  });
});
