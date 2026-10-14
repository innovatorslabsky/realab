import { safeFetchHtml } from '../net/safeFetch.ts';
import type { SafeFetchOptions } from '../net/safeFetch.ts';
import { extractArticle } from './extract.ts';
import type { ExtractedArticle, ExtractOptions } from './extract.ts';
import { normalizeUrl, urlKey } from './normalizeUrl.ts';

export interface DocumentDraft extends ExtractedArticle {
  /** URL as the user supplied it. */
  sourceUrl: string;
  /** URL after redirects and normalization; the dedupe identity. */
  normalizedUrl: string;
  urlKey: string;
  fetchedAt: string;
}

/** Save a URL: fetch it safely, extract the article, return a draft ready to persist. */
export async function saveUrl(
  sourceUrl: string,
  options: { fetch?: SafeFetchOptions; extract?: ExtractOptions; now?: () => Date } = {},
): Promise<DocumentDraft> {
  const page = await safeFetchHtml(sourceUrl, options.fetch);
  return buildDraft(sourceUrl, page.finalUrl, page.html, options);
}

/** Save HTML that the client already has (browser extension, email, pasted page) — no network. */
export function saveHtml(
  sourceUrl: string,
  html: string,
  options: { extract?: ExtractOptions; now?: () => Date } = {},
): DocumentDraft {
  return buildDraft(sourceUrl, sourceUrl, html, options);
}

/**
 * `<link rel=canonical>` is page-controlled, so it is only honoured when it points at the same host
 * we actually fetched. Otherwise a hostile page could claim another site's URL and collide with —
 * or masquerade as — that article's dedupe key.
 */
function trustedCanonical(canonical: string | null, finalUrl: string): string | null {
  if (!canonical) return null;
  try {
    return new URL(canonical).host === new URL(finalUrl).host ? canonical : null;
  } catch {
    return null;
  }
}

function buildDraft(
  sourceUrl: string,
  finalUrl: string,
  html: string,
  options: { extract?: ExtractOptions; now?: () => Date },
): DocumentDraft {
  const article = extractArticle(html, finalUrl, options.extract);
  const normalizedUrl = normalizeUrl(trustedCanonical(article.canonicalUrl, finalUrl) ?? finalUrl);
  return {
    ...article,
    sourceUrl,
    normalizedUrl,
    urlKey: urlKey(normalizedUrl),
    fetchedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}
