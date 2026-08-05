import { type CustomDecorator, SetMetadata } from '@nestjs/common';

import type { UserRole } from '@infra/db/database.types';

export const REQUIRED_ROLES_KEY = 'required_roles';

/**
 * Restricts a route to callers whose **active** role is one of these (§2.3).
 *
 * Holding a role is not the same as acting as it: an account that is both
 * candidate and employer must not reach employer routes while acting as a
 * candidate, or the two sides of the product leak into each other.
 */
export const RequireRole = (...roles: UserRole[]): CustomDecorator<string> =>
  SetMetadata(REQUIRED_ROLES_KEY, roles);
