/**
 * Bridge between DOM Ranges (what a user selects, what we paint) and the flat text coordinates that
 * anchors use. Works with any DOM — the browser's, or jsdom on the server — because it relies only on
 * Range and TreeWalker. The coordinate space is `root.textContent`: every Text node, in document
 * order, concatenated. Server and client must call these on the *same sanitized HTML*.
 */

const SHOW_TEXT = 0x4;

function documentOf(root: Node): Document {
  return (root.nodeType === 9 ? (root as Document) : root.ownerDocument) as Document;
}

export function canonicalText(root: Node): string {
  return root.textContent ?? '';
}

/** Selection → offsets. Returns null for empty selections or ranges outside `root`. */
export function offsetsFromRange(root: Node, range: Range): { start: number; end: number } | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const pre = documentOf(root).createRange();
  pre.setStart(root, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const length = range.toString().length;
  return length > 0 ? { start, end: start + length } : null;
}

/** Offsets → Range, ready for `Highlight` painting or `surroundContents`. Null if out of bounds. */
export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  if (!(start >= 0) || !(end > start)) return null;
  const doc = documentOf(root);
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!startNode && start < pos + len) {
      startNode = n;
      startOffset = start - pos;
    }
    if (startNode && end <= pos + len) {
      const range = doc.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(n, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}
