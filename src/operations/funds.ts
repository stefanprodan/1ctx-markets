// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A hand-priced fund read by its key as any instrument: its entered prices
// as daily closes and its holdings in an ETF's shape. Never a source call.

import type { Bar, Interval } from "../market/bars.ts";
import { weekOf } from "../market/calendars.ts";
import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import {
  ASSET_KEYS,
  type AssetKey,
  type HoldingsEntry,
  holdingsDays,
  readFundHoldings,
  SECTOR_KEYS,
} from "../portfolios/fund-holdings.ts";
import {
  type FundPrice,
  fundByIsin,
  fundPrices,
  latestPrice,
  seesFund,
} from "../portfolios/funds.ts";
import { FUND_SOURCE } from "../sources/ids.ts";
import { HOLDING_NAME_MAX } from "../sources/yahoo/client.ts";
import type { Db } from "../storage/db/index.ts";
import type { Failure } from "./answer.ts";
import { ArgError, date, fields, optionalText, quoted } from "./args.ts";
import type { Markets } from "./markets.ts";
import { type ItemError, resolveTargets } from "./targets.ts";
import { opens, type Who } from "./who.ts";

// the same unseen, missing or without portfolio access, so a key learns
// nothing of another person's funds
export const NO_FUND =
  "no fund under this key that this caller holds or priced";
export const noFund: ItemError = { error: "not_found", message: NO_FUND };

export const FUND_BASIS =
  "prices entered by hand, one close per priced day; a week's is its last";

export const HAND_HOLDINGS =
  "entered by hand from the fund's own reports: its largest holdings, not its full list; top and assets are as of as_of, sectors as of sectors_as_of";
export const NO_HAND_HOLDINGS = "no holdings entered for this fund";

export function seenFund(db: Db, who: Who, input: string): Instrument | null {
  if (!opens(who.portfolio, false)) return null;
  const f = fundByIsin(db, input);
  if (f === null || !seesFund(db, who.user, f.id)) return null;
  return readInstrument(db, f.id);
}

// oldest first; a week keeps its last price, under its Monday
export function fundBars(
  db: Db,
  id: string,
  interval: Interval,
  today: string,
): Bar[] {
  const prices = fundPrices(db, id).reverse();
  const bar = (date: string, p: FundPrice, final: boolean): Bar => ({
    date,
    open: null,
    high: null,
    low: null,
    close: p.price,
    volume: null,
    final,
  });
  if (interval === "1d") return prices.map((p) => bar(p.date, p, true));
  const weeks = new Map<string, FundPrice>();
  for (const p of prices) weeks.set(weekOf(p.date), p);
  const now = weekOf(today);
  return [...weeks].map(([week, p]) => bar(week, p, week < now));
}

// the price as a quote: no day change, no session, its day in as_of
export function fundQuote(db: Db, input: string, i: Instrument) {
  const p = latestPrice(db, i.id);
  return {
    input,
    id: i.id,
    name: i.name,
    type: i.type,
    source: i.source,
    unit: i.unit,
    currency: i.currency,
    kind: "hand_price",
    price: p?.price ?? null,
    as_of: p?.date ?? null,
    previous_close: null,
    change: null,
    change_percent: null,
    day_high: null,
    day_low: null,
    volume: null,
    trade_time: null,
    fetched_at: null,
    signals: null,
    returns: null,
    session: null,
    stale: [],
  };
}

const percent = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10_000) / 100;

export function fundHoldingsAnswer(db: Db, id: string) {
  const row = readFundHoldings(db, id);
  if (row === null) {
    return { source: FUND_SOURCE, message: NO_HAND_HOLDINGS };
  }
  const p = row.positions;
  return {
    source: FUND_SOURCE,
    // as Yahoo's answer has it, so a page reads both alike
    fetched_at: iso(row.fetchedAt),
    entered_at: iso(row.fetchedAt),
    as_of: row.asOf,
    sectors_as_of: row.sectorsAsOf,
    top: row.holdings.map((h) => ({
      rank: h.rank,
      // the listing's own symbol, as an ETF row's; the key stays in id
      symbol:
        h.id === null ? h.symbol : (readInstrument(db, h.id)?.symbol ?? null),
      id: h.id,
      name: h.name,
      weight_percent: percent(h.weight),
    })),
    top_weight_percent:
      row.holdings.length === 0
        ? null
        : percent(row.holdings.reduce((sum, h) => sum + h.weight, 0)),
    // a sectors-only entry has no split yet
    assets:
      row.asOf === null
        ? null
        : {
            stock_percent: percent(p.stock),
            bond_percent: percent(p.bond),
            cash_percent: percent(p.cash),
            other_percent: percent(p.other),
            preferred_percent: percent(p.preferred),
            convertible_percent: percent(p.convertible),
          },
    sectors: row.sectors.map((s) => ({
      sector: s.key,
      weight_percent: percent(s.weight),
    })),
    bond_ratings: [],
    government_bonds_percent: null,
    note: HAND_HOLDINGS,
  };
}

// ---- holdings entered by hand ---------------------------------------------

export const MAX_HOLDING_ROWS = 10;
const MAX_HOLDINGS_BYTES = 8_000;
// figures rounded in a report may sum a little past 100
const ROUNDING = 0.5;

export type FundHoldingsArgs = {
  asOf: string;
  top?: {
    rows: { symbol: string | null; name: string | null; weight: number }[];
    assets: Partial<Record<AssetKey, number>>;
  };
  sectors?: { key: string; weight: number }[];
};

function percentArg(value: unknown, name: string, positive: boolean): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100 ||
    (positive && value === 0)
  ) {
    throw new ArgError(
      `${name} must be a percent from ${positive ? "above 0" : "0"} to 100`,
    );
  }
  return value;
}

