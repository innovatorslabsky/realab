import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnsafeUrlError, saveHtml, saveUrl } from '../src/index.ts';
import { ARTICLE, html, startServer } from './helpers.ts';

describe('saveUrl / saveHtml', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    s = await startServer({
      '/posts/how-readers-work': html(ARTICLE),
      // A hostile page claiming to be somebody else's article.
      '/evil': html(ARTICLE.replace(/href="\/posts[^"]*"/, 'href="https://victim.example/posts/original"')),
    });
  });
  afterAll(() => s.close());
  const now = () => new Date('2026-10-14T00:00:00Z');

  it('produces a persistable draft with a stable identity', async () => {
    const d = await saveUrl(`${s.base}/posts/how-readers-work?utm_source=newsletter#top`, { fetch: s.fetchOptions, now });
    expect(d.title).toMatch(/How Readers Work/);
    expect(d.normalizedUrl).toBe(`${s.base}/posts/how-readers-work`); // tracking stripped, same-host canonical honoured
    expect(d.urlKey).toMatch(/^[0-9a-f]{64}$/);
    expect(d.fetchedAt).toBe('2026-10-14T00:00:00.000Z');
    expect(d.sourceUrl).toContain('utm_source=newsletter');
  });

  it('ignores a cross-host canonical so a page cannot claim another article\'s identity', async () => {
    const d = await saveUrl(`${s.base}/evil`, { fetch: s.fetchOptions });
    expect(d.normalizedUrl).toBe(`${s.base}/evil`);
  });

  it('refuses to fetch private targets by default', async () => {
    await expect(saveUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('saves client-supplied HTML without any network access', () => {
    const d = saveHtml('https://example.com/posts/how-readers-work', ARTICLE, { now });
    expect(d.normalizedUrl).toBe('https://example.com/posts/how-readers-work');
  });
});
