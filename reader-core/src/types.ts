import { z } from 'zod';

export const anchorSchema = z.object({
  exact: z.string().min(1).max(20_000),
  prefix: z.string().max(200),
  suffix: z.string().max(200),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

export const HIGHLIGHT_COLORS = ['yellow', 'blue', 'green', 'red', 'purple'] as const;

/** What a client sends to create a highlight. Ids, owner and timestamps are assigned server-side. */
export const createHighlightSchema = z
  .object({
    documentId: z.string().min(1),
    anchor: anchorSchema,
    color: z.enum(HIGHLIGHT_COLORS).default('yellow'),
    note: z.string().max(10_000).optional(),
    tags: z.array(z.string().min(1).max(64)).max(20).default([]),
    /**
     * Where the anchor's text lives. Articles are one text, so omit it; an EPUB anchors per chapter and a
     * PDF per page, because each has its own text coordinate space.
     */
    unit: z.object({ kind: z.enum(['chapter', 'page']), index: z.number().int().nonnegative() }).optional(),
    /** `contentHash` of the text the anchor was made against (the article, chapter or page text). */
    contentHash: z.string().length(64),
  })
  .refine((h) => h.anchor.end > h.anchor.start, { message: 'anchor.end must be greater than anchor.start' });

export type CreateHighlight = z.infer<typeof createHighlightSchema>;

export const LOCATIONS = ['inbox', 'later', 'archive', 'feed'] as const;
export type Location = (typeof LOCATIONS)[number];

/**
 * Reading progress as a *text offset*, not a scroll pixel: it survives window resizes, font changes
 * and device switches, which is what makes cross-device "resume where I left off" work.
 */
export const readingProgressSchema = z.object({
  documentId: z.string().min(1),
  textOffset: z.number().int().nonnegative(),
  contentHash: z.string().length(64),
  updatedAt: z.string().datetime(),
});
export type ReadingProgress = z.infer<typeof readingProgressSchema>;
