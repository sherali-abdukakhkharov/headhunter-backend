import { avatarPng, encodePng, pdfDocument } from './documents';

/**
 * The two generated formats, checked where they can silently be wrong.
 *
 * No PDF reader and no image decoder is available in this environment, so these
 * assert the structure a reader would parse rather than what it would display: a
 * cross-reference table whose offsets miss their objects produces a file that opens
 * as blank or not at all, and nothing upstream would notice — `FilesService` checks
 * the first five bytes, and Telegram stores whatever it is given.
 */
describe('encodePng', () => {
  it('writes the signature FilesService checks for', () => {
    // Renamed executables are what that check exists to stop, so a generator that
    // produced almost-a-PNG would be rejected at upload with a validation error
    // pointing at the wrong thing.
    const png = encodePng(4, 4, () => [1, 2, 3]);

    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('declares the dimensions it was asked for', () => {
    const png = encodePng(7, 11, () => [0, 0, 0]);
    // IHDR data begins at byte 16: 8 signature + 4 length + 4 type.
    expect(png.readUInt32BE(16)).toBe(7);
    expect(png.readUInt32BE(20)).toBe(11);
  });

  it('ends with IEND', () => {
    const png = encodePng(2, 2, () => [0, 0, 0]);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
});

describe('avatarPng', () => {
  it('draws ink somewhere and ground elsewhere', () => {
    // A monogram that came out entirely one colour is the failure mode worth
    // catching: it looks like a deliberate flat avatar in a thumbnail.
    const png = avatarPng('AK', [20, 80, 120], 64);
    expect(png.length).toBeGreaterThan(100);

    const flat = avatarPng('', [20, 80, 120], 64);
    expect(png.length).toBeGreaterThan(flat.length);
  });
});

describe('pdfDocument', () => {
  const pdf = pdfDocument([
    { kind: 'title', text: 'Aziza Karimova' },
    { kind: 'heading', text: 'Experience' },
    { kind: 'line', text: 'Backend Developer, Uzum Technologies' },
    { kind: 'gap' },
    { kind: 'muted', text: '(demo) 50% of a line \\ with escapes' },
  ]);

  const text = pdf.toString('latin1');

  it('starts with the header FilesService checks for', () => {
    expect(text.startsWith('%PDF-')).toBe(true);
  });

  it('points every cross-reference entry at its object', () => {
    // The one thing that is both easy to get wrong and invisible until a reader
    // refuses the file: offsets are absolute byte positions, so any change to the
    // header or to an earlier object shifts all of them.
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(Number.isInteger(xrefAt)).toBe(true);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe('xref');

    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );

    expect(entries).toHaveLength(6);

    entries.forEach((offset, index) => {
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
  });

  it('declares the content stream’s true length', () => {
    const declared = Number(/\/Length (\d+)/.exec(text)?.[1]);
    const stream = /stream\n([\s\S]*?)\nendstream/.exec(text)?.[1] ?? '';

    expect(stream).toHaveLength(declared);
  });

  it('escapes the three characters a PDF string cannot carry raw', () => {
    // An unescaped ')' ends the string early and the rest of the document becomes
    // operators, which is how a stray parenthesis in a job title corrupts a CV.
    expect(text).toContain('\\(demo\\)');
    expect(text).toContain('\\\\ with escapes');
  });

  it('names the fonts the page resources declare', () => {
    expect(text).toContain('/F1 5 0 R /F2 6 0 R');
    expect(text).toContain('/BaseFont /Helvetica');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
  });
});
