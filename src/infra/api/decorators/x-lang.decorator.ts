import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';

import type { LocaleCode } from '@infra/db/database.types';
import { normalizeLocale } from '@infra/locale/locale';

/**
 * Injects the request's canonical locale, resolved from `x-lang`.
 *
 * Modelled on `d:\Dev\digital-edo-api`'s decorator of the same name, with one
 * deliberate difference: that one passes the header through verbatim, which we
 * cannot do because the value is used as a translation-table key.
 */
export const XLang = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): LocaleCode => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return normalizeLocale(request.headers['x-lang'] as string | undefined);
  },
);
