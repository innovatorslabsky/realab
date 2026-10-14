import { strToU8, zipSync } from 'fflate';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { EpubDrmError, EpubError, createAnchor, parseEpub, rangeFromOffsets, resolveAnchor, resolveZipPath } from '../src/index.ts';
import { epub2, epub3, rawZip } from './epubFixture.ts';

const dom = (html: string) => new JSDOM(`<!doctype html><body><div id="r">${html}</div>`).window.document.getElementById('r')!;

describe('parseEpub — EPUB 3', () => {
  const book = parseEpub(epub3());

  it('reads package metadata', () => {
    expect(book).toMatchObject({
      format: 'epub', epubVersion: '3.0', title: 'The Test Book', authors: ['Ada Lovelace', 'Alan Turing'], language: 'en',
      identifier: 'urn:uuid:1234', publisher: 'Open Press', publishedAt: '2024-05-06T00:00:00.000Z', description: 'A small book.',
    });
    expect(book.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(book.wordCount).toBeGreaterThan(15);
  });

  it('follows the spine and takes chapter titles and the toc from the nav document (toc nav, not landmarks)', () => {
    expect(book.chapters.map((c) => [c.index, c.path, c.title])).toEqual([[0, 'OEBPS/ch1.xhtml', 'Chapter One'], [1, 'OEBPS/ch2.xhtml', 'Chapter Two']]);
    expect(book.toc).toEqual([
      { title: 'Chapter One', depth: 0, chapterIndex: 0, fragment: null },
      { title: 'Section Two', depth: 1, chapterIndex: 0, fragment: 's2' },
      { title: 'Chapter Two', depth: 0, chapterIndex: 1, fragment: null },
    ]);
  });

  it('parses XHTML as XML so a self-closing anchor does not swallow the text after it', () => {
    const root = dom(book.chapters[0]!.contentHtml);
    expect(root.querySelector('a#x')?.textContent).toBe('');
    expect(book.chapters[0]!.text).toContain('Delta epsilon zeta eta theta.');
  });

  it('falls back to HTML parsing for sloppy books', () => {
    expect(book.chapters[1]!.text).toContain('Final words here.');
  });

  it('sanitizes: no script/style, and rewrites links and images', () => {
    const html = book.chapters[0]!.contentHtml;
    expect(html).not.toMatch(/<script|<style|alert\(1\)|color:red/);
    const root = dom(html);
    expect(root.querySelector('a[data-epub-link="1#end"]')?.hasAttribute('href')).toBe(false);
    expect(root.querySelector('a[data-epub-link="0#top"]')).not.toBeNull();
    const ext = root.querySelector('a[href="https://example.com/ext"]')!;
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    const evil = [...root.querySelectorAll('a')].find((a) => a.textContent === 'Evil')!;
    expect(evil.hasAttribute('href') || evil.hasAttribute('data-epub-link')).toBe(false);
    const img = root.querySelector('img')!;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.getAttribute('data-epub-resource')).toBe('OEBPS/images/img1.png');
  });

  it('keeps ids so toc fragments resolve', () => {
    expect(dom(book.chapters[0]!.contentHtml).querySelector('#s2')?.textContent).toBe('Section Two');
  });

  it('keeps only images whose bytes really are images, and chapters never point at a dropped one', () => {
    expect(book.resources.map((r) => [r.path, r.mediaType]).sort()).toEqual([['OEBPS/images/cover.png', 'image/png'], ['OEBPS/images/img1.png', 'image/png']]);
    expect(book.coverPath).toBe('OEBPS/images/cover.png');
    for (const img of dom(book.chapters[1]!.contentHtml).querySelectorAll('img')) expect(img.hasAttribute('data-epub-resource')).toBe(false);
  });

  it('highlights anchor per chapter and survive a re-import with changed text', () => {
    const c = book.chapters[0]!;
    const i = c.text.indexOf('Delta epsilon zeta');
    const anchor = createAnchor(c.text, i, i + 'Delta epsilon zeta'.length);
    expect(rangeFromOffsets(dom(c.contentHtml), anchor.start, anchor.end)!.toString()).toBe('Delta epsilon zeta');

    const v2 = parseEpub(epub3((f) => { f['OEBPS/ch1.xhtml'] = (f['OEBPS/ch1.xhtml'] as string).replace('<h1 id="top">Chapter One</h1>', '<h1 id="top">Chapter One</h1><p>A new preface paragraph added later.</p>'); }));
    const c2 = v2.chapters[0]!;
    expect(c2.contentHash).not.toBe(c.contentHash);
    const m = resolveAnchor(c2.text, anchor)!;
    expect(rangeFromOffsets(dom(c2.contentHtml), m.start, m.end)!.toString()).toBe('Delta epsilon zeta');
  });
});

