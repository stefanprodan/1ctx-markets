// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// 1ctx's fixed window per key, in memory: one counter and one start per
// key, and a cap on keys, so the map stays bounded whatever is sent.

export const CALLS_PER_MINUTE = 120;
export const MAX_WINDOWS = 10_000;

type Window = { start: number; count: number };

export class RateLimit {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  // counted even when refused, so a flood stays refused until its window
  // ends
  hit(key: string, now: number): boolean {
    let w = this.windows.get(key);
    if (w === undefined || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      // re-inserted, so the map's order is by window start, oldest first
      this.windows.delete(key);
      this.windows.set(key, w);
    }
    w.count++;
    if (this.windows.size > MAX_WINDOWS) this.evict(now);
    return w.count <= this.limit;
  }

  // whole seconds until the key's window ends, for Retry-After
  retryAfter(key: string, now: number): number {
    const w = this.windows.get(key);
    if (w === undefined) return 0;
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
  }

  get size(): number {
    return this.windows.size;
  }

  // the ended windows at most once a window; past the cap regardless the
  // oldest, which forgets a count early and never refuses one that should
  // pass
  private evict(now: number): void {
    if (now - this.lastSweep >= this.windowMs) {
      this.lastSweep = now;
      for (const [key, w] of this.windows) {
        if (now - w.start >= this.windowMs) this.windows.delete(key);
      }
    }
    for (const key of this.windows.keys()) {
      if (this.windows.size <= MAX_WINDOWS) break;
      this.windows.delete(key);
    }
  }
}
