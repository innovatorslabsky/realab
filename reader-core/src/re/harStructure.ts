import { Shape } from './shape.ts';

/**
 * Reduce a browser HAR capture to the *structure* of an app's network behaviour: which endpoints exist,
 * how they are called, what their JSON bodies look like. By construction the output contains no
 * header/cookie/token values, no query-string values, no request or response content, and no
 * third-party URLs. See `test/harStructure.test.ts`, which plants secrets and proves they never leak.
 */

interface HarHeader { name: string; value?: string }
interface HarEntry {
  startedDateTime?: string;
  time?: number;
  _resourceType?: string;
  _webSocketMessages?: Array<{ type?: string; data?: string }>;
  request?: { method?: string; url?: string; headers?: HarHeader[]; postData?: { mimeType?: string; text?: string } };
  response?: { status?: number; headers?: HarHeader[]; content?: { mimeType?: string; text?: string; encoding?: string; size?: number } };
}

export interface SummarizeOptions {
  /** Registrable domain treated as "the app", e.g. `readwise.io`. Default: guessed from the first HTML document. */
  firstParty?: string;
  /** Opt in to listing short vocabulary words (e.g. location names). Off by default. */
  collectEnums?: boolean;
  /** Entries beyond this are ignored. */
  maxEntries?: number;
}

export interface EndpointSummary {
  key: string;
  method: string;
  host: string;
  path: string;
  count: number;
  statuses: Record<string, number>;
  queryKeys: Record<string, number>;
  requestHeaderNames: string[];
  responseHeaderNames: string[];
  auth: string[];
  requestMime: string | null;
  responseMime: string | null;
  requestShape: string | null;
  responseShape: string | null;
  graphqlOperations: string[];
  medianMs: number | null;
  streaming: boolean;
}

