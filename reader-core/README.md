# reader-core

Original building blocks for a read-it-later reader. No Readwise code is used or derived.

- `src/net` — SSRF-safe HTML fetching (`safeFetchHtml`, `assertSafeUrl`, `isBlockedAddress`)
- `src/ingest` — `saveUrl` / `saveHtml`, `extractArticle` (Readability + DOMPurify), `normalizeUrl`
- `src/anchor` — durable highlight anchors (`createAnchor`, `resolveAnchor`) and DOM offset helpers
- `src/types.ts` — zod schemas for highlights and reading progress

```
npm install
npm run typecheck
npm test
```

Design and limits: [`../docs/reader-architecture.md`](../docs/reader-architecture.md).
