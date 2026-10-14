import { describe, expect, it } from 'vitest';
import { createAnchor, resolveAnchor, similarity } from '../src/index.ts';

const pick = (text: string, needle: string, nth = 0) => {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = text.indexOf(needle, i + 1);
  return createAnchor(text, i, i + needle.length);
};

const base =
  'Readers need durable highlights. The key idea matters here. ' +
  'Another paragraph follows with unrelated words. The key idea matters here. ' +
  'A closing thought ends the piece. The key idea matters here.';

describe('createAnchor', () => {
  it('captures the quote, its context and offsets', () => {
    const a = createAnchor(base, 8, 28);
    expect(a.exact).toBe(base.slice(8, 28));
    expect(a.prefix).toBe(base.slice(0, 8));
    expect(a.suffix.length).toBe(32);
  });
  it.each([[-1, 5], [5, 5], [9, 3], [0, 99999], [1.5, 4]])('rejects invalid range [%s, %s)', (s, e) => {
    expect(() => createAnchor(base, s, e)).toThrow(RangeError);
  });
});

describe('resolveAnchor', () => {
  it('finds the highlight at its original position', () => {
    const a = pick(base, 'durable highlights');
    expect(resolveAnchor(base, a)).toMatchObject({ method: 'position', score: 1, start: a.start, end: a.end });
  });

  it('follows the text when earlier content shifts the offsets', () => {
    const a = pick(base, 'durable highlights');
    const edited = 'A brand new introduction was added above. ' + base;
    const m = resolveAnchor(edited, a)!;
    expect(m.method).toBe('quote');
    expect(edited.slice(m.start, m.end)).toBe('durable highlights');
  });

  it('picks the right copy of a repeated sentence using surrounding text', () => {
    const second = pick(base, 'The key idea matters here.', 1);
    const edited = 'Prepended sentence to move everything. ' + base;
    const m = resolveAnchor(edited, second)!;
    expect(edited.slice(m.start - 'unrelated words. '.length, m.start)).toBe('unrelated words. ');
    expect(m.score).toBeGreaterThan(0.9);
  });

  it('re-attaches to a lightly edited passage (fuzzy)', () => {
    const a = pick(base, 'Another paragraph follows with unrelated words.');
    const edited = base.replace('follows with unrelated words', 'follows with some unrelated words');
    const m = resolveAnchor(edited, a)!;
    expect(m.method).toBe('fuzzy');
    expect(m.score).toBeGreaterThan(0.8);
    expect(edited.slice(m.start, m.end)).toContain('follows with some unrelated words');
  });

  it('orphans a highlight whose passage is gone instead of guessing', () => {
    const a = pick(base, 'A closing thought ends the piece.');
    expect(resolveAnchor('Entirely different content about something else, with no overlap at all.', a)).toBeNull();
  });

  it('will not pin a short, common quote onto unrelated text', () => {
    const t1 = 'First sentence is about cats and dogs. Then the rain began to fall on the quiet town. Last sentence closes it.';
    const a = pick(t1, 'the');
    expect(resolveAnchor('Completely different words appear here. Unrelated: the cat sat. Nothing similar remains.', a)).toBeNull();
  });

  it('works on non-ASCII text (offsets are UTF-16 code units)', () => {
    const t = 'Công cụ đọc tốt giúp bạn ghi nhớ tiếng Việt lâu hơn 📚 và dễ ôn lại.';
    const a = pick(t, 'tiếng Việt lâu hơn 📚');
    const m = resolveAnchor('Lời mở đầu mới. ' + t, a)!;
    expect(('Lời mở đầu mới. ' + t).slice(m.start, m.end)).toBe('tiếng Việt lâu hơn 📚');
  });
});

describe('similarity', () => {
  it('is 1 for equal strings, 0 against empty, and graded in between', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', '')).toBe(0);
    expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7, 5);
  });
});
