import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { UnsupportedUploadError, createHighlightSchema, ingestUpload } from '../src/index.ts';
import { epub3, rawZip } from './epubFixture.ts';
import { makePdf } from './pdfFixture.ts';

describe('ingestUpload', () => {
  it('routes by content', async () => {
    const pdf = await ingestUpload(makePdf({ title: 'P', pages: [[[72, 720, 'Hello there reader']]] }));
    expect(pdf.kind).toBe('pdf');
    const epub = await ingestUpload(epub3());
    expect(epub.kind).toBe('epub');
    if (epub.kind === 'epub') expect(epub.draft.title).toBe('The Test Book');
  });
  it('refuses everything else with a specific reason', async () => {
    await expect(ingestUpload(zipSync({ 'a.txt': strToU8('x') }))).rejects.toThrow(/not an EPUB/);
    await expect(ingestUpload(rawZip({ 'a.txt': 'x' }))).rejects.toThrow(/container\.xml/); // claims to be an EPUB (has the mimetype entry) but is not one
    await expect(ingestUpload(new TextEncoder().encode('<html><body>x</body></html>'))).rejects.toThrow(/by URL/);
    await expect(ingestUpload(new TextEncoder().encode('plain'))).rejects.toBeInstanceOf(UnsupportedUploadError);
  });
  it('passes per-format limits through', async () => {
    await expect(ingestUpload(epub3(), { epub: { maxEntries: 2 } })).rejects.toThrow(/entries/);
  });
});

describe('createHighlightSchema', () => {
  const base = { documentId: 'doc1', anchor: { exact: 'x', prefix: '', suffix: '', start: 0, end: 1 }, contentHash: 'a'.repeat(64) };
  it('accepts article, chapter and page highlights with defaults filled in', () => {
    expect(createHighlightSchema.parse(base)).toMatchObject({ color: 'yellow', tags: [] });
    expect(createHighlightSchema.parse({ ...base, unit: { kind: 'chapter', index: 3 } }).unit).toEqual({ kind: 'chapter', index: 3 });
    expect(createHighlightSchema.parse({ ...base, unit: { kind: 'page', index: 0 } }).unit?.kind).toBe('page');
  });
  it.each([
    ['empty quote', { anchor: { ...base.anchor, exact: '' } }],
    ['end before start', { anchor: { ...base.anchor, start: 5, end: 2 } }],
    ['bad color', { color: 'neon' }],
    ['bad hash', { contentHash: 'short' }],
    ['unknown unit kind', { unit: { kind: 'paragraph', index: 1 } }],
    ['negative unit index', { unit: { kind: 'page', index: -1 } }],
  ])('rejects %s', (_n, patch) => expect(createHighlightSchema.safeParse({ ...base, ...patch }).success).toBe(false));
});
