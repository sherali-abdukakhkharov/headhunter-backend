import { deflateSync } from 'node:zlib';

/**
 * The bytes the demo fixtures upload: readable CVs, certificates and avatars.
 *
 * **Why they are generated rather than committed.** `FilesService.store` checks a
 * magic number before it accepts anything, so the fixtures cannot be placeholder
 * text with a `.pdf` name — they have to be real files. The two ways to get real
 * files are to commit binaries or to write them, and committing them loses on every
 * count: a repository that keeps credential-shaped files out should not start
 * carrying stock photographs of nobody in particular, the licence of anything
 * downloaded would need answering, and a CV has to say the candidate's own name to be
 * worth opening. Generating means the document matches the row.
 *
 * So: a real PDF a person can read, and a real PNG a phone can display. Two small
 * encoders, no dependencies — `node:zlib` is what PNG needs and PDF needs nothing.
 *
 * **The avatars are initials, not faces**, and that is deliberate rather than a
 * shortfall. A synthetic face is the one thing here that would be actively
 * misleading in a screenshot, and initials on a coloured ground is what this product
 * shows for a candidate who has not uploaded a photo anyway — so a tester sees a real
 * image, from the real file store, that is honest about what it is. It also makes a
 * screenshot legible: "AK" is Aziza Karimova.
 */

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let c = n;

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    table[n] = c >>> 0;
  }

  return table;
}

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;

  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }

  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));

  return Buffer.concat([length, typed, crc]);
}

export type Rgb = [number, number, number];

/**
 * Encodes an RGB image, one call per pixel.
 *
 * Filter type 0 on every scanline: these images are small and flat, so the filtering
 * that would help a photograph buys nothing and costs a branch per byte.
 */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;

  for (let y = 0; y < height; y += 1) {
    raw[at] = 0;
    at += 1;

    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      at += 3;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A 5x7 bitmap of the Latin alphabet, for drawing initials.
 *
 * Hand-drawn rather than rasterised from a font file: two letters at one size is not
 * worth a font parser, and this way the fixture generator has no font to ship.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
};

/**
 * An avatar: up to two initials, centred on a softly shaded ground.
 *
 * The ground colour comes from the caller rather than a hash of the name, so the
 * fixture file and the tester document can agree on what a given person looks like.
 *
 * Sampled nine times per pixel and blended. A 5x7 bitmap scaled up 70 times has
 * staircase edges that read as a broken image rather than as a monogram, and
 * averaging the coverage is the whole fix — the letterforms stay blocky, which is
 * fine, but the edges stop looking like a rendering fault.
 */
export function avatarPng(initials: string, ground: Rgb, size = 512): Buffer {
  const letters = [...initials.toUpperCase()]
    .filter((c) => GLYPHS[c])
    .slice(0, 2);

  // 5 columns per glyph plus a one-column gap, in glyph units.
  const unitsWide = letters.length * 5 + Math.max(letters.length - 1, 0);
  const scale = (size * 0.44) / Math.max(unitsWide, 1);
  const left = (size - unitsWide * scale) / 2;
  const top = (size - 7 * scale) / 2;

  const ink: Rgb = [255, 255, 255];
  const samples = [0.17, 0.5, 0.83];

  const isInk = (px: number, py: number): boolean => {
    const gx = Math.floor((px - left) / scale);
    const gy = Math.floor((py - top) / scale);

    if (gx < 0 || gy < 0 || gy > 6 || gx >= unitsWide) {
      return false;
    }

    const letter = letters[Math.floor(gx / 6)];
    const column = gx % 6;

    // Column 5 is the gap between the two glyphs.
    return !!letter && column !== 5 && GLYPHS[letter]?.[gy]?.[column] === '#';
  };

  return encodePng(size, size, (x, y) => {
    let covered = 0;

    for (const dy of samples) {
      for (const dx of samples) {
        if (isInk(x + dx, y + dy)) covered += 1;
      }
    }

    // A gentle top-to-bottom darkening, so the ground reads as deliberate rather
    // than as a fill nobody chose.
    const shade = 1 - (y / size) * 0.22;
    const base = ground.map((c) => Math.round(c * shade)) as Rgb;

    if (covered === 0) return base;
    if (covered === 9) return ink;

    const alpha = covered / 9;

    return base.map((c, i) => Math.round(c + (ink[i] - c) * alpha)) as Rgb;
  });
}

// --- PDF ---------------------------------------------------------------------

/** One line of a generated document. */
export type PdfBlock =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'line'; text: string }
  | { kind: 'muted'; text: string }
  | { kind: 'gap' };

const PAGE_WIDTH = 595; // A4 at 72dpi
const PAGE_HEIGHT = 842;
const MARGIN = 56;

/** PDF strings are parenthesised, so three characters have to be escaped. */
function pdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

/**
 * Writes a one-page A4 document.
 *
 * Built by hand rather than with a library for the reason the module comment gives,
 * and it stays honest by construction: the cross-reference table is written from the
 * byte offsets actually emitted, so a malformed document would fail to open rather
 * than render wrong. The two standard fonts need no embedding, which is what keeps
 * this small — and it is why the text is ASCII: the standard encodings do not carry
 * Cyrillic, so a fixture written in Uzbek Latin is one that opens everywhere.
 */
export function pdfDocument(blocks: PdfBlock[]): Buffer {
  const lines: string[] = ['BT'];
  let y = PAGE_HEIGHT - MARGIN;

  const write = (font: string, size: number, text: string, gap: number) => {
    lines.push(
      `/${font} ${size} Tf`,
      `1 0 0 1 ${MARGIN} ${y} Tm`,
      `(${pdfText(text)}) Tj`,
    );
    y -= gap;
  };

  for (const block of blocks) {
    switch (block.kind) {
      case 'title':
        write('F2', 20, block.text, 30);
        break;
      case 'heading':
        y -= 8;
        write('F2', 12, block.text, 20);
        break;
      case 'line':
        write('F1', 11, block.text, 16);
        break;
      case 'muted':
        write('F1', 9, block.text, 14);
        break;
      case 'gap':
        y -= 10;
        break;
    }
  }

  lines.push('ET');

  const content = Buffer.from(lines.join('\n'), 'latin1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
  ];

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let at = parts[0].length;

  objects.forEach((body, index) => {
    offsets.push(at);
    const object = Buffer.from(
      `${index + 1} 0 obj\n${body}\nendobj\n`,
      'latin1',
    );
    parts.push(object);
    at += object.length;
  });

  const xrefAt = at;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map(
      (offset) => `${String(offset).padStart(10, '0')} 00000 n \n`,
    ),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefAt}\n%%EOF\n`,
  ].join('');

  parts.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}
