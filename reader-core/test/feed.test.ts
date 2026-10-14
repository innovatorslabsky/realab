import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FeedParseError, discoverFeeds, feedItemKey, fetchFeed, parseFeed, subscribeToUrl, FetchError } from '../src/index.ts';
import { html, startServer } from './helpers.ts';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>Example &amp; Blog</title><link>https://blog.example.test/</link><description>Notes on reading</description><language>en</language>
  <item>
    <title>First &lt;em&gt;post&lt;/em&gt;</title><link>/posts/first</link><guid isPermaLink="false">post-1</guid>
    <pubDate>Tue, 03 Mar 2026 10:00:00 GMT</pubDate><dc:creator>Ada Lovelace</dc:creator>
    <description><![CDATA[<p>Teaser <a href="/posts/first">more</a></p>]]></description>
    <content:encoded><![CDATA[<p>Full body with <img src="/i/a.png" onerror="alert(1)"> and <script>alert(2)</script><a href="javascript:alert(3)">x</a></p>]]></content:encoded>
    <enclosure url="https://cdn.example.test/ep1.mp3" type="audio/mpeg" length="12345"/>
    <category>reading</category><category>tools</category>
  </item>
  <item><title>Second</title><guid isPermaLink="true">https://blog.example.test/posts/second</guid><pubDate>not a date</pubDate></item>
  <item><title>Dup</title><guid>post-1</guid><link>https://blog.example.test/dup</link></item>
  <item><description>No title, no id, no link</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="vi">
  <title>Nhật ký đọc</title><subtitle>Ghi chú</subtitle>
  <link rel="self" href="https://atom.example.test/feed.xml"/><link rel="alternate" type="text/html" href="https://atom.example.test/"/>
  <author><name>Feed Author</name></author>
  <entry>
    <id>tag:atom.example.test,2026:1</id><title type="html">Tiêu đề &amp;amp; thử</title>
    <link rel="alternate" href="/bai-1"/><link rel="enclosure" href="/f.pdf" type="application/pdf" length="99"/>
    <published>2026-03-04T08:00:00+07:00</published><updated>2026-03-05T08:00:00Z</updated>
    <summary type="text">Tóm tắt &lt;b&gt;thuần&lt;/b&gt; văn bản</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Nội dung <b>đầy đủ</b></p></div></content>
    <category term="sách"/>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.test/"><title>RDF Feed</title><link>https://rdf.example.test/</link><description>d</description></channel>
  <item rdf:about="https://rdf.example.test/a"><title>Item A</title><link>https://rdf.example.test/a</link><dc:date>2026-01-02T03:04:05Z</dc:date><dc:creator>Zed</dc:creator></item>
