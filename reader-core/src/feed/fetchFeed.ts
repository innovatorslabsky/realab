import { safeFetch, decodeBody, FetchError } from '../net/safeFetch.ts';
import type { SafeFetchOptions } from '../net/safeFetch.ts';
import { FeedParseError, discoverFeeds, parseFeed } from './parseFeed.ts';
import type { FeedDraft, ParseFeedOptions } from './parseFeed.ts';

const FEED_TYPES = [
  'application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/xml', 'text/xml',
  'application/feed+json', 'application/json',
  // Misconfigured servers commonly label feeds like this; the parser is the real validator.
  'text/plain', 'application/octet-stream',
] as const;

export interface FeedFetchOptions {
  fetch?: SafeFetchOptions;
  parse?: ParseFeedOptions;
  /** Validators saved from the previous poll. */
  etag?: string | null;
  lastModified?: string | null;
}

export interface FeedFetchResult {
  /** Null when the server answered 304 Not Modified. */
  feed: FeedDraft | null;
  notModified: boolean;
  feedUrl: string;
  etag: string | null;
  lastModified: string | null;
}

/** Poll a known feed URL. Pass back `etag`/`lastModified` from the last result to make polling cheap. */
export async function fetchFeed(url: string, options: FeedFetchOptions = {}): Promise<FeedFetchResult> {
  const res = await safeFetch(url, {
    maxBytes: 5 * 1024 * 1024,
    ...options.fetch,
    accept: FEED_TYPES,
    ifNoneMatch: options.etag ?? undefined,
    ifModifiedSince: options.lastModified ?? undefined,
  });
  if (res.notModified) return { feed: null, notModified: true, feedUrl: res.finalUrl, etag: res.etag ?? options.etag ?? null, lastModified: res.lastModified ?? options.lastModified ?? null };
  const feed = parseFeed(decodeBody(res.bytes, res.contentType), res.finalUrl, options.parse);
  return { feed, notModified: false, feedUrl: feed.feedUrl, etag: res.etag, lastModified: res.lastModified };
}

/**
 * "Add a feed": the user may paste a feed URL or just a site's address. Try it as a feed; if it is an
 * HTML page, follow its advertised feed (one hop only, through the same safe fetcher).
 */
export async function subscribeToUrl(url: string, options: FeedFetchOptions = {}): Promise<FeedFetchResult> {
  const res = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, ...options.fetch, accept: [...FEED_TYPES, 'text/html', 'application/xhtml+xml'] });
  const body = decodeBody(res.bytes, res.contentType);
  const isHtml = /^(text\/html|application\/xhtml\+xml)/i.test(res.contentType);
  if (!isHtml) {
    const feed = parseFeed(body, res.finalUrl, options.parse);
    return { feed, notModified: false, feedUrl: feed.feedUrl, etag: res.etag, lastModified: res.lastModified };
  }
  const candidates = discoverFeeds(body, res.finalUrl);
  if (!candidates.length) throw new FeedParseError('This page does not advertise a feed');
  let lastError: unknown;
  for (const c of candidates.slice(0, 3)) {
    try {
      return await fetchFeed(c.url, { ...options, etag: null, lastModified: null });
    } catch (err) {
      if (!(err instanceof FeedParseError || err instanceof FetchError)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new FeedParseError('No advertised feed could be read');
}
