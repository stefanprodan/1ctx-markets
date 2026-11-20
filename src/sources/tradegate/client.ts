// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// keyless and undocumented: the exchange's own page refresh, read only
// inside a quote that asks for it, never stored

import { type Clock, MINUTE_MS } from "../../runtime/clock.ts";
import type { Log } from "../../runtime/log.ts";
import { TRADEGATE } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  limiter,
  type RunOptions,
  rateLimited,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = TRADEGATE;
export const HOST = "https://www.tradegatebsx.com";
// no limit is published; a quote of many listings stays polite
export const SPACING_MS = 250;
const TIMEOUT_MS = 10_000;
// the page itself asks again every 10 seconds or so
export const HELD_MS = 15_000;

// Tradegate's hours, which it publishes nowhere a server can read
export const ZONE = "Europe/Berlin";
// wall time into the day: 07:30 to 22:00 on a day Xetra trades
export const OPENS_AT = (7 * 60 + 30) * MINUTE_MS;
export const CLOSES_AT = 22 * 60 * MINUTE_MS;

// every price it answers is in it
export const CURRENCY = "EUR";

// in EUR, with no time of its own: fetchedAt is the quote's time
export type TradegateQuote = {
  last: number;
  bid: number | null;
  ask: number | null;
  high: number | null;
  low: number | null;
  // the previous trading day's, at Tradegate's own 22:00 close
  close: number | null;
  // shares traded today
  volume: number | null;
  fetchedAt: number;
};

export type Tradegate = {
  quote(isin: string): Promise<TradegateQuote>;
  failFast(): Tradegate;
  within(live: () => boolean): Tradegate;
  close(): void;
  due(): number | null;
  backoff(): Backoff | null;
};

export type TradegateOptions = {
  clock: Clock;
  fetch?: Fetch;
  host?: string;
  log?: Log;
};

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

// a decimal comma or a decimal point; no thousands marks are sent
export function tradegateNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return null;
  const plain = s.replace(",", ".");
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

// outside its hours a side can stand at 0, which is no price
const positive = (v: unknown): number | null => {
  const n = tradegateNumber(v);
  return n !== null && n > 0 ? n : null;
};

const count = (v: unknown): number | null => {
  const n = tradegateNumber(v);
  return n !== null && n >= 0 ? n : null;
};

// an unknown ISIN answers 200 with an empty body
export function parseRefresh(raw: string, fetchedAt: number): TradegateQuote {
  if (raw.trim() === "") throw new SourceError("not found", "no such ISIN");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Unreadable();
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw malformed("not a quote");
  }
  const b = body as Record<string, unknown>;
  const last = positive(b.last);
  if (last === null) throw malformed("no last price");
  return {
    last,
    bid: positive(b.bid),
    ask: positive(b.ask),
    high: positive(b.high),
    low: positive(b.low),
    close: positive(b.close),
    volume: count(b.stueck),
    fetchedAt,
  };
}

export function tradegate(options: TradegateOptions): Tradegate {
  const { clock } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = limiter(
    clock,
    SPACING_MS,
    options.log === undefined
      ? undefined
      : { source: SOURCE, log: options.log },
  );

  const quote = (isin: string, run: RunOptions): Promise<TradegateQuote> =>
    calls.run(async () => {
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(
            `${host}/refresh.php?${new URLSearchParams({ isin })}`,
            { headers: { Accept: "application/json" }, signal: abort.signal },
          );
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        if (res.status === 429) throw rateLimited(res, clock.now());
        if (res.status === 404) throw new SourceError("not found");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        return parseRefresh(raw, clock.now());
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Tradegate => ({
    quote: (isin) => quote(isin, run),
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close: () => calls.close(),
    due: () => calls.due(),
    backoff: () => calls.backoff(),
  });
  return client({});
}
