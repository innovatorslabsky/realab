import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import type { UnzipFileInfo } from 'fflate';
import { JSDOM, VirtualConsole } from 'jsdom';
import { readingMinutes, sanitizeArticleHtml, totalWords } from '../ingest/extract.ts';
import { editFragment, htmlToText, plainText } from '../ingest/html.ts';

export class EpubError extends Error {
  override name = 'EpubError';
}
/** The book is encrypted by a DRM scheme. We do not decrypt or circumvent DRM. */
export class EpubDrmError extends EpubError {
  override name = 'EpubDrmError';
}

export interface EpubLimits {
  /** Compressed upload size. Default 100 MiB. */
  maxBytes: number;
  /** Zip entries. Default 5000. */
  maxEntries: number;
  /** Sum of *declared* uncompressed sizes of the entries we read. Default 200 MiB. */
  maxUncompressedBytes: number;
  maxChapters: number;
  maxChapterBytes: number;
  maxImageBytes: number;
  maxImagesTotalBytes: number;
}

const DEFAULT_LIMITS: EpubLimits = {
  maxBytes: 100 * 1024 * 1024,
  maxEntries: 5000,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxChapters: 1000,
  maxChapterBytes: 5 * 1024 * 1024,
  maxImageBytes: 8 * 1024 * 1024,
  maxImagesTotalBytes: 80 * 1024 * 1024,
};

export interface EpubChapter {
  index: number;
  /** manifest id */
  id: string;
  /** path inside the zip */
  path: string;
  title: string;
  /** Sanitized. Images carry `data-epub-resource="<zip path>"` instead of `src`; internal links carry `data-epub-link="<chapterIndex>#<fragment>"` instead of `href`. */
  contentHtml: string;
  /** `textContent` of `contentHtml` — the coordinate space highlights anchor in (per chapter). */
  text: string;
  wordCount: number;
  contentHash: string;
}

export interface EpubTocEntry {
  title: string;
  depth: number;
  chapterIndex: number | null;
  fragment: string | null;
}

export interface EpubResource {
  path: string;
  /** Detected from the bytes, not trusted from the manifest. */
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Uint8Array;
}

export interface EpubDraft {
  format: 'epub';
  epubVersion: string | null;
  title: string;
  authors: string[];
  language: string | null;
  identifier: string | null;
  publisher: string | null;
  publishedAt: string | null;
  description: string | null;
  coverPath: string | null;
  toc: EpubTocEntry[];
  chapters: EpubChapter[];
  resources: EpubResource[];
  wordCount: number;
  readingMinutes: number;
  contentHash: string;
}

/** Font obfuscation is not DRM: it only scrambles embedded fonts, which we never use. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
const XHTML_TYPES = new Set(['application/xhtml+xml', 'text/html']);
const XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const norm = (name: string): string => name.replace(/\\/g, '/');

/**
 * Resolve an href found inside `baseFile` to a path inside the zip. Returns null for anything that is
 * not a plain relative in-archive reference: URL schemes, absolute paths, or `..` escaping the root.
 */
export function resolveZipPath(baseFile: string, href: string): string | null {
  const bare = href.split('#')[0]!.split('?')[0]!;
  if (!bare || bare.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  const dir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  const stack: string[] = [];
  for (const part of (dir + norm(decoded)).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(part);
  }
  return stack.length ? stack.join('/') : null;
}

function parseXml(text: string): { doc: Document; close: () => void } {
  const body = text.replace(/^﻿/, '').replace(XML_CONTROL, '');
  if (/<!ENTITY/i.test(body)) throw new EpubError('DTD entity declarations are not allowed');
  try {
    const dom = new JSDOM(body, { contentType: 'application/xml', virtualConsole: new VirtualConsole() });
    return { doc: dom.window.document, close: () => dom.window.close() };
  } catch {
    throw new EpubError('Malformed XML in EPUB package');
  }
}

const kids = (el: Element, name: string): Element[] => Array.from(el.children).filter((c) => c.localName === name);
const first = (el: Element, name: string): Element | null => kids(el, name)[0] ?? null;
const text = (el: Element | null): string | null => el?.textContent?.trim() || null;
const descendants = (el: Element | Document, name: string): Element[] => Array.from(el.getElementsByTagName('*')).filter((e) => e.localName === name);

function sniffImage(bytes: Uint8Array): EpubResource['mediaType'] | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && strFromU8(b.subarray(0, 4)) === 'RIFF' && strFromU8(b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null; // SVG is deliberately excluded: it can carry script.
}

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string[];
}

