import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from '@infra/api/decorators/public.decorator';

import {
  LEGAL_LANGUAGES,
  type LegalDocument,
  type LegalLanguage,
  type RenderedPage,
} from './legal-pages.build';
import { LEGAL_PAGES } from './legal-pages.generated';

/**
 * The two public pages Google Play requires: the privacy policy, and how to delete
 * an account (docs/PLAY_STORE.md §1).
 *
 * **HTML from the API, deliberately.** This product has no website and, by §2.4, no
 * web administration — but a store listing needs two URLs that a reviewer can open,
 * and `hh.qitmir.uz` is the one host the operator already runs. Two GET routes
 * returning a page is the smallest thing that satisfies that; a static-site host
 * would be a second deployment to keep alive for two documents.
 *
 * `@Public()` because a reviewer is not signed in, and excluded from Swagger because
 * they are not part of the API a client consumes. The text is rendered at build time
 * from `docs/legal/*.md` (see `legal-pages.build.ts`), so nothing here reads a file.
 *
 * Language is a query parameter rather than `Accept-Language`: the store listing
 * links one URL per language, the app links the user's own, and a reviewer pasting
 * `?lang=en` gets English whatever their browser says. Unknown values fall back to
 * Uzbek, the product's primary variant, rather than to a 404 — the page exists; only
 * the translation was mis-asked for.
 */
@Public()
@ApiExcludeController()
@Controller()
export class LegalController {
  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=600')
  privacy(@Query('lang') lang?: string): string {
    return this.page('privacy', 'privacy', lang);
  }

  @Get('account/delete')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=600')
  accountDelete(@Query('lang') lang?: string): string {
    return this.page('accountDelete', 'account/delete', lang);
  }

  private page(document: LegalDocument, path: string, lang?: string): string {
    const language = resolveLanguage(lang);

    return renderPage(LEGAL_PAGES[document][language], language, path);
  }
}

/** `uz` unless the caller asked for one of the others by its exact code. */
export function resolveLanguage(lang: string | undefined): LegalLanguage {
  return (LEGAL_LANGUAGES as readonly string[]).includes(lang ?? '')
    ? (lang as LegalLanguage)
    : 'uz';
}

const LANGUAGE_NAMES: Record<LegalLanguage, string> = {
  uz: 'O‘zbekcha',
  ru: 'Русский',
  en: 'English',
};

/**
 * Wraps a rendered document in a complete page.
 *
 * No script, no external resources: helmet's default Content-Security-Policy
 * permits inline styles and nothing from elsewhere, and a legal page has no reason
 * to load anything. The switcher is plain links, one per language, on the same path.
 *
 * **The `email_off` comments are load-bearing.** Cloudflare sits in front of this
 * host with its default "email address obfuscation" on, which rewrites every
 * address in an HTML response into a script-decoded placeholder — so the first
 * deployment served a privacy policy whose contact line read "Contact:" and
 * nothing, to anyone without JavaScript, including whatever fetches it for a
 * store review. The comment pair is Cloudflare's own opt-out for a region of the
 * page; the whole document is that region, because the address is the point.
 */
export function renderPage(
  page: RenderedPage,
  language: LegalLanguage,
  path: string,
): string {
  const switcher = LEGAL_LANGUAGES.map((code) =>
    code === language
      ? `<span aria-current="page">${LANGUAGE_NAMES[code]}</span>`
      : `<a href="/${path}?lang=${code}">${LANGUAGE_NAMES[code]}</a>`,
  ).join(' · ');

  return [
    '<!doctype html>',
    `<html lang="${language}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${page.title} — JobBridge</title>`,
    '<style>',
    'body{margin:0;background:#fff;color:#14213d;font:16px/1.55 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
    'main{max-width:720px;margin:0 auto;padding:24px 20px 64px}',
    'nav{font-size:14px;color:#5b6572;margin-bottom:24px}',
    'nav a{color:#0b5fa5}nav span{font-weight:600}',
    'h1{font-size:28px;line-height:1.2;margin:0 0 16px}',
    'h2{font-size:20px;margin:32px 0 8px}h3{font-size:17px;margin:20px 0 6px}',
    'p,li{margin:0 0 10px}ul,ol{padding-left:22px}',
    'a{color:#0b5fa5}code{font-size:15px}',
    '</style>',
    '</head>',
    '<body>',
    '<!--email_off-->',
    '<main>',
    `<nav aria-label="Language">${switcher}</nav>`,
    page.html,
    '</main>',
    '<!--/email_off-->',
    '</body>',
    '</html>',
  ].join('\n');
}
