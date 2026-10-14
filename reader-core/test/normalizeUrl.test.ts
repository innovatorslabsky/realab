import { describe, expect, it } from 'vitest';
import { normalizeUrl, urlKey } from '../src/index.ts';

describe('normalizeUrl', () => {
  it('collapses tracking noise so one article has one identity', () => {
    const a = normalizeUrl('https://Example.com/post/?utm_source=nl&utm_medium=email&id=7&fbclid=abc#section');
    const b = normalizeUrl('https://example.com/post?id=7');
    expect(a).toBe(b);
    expect(urlKey(a)).toBe(urlKey(b));
  });
  it('sorts parameters and drops default ports', () => {
    expect(normalizeUrl('https://example.com:443/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2');
  });
  it('keeps meaningful parameters, www and paths distinct', () => {
    expect(normalizeUrl('https://example.com/a?page=2')).not.toBe(normalizeUrl('https://example.com/a?page=3'));
    expect(normalizeUrl('https://www.example.com/a')).not.toBe(normalizeUrl('https://example.com/a'));
  });
  it('rejects garbage', () => expect(() => normalizeUrl('nope')).toThrow());
});
