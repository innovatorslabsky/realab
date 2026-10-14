import { createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { sanitizeArticleHtml } from '../ingest/extract.ts';
import { absoluteHttpUrl, absolutizeUrls, escapeHtml, plainText } from '../ingest/html.ts';
import { normalizeUrl } from '../ingest/normalizeUrl.ts';

export class FeedParseError extends Error {
  override name = 'FeedParseError';
}

export type FeedFormat = 'rss' | 'atom' | 'rdf' | 'jsonfeed';

export interface FeedEnclosure {
  url: string;
  type: string | null;
  length: number | null;
}

export interface FeedItemDraft {
  /** Stable identity within the feed (guid / atom:id / url / hash). */
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  /** Sanitized. Many feeds only carry a teaser here; save the item's `url` to get the full article. */
  summaryHtml: string | null;
  contentHtml: string | null;
  enclosures: FeedEnclosure[];
  categories: string[];
}

export interface FeedDraft {
  format: FeedFormat;
  title: string;
  siteUrl: string | null;
  feedUrl: string;
  description: string | null;
  language: string | null;
  items: FeedItemDraft[];
}

export interface ParseFeedOptions {
  maxItems?: number;
}

const MAX_HTML = 500_000;
const XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function kids(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === name);
}
const first = (el: Element, name: string): Element | null => kids(el, name)[0] ?? null;
const textOf = (el: Element | null): string | null => el?.textContent?.trim() || null;

function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function cleanHtml(html: string | null | undefined, base: string): string | null {
  if (!html || !html.trim() || html.length > MAX_HTML) return null;
  const out = sanitizeArticleHtml(absolutizeUrls(html, base)).trim();
  return out || null;
}

/** Atom text constructs carry a `type`: text (default, needs escaping), html (escaped markup), xhtml (inline markup). */
function atomHtml(el: Element | null): string | null {
  if (!el) return null;
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();
  if (type === 'xhtml') return el.innerHTML;
  if (type === 'html') return el.textContent;
  return el.textContent ? `<p>${escapeHtml(el.textContent)}</p>` : null;
}

function finishItem(raw: Omit<FeedItemDraft, 'guid'> & { guid: string | null }): FeedItemDraft | null {
  const title = raw.title || (raw.url ?? '');
  const guid = raw.guid || raw.url || (title ? createHash('sha256').update(`${title}\n${raw.publishedAt ?? ''}`).digest('hex') : null);
  if (!guid) return null;
  return { ...raw, title: title.slice(0, 500), guid };
}

function parseRss(root: Element, feedUrl: string, max: number): FeedDraft {
  const channel = first(root, 'channel') ?? root;
  const siteUrl = absoluteHttpUrl(textOf(first(channel, 'link')), feedUrl);
  const base = siteUrl ?? feedUrl;
  const items: FeedItemDraft[] = [];
  for (const item of kids(channel, 'item').slice(0, max)) {
    const guidEl = first(item, 'guid');
    const guid = textOf(guidEl);
    const permalink = guidEl?.getAttribute('isPermaLink') !== 'false' && guid ? absoluteHttpUrl(guid, base) : null;
    const url =
      absoluteHttpUrl(textOf(first(item, 'link')), base) ??
      permalink ??
      absoluteHttpUrl(first(item, 'link')?.getAttribute('href'), base);
    const finished = finishItem({
      guid,
      url,
      title: plainText(textOf(first(item, 'title')) ?? ''),
      author: plainText(textOf(first(item, 'creator')) ?? textOf(first(item, 'author')) ?? '') || null,
      publishedAt: toIso(textOf(first(item, 'pubDate')) ?? textOf(first(item, 'date')) ?? textOf(first(item, 'published'))),
      summaryHtml: cleanHtml(textOf(first(item, 'description')), base),
      contentHtml: cleanHtml(first(item, 'encoded')?.textContent, base),
      enclosures: kids(item, 'enclosure').flatMap((e) => {
        const u = absoluteHttpUrl(e.getAttribute('url'), base);
        const len = Number(e.getAttribute('length'));
        return u ? [{ url: u, type: e.getAttribute('type'), length: Number.isFinite(len) && len > 0 ? len : null }] : [];
      }),
      categories: kids(item, 'category').map((c) => plainText(c.textContent ?? '')).filter(Boolean),
    });
    if (finished) items.push(finished);
  }
  return {
    format: 'rss',
    title: plainText(textOf(first(channel, 'title')) ?? '') || new URL(feedUrl).hostname,
    siteUrl,
    feedUrl,
    description: plainText(textOf(first(channel, 'description')) ?? '') || null,
    language: textOf(first(channel, 'language')),
    items,
  };
}

