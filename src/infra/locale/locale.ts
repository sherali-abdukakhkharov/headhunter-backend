import type { LocaleCode } from '@infra/db/database.types';

/**
 * Locale resolution for the `x-lang` header (§3.1, docs/API_CONTRACTS.md §1).
 *
 * Four interface variants, three languages: Uzbek ships in two scripts. The
 * canonical codes are BCP-47 with frozen casing, because the client keys its
 * dictionary cache off the `locale` field we emit - a casing slip is not a
 * cosmetic bug, it permanently splits the cache and every read becomes a miss.
 */

export const CANONICAL_LOCALES: readonly LocaleCode[] = [
  'uz-Latn',
  'uz-Cyrl',
  'ru',
  'en',
];

/** Used when `x-lang` is absent or unrecognized. */
export const DEFAULT_LOCALE: LocaleCode = 'uz-Latn';

/**
 * Accepted spellings, lower-cased.
 *
 * The house aliases `uz` and `oz` exist because `d:\Dev\digital-edo-api` already
 * uses them and alignment across the service family is free. This is a strict
 * allow-list rather than the pass-through that decorator uses: the value becomes
 * a translation-table key here, so an arbitrary string would be a query against
 * a locale that cannot exist.
 */
const ALIASES: Readonly<Record<string, LocaleCode>> = {
  uz: 'uz-Latn',
  'uz-latn': 'uz-Latn',
  uz_latn: 'uz-Latn',
  oz: 'uz-Cyrl',
  'uz-cyrl': 'uz-Cyrl',
  uz_cyrl: 'uz-Cyrl',
  ru: 'ru',
  'ru-ru': 'ru',
  en: 'en',
  'en-us': 'en',
  'en-gb': 'en',
};

/**
 * Resolves a header value to a canonical locale.
 *
 * An unknown value falls back to the default rather than failing the request:
 * §3.2 requires a configured fallback, and refusing to serve a client that sent
 * `de` would be a worse outcome than serving it Uzbek.
 */
export function normalizeLocale(raw: string | undefined): LocaleCode {
  if (!raw) {
    return DEFAULT_LOCALE;
  }

  // A full Accept-Language-style list may arrive here; only the first entry is
  // considered, and quality values are ignored.
  const first = raw.split(',')[0].trim().toLowerCase();

  return ALIASES[first] ?? DEFAULT_LOCALE;
}

/**
 * Label lookup order for a locale, most specific first (§3.2).
 *
 * `uz-Cyrl` falls back to `uz-Latn` before English because the two are the same
 * language in different scripts: a Cyrillic reader is far better served by a
 * Latin-script Uzbek label than by an English one.
 */
export function localeFallbackChain(locale: LocaleCode): LocaleCode[] {
  switch (locale) {
    case 'uz-Cyrl':
      return ['uz-Cyrl', 'uz-Latn', 'en'];
    case 'uz-Latn':
      return ['uz-Latn', 'en'];
    case 'ru':
      return ['ru', 'en'];
    default:
      return ['en'];
  }
}
