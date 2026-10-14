import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { canonicalText, createAnchor, extractArticle, offsetsFromRange, rangeFromOffsets, resolveAnchor } from '../src/index.ts';
import { ARTICLE } from './helpers.ts';

const rootOf = (inner: string) => new JSDOM(`<!doctype html><body><div id="r">${inner}</div>`).window.document.getElementById('r')!;

describe('DOM ↔ offsets', () => {
  const root = rootOf('<p>Hello <b>brave</b> new world</p><p>Second paragraph here.</p>');
  const doc = root.ownerDocument;

  it('round-trips a selection that crosses inline elements', () => {
    const b = root.querySelector('b')!;
    const range = doc.createRange();
    range.setStart(root.querySelector('p')!.firstChild!, 3); // "lo "
    range.setEnd(b.firstChild!, 3); //                          "bra"
    const off = offsetsFromRange(root, range)!;
    expect(canonicalText(root).slice(off.start, off.end)).toBe('lo bra');
    expect(rangeFromOffsets(root, off.start, off.end)!.toString()).toBe('lo bra');
  });

  it('round-trips a selection that spans paragraphs, and element-boundary containers', () => {
    const range = doc.createRange();
    range.setStart(root, 0); // element container, not a text node
    range.setEnd(root.lastChild!, 1);
    const off = offsetsFromRange(root, range)!;
    expect(off.start).toBe(0);
    expect(rangeFromOffsets(root, off.start, off.end)!.toString()).toBe(range.toString());
  });

  it('rejects empty, foreign and out-of-bounds input', () => {
    const empty = doc.createRange();
    empty.setStart(root.firstChild!.firstChild!, 2);
    empty.collapse(true);
    expect(offsetsFromRange(root, empty)).toBeNull();
    const outside = doc.createRange();
    outside.selectNodeContents(doc.body);
    expect(offsetsFromRange(rootOf('<p>other</p>'), outside)).toBeNull();
    expect(rangeFromOffsets(root, 0, 99999)).toBeNull();
    expect(rangeFromOffsets(root, 5, 5)).toBeNull();
    expect(rangeFromOffsets(root, -1, 3)).toBeNull();
  });
});

describe('end to end: highlight survives re-extraction of a changed page', () => {
  it('anchors on v1, re-resolves on v2, and paints the same words', () => {
    const v1 = extractArticle(ARTICLE, 'https://example.com/posts/how-readers-work');
    const r1 = rootOf(v1.contentHtml);
    const i = v1.text.indexOf('the reader keeps its place');
    const anchor = createAnchor(v1.text, i, i + 'the reader keeps its place'.length);
    expect(rangeFromOffsets(r1, anchor.start, anchor.end)!.toString()).toBe('the reader keeps its place');

    // The publisher adds an editor's note above the fold; the same article is saved again.
    const v2html = ARTICLE.replace('<h1>How Readers Work</h1>', '<h1>How Readers Work</h1><p>Editor’s note: this post was updated in March with new examples and fixes.</p>');
    const v2 = extractArticle(v2html, 'https://example.com/posts/how-readers-work');
    expect(v2.contentHash).not.toBe(v1.contentHash);

    const match = resolveAnchor(v2.text, anchor)!;
    expect(match.method).toBe('quote');
    expect(match.start).not.toBe(anchor.start);
    expect(rangeFromOffsets(rootOf(v2.contentHtml), match.start, match.end)!.toString()).toBe('the reader keeps its place');
  });
});
