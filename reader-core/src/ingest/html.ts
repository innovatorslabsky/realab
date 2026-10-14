import { JSDOM } from 'jsdom';

/**
 * One shared, script-less document for fragment work. Setting `innerHTML` here never executes script
 * and never loads resources (jsdom has no resource loader configured), so it is safe for untrusted
 * markup, and far cheaper than building a JSDOM per feed item or EPUB chapter.
 */
let shared: Document | undefined;
function doc(): Document {
  return (shared ??= new JSDOM('<!doctype html><body></body>').window.document);
}

/**
 * Text of an HTML fragment — the coordinate space highlights anchor in. It equals `textContent` of
 * a container whose `innerHTML` is this string, which is exactly what a client computes.
 */
export function htmlToText(html: string): string {
  const box = doc().createElement('div');
  box.innerHTML = html;
  return box.textContent ?? '';
}

/** Plain text for short fields (titles); skips the parser when there is nothing to decode. */
export function plainText(s: string): string {
  const t = /[<&]/.test(s) ? htmlToText(s) : s;
  return t.replace(/\s+/g, ' ').trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** http(s) only; relative references resolved against `base`. Anything else (javascript:, data:, file:) → null. */
export function absoluteHttpUrl(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Resolve relative `href`/`src` in a fragment so it still works once it leaves its original page. */
export function absolutizeUrls(html: string, base: string): string {
  const box = doc().createElement('div');
  box.innerHTML = html;
  for (const el of box.querySelectorAll('[href]')) {
    const abs = absoluteHttpUrl(el.getAttribute('href'), base);
    if (abs) el.setAttribute('href', abs);
  }
  for (const el of box.querySelectorAll('[src]')) {
    const abs = absoluteHttpUrl(el.getAttribute('src'), base);
    if (abs) el.setAttribute('src', abs);
  }
  return box.innerHTML;
}

/** Parse a fragment, let `edit` mutate it, and serialize it back. */
export function editFragment(html: string, edit: (root: Element) => void): string {
  const box = doc().createElement('div');
  box.innerHTML = html;
  edit(box);
  return box.innerHTML;
}