function objectArg(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArgError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function summed(weights: number[], name: string) {
  if (weights.reduce((s, w) => s + w, 0) > 100 + ROUNDING) {
    throw new ArgError(`${name} weights sum to more than 100`);
  }
}

// {key: percent}, keys from a fixed list
function weightsArg<K extends string>(
  value: unknown,
  name: string,
  keys: readonly K[],
  positive: boolean,
): { key: K; weight: number }[] {
  const o = objectArg(value, name);
  const out: { key: K; weight: number }[] = [];
  for (const [key, w] of Object.entries(o)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new ArgError(
        `${name} takes ${keys.join(", ")}, not ${quoted(key)}`,
      );
    }
    out.push({
      key: key as K,
      weight: percentArg(w, `${name}.${key}`, positive),
    });
  }
  if (out.length === 0) throw new ArgError(`${name} names at least one weight`);
  summed(
    out.map((x) => x.weight),
    name,
  );
  return out;
}

// some clients send an object as JSON text
function parsedArg(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return value;
  if (Buffer.byteLength(value) > MAX_HOLDINGS_BYTES) {
    throw new ArgError(`holdings is longer than ${MAX_HOLDINGS_BYTES} bytes`);
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseHoldings(value: unknown): FundHoldingsArgs {
  const f = fields(objectArg(parsedArg(value), "holdings"), [
    "as_of",
    "top",
    "assets",
    "sectors",
  ]);
  const asOf = date(f.as_of, "holdings.as_of");
  if (asOf === null)
    throw new ArgError("holdings.as_of is the day they are as of");
  if ((f.top === undefined) !== (f.assets === undefined)) {
    throw new ArgError(
      "holdings top and assets go together: an entry replaces both",
    );
  }
  if (f.top === undefined && f.sectors === undefined) {
    throw new ArgError("holdings gives top and assets, sectors, or all three");
  }
  const out: FundHoldingsArgs = { asOf };
  if (f.top !== undefined) {
    if (
      !Array.isArray(f.top) ||
      f.top.length === 0 ||
      f.top.length > MAX_HOLDING_ROWS
    ) {
      throw new ArgError(
        `holdings.top must be a list of 1 to ${MAX_HOLDING_ROWS} holdings`,
      );
    }
    const rows = f.top.map((r, k) => {
      const name = `holdings.top[${k}]`;
      const h = fields(objectArg(r, name), ["symbol", "name", "weight"]);
      const row = {
        symbol: optionalText(h.symbol, `${name}.symbol`),
        name: optionalText(h.name, `${name}.name`, HOLDING_NAME_MAX),
        weight: percentArg(h.weight, `${name}.weight`, true),
      };
      if (row.symbol === null && row.name === null) {
        throw new ArgError(`${name} needs a symbol or a name`);
      }
      return row;
    });
    summed(
      rows.map((r) => r.weight),
      "holdings.top",
    );
    const assets = Object.fromEntries(
      weightsArg(f.assets, "holdings.assets", ASSET_KEYS, false).map((a) => [
        a.key,
        a.weight,
      ]),
    );
    // largest first, ties in the order given
    out.top = { rows: rows.sort((a, b) => b.weight - a.weight), assets };
  }
  if (f.sectors !== undefined) {
    out.sectors = weightsArg(f.sectors, "holdings.sectors", SECTOR_KEYS, true);
  }
  return out;
}

// a holding's symbol is a listing the server can name, fetched as any
// read's would be, and kept by its id; nothing is marked read
export async function holdingsEntry(
  m: Markets,
  args: FundHoldingsArgs,
): Promise<HoldingsEntry | Failure> {
  const entry: HoldingsEntry = { asOf: args.asOf };
  if (args.sectors !== undefined) entry.sectors = args.sectors;
  if (args.top === undefined) return entry;
  const named = args.top.rows.flatMap((r) =>
    r.symbol === null ? [] : [r.symbol],
  );
  const targets = named.length === 0 ? [] : await resolveTargets(m, named);
  const found = new Map<string, Instrument>();
  for (const t of targets) {
    if ("error" in t) {
      const { candidates, ...error } = t.error;
      return {
        ...error,
        message: `holding ${quoted(t.input)}: ${error.message}`,
        ...(candidates === undefined ? {} : { candidates }),
      };
    }
    found.set(t.input, t.instrument);
  }
  const ids = new Set<string>();
  const rows = [];
  for (const r of args.top.rows) {
    const i = r.symbol === null ? null : found.get(r.symbol)!;
    if (i !== null) {
      if (ids.has(i.id)) {
        return {
          error: "bad_arguments",
          message: `holdings.top names ${i.id} twice`,
        };
      }
      ids.add(i.id);
    }
    rows.push({
      symbol: i?.id ?? null,
      name: r.name ?? i?.name ?? i!.symbol,
      weight: r.weight,
    });
  }
  entry.top = { rows, assets: args.top.assets };
  return entry;
}

// an older report never replaces a newer one's part
export function olderHoldings(
  db: Db,
  id: string,
  entry: Pick<HoldingsEntry, "asOf"> & { top?: unknown; sectors?: unknown },
): Failure | null {
  const days = holdingsDays(db, id);
  if (days === null) return null;
  const both = entry.top !== undefined && entry.sectors !== undefined;
  const late = (part: string, other: string, stored: string | null) =>
    stored !== null && entry.asOf < stored
      ? {
          error: "conflict",
          message: `the fund's ${part} are as of ${stored}, later than ${entry.asOf}${both ? `; send ${other} alone` : ""}`,
        }
      : null;
  return (
    (entry.top === undefined
      ? null
      : late("top and assets", "sectors", days.asOf)) ??
    (entry.sectors === undefined
      ? null
      : late("sectors", "top and assets", days.sectorsAsOf))
  );
}