function parseAtom(root: Element, feedUrl: string, max: number): FeedDraft {
  const links = kids(root, 'link');
  const alt = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate' && (l.getAttribute('type') ?? 'text/html').includes('html'));
  const self = links.find((l) => l.getAttribute('rel') === 'self');
  const siteUrl = absoluteHttpUrl(alt?.getAttribute('href'), feedUrl);
  const base = siteUrl ?? feedUrl;
  const feedAuthor = textOf(first(first(root, 'author') ?? root, 'name'));
  const items: FeedItemDraft[] = [];
  for (const entry of kids(root, 'entry').slice(0, max)) {
    const eLinks = kids(entry, 'link');
    const href = (l: Element | undefined) => absoluteHttpUrl(l?.getAttribute('href'), base);
    const url = href(eLinks.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate'));
    const finished = finishItem({
      guid: textOf(first(entry, 'id')),
      url,
      title: plainText(atomHtml(first(entry, 'title')) ?? ''),
      author: textOf(first(first(entry, 'author') ?? entry, 'name')) ?? feedAuthor,
      publishedAt: toIso(textOf(first(entry, 'published')) ?? textOf(first(entry, 'updated'))),
      summaryHtml: cleanHtml(atomHtml(first(entry, 'summary')), base),
      contentHtml: cleanHtml(atomHtml(first(entry, 'content')), base),
      enclosures: eLinks.filter((l) => l.getAttribute('rel') === 'enclosure').flatMap((l) => {
        const u = href(l);
        const len = Number(l.getAttribute('length'));
        return u ? [{ url: u, type: l.getAttribute('type'), length: Number.isFinite(len) && len > 0 ? len : null }] : [];
      }),
      categories: kids(entry, 'category').map((c) => c.getAttribute('term') ?? '').filter(Boolean),
    });
    if (finished) items.push(finished);
  }
  return {
    format: 'atom',
    title: plainText(atomHtml(first(root, 'title')) ?? '') || new URL(feedUrl).hostname,
    siteUrl,
    feedUrl: absoluteHttpUrl(self?.getAttribute('href'), feedUrl) ?? feedUrl,
    description: plainText(atomHtml(first(root, 'subtitle')) ?? '') || null,
    language: root.getAttribute('xml:lang') ?? root.getAttribute('lang'),
    items,
  };
}

function parseRdf(root: Element, feedUrl: string, max: number): FeedDraft {
  const channel = first(root, 'channel');
  const siteUrl = absoluteHttpUrl(textOf(channel ? first(channel, 'link') : null), feedUrl);
  const base = siteUrl ?? feedUrl;
  const items: FeedItemDraft[] = [];
  for (const item of kids(root, 'item').slice(0, max)) {
    const url = absoluteHttpUrl(textOf(first(item, 'link')), base);
    const finished = finishItem({
      guid: item.getAttribute('rdf:about') ?? item.getAttributeNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about'),
      url,
      title: plainText(textOf(first(item, 'title')) ?? ''),
      author: textOf(first(item, 'creator')),
      publishedAt: toIso(textOf(first(item, 'date'))),
      summaryHtml: cleanHtml(textOf(first(item, 'description')), base),
      contentHtml: cleanHtml(first(item, 'encoded')?.textContent, base),
      enclosures: [],
      categories: kids(item, 'subject').map((c) => plainText(c.textContent ?? '')).filter(Boolean),
    });
    if (finished) items.push(finished);
  }
  return {
    format: 'rdf',
    title: plainText(textOf(channel ? first(channel, 'title') : null) ?? '') || new URL(feedUrl).hostname,
    siteUrl,
    feedUrl,
    description: plainText(textOf(channel ? first(channel, 'description') : null) ?? '') || null,
    language: null,
    items,
  };
}

interface JsonFeedItem {
  id?: unknown; url?: unknown; title?: unknown; content_html?: unknown; content_text?: unknown; summary?: unknown;
  date_published?: unknown; date_modified?: unknown; tags?: unknown; authors?: unknown; author?: unknown; attachments?: unknown;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null);

function parseJsonFeed(body: string, feedUrl: string, max: number): FeedDraft {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new FeedParseError('Not valid JSON');
  }
  if (typeof j.version !== 'string' || !j.version.startsWith('https://jsonfeed.org/version/') || !Array.isArray(j.items)) {
    throw new FeedParseError('Not a JSON Feed');
  }
  const siteUrl = absoluteHttpUrl(str(j.home_page_url), feedUrl);
  const base = siteUrl ?? feedUrl;
  const items: FeedItemDraft[] = [];
  for (const it of (j.items as JsonFeedItem[]).slice(0, max)) {
    if (!it || typeof it !== 'object') continue;
    const authors = Array.isArray(it.authors) ? it.authors : it.author ? [it.author] : [];
    const text = str(it.content_text);
    const finished = finishItem({
      guid: str(it.id),
      url: absoluteHttpUrl(str(it.url), base),
      title: plainText(str(it.title) ?? ''),
      author: str((authors[0] as { name?: unknown } | undefined)?.name),
      publishedAt: toIso(str(it.date_published) ?? str(it.date_modified)),
      summaryHtml: cleanHtml(str(it.summary) ?? (text && !it.content_html ? `<p>${escapeHtml(text)}</p>` : null), base),
      contentHtml: cleanHtml(str(it.content_html), base),
      enclosures: (Array.isArray(it.attachments) ? it.attachments : []).flatMap((a: { url?: unknown; mime_type?: unknown; size_in_bytes?: unknown }) => {
        const u = absoluteHttpUrl(str(a?.url), base);
        return u ? [{ url: u, type: str(a.mime_type), length: typeof a.size_in_bytes === 'number' ? a.size_in_bytes : null }] : [];
      }),
      categories: (Array.isArray(it.tags) ? it.tags : []).filter((t): t is string => typeof t === 'string'),
    });
    if (finished) items.push(finished);
  }
  return {
    format: 'jsonfeed',
    title: plainText(str(j.title) ?? '') || new URL(feedUrl).hostname,
    siteUrl,
    feedUrl: absoluteHttpUrl(str(j.feed_url), feedUrl) ?? feedUrl,
    description: plainText(str(j.description) ?? '') || null,
    language: str(j.language),
    items,
  };
}

