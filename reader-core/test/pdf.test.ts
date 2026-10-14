import { describe, expect, it } from 'vitest';
import { PdfError, createAnchor, pageReadableText, parsePdf, parsePdfDate, resolveAnchor, sniffUpload } from '../src/index.ts';
import type { TextItemLike } from '../src/index.ts';
import { epub3 } from './epubFixture.ts';
import { makePdf } from './pdfFixture.ts';

const item = (str: string, y: number, hasEOL = true, height = 12): TextItemLike => ({ str, transform: [12, 0, 0, 12, 72, y], height, hasEOL });

const SAMPLE = makePdf({
  title: 'A Test Paper', author: 'Ada Lovelace',
  outline: [{ title: 'Intro', page: 0 }, { title: 'Later', page: 1 }],
  pages: [
    [[72, 720, 'Hello brave new'], [72, 706, 'world of readers.'], [72, 660, 'Second paragraph here.']],
    [[72, 720, 'Page two has inter-'], [72, 706, 'national trade and well-'], [72, 692, 'Known facts.']],
  ],
});

describe('parsePdf', () => {
  it('reads metadata, page geometry and the outline', async () => {
    const pdf = await parsePdf(SAMPLE);
    expect(pdf).toMatchObject({ format: 'pdf', title: 'A Test Paper', author: 'Ada Lovelace', createdAt: '2026-03-14T12:00:00.000Z', pageCount: 2, pagesParsed: 2, truncated: false, needsOcr: false });
    expect(pdf.pages[0]).toMatchObject({ index: 0, width: 612, height: 792 });
    expect(pdf.toc).toEqual([{ title: 'Intro', depth: 0, pageIndex: 0 }, { title: 'Later', depth: 0, pageIndex: 1 }]);
    expect(pdf.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes two texts per page: the exact anchor space, and reflowed readable text', async () => {
    const [p1, p2] = (await parsePdf(SAMPLE)).pages;
    expect(p1!.anchorText).toBe('Hello brave newworld of readers.Second paragraph here.');
    expect(p1!.text).toBe('Hello brave new world of readers.\n\nSecond paragraph here.');
    expect(p2!.text).toBe('Page two has international trade and well- Known facts.'); // lower-case continuation re-joined; capitalised one is not
    expect(p1!.wordCount).toBeGreaterThan(5);
  });

  it('highlights anchor to a page and re-attach after the PDF is replaced by a revised copy', async () => {
    const v1 = (await parsePdf(SAMPLE)).pages[0]!;
    const i = v1.anchorText.indexOf('readers.');
    const anchor = createAnchor(v1.anchorText, i, i + 'readers.'.length);
    const revised = makePdf({ pages: [[[72, 720, 'A new line was inserted above.'], [72, 706, 'Hello brave new'], [72, 692, 'world of readers.'], [72, 646, 'Second paragraph here.']]] });
    const v2 = (await parsePdf(revised)).pages[0]!;
    const m = resolveAnchor(v2.anchorText, anchor)!;
    expect(v2.anchorText.slice(m.start, m.end)).toBe('readers.');
  });

  it('flags image-only PDFs instead of pretending they have text', async () => {
    const pdf = await parsePdf(makePdf({ pages: [[], []] }));
    expect(pdf).toMatchObject({ pagesParsed: 2, needsOcr: true, wordCount: 0, title: 'Untitled' });
  });

  it('falls back to the first line of text for the title', async () => {
    expect((await parsePdf(makePdf({ pages: [[[72, 720, 'Untitled Draft Heading'], [72, 700, 'body']]] }))).title).toBe('Untitled Draft Heading');
  });

  it('stops at maxPages and says so', async () => {
    const many = makePdf({ pages: Array.from({ length: 6 }, (_, i) => [[72, 720, `Page ${i + 1}`]] as Array<[number, number, string]>) });
    const pdf = await parsePdf(many, { maxPages: 3 });
    expect(pdf).toMatchObject({ pageCount: 6, pagesParsed: 3, truncated: true });
    expect(pdf.pages.map((p) => p.anchorText)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('caps per-page text', async () => {
    // pdf.js drops text that falls outside the page box, so spread the text over lines that fit.
    const lines = Array.from({ length: 5 }, (_, i) => [72, 720 - i * 14, 'x'.repeat(60)] as [number, number, string]);
    const pdf = await parsePdf(makePdf({ pages: [lines] }), { maxCharsPerPage: 100 });
    expect(pdf.pages[0]!.anchorText).toHaveLength(100);
    expect((await parsePdf(makePdf({ pages: [lines] }))).pages[0]!.anchorText).toHaveLength(300);
  });

  it('rejects non-PDFs, oversized files, damaged files and cancelled work with PdfError', async () => {
    await expect(parsePdf(new TextEncoder().encode('hello'))).rejects.toThrow(/Not a PDF/);
    await expect(parsePdf(SAMPLE, { maxBytes: 100 })).rejects.toThrow(/exceeds/);
    await expect(parsePdf(SAMPLE.slice(0, 200))).rejects.toBeInstanceOf(PdfError);
    await expect(parsePdf(SAMPLE, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled|timed out/);
  });

  it('is not affected by the caller reusing its buffer afterwards', async () => {
    const copy = SAMPLE.slice();
    await parsePdf(copy);
    expect(copy.byteLength).toBe(SAMPLE.byteLength); // pdf.js detaches what it is given; we hand it a copy
  });
});

describe('pageReadableText', () => {
  it('joins lines into paragraphs and breaks on large vertical gaps', () => {
    expect(pageReadableText([item('One', 700), item('two', 686), item('Three', 640)])).toBe('One two\n\nThree');
  });
  it('keeps items on the same baseline together, in stream order', () => {
    expect(pageReadableText([item('Hello ', 700, false), item('world', 700, true)])).toBe('Hello world');
  });
  it('only de-hyphenates when a letter precedes the hyphen and a lower-case letter follows', () => {
    expect(pageReadableText([item('co-', 700), item('operate', 686)])).toBe('cooperate');
    expect(pageReadableText([item('range 5-', 700), item('9 items', 686)])).toBe('range 5- 9 items');
    expect(pageReadableText([item('Smith-', 700), item('Jones', 686)])).toBe('Smith- Jones');
  });
  it('returns an empty string for no items', () => expect(pageReadableText([])).toBe(''));
});

describe('parsePdfDate', () => {
  it.each([
    ["D:20260314120000Z", '2026-03-14T12:00:00.000Z'],
    ["D:20260314120000+07'00'", '2026-03-14T05:00:00.000Z'],
    ["D:20260314", '2026-03-14T00:00:00.000Z'],
    ["D:2026", '2026-01-01T00:00:00.000Z'],
    ['garbage', null], [undefined, null], [42, null],
  ])('%s → %s', (raw, expected) => expect(parsePdfDate(raw)).toBe(expected));
});

describe('sniffUpload', () => {
  it('classifies by content, not by name', () => {
    expect(sniffUpload(SAMPLE)).toBe('pdf');
    expect(sniffUpload(epub3())).toBe('epub');
    expect(sniffUpload(new TextEncoder().encode('<!DOCTYPE html><html><body>hi</body></html>'))).toBe('html');
    expect(sniffUpload(new TextEncoder().encode('just some text'))).toBe('unknown');
    expect(sniffUpload(Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))).toBe('zip');
  });
});
