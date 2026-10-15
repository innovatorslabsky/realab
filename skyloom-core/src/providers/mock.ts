import { ProviderError } from '../types.ts';
import type { Call, Kind, MicroUsd, Output, Provider } from '../types.ts';

export interface MockConfig {
  id: string;
  kinds: readonly Kind[];
  costPerCall?: MicroUsd;
  /** Fail the first N calls with this kind of error, then succeed. */
  failFirst?: number;
  failWith?: { retryable: boolean; retryAfterMs?: number };
  rpm?: number;
  maxConcurrent?: number;
  delay?: () => Promise<void>;
}

/** Offline provider for tests, demos and the desktop app's "dry run" mode. Spends nothing. */
export function mockProvider(c: MockConfig): Provider & { calls: number } {
  const p = {
    id: c.id,
    label: `Mock ${c.id}`,
    kinds: c.kinds,
    ...(c.rpm !== undefined ? { rpm: c.rpm } : {}),
    maxConcurrent: c.maxConcurrent ?? 2,
    calls: 0,
    estimate: (): MicroUsd => c.costPerCall ?? 0,
    async run(call: Call): Promise<Output> {
      p.calls++;
      await c.delay?.();
      if (p.calls <= (c.failFirst ?? 0)) {
        const w = c.failWith ?? { retryable: true };
        throw new ProviderError(`mock ${c.id} failure #${p.calls}`, { retryable: w.retryable, ...(w.retryAfterMs !== undefined ? { retryAfterMs: w.retryAfterMs } : {}) });
      }
      if (call.kind === 'text') return { text: `Scene: ${call.prompt}` };
      return { media: { url: `mock://${c.id}/${p.calls}`, mime: call.kind === 'video' ? 'video/mp4' : 'image/png' } };
    },
  };
  return p;
}
