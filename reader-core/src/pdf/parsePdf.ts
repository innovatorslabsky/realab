import { createHash } from 'node:crypto';
import { readingMinutes, totalWords } from '../ingest/extract.ts';

export class PdfError extends Error {
  override name = 'PdfError';
}
/** The PDF needs a password. We never try to guess or bypass one. */
export class PdfEncryptedError extends PdfError {
  override name = 'PdfEncryptedError';
}

export interface PdfLimits {
  /** Upload size. Default 50 MiB. */
  maxBytes: number;
  /** Pages read; further pages are skipped and `truncated` is set. Default 1500. */
  maxPages: number;
  /** Wall-clock budget for the whole parse. Default 60 s. */
  timeoutMs: number;
  /** Characters kept per page. Default 200 000. */
  maxCharsPerPage: number;
}

export interface PdfParseOptions extends Partial<PdfLimits> {
  signal?: AbortSignal;
}

export interface PdfPage {
  index: number;
  /** PDF user-space size in points. */
  width: number;
  height: number;
  /**
   * The coordinate space highlights anchor in: every text item's `str` on the page, concatenated with
   * nothing added. A client that renders pdf.js's text layer must build the same string from the text
   * spans (their `textContent`, in order). Not yet verified against a real browser text layer.
   */
  anchorText: string;
  /** Reflowed text for reading, search and AI: lines joined into paragraphs, hyphenation repaired. Not an anchor space. */
  text: string;
  wordCount: number;
  contentHash: string;
}

export interface PdfTocEntry {
  title: string;
  depth: number;
  pageIndex: number | null;
}

export interface PdfDraft {
  format: 'pdf';
  title: string;
  author: string | null;
  createdAt: string | null;
  pageCount: number;
  pagesParsed: number;
  truncated: boolean;
  pages: PdfPage[];
  toc: PdfTocEntry[];
  /** Almost no text was found: probably scanned images. The caller decides whether to OCR. */
  needsOcr: boolean;
  wordCount: number;
  readingMinutes: number;
  contentHash: string;
}

const DEFAULTS: PdfLimits = { maxBytes: 50 * 1024 * 1024, maxPages: 1500, timeoutMs: 60_000, maxCharsPerPage: 200_000 };

export interface TextItemLike {
  str: string;
  transform: number[];
  height: number;
  hasEOL: boolean;
}

const isTextItem = (x: unknown): x is TextItemLike => !!x && typeof (x as TextItemLike).str === 'string' && Array.isArray((x as TextItemLike).transform);

export function pageAnchorText(items: readonly TextItemLike[]): string {
  let out = '';
  for (const i of items) out += i.str;
  return out;
}

interface PdfLine {
  y: number;
  h: number;
  text: string;
}

/** Group positioned items into visual lines (baseline changes start a new line), whitespace-normalized. */
export function pageLines(items: readonly TextItemLike[]): PdfLine[] {
  const lines: PdfLine[] = [];
  let cur: PdfLine | null = null;
  let prevEol = false;
  for (const it of items) {
    const y = it.transform[5] ?? 0;
    const h = it.height || Math.abs(it.transform[3] ?? 0) || 10;
    if (!cur || prevEol || Math.abs(y - cur.y) > 0.5 * Math.max(h, cur.h)) {
      cur = { y, h, text: '' };
      lines.push(cur);
    }
    cur.text += it.str;
    cur.h = Math.max(cur.h, h);
    prevEol = it.hasEOL;
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
}

/**
 * Rebuild readable text from positioned items. A vertical gap well beyond normal leading starts a new
 * paragraph; a word split by a trailing hyphen is re-joined when the next line continues in lower case.
 * Reading order is the PDF's own content order — multi-column pages whose stream interleaves columns
 * will interleave here too.
 */
export function pageReadableText(items: readonly TextItemLike[]): string {
  const lines = pageLines(items);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prev = lines[i - 1];
    if (!prev) {
      out = line.text;
      continue;
    }
    const gap = prev.y - line.y;
    if (gap > 1.8 * Math.max(prev.h, line.h)) out += `\n\n${line.text}`;
    else if (/[\p{L}]-$/u.test(out) && /^\p{Ll}/u.test(line.text)) out = out.slice(0, -1) + line.text;
    else out += ` ${line.text}`;
  }
  return out;
}

