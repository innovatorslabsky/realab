/**
 * Durable highlight anchors, modelled on the W3C Web Annotation selectors (TextQuoteSelector +
 * TextPositionSelector). A highlight is stored as *what was selected plus the text around it*, with
 * the numeric offsets kept only as a fast path and tie-breaker. Offsets alone break the moment the
 * article is re-extracted or edited; the quote survives.
 *
 * All offsets are UTF-16 code-unit indexes into `text` (the sanitized article's `textContent`).
 */

export interface TextAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export type AnchorMethod = 'position' | 'quote' | 'fuzzy';

export interface AnchorMatch {
  start: number;
  end: number;
  method: AnchorMethod;
  /** 1 = identical context / text; lower = weaker evidence. */
  score: number;
}

export interface ResolveOptions {
  /** Minimum similarity for the fuzzy fallback. Default 0.8. */
  minSimilarity?: number;
}

const CONTEXT_LENGTH = 32;
const MAX_OCCURRENCES = 1000;
const MAX_FUZZY_LENGTH = 2000;
const SHORT_QUOTE = 24;

export function createAnchor(text: string, start: number, end: number, contextLength = CONTEXT_LENGTH): TextAnchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) {
    throw new RangeError(`Invalid selection [${start}, ${end}) for text of length ${text.length}`);
  }
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - contextLength), start),
    suffix: text.slice(end, end + contextLength),
    start,
    end,
  };
}

function occurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = text.indexOf(needle); i !== -1 && out.length < MAX_OCCURRENCES; i = text.indexOf(needle, i + 1)) {
    out.push(i);
  }
  return out;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** How well the text around [start, end) agrees with the stored prefix/suffix, 0..1. */
function contextScore(text: string, anchor: TextAnchor, start: number, end: number): number {
  const before = text.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = text.slice(end, end + anchor.suffix.length);
  // An empty stored context means the selection touched a document edge; if it still does, that
  // agrees perfectly, otherwise we simply have no evidence either way.
  const pre = anchor.prefix ? commonSuffixLength(before, anchor.prefix) / anchor.prefix.length : start === 0 ? 1 : 0.5;
  const suf = anchor.suffix ? commonPrefixLength(after, anchor.suffix) / anchor.suffix.length : end === text.length ? 1 : 0.5;
  return (pre + suf) / 2;
}

/** Edit-distance similarity in 0..1 (two-row Levenshtein). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function fuzzyMatch(text: string, anchor: TextAnchor, minSimilarity: number): AnchorMatch | null {
  const len = anchor.exact.length;
  if (len > MAX_FUZZY_LENGTH) return null;
  // Candidate starts come from the stored prefix, candidate ends from the stored suffix.
  const starts = anchor.prefix.length >= 8 ? occurrences(text, anchor.prefix).map((i) => i + anchor.prefix.length) : [];
  const ends = anchor.suffix.length >= 8 ? occurrences(text, anchor.suffix) : [];

  const pairs: Array<[number, number]> = [];
  for (const s of starts) {
    const near = ends.filter((e) => e - s >= len * 0.5 && e - s <= len * 1.5);
    if (near.length) for (const e of near) pairs.push([s, e]);
    else pairs.push([s, Math.min(text.length, s + len)]);
  }
  if (!starts.length) for (const e of ends) pairs.push([Math.max(0, e - len), e]);

  let best: AnchorMatch | null = null;
  for (const [s, e] of pairs) {
    if (e <= s) continue;
    const score = similarity(text.slice(s, e), anchor.exact);
    if (score >= minSimilarity && (!best || score > best.score)) best = { start: s, end: e, method: 'fuzzy', score };
  }
  return best;
}

/**
 * Find where a stored highlight now lives in `text`.
 *   1. exact quote (several copies → the one whose surrounding text agrees best; ties go to the
 *      one nearest the old offsets). If it sits at the old offsets, `method` is 'position'.
 *   2. fuzzy: the passage was lightly edited; locate it between the stored prefix and suffix.
 *   3. null: orphaned. Keep the highlight and show it as "could not be placed" rather than deleting it.
 */
export function resolveAnchor(text: string, anchor: TextAnchor, options: ResolveOptions = {}): AnchorMatch | null {
  const found = occurrences(text, anchor.exact);
  if (found.length) {
    let best: AnchorMatch | null = null;
    let bestRank = -1;
    for (const start of found) {
      const end = start + anchor.exact.length;
      const score = contextScore(text, anchor, start, end);
      const proximity = 1 - Math.min(1, Math.abs(start - anchor.start) / Math.max(text.length, 1));
      const rank = score + proximity * 0.01;
      if (rank > bestRank) {
        bestRank = rank;
        best = { start, end, method: start === anchor.start ? 'position' : 'quote', score };
      }
    }
    // A short quote ("the", "it works") occurs everywhere; without supporting context it is a guess.
    if (best && (best.method === 'position' || anchor.exact.length >= SHORT_QUOTE || best.score >= 0.25)) return best;
  }
  return fuzzyMatch(text, anchor, options.minSimilarity ?? 0.8);
}
