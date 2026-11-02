// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// One read for a page of thousands: stored figures only, never a source,
// never one symbol at a time.

import { json, queryArgs } from "../api/http.ts";
import { round } from "../market/format.ts";
import { trackedIds } from "../market/tracking.ts";
import { cursor, readCursor } from "../operations/answer.ts";
import { ArgError, oneOf } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import { LATEST_DAILY } from "../signals/store.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FRED, FUND_SOURCE } from "../sources/ids.ts";
import {
  listRow,
  pageSize,
  STORED_COLUMNS,
  STORED_JOINS,
  type Stored,
} from "./http.ts";

// a series has no price to be near a high, and a currency pair's RSI
// says nothing of being bought or sold
const PRICED = "r.type <> 'SERIES'";
const TRADED = "r.type not in ('SERIES', 'CURRENCY')";

type Order = "asc" | "desc";

export const SCREENS = {
  moves: { keeps: "1", sort: "move", order: "desc" },
  near_high: {
    keeps: `${PRICED} and r.drawdown >= -3`,
    sort: "drawdown",
    order: "desc",
  },
  off_high: {
    keeps: `${PRICED} and r.drawdown <= -20`,
    sort: "drawdown",
    order: "asc",
  },
  oversold: {
    keeps: `${TRADED} and r.rsi14 <= 30`,
    sort: "rsi14",
    order: "asc",
  },
  overbought: {
    keeps: `${TRADED} and r.rsi14 >= 70`,
    sort: "rsi14",
    order: "desc",
  },
} as const satisfies Record<
  string,
  { keeps: string; sort: string; order: Order }
>;

export type Screen = keyof typeof SCREENS;
export const SCREEN_NAMES = Object.keys(SCREENS) as Screen[];

// the ticker people know, an index's ^ ignored, as the page sorts names
const TICKER = "ltrim(r.symbol, '^') collate nocase";

export const SORTS = {
  move: "abs(r.changePercent)",
  symbol: TICKER,
  change: "r.changePercent",
  return_1m: "r.return1m",
  return_1y: "r.return1y",
  drawdown: "r.drawdown",
  rsi14: "r.rsi14",
  trend: "r.trend",
} as const;

export type Sort = keyof typeof SORTS;
export const SORT_NAMES = Object.keys(SORTS) as Sort[];

// a kind as stored: Yahoo's types and SERIES
const KIND = /^[A-Z0-9_]{1,32}$/;
const MAX_KINDS = 16;

export type ScreenerArgs = {
  types: string[];
  screen: Screen;
  sort: Sort;
  order: Order;
  size: number;
  offset: number;
};

export function parseScreener(url: URL): ScreenerArgs {
  const q = queryArgs(url, {
    type: "list",
    screen: "text",
    sort: "text",
    order: "text",
    page_size: "number",
    page_token: "text",
  });
  const types = [...new Set((q.type as string[] | undefined) ?? [])];
  if (types.length > MAX_KINDS || !types.every((t) => KIND.test(t))) {
    throw new ArgError(
      `type is at most ${MAX_KINDS} stored kinds, such as EQUITY or ETF`,
    );
  }
  const screen = oneOf(q.screen, "screen", SCREEN_NAMES, "moves");
  const own = SCREENS[screen];
  if (q.sort === undefined && q.order !== undefined) {
    throw new ArgError("order needs sort");
  }
  const sort = oneOf(q.sort, "sort", SORT_NAMES, own.sort);
  const order = oneOf(
    q.order,
    "order",
    ["asc", "desc"] as const,
    q.sort === undefined ? own.order : sort === "symbol" ? "asc" : "desc",
  );
  const size = pageSize(q.page_size);
  let offset = 0;
  if (q.page_token !== undefined) {
    const at = readCursor(String(q.page_token), { types, screen, sort, order });
    offset = at === null ? Number.NaN : Number(at);
    if (!Number.isSafeInteger(offset) || offset < 1) {
      throw new ArgError("page_token does not continue this screen");
    }
  }
  return { types, screen, sort, order, size, offset };
}

type Row = Stored & {
  symbol: string;
  return1m: number | null;
  return1y: number | null;
  drawdown: number | null;
  rsi14: number | null;
  cross: number | null;
  distance: number | null;
  trend: number | null;
};

// every updated instrument with its latest daily row and quote; a fund
// the owner prices is a holding, private to portfolio access
const BASE = `with t as (select value as id from json_each(?1)),
  base as (
    select ${STORED_COLUMNS}, i.symbol,
      s.return_1m as return1m, s.return_1y as return1y,
      s.drawdown, s.rsi14, s.cross,
      case when q.price is not null and s.sma200 > 0
        then 100 * (q.price / s.sma200 - 1) end as distance
    from t join instruments i on i.id = t.id
    ${STORED_JOINS}
    left join signals s on ${LATEST_DAILY}
    where i.source <> '${FUND_SOURCE}'
  ),
  r as (
    select *, case when distance is null or cross is null then null
        when cross = 1 and distance > 0 then 1
        when cross = -1 and distance < 0 then -1
        else 0 end as trend
    from base
  )`;

const TREND = { 1: "up", 0: "mixed", [-1]: "down" } as Record<number, string>;

export function screener(m: Markets, url: URL): Response {
  const args = parseScreener(url);
  const { types, screen, sort, order, size, offset } = args;
  const { db } = m;
  const now = m.clock.now();
  const tracked = JSON.stringify([...trackedIds(db, now, m.tracking)]);
  const kinds = JSON.stringify(types);
  const typed =
    "(json_array_length(?2) = 0 or r.type in (select value from json_each(?2)))";
  const by = SORTS[sort];
  // nulls last either way, ties by the ticker
  const rows = db
    .query<Row, [string, string, number, number]>(
      `${BASE} select * from r
       where ${typed} and ${SCREENS[screen].keeps}
       order by ${by} is null, ${by} ${order}, ${TICKER}, r.id
       limit ?3 offset ?4`,
    )
    .all(tracked, kinds, size + 1, offset);
  const counted = db
    .query<Record<Screen, number> & { type: string }, [string]>(
      `${BASE} select r.type as type, ${SCREEN_NAMES.map(
        (s) => `sum(case when ${SCREENS[s].keeps} then 1 else 0 end) as ${s}`,
      ).join(", ")}
       from r group by r.type order by r.type`,
    )
    .all(tracked);
  const counts = Object.fromEntries(
    SCREEN_NAMES.map((s) => [
      s,
      counted
        .filter((c) => types.length === 0 || types.includes(c.type))
        .reduce((n, c) => n + c[s], 0),
    ]),
  ) as Record<Screen, number>;
  const listed = listRow(m, now);
  const page = rows.slice(0, size);
  return json({
    ...(page.some((r) => r.source === FRED)
      ? { attribution: ATTRIBUTION }
      : {}),
    screen,
    type: types,
    sort: { field: sort, order },
    counts,
    kinds: counted.map((c) => ({ kind: c.type, count: c.moves })),
    instruments: page.map((r) => ({
      ...listed(r),
      return_1m: round(r.return1m),
      return_1y: round(r.return1y),
      drawdown: round(r.drawdown),
      rsi14: round(r.rsi14),
      distance_sma200: round(r.distance),
      cross: r.cross,
      trend: r.trend === null ? null : TREND[r.trend]!,
    })),
    ...(rows.length > size
      ? {
          next_page_token: cursor(String(offset + size), {
            types,
            screen,
            sort,
            order,
          }),
        }
      : {}),
  });
}