describe('parseEpub — EPUB 2 and quirks', () => {
  it('reads the NCX toc and the EPUB2 cover meta', () => {
    const b = parseEpub(epub2());
    expect(b.epubVersion).toBe('2.0');
    expect(b.toc.map((t) => [t.title, t.depth, t.chapterIndex, t.fragment])).toEqual([['First & Foremost', 0, 0, null], ['Nested', 1, 0, 's2'], ['Second', 0, 1, null]]);
    expect(b.chapters.map((c) => c.title)).toEqual(['First & Foremost', 'Second']);
    expect(b.coverPath).toBe('OEBPS/images/cover.png'); // declared image/jpeg, but the bytes are PNG → mediaType from bytes
    expect(b.resources.find((r) => r.path === b.coverPath)?.mediaType).toBe('image/png');
  });

  it('tolerates a manifest href whose case does not match the archive', () => {
    const b = parseEpub(epub3((f) => { f['OEBPS/content.opf'] = (f['OEBPS/content.opf'] as string).replace('href="ch2.xhtml"', 'href="CH2.XHTML"'); }));
    expect(b.chapters[1]!.text).toContain('Final');
  });

  it('falls back to a heading, then "Chapter N", when there is no toc', () => {
    const b = parseEpub(epub3((f) => { f['OEBPS/content.opf'] = (f['OEBPS/content.opf'] as string).replace(' properties="nav"', ''); }));
    expect(b.toc).toEqual([]);
    expect(b.chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
  });
});

describe('parseEpub — DRM', () => {
  const enc = (alg: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="${alg}"/><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>`;
  it('refuses DRM-protected books rather than trying to read them', () => {
    expect(() => parseEpub(epub3((f) => { f['META-INF/encryption.xml'] = enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc'); }))).toThrow(EpubDrmError);
  });
  it('treats font obfuscation as harmless', () => {
    expect(parseEpub(epub3((f) => { f['META-INF/encryption.xml'] = enc('http://www.idpf.org/2008/embedding'); })).chapters).toHaveLength(2);
  });
});

describe('parseEpub — hostile archives', () => {
  it('rejects non-zip and corrupt input', () => {
    expect(() => parseEpub(strToU8('hello world, definitely not a zip'))).toThrow(/Not a zip/);
    expect(() => parseEpub(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(EpubError);
  });
  it('rejects a book missing its container or package', () => {
    expect(() => parseEpub(rawZip({ 'a.txt': 'x' }))).toThrow(/container\.xml/);
    expect(() => parseEpub(epub3((f) => { delete f['OEBPS/content.opf']; }))).toThrow(/not found/);
  });
  it('enforces the entry count, the upload size and per-chapter size from the headers, before inflating', () => {
    expect(() => parseEpub(epub3(), { maxEntries: 3 })).toThrow(/more than 3 entries/);
    expect(() => parseEpub(epub3(), { maxBytes: 100 })).toThrow(/exceeds/);
    const bomb = epub3((f) => { f['OEBPS/ch2.xhtml'] = new Uint8Array(30 * 1024 * 1024); }); // 30 MiB of zeros, a few KB compressed
    expect(bomb.length).toBeLessThan(100_000);
    expect(() => parseEpub(bomb)).toThrow(/larger than the allowed/);
  });
  it('enforces the total expansion budget', () => {
    expect(() => parseEpub(epub3(), { maxUncompressedBytes: 500 })).toThrow(/expands beyond/);
  });
  it('does not choke on zip-slip entry names and never resolves them', () => {
    const b = parseEpub(epub3((f) => { f['../../evil.xhtml'] = 'x'; f['/abs/evil.xhtml'] = 'y'; }));
    expect(b.chapters).toHaveLength(2);
  });
  it('refuses entity declarations in package XML', () => {
    expect(() => parseEpub(epub3((f) => { f['OEBPS/content.opf'] = '<!DOCTYPE p [<!ENTITY x "y">]>' + f['OEBPS/content.opf']; }))).toThrow(/entity/i);
  });
  it('a book with no spine documents is an error, not an empty success', () => {
    expect(() => parseEpub(epub3((f) => { f['OEBPS/content.opf'] = (f['OEBPS/content.opf'] as string).replace(/<spine>.*<\/spine>/s, '<spine/>'); }))).toThrow(/no readable chapters/);
  });
  it('survives forged uncompressed sizes: a clean error, quickly, without allocating the real size', () => {
    const z = epub3((f) => { f['OEBPS/ch2.xhtml'] = new Uint8Array(40 * 1024 * 1024); });
    const forged = z.slice();
    const dv = new DataView(forged.buffer);
    for (let i = 0; i < forged.length - 30; i++) {
      if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, 100, true); // local header
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 100, true); // central directory
    }
    const t = Date.now();
    expect(() => parseEpub(forged)).toThrow(EpubError);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('resolveZipPath', () => {
  it.each([
    ['OEBPS/content.opf', 'ch1.xhtml', 'OEBPS/ch1.xhtml'],
    ['OEBPS/content.opf', '../META-INF/x.xml', 'META-INF/x.xml'],
    ['OEBPS/a/b.xhtml', '../images/p%20q.png#frag', 'OEBPS/images/p q.png'],
    ['content.opf', './ch1.xhtml', 'ch1.xhtml'],
    ['OEBPS/content.opf', '../../etc/passwd', null],
    ['OEBPS/content.opf', '/etc/passwd', null],
    ['OEBPS/content.opf', 'http://evil.test/x', null],
    ['OEBPS/content.opf', 'file:///etc/passwd', null],
    ['OEBPS/content.opf', '#only-fragment', null],
    ['OEBPS/content.opf', '%E0%A4%A', null],
  ])('%s + %s → %s', (base, href, expected) => expect(resolveZipPath(base, href)).toBe(expected));
});
