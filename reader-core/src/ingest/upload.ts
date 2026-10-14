import { parseEpub } from '../epub/parseEpub.ts';
import type { EpubDraft, EpubLimits } from '../epub/parseEpub.ts';
import { parsePdf, sniffUpload } from '../pdf/parsePdf.ts';
import type { PdfDraft, PdfParseOptions } from '../pdf/parsePdf.ts';

export class UnsupportedUploadError extends Error {
  override name = 'UnsupportedUploadError';
}

export type UploadDraft = { kind: 'pdf'; draft: PdfDraft } | { kind: 'epub'; draft: EpubDraft };

/**
 * One entry point for "the user uploaded a file". The type is decided from the bytes alone — a file
 * named `.pdf` that is really a zip, or an `.epub` that is really HTML, is routed by what it is.
 * HTML is not an upload format here: pages come in through `saveUrl` / `saveHtml`.
 */
export async function ingestUpload(bytes: Uint8Array, options: { pdf?: PdfParseOptions; epub?: Partial<EpubLimits> } = {}): Promise<UploadDraft> {
  switch (sniffUpload(bytes)) {
    case 'pdf':
      return { kind: 'pdf', draft: await parsePdf(bytes, options.pdf) };
    case 'epub':
      return { kind: 'epub', draft: parseEpub(bytes, options.epub) };
    case 'zip':
      throw new UnsupportedUploadError('This zip archive is not an EPUB');
    case 'html':
      throw new UnsupportedUploadError('Web pages are saved by URL, not uploaded as files');
    default:
      throw new UnsupportedUploadError('Unsupported file type (expected PDF or EPUB)');
  }
}
