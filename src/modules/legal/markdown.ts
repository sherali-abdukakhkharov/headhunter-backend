/**
 * The Markdown the legal pages are written in, rendered to HTML.
 *
 * **A subset, on purpose, and not a dependency.** The two documents this serves use
 * headings, paragraphs, bullet and numbered lists, bold, links and the two-space line
 * break — nothing else — and they are written by us, so the renderer needs to be
 * correct for exactly that and safe for everything else. A general Markdown library
 * would bring HTML passthrough, which is the one feature a page holding user-facing
 * legal text must not have: this renderer escapes every character of source text
 * first and adds tags only from its own grammar, so a `<script>` in a policy file
 * renders as the six characters `<script>`.
 *
 * Anything outside the subset degrades to a paragraph rather than to a parse error,
 * which is the right failure for a document a lawyer edits: the text still reaches
 * the reader, and `legal-pages.spec.ts` pins the constructs the current files use.
 */

/** Escapes the five characters HTML cannot carry as text. */
function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Inline grammar: bold, links, code. Applied to already-escaped text, so the
 * patterns match escaped characters where it matters (`&quot;` never appears
 * inside a URL we accept).
 *
 * Links are emitted only for `http(s)` and `mailto` targets. A `javascript:` URL
 * in a policy file is not a case worth supporting.
 */
function inline(escaped: string): string {
  return escaped
    .replace(
      /\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g,
      '<a href="$2">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Renders a document to an HTML fragment (no `<html>`, no `<body>`).
 *
 * Returns the fragment and the document's title — the first level-one heading —
 * so the page template can put it in `<title>` without parsing the output.
 */
export function renderMarkdown(source: string): {
  title: string;
  html: string;
} {
  const out: string[] = [];
  let title = '';
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join('\n')}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };

  const openList = (kind: 'ul' | 'ol') => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };

  for (const raw of source.replace(/\r\n/g, '\n').split('\n')) {
    // Two trailing spaces are Markdown's hard line break; other trailing
    // whitespace is noise.
    const hardBreak = /\S {2,}$/.test(raw);
    const line = raw.replace(/\s+$/, '');

    if (line === '') {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3}) (.+)$/.exec(line);

    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      const text = inline(escape(heading[2]));
      if (level === 1 && !title) title = heading[2];
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    const bullet = /^- (.+)$/.exec(line);
    const item = bullet ?? /^\d+\. (.+)$/.exec(line);

    if (item) {
      flushParagraph();
      openList(bullet ? 'ul' : 'ol');
      out.push(`<li>${inline(escape(item[1]))}</li>`);
      continue;
    }

    // An indented line inside a list continues the previous item: the source
    // wraps long items at 80 columns.
    if (list && /^\s+\S/.test(line)) {
      // A list is open only once an item has been pushed, so there is one.
      const last = out.pop() ?? '';
      out.push(
        `${last.slice(0, -'</li>'.length)} ${inline(escape(line.trim()))}</li>`,
      );
      continue;
    }

    closeList();
    paragraph.push(inline(escape(line)) + (hardBreak ? '<br>' : ''));
  }

  flushParagraph();
  closeList();

  return { title, html: out.join('\n') };
}
