import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../tools/dom-skeleton.browser.js', import.meta.url), 'utf8');

function skeleton(body: string, options?: object): string {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { runScripts: 'outside-only' });
  if (options) (dom.window as unknown as { __domSkeletonOptions: object }).__domSkeletonOptions = options;
  return dom.window.eval(script) as string;
}

const page = `
<div id="root" class="app css-1a2b3c4d">
  <nav role="navigation" aria-label="Main"><a href="/inbox" class="nav-link">Private inbox title</a></nav>
  <main data-view="library">
    <ul class="list">
      <li id="doc-48392011" class="row" data-doc-id="c0ffee00-1111"><h3 class="title">Confidential Article About Cats</h3><span class="meta">3 min</span></li>
      <li id="doc-48392012" class="row" data-doc-id="c0ffee00-2222"><h3 class="title">Another Secret Headline</h3><span class="meta">9 min</span></li>
      <li id="doc-48392013" class="row" data-doc-id="c0ffee00-3333"><h3 class="title">Third Private Thing</h3><span class="meta">1 min</span></li>
    </ul>
    <article contenteditable="true"><p>Body text that must not appear.</p></article>
    <script>var token = "SECRET-TOKEN";</script>
    <svg><path d="M0 0"/></svg>
  </main>
</div>`;

describe('dom-skeleton.browser.js', () => {
  const out = skeleton(page);

  it('prints no page text, attribute values or script bodies', () => {
    for (const leak of ['Confidential', 'Secret', 'Private inbox', 'Body text', 'SECRET-TOKEN', 'c0ffee', '/inbox', 'Main', '48392011']) {
      expect(out, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('keeps the structure: roles, attribute names, classes, ids templated', () => {
    expect(out).toContain('div#root.app.:hash');
    expect(out).toContain('nav[role=navigation aria-label]');
    expect(out).toContain('main[data-view]');
    expect(out).toContain('article[contenteditable]');
    expect(out).toContain('li#:id.row[data-doc-id]');
  });

  it('collapses repeated rows into one line with a count', () => {
    expect(out).toContain('li#:id.row[data-doc-id]  ×3');
    expect(out.match(/li#:id/g)).toHaveLength(1);
  });

  it('does not descend into script/svg and honours the selector option', () => {
    expect(out).toMatch(/\n\s+script "…"\n/);
    expect(out).not.toContain('path');
    expect(skeleton(page, { selector: 'nav' })).toMatch(/^nav\[role=navigation aria-label\]\n\s+a\.nav-link "…"$/);
  });
});