export interface HarSummary {
  entries: number;
  firstParty: string;
  endpoints: EndpointSummary[];
  assets: { byType: Record<string, number>; scripts: string[]; styles: string[] };
  thirdParty: { requests: number; hosts: number };
  websockets: Array<{ host: string; path: string; sent: string | null; received: string | null }>;
  notes: string[];
}

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const NOISE_HEADERS = new Set(['accept-encoding', 'accept-language', 'connection', 'host', 'content-length', 'date', 'user-agent', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'priority']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/api/doc/8f3…/highlights/42` → `/api/doc/:uuid/highlights/:int`. Slugs and opaque tokens never survive. */
export function templatePath(pathname: string): string {
  const out = pathname.split('/').map((seg) => {
    if (!seg) return seg;
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
    if (UUID.test(s)) return ':uuid';
    if (/^\d+$/.test(s)) return ':int';
    if (/^[0-9a-f]{16,}$/i.test(s)) return ':hex';
    if (/^[A-Za-z0-9_-]{20,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return ':token';
    if (/^[A-Za-z0-9_.-]+$/.test(s) && s.length <= 40 && !/\d{5,}/.test(s)) return s;
    return ':opaque'; // anything slug-like, long or non-ASCII could be content
  });
  return out.join('/') || '/';
}

function templateAssetName(pathname: string): string {
  const name = pathname.split('/').pop() ?? '';
  return name.replace(/[.-][0-9a-f]{6,}(?=[.-]|$)/gi, '.:hash').replace(/\d{6,}/g, ':n');
}

function mimeOf(m: string | undefined): string | null {
  return m ? (m.split(';')[0]!.trim().toLowerCase() || null) : null;
}

function registrable(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function parseJson(text: string | undefined, encoding: string | undefined): unknown {
  if (!text || text.length > 5_000_000) return undefined;
  try {
    return JSON.parse(encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text);
  } catch {
    return undefined;
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]!);
}

interface Acc {
  method: string; host: string; path: string; count: number;
  statuses: Map<number, number>; query: Map<string, number>;
  reqHeaders: Set<string>; resHeaders: Set<string>; auth: Set<string>;
  reqMime: string | null; resMime: string | null;
  reqShape: Shape; resShape: Shape; reqSeen: boolean; resSeen: boolean;
  gql: Set<string>; times: number[]; streaming: boolean;
}

export function summarizeHar(har: unknown, options: SummarizeOptions = {}): HarSummary {
  const entries = ((har as { log?: { entries?: HarEntry[] } })?.log?.entries ?? []).slice(0, options.maxEntries ?? 20_000);
  if (!Array.isArray(entries) || !entries.length) throw new Error('Not a HAR file: log.entries is missing or empty');
  const shapeOpts = { collectEnums: options.collectEnums ?? false };
  const notes: string[] = [];

  const firstDoc = entries.find((e) => mimeOf(e.response?.content?.mimeType) === 'text/html' && e.request?.url);
  const guess = firstDoc ? registrable(new URL(firstDoc.request!.url!).hostname) : '';
  const firstParty = (options.firstParty ?? guess).toLowerCase();
  if (!firstParty) notes.push('Could not determine the first-party domain; pass --first-party.');

  const groups = new Map<string, Acc>();
  const byType = new Map<string, number>();
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const thirdHosts = new Set<string>();
  let thirdRequests = 0;
  const sockets = new Map<string, { host: string; path: string; sent: Shape; recv: Shape; sSeen: boolean; rSeen: boolean }>();

  for (const e of entries) {
    const rawUrl = e.request?.url;
    if (!rawUrl) continue;
    let url: URL;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol === 'data:' || url.protocol === 'blob:') continue;
    const host = url.hostname.toLowerCase();

    if (!firstParty || !(host === firstParty || host.endsWith(`.${firstParty}`))) {
      thirdRequests++;
      thirdHosts.add(host);
      continue;
    }

    const resMime = mimeOf(e.response?.content?.mimeType);
    const type = (e._resourceType ?? '').toLowerCase();
    const path = templatePath(url.pathname);

    if (url.protocol === 'ws:' || url.protocol === 'wss:' || e._webSocketMessages) {
      const k = `${host}${path}`;
      const s = sockets.get(k) ?? { host, path, sent: new Shape(shapeOpts), recv: new Shape(shapeOpts), sSeen: false, rSeen: false };
      for (const m of e._webSocketMessages ?? []) {
        const v = parseJson(m.data, undefined);
        if (v === undefined) continue;
        if (m.type === 'send') { s.sent.add(v); s.sSeen = true; } else { s.recv.add(v); s.rSeen = true; }
      }
      sockets.set(k, s);
      continue;
    }

    const isAsset = ['script', 'stylesheet', 'image', 'font', 'media'].includes(type) ||
      (!!resMime && /^(text\/css|image\/|font\/|application\/(javascript|font)|text\/javascript)/.test(resMime));
    if (isAsset) {
      const label = type || resMime || 'other';
      byType.set(label, (byType.get(label) ?? 0) + 1);
      const name = `${host}/${templateAssetName(url.pathname)}`;
      if (label === 'script' || resMime?.includes('javascript')) scripts.add(name);
      else if (label === 'stylesheet' || resMime === 'text/css') styles.add(name);
      continue;
    }

    const method = (e.request?.method ?? 'GET').toUpperCase();
    const key = `${method} ${host}${path}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        method, host, path, count: 0, statuses: new Map(), query: new Map(), reqHeaders: new Set(), resHeaders: new Set(),
        auth: new Set(), reqMime: null, resMime: null, reqShape: new Shape(shapeOpts), resShape: new Shape(shapeOpts),
        reqSeen: false, resSeen: false, gql: new Set(), times: [], streaming: false,
      };
      groups.set(key, g);
    }
    g.count++;
    const status = e.response?.status ?? 0;
    g.statuses.set(status, (g.statuses.get(status) ?? 0) + 1);
    for (const k of new Set(url.searchParams.keys())) g.query.set(k, (g.query.get(k) ?? 0) + 1);
    if (typeof e.time === 'number' && e.time >= 0) g.times.push(e.time);
    if (resMime === 'text/event-stream') g.streaming = true;

    for (const h of e.request?.headers ?? []) {
      const n = h.name.toLowerCase();
      if (n.startsWith(':')) continue;
      if (n === 'authorization') {
        const scheme = (h.value ?? '').split(/\s+/)[0]!.toLowerCase();
        g.auth.add(['bearer', 'token', 'basic', 'digest'].includes(scheme) ? `Authorization: ${scheme}` : 'Authorization: other');
      } else if (n === 'cookie') g.auth.add('cookie session');
      else if (/csrf|xsrf/.test(n)) g.auth.add(`CSRF header: ${n}`);
      if (!SECRET_HEADERS.has(n) && !NOISE_HEADERS.has(n)) g.reqHeaders.add(n);
    }
    for (const h of e.response?.headers ?? []) {
      const n = h.name.toLowerCase();
      if (!SECRET_HEADERS.has(n) && !NOISE_HEADERS.has(n) && !n.startsWith(':')) g.resHeaders.add(n);
    }

    g.reqMime ??= mimeOf(e.request?.postData?.mimeType);
    g.resMime ??= resMime;
    if (e.request?.postData?.text && (g.reqMime?.includes('json') ?? false)) {
      const body = parseJson(e.request.postData.text, undefined);
      if (body !== undefined) {
        g.reqShape.add(body); g.reqSeen = true;
        const ops = Array.isArray(body) ? body : [body];
        for (const o of ops) {
          const name = (o as { operationName?: unknown } | null)?.operationName;
          if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) g.gql.add(name);
        }
      }
    }
    if (resMime?.includes('json')) {
      const body = parseJson(e.response?.content?.text, e.response?.content?.encoding);
      if (body !== undefined) { g.resShape.add(body); g.resSeen = true; }
    }
  }

  const endpoints: EndpointSummary[] = [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .map(([key, g]) => ({
      key, method: g.method, host: g.host, path: g.path, count: g.count,
      statuses: Object.fromEntries([...g.statuses].sort((a, b) => a[0] - b[0])),
      queryKeys: Object.fromEntries([...g.query].sort((a, b) => b[1] - a[1])),
      requestHeaderNames: [...g.reqHeaders].sort(), responseHeaderNames: [...g.resHeaders].sort(),
      auth: [...g.auth].sort(), requestMime: g.reqMime, responseMime: g.resMime,
      requestShape: g.reqSeen ? g.reqShape.render() : null,
      responseShape: g.resSeen ? g.resShape.render() : null,
      graphqlOperations: [...g.gql].sort(), medianMs: median(g.times), streaming: g.streaming,
    }));

  if (!endpoints.some((e) => e.responseShape)) {
    notes.push('No JSON response bodies were found. Export the HAR with content ("Save all as HAR with content").');
  }
  if (endpoints.some((e) => e.responseShape) === false && endpoints.length > 0) notes.push('Shapes will be empty without response content.');
  notes.push('Values are never recorded. Still skim this report before sharing it.');

  return {
    entries: entries.length,
    firstParty,
    endpoints,
    assets: { byType: Object.fromEntries([...byType].sort()), scripts: [...scripts].sort(), styles: [...styles].sort() },
    thirdParty: { requests: thirdRequests, hosts: thirdHosts.size },
    websockets: [...sockets.values()].map((s) => ({
      host: s.host, path: s.path, sent: s.sSeen ? s.sent.render() : null, received: s.rSeen ? s.recv.render() : null,
    })),
    notes,
  };
}