export function parsePdfDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz]|[+-]\d{2}'?\d{2}'?)?/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz = 'Z'] = m;
  const zone = tz.toUpperCase() === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.replace(/\D/g, '').slice(2, 4) || '00'}`;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/* Minimal views of pdf.js that we use, so types stay local and the import stays lazy. */
interface PdfOutlineNode { title?: string; dest?: unknown; items?: PdfOutlineNode[] }
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }>;
  getMetadata(): Promise<{ info?: Record<string, unknown>; metadata?: { get(k: string): unknown } | null }>;
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}
interface PdfTask { promise: Promise<PdfDoc>; destroy(): Promise<void> }

export async function parsePdf(data: Uint8Array, options: PdfParseOptions = {}): Promise<PdfDraft> {
  const L = { ...DEFAULTS, ...options };
  if (data.byteLength > L.maxBytes) throw new PdfError(`PDF exceeds ${L.maxBytes} bytes`);
  const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new PdfError('Not a PDF file');

  const signals = [AbortSignal.timeout(L.timeoutMs), ...(options.signal ? [options.signal] : [])];
  const signal = AbortSignal.any(signals);

  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as { getDocument(o: Record<string, unknown>): PdfTask };
  // `slice` because pdf.js transfers (detaches) the buffer it is given.
  const task = pdfjs.getDocument({
    data: data.slice(),
    isEvalSupported: false, // no code generation from untrusted font programs
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    enableXfa: false,
    verbosity: 0,
  });
  const onAbort = (): void => void task.destroy().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    let doc: PdfDoc;
    try {
      doc = await task.promise;
    } catch (err) {
      if (signal.aborted) throw new PdfError('PDF parsing timed out or was cancelled');
      const name = (err as { name?: string })?.name;
      if (name === 'PasswordException') throw new PdfEncryptedError('This PDF is password-protected');
      throw new PdfError(name === 'InvalidPDFException' ? 'Not a valid PDF file' : 'The PDF could not be read');
    }

    const pagesToRead = Math.min(doc.numPages, L.maxPages);
    const pages: PdfPage[] = [];
    let firstLine: string | null = null;
    try {
      for (let n = 1; n <= pagesToRead; n++) {
        if (signal.aborted) throw new PdfError('PDF parsing timed out or was cancelled');
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const items = (await page.getTextContent()).items.filter(isTextItem);
        page.cleanup();
        firstLine ??= pageLines(items)[0]?.text ?? null;
        const anchorText = pageAnchorText(items).slice(0, L.maxCharsPerPage);
        const text = pageReadableText(items).slice(0, L.maxCharsPerPage);
        pages.push({ index: n - 1, width: vp.width, height: vp.height, anchorText, text, wordCount: totalWords(text), contentHash: createHash('sha256').update(anchorText).digest('hex') });
      }
    } catch (err) {
      if (err instanceof PdfError) throw err;
      if (signal.aborted) throw new PdfError('PDF parsing timed out or was cancelled');
      throw new PdfError('The PDF could not be read');
    }

    const meta = await doc.getMetadata().catch(() => ({ info: undefined, metadata: null }));
    const info = (meta.info ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const title = str(info.Title) ?? str(meta.metadata?.get('dc:title')) ?? (firstLine ? firstLine.slice(0, 120) : null) ?? 'Untitled';

    const toc = await readOutline(doc, L.maxPages).catch(() => []);
    const allText = pages.map((p) => p.text).join('\n\n');
    const chars = pages.reduce((n, p) => n + p.anchorText.trim().length, 0);

    return {
      format: 'pdf',
      title,
      author: str(info.Author),
      createdAt: parsePdfDate(info.CreationDate),
      pageCount: doc.numPages,
      pagesParsed: pages.length,
      truncated: doc.numPages > pages.length,
      pages,
      toc,
      needsOcr: pages.length > 0 && chars / pages.length < 10,
      wordCount: pages.reduce((n, p) => n + p.wordCount, 0),
      readingMinutes: readingMinutes(allText),
      contentHash: createHash('sha256').update(pages.map((p) => p.contentHash).join('\n')).digest('hex'),
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await task.destroy().catch(() => undefined);
  }
}

async function readOutline(doc: PdfDoc, maxPages: number): Promise<PdfTocEntry[]> {
  const out: PdfTocEntry[] = [];
  const walk = async (nodes: PdfOutlineNode[], depth: number): Promise<void> => {
    for (const n of nodes) {
      if (out.length >= 500) return;
      const title = (n.title ?? '').replace(/\s+/g, ' ').trim();
      if (title) out.push({ title: title.slice(0, 300), depth, pageIndex: await pageIndexOf(doc, n.dest, maxPages) });
      if (n.items?.length && depth < 3) await walk(n.items, depth + 1);
    }
  };
  await walk((await doc.getOutline()) ?? [], 0);
  return out;
}

async function pageIndexOf(doc: PdfDoc, dest: unknown, maxPages: number): Promise<number | null> {
  try {
    const d = typeof dest === 'string' ? await doc.getDestination(dest) : Array.isArray(dest) ? dest : null;
    const target = d?.[0];
    const idx = typeof target === 'number' ? target : target ? await doc.getPageIndex(target) : null;
    return idx !== null && Number.isInteger(idx) && idx >= 0 && idx < maxPages ? idx : null;
  } catch {
    return null;
  }
}

export type UploadKind = 'pdf' | 'epub' | 'zip' | 'html' | 'unknown';

/** Classify an upload by its bytes. The filename and declared MIME type are never trusted. */
export function sniffUpload(bytes: Uint8Array): UploadKind {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) {
    // EPUB's first entry is normally a stored "mimetype" file, readable straight from the first bytes.
    return /mimetypeapplication\/epub\+zip/.test(head) ? 'epub' : 'zip';
  }
  if (/^\s*(<!doctype html|<html)/i.test(head)) return 'html';
  return 'unknown';
}
