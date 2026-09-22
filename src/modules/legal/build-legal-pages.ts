/**
 * CLI for `legal-pages.build.ts`: renders `docs/legal/*.md` and writes the module.
 *
 *   pnpm legal:build
 *
 * Runs under tsx like the other standalone scripts - nothing here boots Nest.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderLegalPages, serializeLegalPages } from './legal-pages.build';

const root = join(__dirname, '../../..');
const pages = renderLegalPages(join(root, 'docs/legal'));
const target = join(__dirname, 'legal-pages.generated.ts');

writeFileSync(target, serializeLegalPages(pages));

for (const [document, languages] of Object.entries(pages)) {
  for (const [language, page] of Object.entries(languages)) {
    console.log(
      `${document}/${language}: "${page.title}" (${page.html.length} bytes)`,
    );
  }
}

console.log(`\nWrote ${target}`);
