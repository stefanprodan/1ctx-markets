// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  CRYPTO,
  isQuoted,
  readSession,
  sessionDate,
} from "../market/calendars.ts";
import { iso, price } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import {
  intradaySessions,
  newestSession,
  readIntraday,
} from "../market/intraday.ts";
import type { StaleReason } from "../market/stale.ts";
import { YAHOO } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import {
  cursor,
  errorResult,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError } from "./args.ts";
import type { Markets } from "./markets.ts";
import { readLatest, sessionOf } from "./quote.ts";
import { type ItemError, readTargets } from "./targets.ts";

export type IntradayArgs = {
  symbol: string;
  interval: "5m";
  from: string | null;
  to: string | null;
  benchmark: string | null;
  next: string | null;
};

const CONTINUES = "next does not continue these arguments";

export const NO_SOURCE = "this instrument's source gives no 5-minute closes";

export type IntradayPoint = {
  at: number;
  session: string;
  close: number;
  final: boolean;
};

export type IntradayRead =
  | { input: string; error: ItemError }
  | {
      instrument: Instrument;
      from: string;
      to: string;
      points: IntradayPoint[];
      sessions: { session: string; fetchedAt: number }[];
      session: ReturnType<typeof sessionOf>;
      stale: StaleReason[];
    };

const noData = (input: string, message: string): IntradayRead => ({
  input,
  error: { error: "no_data", message },
});

// crypto never closes, so its newest point is never final
function movingAt(db: Db, i: Instrument, now: number): number | null {
  const newest = db
    .query<{ at: number | null; session: string | null }, [string]>(
      `select at, session from intraday where instrument = ?
       order by session desc, at desc limit 1`,
    )
    .get(i.id);
  if (newest?.at == null) return null;
  if (i.market === CRYPTO) return newest.at;
  const s = readSession(db, i.market);
  return s !== null &&
    isQuoted(i.market, s, now) &&
    sessionDate(s) === newest.session
    ? newest.at
    : null;
}

// a cursor keeps its bounds, so a session added between pages never moves them
export async function readIntradayHistory(
  m: Markets,
  args: IntradayArgs,
  page: { from: string; to: string; start: number } | null,
): Promise<IntradayRead> {
  const [target] = await readTargets(m, [args.symbol]);
  if ("error" in target!) return { input: target.input, error: target.error };
  const instrument = target.instrument;
  if (instrument.source !== YAHOO) return noData(target.input, NO_SOURCE);
  const db = m.db;
  const newest = newestSession(db, instrument.id);
  const to = page?.to ?? args.to ?? newest;
  const from = page?.from ?? args.from ?? to;
  if (from === null || to === null) {
    return noData(target.input, "no 5-minute closes stored yet");
  }
  const stored = readIntraday(db, instrument.id, from, to, page?.start);
  // its next point replaced or cleared: an empty page would end the walk
  if (page !== null && stored[0]?.at !== page.start) {
    throw new ArgError(CONTINUES);
  }
  if (stored.length === 0) {
    return noData(
      target.input,
      `no 5-minute closes stored from ${from} to ${to}`,
    );
  }
  const now = m.clock.now();
  const moving = movingAt(db, instrument, now);
  return {
    instrument,
    from,
    to,
    points: stored.map((p) => ({ ...p, final: p.at !== moving })),
    sessions: intradaySessions(db, instrument.id, from, to),
    session: sessionOf(m, instrument, now),
    stale: readLatest(db, instrument, now, m.quoteEveryMs).stale,
  };
}

const POSITION = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_(\d{1,16})$/;

export async function intradayAnswer(
  m: Markets,
  args: IntradayArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  let page: { from: string; to: string; start: number } | null = null;
  if (next !== null) {
    const at = POSITION.exec(readCursor(next, asked) ?? "");
    const start = Number(at?.[3]);
    if (at === null || !Number.isSafeInteger(start)) {
      throw new ArgError(CONTINUES);
    }
    page = { from: at[1]!, to: at[2]!, start };
  }
  const read = await readIntradayHistory(m, args, page);
  if ("error" in read) return errorResult({ input: read.input, ...read.error });
  const { instrument, from, to, points } = read;
  const items = points.map((p) => ({
    at: iso(p.at),
    session: p.session,
    close: price(p.close),
    final: p.final,
  }));
  const result = fitPage(
    items,
    (count) => ({
      id: instrument.id,
      name: instrument.name,
      source: instrument.source,
      unit: instrument.unit,
      currency: instrument.currency,
      interval: "5m",
      from,
      to,
      session: read.session,
      sessions: read.sessions.map((s) => ({
        session: s.session,
        fetched_at: iso(s.fetchedAt),
      })),
      stale: read.stale,
      next:
        count < points.length
          ? cursor(`${from}_${to}_${points[count]!.at}`, asked)
          : null,
    }),
    "points",
  );
  return textResult(result.text);
}