</rdf:RDF>`;

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1', title: 'JSON Feed', home_page_url: 'https://json.example.test/', feed_url: 'https://json.example.test/feed.json',
  items: [
    { id: 42, url: '/p/42', title: 'Numeric id', content_html: '<p>hi <script>x</script></p>', date_published: '2026-02-01T00:00:00Z', authors: [{ name: 'Jo' }], tags: ['a'], attachments: [{ url: '/a.mp3', mime_type: 'audio/mpeg', size_in_bytes: 7 }] },
    { id: 'text-only', content_text: 'Just <text>' },
  ],
});

describe('parseFeed — RSS 2.0', () => {
  const f = parseFeed(RSS, 'https://blog.example.test/feed.xml');
  it('reads channel metadata and decodes entities in titles', () => {
    expect(f).toMatchObject({ format: 'rss', title: 'Example & Blog', siteUrl: 'https://blog.example.test/', language: 'en', description: 'Notes on reading' });
  });
  it('reads items, resolving relative links and dates', () => {
    const a = f.items[0]!;
    expect(a).toMatchObject({ guid: 'post-1', url: 'https://blog.example.test/posts/first', title: 'First post', author: 'Ada Lovelace', publishedAt: '2026-03-03T10:00:00.000Z', categories: ['reading', 'tools'] });
    expect(a.enclosures).toEqual([{ url: 'https://cdn.example.test/ep1.mp3', type: 'audio/mpeg', length: 12345 }]);
    expect(a.summaryHtml).toContain('href="https://blog.example.test/posts/first"');
  });
  it('sanitizes item HTML', () => {
    const body = f.items[0]!.contentHtml!;
    expect(body).not.toMatch(/<script|onerror|javascript:/i);
    expect(body).toContain('src="https://blog.example.test/i/a.png"');
  });
  it('uses a permalink guid as the url, tolerates bad dates, dedupes by guid, drops items with no identity', () => {
    expect(f.items.map((i) => i.guid)).toEqual(['post-1', 'https://blog.example.test/posts/second']);
    expect(f.items[1]).toMatchObject({ url: 'https://blog.example.test/posts/second', publishedAt: null });
  });
});

describe('parseFeed — Atom, RDF, JSON Feed', () => {
  it('Atom: text constructs, xhtml content, relative links, feed-level author and self link', () => {
    const f = parseFeed(ATOM, 'https://atom.example.test/feed.xml');
    expect(f).toMatchObject({ format: 'atom', title: 'Nhật ký đọc', siteUrl: 'https://atom.example.test/', feedUrl: 'https://atom.example.test/feed.xml', language: 'vi' });
    const e = f.items[0]!;
    expect(e).toMatchObject({ guid: 'tag:atom.example.test,2026:1', title: 'Tiêu đề & thử', url: 'https://atom.example.test/bai-1', author: 'Feed Author', publishedAt: '2026-03-04T01:00:00.000Z', categories: ['sách'] });
    expect(e.contentHtml).toContain('<b>đầy đủ</b>');
    expect(e.summaryHtml).toBe('<p>Tóm tắt &lt;b&gt;thuần&lt;/b&gt; văn bản</p>'); // type=text is escaped, never interpreted as markup
    expect(e.enclosures[0]).toEqual({ url: 'https://atom.example.test/f.pdf', type: 'application/pdf', length: 99 });
  });
  it('RDF / RSS 1.0', () => {
    const f = parseFeed(RDF, 'https://rdf.example.test/rss');
    expect(f.format).toBe('rdf');
    expect(f.items[0]).toMatchObject({ guid: 'https://rdf.example.test/a', title: 'Item A', author: 'Zed', publishedAt: '2026-01-02T03:04:05.000Z' });
  });
  it('JSON Feed: numeric ids, content_text escaped, attachments', () => {
    const f = parseFeed(JSONFEED, 'https://json.example.test/feed.json');
    expect(f).toMatchObject({ format: 'jsonfeed', feedUrl: 'https://json.example.test/feed.json' });
    expect(f.items[0]).toMatchObject({ guid: '42', url: 'https://json.example.test/p/42', author: 'Jo', categories: ['a'] });
    expect(f.items[0]!.contentHtml).toBe('<p>hi </p>');
    expect(f.items[0]!.enclosures[0]).toEqual({ url: 'https://json.example.test/a.mp3', type: 'audio/mpeg', length: 7 });
    expect(f.items[1]!.summaryHtml).toBe('<p>Just &lt;text&gt;</p>');
  });
});

describe('parseFeed — hostile and broken input', () => {
  const billionLaughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><rss version="2.0"><channel><title>&lol2;</title></channel></rss>`;
  const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel><title>&x;</title></channel></rss>`;
  it.each([['entity bomb', billionLaughs], ['external entity (XXE)', xxe]])('rejects %s', (_n, doc) => {
    expect(() => parseFeed(doc, 'https://x.example.test/f')).toThrow(/entity/i);
  });
  it.each([['', /Empty/], ['<html><body>hi</body></html>', /Unrecognized|well-formed/], ['<rss><channel>', /well-formed/], ['{"nope":1}', /JSON Feed/], ['{bad json', /JSON/]])('rejects %j', (doc, re) => {
    expect(() => parseFeed(doc, 'https://x.example.test/f')).toThrow(re);
  });
  it('tolerates a BOM and stray control characters', () => {
    const f = parseFeed('﻿' + RSS.replace('<title>Second</title>', '<title>Sec\u0001ond</title>'), 'https://blog.example.test/feed.xml');
    expect(f.items[1]!.title).toBe('Second');
  });
  it('honours maxItems', () => expect(parseFeed(RSS, 'https://blog.example.test/f', { maxItems: 1 }).items).toHaveLength(1));
  it('never emits non-http(s) item URLs', () => {
    const f = parseFeed(RSS.replace('/posts/first', 'javascript:alert(1)'), 'https://blog.example.test/f');
    expect(f.items[0]!.url).toBeNull();
  });
});

describe('identity and discovery', () => {
  it('feedItemKey is stable per feed+guid and ignores tracking noise in the feed URL', () => {
    expect(feedItemKey('https://a.test/feed?utm_source=x', 'g1')).toBe(feedItemKey('https://a.test/feed', 'g1'));
    expect(feedItemKey('https://a.test/feed', 'g1')).not.toBe(feedItemKey('https://a.test/feed', 'g2'));
    expect(feedItemKey('https://a.test/feed', 'g1')).not.toBe(feedItemKey('https://b.test/feed', 'g1'));
  });
  it('discoverFeeds finds advertised feeds only, as absolute http(s) URLs', () => {
    const page = `<html><head>
      <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://x.test/atom">
      <link rel="alternate" type="application/feed+json" href="/feed.json">
      <link rel="alternate" type="text/html" href="/fr">
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`;
    expect(discoverFeeds(page, 'https://x.test/blog/').map((d) => d.url)).toEqual(['https://x.test/feed.xml', 'https://x.test/atom', 'https://x.test/feed.json']);
  });
});

describe('fetchFeed / subscribeToUrl', () => {
  let s: Awaited<ReturnType<typeof startServer>>;
  let hits = { rss: 0, notModified: 0 };
  beforeAll(async () => {
    s = await startServer({
      '/feed.xml': (req, res) => {
        hits.rss++;
        if (req.headers['if-none-match'] === '"v1"') { hits.notModified++; res.statusCode = 304; res.end(); return; }
        res.setHeader('content-type', 'application/rss+xml'); res.setHeader('etag', '"v1"'); res.setHeader('last-modified', 'Tue, 03 Mar 2026 10:00:00 GMT');
        res.end(RSS);
      },
      '/mislabelled': (_q, res) => { res.setHeader('content-type', 'text/plain'); res.end(RSS); },
      '/site': html(`<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>hi</body></html>`),
      '/nofeed': html('<html><body>nothing here</body></html>'),
      '/image': (_q, res) => { res.setHeader('content-type', 'image/png'); res.end('x'); },
    });
  });
  afterAll(() => s.close());

  it('fetches, parses and returns validators; a repeat poll gets 304 and does no parsing', async () => {
    const first = await fetchFeed(`${s.base}/feed.xml`, { fetch: s.fetchOptions });
    expect(first.feed?.items).toHaveLength(2);
    expect(first).toMatchObject({ notModified: false, etag: '"v1"', lastModified: 'Tue, 03 Mar 2026 10:00:00 GMT' });
    const second = await fetchFeed(`${s.base}/feed.xml`, { fetch: s.fetchOptions, etag: first.etag, lastModified: first.lastModified });
    expect(second).toMatchObject({ notModified: true, feed: null, etag: '"v1"' });
    expect(hits.notModified).toBe(1);
  });
  it('accepts feeds served with a wrong content type, since the parser is the validator', async () => {
    expect((await fetchFeed(`${s.base}/mislabelled`, { fetch: s.fetchOptions })).feed?.format).toBe('rss');
  });
  it('subscribeToUrl follows a site page to its advertised feed', async () => {
    const r = await subscribeToUrl(`${s.base}/site`, { fetch: s.fetchOptions });
    expect(r.feed?.title).toBe('Example & Blog');
  });
  it('fails clearly when there is no feed or the type is unsupported', async () => {
    await expect(subscribeToUrl(`${s.base}/nofeed`, { fetch: s.fetchOptions })).rejects.toBeInstanceOf(FeedParseError);
    await expect(fetchFeed(`${s.base}/image`, { fetch: s.fetchOptions })).rejects.toBeInstanceOf(FetchError);
  });
  it('is subject to the same SSRF policy as everything else', async () => {
    await expect(fetchFeed('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/not allowed/);
  });
});
