#!/usr/bin/env node
// Usage: node tools/har-structure.ts capture.har [--first-party readwise.io] [--enums] [--json] > report.md
// Runs entirely locally. Prints structure only (no values). Node >= 22.18 runs this file directly.
import { readFileSync } from 'node:fs';
import { renderMarkdown, summarizeHar } from '../src/re/harStructure.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--first-party');
const fpIndex = args.indexOf('--first-party');
const firstParty = fpIndex >= 0 ? args[fpIndex + 1] : undefined;

if (!file) {
  console.error('usage: node tools/har-structure.ts capture.har [--first-party example.com] [--enums] [--json]');
  process.exit(2);
}
try {
  const summary = summarizeHar(JSON.parse(readFileSync(file, 'utf8')), { firstParty, collectEnums: args.includes('--enums') });
  process.stdout.write(args.includes('--json') ? JSON.stringify(summary, null, 2) + '\n' : renderMarkdown(summary));
} catch (err) {
  console.error(`har-structure: ${(err as Error).message}`);
  process.exit(1);
}
