import { createHash } from 'node:crypto';

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src', 'ref_url',
  '_hsenc', '_hsmi', 'mkt_tok', 'yclid', 'twclid', 'si',
]);

/**
 * Canonical form used to dedupe saves: same article reached through a newsletter link, a share link
 * or a campaign link should map to one document. Host is lowercased by `URL`, default ports dropped,
 * fragment and tracking parameters removed, remaining parameters sorted. `www.` is kept on purpose:
 * some sites serve different content on the bare domain.
 */
export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = '';
  const kept = [...url.searchParams.entries()].filter(
    ([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()),
  );
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}

export function urlKey(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}