/** Parse RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 / JSON Feed from text. Never fetches anything. */
export function parseFeed(body: string, feedUrl: string, options: ParseFeedOptions = {}): FeedDraft {
  const max = options.maxItems ?? 500;
  const text = body.replace(/^﻿/, '').trim();
  if (!text) throw new FeedParseError('Empty document');
  if (text.startsWith('{')) return dedupe(parseJsonFeed(text, feedUrl, max));

  // Entity declarations are how XML bombs and XXE are built. No real feed needs them.
  if (/<!ENTITY/i.test(text)) throw new FeedParseError('DTD entity declarations are not allowed');

  let dom: JSDOM;
  try {
    dom = new JSDOM(text.replace(XML_CONTROL, ''), { contentType: 'text/xml', virtualConsole: new VirtualConsole() });
  } catch {
    throw new FeedParseError('Not well-formed XML');
  }
  try {
    const root = dom.window.document.documentElement;
    const name = root.localName;
    if (name === 'rss') return dedupe(parseRss(root, feedUrl, max));
    if (name === 'feed') return dedupe(parseAtom(root, feedUrl, max));
    if (name === 'RDF') return dedupe(parseRdf(root, feedUrl, max));
    throw new FeedParseError(`Unrecognized feed root <${name}>`);
  } finally {
    dom.window.close();
  }
}

function dedupe(feed: FeedDraft): FeedDraft {
  const seen = new Set<string>();
  return { ...feed, items: feed.items.filter((i) => (seen.has(i.guid) ? false : (seen.add(i.guid), true))) };
}

/** Identity of one feed item across polls: the same guid in the same feed is the same item. */
export function feedItemKey(feedUrl: string, guid: string): string {
  return createHash('sha256').update(`${normalizeUrl(feedUrl)}\n${guid}`).digest('hex');
}

export interface DiscoveredFeed {
  url: string;
  type: string;
  title: string | null;
}

/** Find `<link rel="alternate" type="application/rss+xml">`-style feed advertisements in an HTML page. */
export function discoverFeeds(html: string, pageUrl: string): DiscoveredFeed[] {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
  try {
    const out: DiscoveredFeed[] = [];
    const seen = new Set<string>();
    for (const link of dom.window.document.querySelectorAll('link[rel~="alternate"][type][href]')) {
      const type = (link.getAttribute('type') ?? '').toLowerCase();
      if (!/(rss|atom|feed)\+(xml|json)|^application\/(rss|atom)\+xml$/.test(type)) continue;
      const url = absoluteHttpUrl(link.getAttribute('href'), pageUrl);
      if (url && !seen.has(url)) {
        seen.add(url);
        out.push({ url, type, title: link.getAttribute('title') });
      }
    }
    return out;
  } finally {
    dom.window.close();
  }
}