export function parseEpub(data: Uint8Array, limits: Partial<EpubLimits> = {}): EpubDraft {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (data.byteLength > L.maxBytes) throw new EpubError(`EPUB exceeds ${L.maxBytes} bytes`);
  if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) throw new EpubError('Not a zip archive');

  // 1) List entries without inflating anything. NB: in fflate, `size` is the COMPRESSED size and
  //    `originalSize` the declared UNCOMPRESSED size. Inflation is bounded by the declared size
  //    (a forged smaller value just truncates), so checking `originalSize` first is what makes this safe.
  const entries = new Map<string, UnzipFileInfo>();
  const lower = new Map<string, string>();
  try {
    unzipSync(data, {
      filter: (f) => {
        if (entries.size >= L.maxEntries) throw new EpubError(`EPUB has more than ${L.maxEntries} entries`);
        const name = norm(f.name);
        if (name.endsWith('/') || name.split('/').includes('..') || name.startsWith('/')) return false; // directories, zip-slip names
        entries.set(name, f);
        const l = name.toLowerCase();
        lower.set(l, lower.has(l) ? '' : name); // '' marks an ambiguous case-insensitive name
        return false;
      },
    });
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError('Corrupt or unsupported zip archive');
  }

  let budget = L.maxUncompressedBytes;
  const find = (path: string): string | null => (entries.has(path) ? path : lower.get(path.toLowerCase()) || null);
  const read = (paths: string[], perFile: number): Map<string, Uint8Array> => {
    const wanted = new Map<string, string>();
    for (const p of paths) {
      const real = find(p);
      if (!real) continue;
      const declared = entries.get(real)!.originalSize;
      if (declared > perFile) throw new EpubError(`${real} is larger than the allowed ${perFile} bytes`);
      budget -= declared;
      if (budget < 0) throw new EpubError('EPUB expands beyond the allowed size');
      wanted.set(real, p);
    }
    const out = new Map<string, Uint8Array>();
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(data, { filter: (f) => wanted.has(norm(f.name)) });
    } catch {
      throw new EpubError('Corrupt zip entry');
    }
    for (const [name, bytes] of Object.entries(files)) out.set(wanted.get(norm(name))!, bytes);
    return out;
  };

  // 2) container → package document
  const meta = read(['META-INF/container.xml', 'META-INF/encryption.xml'], 1_000_000);
  const containerBytes = meta.get('META-INF/container.xml');
  if (!containerBytes) throw new EpubError('Missing META-INF/container.xml');
  const container = parseXml(strFromU8(containerBytes));
  const rootfile = descendants(container.doc, 'rootfile').find((r) => !r.getAttribute('media-type') || r.getAttribute('media-type') === 'application/oebps-package+xml');
  const opfPath = rootfile?.getAttribute('full-path') ? resolveZipPath('', rootfile.getAttribute('full-path')!) : null;
  container.close();
  if (!opfPath) throw new EpubError('container.xml does not point at a package document');

  const encBytes = meta.get('META-INF/encryption.xml');
  if (encBytes) {
    const enc = parseXml(strFromU8(encBytes));
    const algorithms = descendants(enc.doc, 'EncryptionMethod').map((e) => e.getAttribute('Algorithm') ?? '');
    enc.close();
    if (algorithms.some((a) => !FONT_OBFUSCATION.has(a))) throw new EpubDrmError('This EPUB is DRM-protected and cannot be imported');
  }

  const opfBytes = read([opfPath], 5_000_000).get(opfPath);
  if (!opfBytes) throw new EpubError(`Package document ${opfPath} not found`);
  const opfXml = parseXml(strFromU8(opfBytes));
  const pkg = opfXml.doc.documentElement;
  if (pkg.localName !== 'package') throw new EpubError('Package document has no <package> root');

  // 3) metadata, manifest, spine
  const metadata = first(pkg, 'metadata');
  const dc = (name: string): Element[] => (metadata ? kids(metadata, name) : []);
  const uid = pkg.getAttribute('unique-identifier');
  const identifier = text(dc('identifier').find((e) => e.getAttribute('id') === uid) ?? dc('identifier')[0] ?? null);
  const metaEls = metadata ? kids(metadata, 'meta') : [];

  const manifest = new Map<string, ManifestItem>();
  for (const item of descendants(first(pkg, 'manifest') ?? pkg, 'item')) {
    const id = item.getAttribute('id');
    const path = resolveZipPath(opfPath, item.getAttribute('href') ?? '');
    if (id && path) manifest.set(id, { id, path, mediaType: (item.getAttribute('media-type') ?? '').toLowerCase(), properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean) });
  }
  const spineEl = first(pkg, 'spine');
  const spineItems = (spineEl ? kids(spineEl, 'itemref') : [])
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref') ?? ''))
    .filter((m): m is ManifestItem => !!m && XHTML_TYPES.has(m.mediaType))
    .slice(0, L.maxChapters);
  if (!spineItems.length) throw new EpubError('EPUB has no readable chapters');

  const coverId = metaEls.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = [...manifest.values()].find((m) => m.properties.includes('cover-image')) ?? (coverId ? manifest.get(coverId) : undefined);
  const navItem = [...manifest.values()].find((m) => m.properties.includes('nav'));
  const ncxItem = manifest.get(spineEl?.getAttribute('toc') ?? '') ?? [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml');

  const chapterIndexByPath = new Map<string, number>();
  spineItems.forEach((m, i) => chapterIndexByPath.set(m.path, i));

  const bodies = read([...spineItems.map((m) => m.path), ...(navItem ? [navItem.path] : []), ...(ncxItem && !navItem ? [ncxItem.path] : [])], L.maxChapterBytes);

  // 4) table of contents
  const toc: EpubTocEntry[] = [];
  const addToc = (title: string, depth: number, fromFile: string, href: string): void => {
    const path = resolveZipPath(fromFile, href);
    const frag = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
    const clean = plainText(title);
    if (clean) toc.push({ title: clean.slice(0, 300), depth, chapterIndex: path !== null ? (chapterIndexByPath.get(path) ?? null) : null, fragment: frag || null });
  };
  if (navItem && bodies.get(navItem.path)) {
    const { doc, close } = parseMarkup(strFromU8(bodies.get(navItem.path)!));
    const navs = descendants(doc, 'nav');
    const tocNav = navs.find((n) => (n.getAttribute('epub:type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
    const walk = (ol: Element, depth: number): void => {
      for (const li of kids(ol, 'li')) {
        const a = first(li, 'a') ?? first(li, 'span');
        if (a) addToc(a.textContent ?? '', depth, navItem.path, a.getAttribute('href') ?? '');
        for (const sub of kids(li, 'ol')) if (depth < 6) walk(sub, depth + 1);
      }
    };
    const top = tocNav ? first(tocNav, 'ol') : null;
    if (top) walk(top, 0);
    close();
  } else if (ncxItem && bodies.get(ncxItem.path)) {
    const ncx = parseXml(strFromU8(bodies.get(ncxItem.path)!));
    const walk = (parent: Element, depth: number): void => {
      for (const np of kids(parent, 'navPoint')) {
        const label = first(first(np, 'navLabel') ?? np, 'text');
        addToc(label?.textContent ?? '', depth, ncxItem.path, first(np, 'content')?.getAttribute('src') ?? '');
        if (depth < 6) walk(np, depth + 1);
      }
    };
    const map = descendants(ncx.doc, 'navMap')[0];
    if (map) walk(map, 0);
    ncx.close();
  }

  // 5) chapters
  const imagePaths = new Set<string>();
  const chapters: EpubChapter[] = spineItems.map((item, index) => {
    const raw = bodies.get(item.path);
    const { doc, close } = parseMarkup(raw ? strFromU8(raw) : '');
    const body = doc.body ?? doc.documentElement;

    for (const img of Array.from(body.getElementsByTagName('img'))) {
      const path = resolveZipPath(item.path, img.getAttribute('src') ?? '');
      const real = path ? find(path) : null;
      img.removeAttribute('src');
      img.removeAttribute('srcset');
      if (real) {
        img.setAttribute('data-epub-resource', real);
        imagePaths.add(real);
      }
    }
    for (const a of Array.from(body.getElementsByTagName('a'))) {
      const href = a.getAttribute('href');
      if (href === null) continue;
      if (/^https?:/i.test(href)) continue; // external: kept, sanitizer adds rel/target
      const frag = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
      const target = href.startsWith('#') ? item.path : resolveZipPath(item.path, href);
      const idx = target ? chapterIndexByPath.get(find(target) ?? target) : undefined;
      a.removeAttribute('href');
      if (idx !== undefined) a.setAttribute('data-epub-link', `${idx}#${frag}`);
    }
    const headingEl = body.querySelector('h1, h2, h3');
    const headingText = plainText(headingEl?.textContent ?? '');
    const contentHtml = sanitizeArticleHtml(body.innerHTML);
    close();

    const chapterText = htmlToText(contentHtml);
    const tocTitle = toc.find((t) => t.chapterIndex === index && !t.fragment)?.title ?? toc.find((t) => t.chapterIndex === index)?.title;
    return {
      index,
      id: item.id,
      path: item.path,
      title: (tocTitle || headingText || `Chapter ${index + 1}`).slice(0, 300),
      contentHtml,
      text: chapterText,
      wordCount: totalWords(chapterText),
      contentHash: createHash('sha256').update(chapterText).digest('hex'),
    };
  });

  // 6) images (validated by content, never by declared type)
  if (coverItem) imagePaths.add(find(coverItem.path) ?? coverItem.path);
  const resources: EpubResource[] = [];
  let imageBudget = L.maxImagesTotalBytes;
  const wantImages = [...imagePaths].filter((p) => find(p) && entries.get(find(p)!)!.originalSize <= L.maxImageBytes);
  for (const [path, bytes] of read(wantImages, L.maxImageBytes)) {
    const mediaType = sniffImage(bytes);
    if (!mediaType || bytes.length > imageBudget) continue;
    imageBudget -= bytes.length;
    resources.push({ path, mediaType, bytes });
  }
  // A chapter must never point at an image we did not keep (failed the content check, or too large).
  const kept = new Set(resources.map((r) => r.path));
  const dropped = [...imagePaths].filter((p) => !kept.has(p));
  if (dropped.length) {
    for (const c of chapters) {
      c.contentHtml = editFragment(c.contentHtml, (root) => {
        for (const img of root.querySelectorAll('img[data-epub-resource]')) {
          if (!kept.has(img.getAttribute('data-epub-resource') ?? '')) img.removeAttribute('data-epub-resource');
        }
      });
    }
  }
  const coverPath = coverItem ? (resources.find((r) => r.path === (find(coverItem.path) ?? coverItem.path))?.path ?? null) : null;

  const allText = chapters.map((c) => c.text).join('\n');
  const date = text(dc('date')[0] ?? null);
  const parsedDate = date ? Date.parse(date) : NaN;
  const draft: EpubDraft = {
    format: 'epub',
    epubVersion: pkg.getAttribute('version'),
    title: plainText(text(dc('title')[0] ?? null) ?? '') || 'Untitled',
    authors: dc('creator').map((e) => plainText(e.textContent ?? '')).filter(Boolean),
    language: text(dc('language')[0] ?? null),
    identifier,
    publisher: text(dc('publisher')[0] ?? null),
    publishedAt: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
    description: plainText(text(dc('description')[0] ?? null) ?? '') || null,
    coverPath,
    toc,
    chapters,
    resources,
    wordCount: chapters.reduce((n, c) => n + c.wordCount, 0),
    readingMinutes: readingMinutes(allText),
    contentHash: createHash('sha256').update(chapters.map((c) => c.contentHash).join('\n')).digest('hex'),
  };
  opfXml.close();
  return draft;
}

/** EPUB content is XHTML, so try a real XML parse first — an HTML parser turns `<a id="x"/>` into an unclosed tag that swallows the rest of the page. Fall back to HTML for sloppy books (`&nbsp;` without a DTD). */
function parseMarkup(source: string): { doc: Document; close: () => void } {
  const body = source.replace(/^﻿/, '');
  if (!/<!ENTITY/i.test(body)) {
    try {
      const dom = new JSDOM(body, { contentType: 'application/xhtml+xml', virtualConsole: new VirtualConsole() });
      return { doc: dom.window.document, close: () => dom.window.close() };
    } catch {
      /* not well-formed XML: fall through */
    }
  }
  const dom = new JSDOM(body, { contentType: 'text/html', virtualConsole: new VirtualConsole() });
  return { doc: dom.window.document, close: () => dom.window.close() };
}
