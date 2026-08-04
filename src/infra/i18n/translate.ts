import type { LocaleCode } from '@infra/db/database.types';
import { localeFallbackChain } from '@infra/locale/locale';

import { MESSAGES, type MessageKey, type MessageParams } from './messages';

/**
 * Renders a message in the requested locale.
 *
 * Uses the same fallback chain as dictionary labels (`uz-Cyrl → uz-Latn`,
 * anything → `en`), so a message and the values inside it degrade the same way.
 * The catalog's type requires all four locales, so the chain is a safety net for
 * a hand-edited catalog rather than an expected path.
 *
 * A missing key returns the key itself. That is deliberately ugly: an untranslated
 * error is a bug, and swallowing it into a bland "an error occurred" hides it from
 * the only people who can fix it.
 */
export function translate(
  key: MessageKey,
  locale: LocaleCode,
  params?: MessageParams,
): string {
  const entry = MESSAGES[key] as Record<LocaleCode, string> | undefined;

  if (!entry) {
    return key;
  }

  const template =
    localeFallbackChain(locale)
      .map((candidate) => entry[candidate])
      .find((value) => typeof value === 'string' && value.length > 0) ?? key;

  return interpolate(template, params);
}

/**
 * Substitutes `{name}` placeholders.
 *
 * An unmatched placeholder is left as-is rather than blanked, so a mismatch
 * between the catalog and a call site is visible in the response instead of
 * producing a sentence with a hole in it.
 */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}
