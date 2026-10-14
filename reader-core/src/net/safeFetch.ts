import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { publicAddressesOnly } from './ipGuard.ts';

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}
export class FetchError extends Error {
  override name = 'FetchError';
}
export class TooLargeError extends FetchError {
  override name = 'TooLargeError';
}

export interface SafeFetchOptions {
  /** Hard cap on the response body. Default 5 MiB. */
  maxBytes?: number;
  /** Total time budget per request, redirects included. Default 15 s. */
  timeoutMs?: number;
  /** Redirect hops followed, each re-validated. Default 5. */
  maxRedirects?: number;
  /** Ports we may connect to. Default 80 and 443. */
  allowedPorts?: readonly number[];
  /** Decides whether a *resolved* IP may be connected to. Default: public addresses only. */
  isAddressAllowed?: (address: string) => boolean;
  userAgent?: string;
}

export interface FetchedPage {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

class BlockedAddress extends Error {
  override name = 'BlockedAddress';
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** Parse and vet a URL before any socket is opened. IP literals skip DNS, so they are checked here. */
export function assertSafeUrl(
  raw: string,
  opts: Pick<SafeFetchOptions, 'allowedPorts' | 'isAddressAllowed'> = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs with embedded credentials are refused');
  }
  const ports = opts.allowedPorts ?? [80, 443];
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ports.includes(port)) throw new UnsafeUrlError(`Port ${port} is not allowed`);

  const allowed = opts.isAddressAllowed ?? publicAddressesOnly;
  const host = stripBrackets(url.hostname);
  if (isIP(host) !== 0 && !allowed(host)) {
    throw new UnsafeUrlError(`Address ${host} is not allowed`);
  }
  return url;
}

/**
 * The address check that matters. It runs inside the socket's own DNS lookup, so the IP that is
 * validated is the IP that is connected to — a hostname that re-resolves to a private address
 * between "check" and "connect" (DNS rebinding) cannot slip through.
 */
function guardedLookup(isAllowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = addresses as LookupAddress[];
      const bad = list.find((a) => !isAllowed(a.address));
      if (bad || list.length === 0) {
        return callback(new BlockedAddress(`${hostname} resolves to a blocked address`) as NodeJS.ErrnoException, '', 4);
      }
      if (options.all) {
        // Overload for `all: true` returns an array.
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      }
      const first = list[0]!;
      callback(null, first.address, first.family);
    });
  };
}

function rootCause(err: unknown): unknown {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error && cur.cause; i++) cur = cur.cause;
  return cur;
}

function pickCharset(contentType: string, head: Uint8Array): string {
  const header = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (header) return header;
  const sniff = new TextDecoder('latin1').decode(head.subarray(0, 2048));
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1] ?? 'utf-8';
}

function decode(bytes: Uint8Array, contentType: string): string {
  const label = pickCharset(contentType, bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Fetch an HTML page on behalf of a user without letting the user aim our server at its own network.
 * Every redirect hop is re-validated, the body is size-capped while streaming, and no cookies or
 * ambient credentials are sent.
 */
export async function safeFetchHtml(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 5;
  const isAllowed = options.isAddressAllowed ?? publicAddressesOnly;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const agent = new Agent({ connect: { lookup: guardedLookup(isAllowed) } });

  try {
    let url = assertSafeUrl(rawUrl, options);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await undiciFetch(url, {
          dispatcher: agent,
          redirect: 'manual',
          signal,
          headers: {
            'user-agent': options.userAgent ?? 'reader-core/0.1 (+article-fetcher)',
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          },
        });
      } catch (err) {
        const cause = rootCause(err);
        if (cause instanceof BlockedAddress) throw new UnsafeUrlError(cause.message);
        throw new FetchError(`Request failed: ${(cause as Error)?.message ?? String(cause)}`);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= maxRedirects) throw new FetchError('Too many redirects');
        url = assertSafeUrl(new URL(res.headers.get('location')!, url).toString(), options);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw new FetchError(`Unexpected status ${res.status}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!HTML_TYPES.some((t) => contentType.toLowerCase().startsWith(t))) {
        await res.body?.cancel().catch(() => undefined);
        throw new FetchError(`Not an HTML page (content-type: ${contentType || 'missing'})`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new TooLargeError(`Response exceeds ${maxBytes} bytes`);
      }
      const bytes = await readCapped(res.body as ReadableStream<Uint8Array> | null, maxBytes);
      return { finalUrl: url.toString(), status: res.status, contentType, html: decode(bytes, contentType) };
    }
  } finally {
    await agent.close().catch(() => undefined);
  }
}