export function renderMarkdown(s: HarSummary): string {
  const L: string[] = [];
  L.push('# Network structure report', '');
  L.push(`First-party: \`${s.firstParty}\` · entries scanned: ${s.entries} · third-party: ${s.thirdParty.requests} requests to ${s.thirdParty.hosts} hosts (not listed)`, '');
  for (const n of s.notes) L.push(`> ${n}`);
  L.push('', '## Endpoints', '');
  for (const e of s.endpoints) {
    L.push(`### \`${e.method} ${e.host}${e.path}\` ×${e.count}`);
    L.push(`- status: ${Object.entries(e.statuses).map(([k, v]) => `${k}×${v}`).join(', ') || '—'}${e.medianMs !== null ? ` · median ${e.medianMs} ms` : ''}${e.streaming ? ' · **event-stream**' : ''}`);
    if (Object.keys(e.queryKeys).length) L.push(`- query keys: ${Object.entries(e.queryKeys).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    if (e.auth.length) L.push(`- auth: ${e.auth.join('; ')}`);
    if (e.requestHeaderNames.length) L.push(`- request headers: ${e.requestHeaderNames.join(', ')}`);
    if (e.graphqlOperations.length) L.push(`- GraphQL operations: ${e.graphqlOperations.join(', ')}`);
    if (e.requestShape) L.push(`- request body (${e.requestMime}): \`${e.requestShape}\``);
    if (e.responseShape) L.push(`- response body (${e.responseMime}): \`${e.responseShape}\``);
    else if (e.responseMime) L.push(`- response type: ${e.responseMime}`);
    L.push('');
  }
  if (s.websockets.length) {
    L.push('## WebSockets', '');
    for (const w of s.websockets) L.push(`- \`${w.host}${w.path}\` sent: \`${w.sent ?? '—'}\` received: \`${w.received ?? '—'}\``);
    L.push('');
  }
  L.push('## Static assets', '');
  L.push(`- by type: ${Object.entries(s.assets.byType).map(([k, v]) => `${k}×${v}`).join(', ') || '—'}`);
  if (s.assets.scripts.length) L.push('- scripts:', ...s.assets.scripts.map((x) => `  - ${x}`));
  if (s.assets.styles.length) L.push('- styles:', ...s.assets.styles.map((x) => `  - ${x}`));
  return L.join('\n') + '\n';
}
