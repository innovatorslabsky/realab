import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, TooLargeError, UnsafeUrlError, assertSafeUrl, safeFetchHtml } from '../src/index.ts';
import { html, startServer } from './helpers.ts';

describe('assertSafeUrl', () => {
  it.each([
    'file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)', 'not a url',
    'http://user:pw@example.com/', 'http://example.com:22/', 'http://example.com:6379/',
    'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://0x7f.1/', // hex/short form
    'http://017700000001/', // octal form
    'http://[::ffff:127.0.0.1]/', 'http://10.0.0.5:80/',
  ])('refuses %s', (url) => expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError));

  it('accepts ordinary public URLs', () => {
    expect(assertSafeUrl('https://example.com/a?b=1').hostname).toBe('example.com');
    expect(assertSafeUrl('http://example.com/').port).toBe('');
  });
});

describe('safeFetchHtml', () => {
  const big = 'x'.repeat(5000);
  let s: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    s = await startServer({
      '/ok': html('<html><body>hello</body></html>'),
      '/r1': (_q, r) => { r.statusCode = 302; r.setHeader('location', '/ok'); r.end(); },
      '/loop': (_q, r) => { r.statusCode = 302; r.setHeader('location', '/loop'); r.end(); },
      '/to-metadata': (_q, r) => { r.statusCode = 302; r.setHeader('location', 'http://169.254.169.254/latest/meta-data/'); r.end(); },
      '/to-file': (_q, r) => { r.statusCode = 302; r.setHeader('location', 'file:///etc/passwd'); r.end(); },
      '/declared-big': html(big, { 'content-length': String(big.length) }),
      '/chunked-big': (_q, r) => {
        r.setHeader('content-type', 'text/html');
        const t = setInterval(() => r.write(big), 5);
        r.on('close', () => clearInterval(t));
      },
      '/json': (_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{}'); },
      '/latin1': (_q, r) => {
        r.setHeader('content-type', 'text/html; charset=iso-8859-1');
        r.end(Buffer.from('<html><body>caf\xe9</body></html>', 'latin1'));
      },
    });
  });
  afterAll(() => s.close());

  it('fetches and decodes a page, following a vetted redirect', async () => {
    const page = await safeFetchHtml(`${s.base}/r1`, s.fetchOptions);
    expect(page.html).toContain('hello');
    expect(page.finalUrl).toBe(`${s.base}/ok`);
  });

  it('refuses loopback under the default policy (literal IP)', async () => {
    await expect(safeFetchHtml(`${s.base}/ok`, { allowedPorts: [s.port] })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a hostname that resolves to a private address (guard runs inside DNS lookup)', async () => {
    await expect(safeFetchHtml(`http://localhost:${s.port}/ok`, { allowedPorts: [s.port] })).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('re-validates every redirect hop', async () => {
    await expect(safeFetchHtml(`${s.base}/to-metadata`, s.fetchOptions)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetchHtml(`${s.base}/to-file`, s.fetchOptions)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('gives up on redirect loops', async () => {
    await expect(safeFetchHtml(`${s.base}/loop`, { ...s.fetchOptions, maxRedirects: 3 })).rejects.toThrow(/Too many redirects/);
  });

  it('enforces the size cap for declared and undeclared lengths', async () => {
    await expect(safeFetchHtml(`${s.base}/declared-big`, { ...s.fetchOptions, maxBytes: 1000 })).rejects.toBeInstanceOf(TooLargeError);
    await expect(safeFetchHtml(`${s.base}/chunked-big`, { ...s.fetchOptions, maxBytes: 1000 })).rejects.toBeInstanceOf(TooLargeError);
  });

  it('rejects non-HTML and error statuses', async () => {
    await expect(safeFetchHtml(`${s.base}/json`, s.fetchOptions)).rejects.toThrow(/Unsupported content type/);
    await expect(safeFetchHtml(`${s.base}/missing`, s.fetchOptions)).rejects.toBeInstanceOf(FetchError);
  });

  it('honours the declared charset', async () => {
    expect((await safeFetchHtml(`${s.base}/latin1`, s.fetchOptions)).html).toContain('café');
  });
});
