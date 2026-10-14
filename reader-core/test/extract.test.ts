import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { NotReadableError, countWords, extractArticle, readingMinutes } from '../src/index.ts';
import { ARTICLE } from './helpers.ts';

const URL_ = 'https://example.com/posts/how-readers-work';

describe('extractArticle', () => {
  const a = extractArticle(ARTICLE, URL_);

  it('pulls the article and its metadata, not the page chrome', () => {
    expect(a.title).toMatch(/How Readers Work/);
    expect(a.byline).toMatch(/Ada Lovelace/);
    expect(a.siteName).toBe('Example Blog');
    expect(a.lang).toBe('en');
    expect(a.publishedTime).toBe('2026-03-01T10:00:00Z');
    expect(a.imageUrl).toBe('https://example.com/img/cover.png');
    expect(a.text).toContain('The quick brown fox');
    expect(a.text).not.toContain('Copyright');
    expect(a.wordCount).toBeGreaterThan(50);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('removes everything that can execute, submit or leak', () => {
    expect(a.contentHtml).not.toMatch(/<script|<form|<input|<button|onerror|javascript:|srcset/i);
    const doc = new JSDOM(a.contentHtml).window.document;
    expect(doc.querySelectorAll('[onerror],[onclick]').length).toBe(0);
    for (const link of doc.querySelectorAll('a[href]')) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
      expect(link.getAttribute('target')).toBe('_blank');
    }
    for (const img of doc.querySelectorAll('img')) expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('resolves relative links and images against the page URL', () => {
    const doc = new JSDOM(a.contentHtml).window.document;
    expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://example.com/img/diagram.png');
    expect(doc.querySelector('a[href*="more"]')?.getAttribute('href')).toBe('https://example.com/more');
  });

  it('is deterministic — the same page yields the same hash (anchors depend on this)', () => {
    expect(extractArticle(ARTICLE, URL_).contentHash).toBe(a.contentHash);
  });

  it('refuses pages that are not articles', () => {
    expect(() => extractArticle('<html><body><p>Too short.</p></body></html>', URL_)).toThrow(NotReadableError);
    expect(() => extractArticle('<html><body></body></html>', URL_)).toThrow(NotReadableError);
  });
});

describe('reading time', () => {
  it('counts Latin words and CJK characters separately', () => {
    expect(countWords('Hello, world — it’s fine.')).toEqual({ words: 4, cjkChars: 0 });
    expect(countWords('これは日本語の文章です').cjkChars).toBeGreaterThan(5);
  });
  it('never reports less than one minute', () => expect(readingMinutes('short')).toBe(1));
  it('scales with length', () => expect(readingMinutes('word '.repeat(2300))).toBe(10));
});
