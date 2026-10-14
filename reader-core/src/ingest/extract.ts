import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { JSDOM, VirtualConsole } from 'jsdom';
import { htmlToText } from './html.ts';

export class NotReadableError extends Error {
  override name = 'NotReadableError';
}

export interface ExtractedArticle {
  title: string;
  byline: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
  imageUrl: string | null;
  canonicalUrl: string | null;
  /** Sanitized HTML, safe to render with `innerHTML`. */
  contentHtml: string;
  /** `contentHtml.textContent` — the coordinate space highlights are anchored in. */
  text: string;
  wordCount: number;
  readingMinutes: number;
  contentHash: string;
}

export interface ExtractOptions {
  /** Below this many characters of text we treat the page as "not an article". Default 200. */
  minTextLength?: number;
}

let purifier: ReturnType<typeof createDOMPurify> | undefined;

function getPurifier() {
  if (purifier) return purifier;
  const p = createDOMPurify(new JSDOM('').window as unknown as Window & typeof globalThis);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (node.nodeName === 'IMG') {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
  purifier = p;
  return p;
}

/** Remove everything that can execute or phone home; keep the markup an article needs. */
export function sanitizeArticleHtml(html: string): string {
  return getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style', 'srcset', 'ping'],
  });
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export function countWords(text: string): { words: number; cjkChars: number } {
  const cjkChars = text.match(CJK)?.length ?? 0;
  const words = (text.replace(CJK, ' ').match(WORD) ?? []).length;
  return { words, cjkChars };
}

/** Words for Latin-script text plus individual CJK characters (which have no spaces to count). */
export function totalWords(text: string): number {
  const { words, cjkChars } = countWords(text);
  return words + cjkChars;
}

export function readingMinutes(text: string): number {
  const { words, cjkChars } = countWords(text);
  return Math.max(1, Math.ceil(words / 230 + cjkChars / 500));
}

function meta(doc: Document, ...names: string[]): string | null {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
}

function absolute(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Turn a fetched HTML page into a clean, sanitized, measurable article. */
export function extractArticle(html: string, pageUrl: string, options: ExtractOptions = {}): ExtractedArticle {
  const quiet = new VirtualConsole(); // swallow jsdom CSS/parse noise; nothing runs (no `runScripts`)
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: quiet });
  const doc = dom.window.document;

  // Read metadata first: Readability mutates the document it is given.
  const meta0 = {
    siteName: meta(doc, 'og:site_name'),
    published: meta(doc, 'article:published_time', 'og:article:published_time', 'date', 'pubdate'),
    image: meta(doc, 'og:image', 'twitter:image'),
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    ogTitle: meta(doc, 'og:title'),
    author: meta(doc, 'author', 'article:author'),
    lang: doc.documentElement.getAttribute('lang'),
  };

  const parsed = new Readability(doc).parse();
  if (!parsed?.content) throw new NotReadableError('No article content could be extracted');

  const contentHtml = sanitizeArticleHtml(parsed.content);
  const text = htmlToText(contentHtml);
  if (text.trim().length < (options.minTextLength ?? 200)) {
    throw new NotReadableError('Extracted text is too short to be an article');
  }

  return {
    title: (parsed.title || meta0.ogTitle || new URL(pageUrl).hostname).trim(),
    byline: parsed.byline?.trim() || meta0.author,
    excerpt: parsed.excerpt?.trim() || null,
    siteName: parsed.siteName?.trim() || meta0.siteName,
    lang: parsed.lang || meta0.lang,
    publishedTime: parsed.publishedTime || meta0.published,
    imageUrl: absolute(meta0.image, pageUrl),
    canonicalUrl: absolute(meta0.canonical, pageUrl),
    contentHtml,
    text,
    wordCount: totalWords(text),
    readingMinutes: readingMinutes(text),
    contentHash: createHash('sha256').update(text).digest('hex'),
  };
}
