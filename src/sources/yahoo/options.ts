// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Option chains from Yahoo, read inside a call and never stored: a chain
// changes through the day, and nothing else reads it.

import { iso, round } from "../../market/format.ts";
import type { Instrument } from "../../market/instruments.ts";
import { addDays, dateOfWall, wallOfDate } from "../../market/zone.ts";
import { DAY_MS } from "../../runtime/clock.ts";
import type { EventRow } from "../finnhub/read.ts";
import { YAHOO } from "../ids.ts";
import type { OptionChain, OptionContract } from "./client.ts";

export const NOT_OPTIONABLE =
  "Options come from Yahoo; this symbol is priced by another source.";
export const NO_OPTIONS = "Yahoo lists no options for this symbol.";
// rows of the summary besides the earnings expiry, each a call past the nearest
export const SUMMARY_EXPIRIES = 4;
// percent from the price either side, what a chain near the money shows
export const CHAIN_BAND = 10;
// strikes a summary row names for the open interest on each side
export const TOP_STRIKES = 3;

// any listing another source prices has no Yahoo chain to ask
export const optionable = (i: Pick<Instrument, "source">): boolean =>
  i.source === YAHOO;

export type Chain = NonNullable<OptionChain["chain"]>;

// a listed expiry is 00:00 UTC of its date
export const expiryDate = (at: number): string => dateOfWall(at);

// calendar days from the market's date to the expiry's
export const daysTo = (expiry: number, today: string): number =>
  Math.round((expiry - wallOfDate(today)) / DAY_MS);

// a crossed or one-sided quote has no mid, never a last price in its place
export const mid = (c: OptionContract | undefined): number | null =>
  c === undefined ||
  c.bid === null ||
  c.ask === null ||
  c.bid <= 0 ||
  c.ask <= 0 ||
  c.ask < c.bid
    ? null
    : (c.bid + c.ask) / 2;

const percent = (v: number | null): number | null =>
  v === null ? null : round(v * 100);

// A contract expiring before the news prices none of it. One expiring on
// the report day settles at its close, after a bmo or dmh report; after an
// amc or unlabelled one, the next expiry.
const SAME_DAY = new Set(["bmo", "dmh"]);

export function earningsExpiry(
  expiries: readonly number[],
  event: Pick<EventRow, "date" | "hour"> | null,
): number | null {
  if (event === null) return null;
  const from = SAME_DAY.has(event.hour) ? event.date : addDays(event.date, 1);
  return expiries.find((e) => expiryDate(e) >= from) ?? null;
}

// the nearest expiries still to trade, and the earnings one when past them
export function summaryExpiries(
  expiries: readonly number[],
  today: string,
  earnings: number | null,
): { expiry: number; earnings: boolean }[] {
  const ahead = [...expiries]
    .sort((a, b) => a - b)
    .filter((e) => daysTo(e, today) > 0);
  const rows = ahead
    .slice(0, SUMMARY_EXPIRIES)
    .map((expiry) => ({ expiry, earnings: expiry === earnings }));
  if (
    earnings !== null &&
    daysTo(earnings, today) > 0 &&
    !rows.some((r) => r.earnings)
  ) {
    rows.push({ expiry: earnings, earnings: true });
  }
  return rows;
}

const byStrike = (side: readonly OptionContract[]) =>
  new Map(side.map((c) => [c.strike, c]));

// the strike nearest the price that lists both a call and a put, the
// lower on a tie
export function atmStrike(chain: Chain, price: number | null): number | null {
  if (price === null) return null;
  const puts = byStrike(chain.puts);
  let best: number | null = null;
  for (const c of chain.calls) {
    if (!puts.has(c.strike)) continue;
    const d = Math.abs(c.strike - price);
    const b = best === null ? Number.POSITIVE_INFINITY : Math.abs(best - price);
    if (d < b || (d === b && best !== null && c.strike < best)) best = c.strike;
  }
  return best;
}

const sum = (side: readonly OptionContract[], k: "openInterest" | "volume") =>
  side.reduce((s, c) => s + (c[k] ?? 0), 0);

const ratio = (puts: number, calls: number): number | null =>
  calls === 0 ? null : round(puts / calls);

const topOi = (side: readonly OptionContract[]) =>
  side
    .filter((c) => (c.openInterest ?? 0) > 0)
    .sort((a, b) => b.openInterest! - a.openInterest! || a.strike - b.strike)
    .slice(0, TOP_STRIKES)
    .map((c) => ({ strike: c.strike, open_interest: c.openInterest }));

export function summaryRow(chain: Chain, price: number | null) {
  const atm = atmStrike(chain, price);
  const call = atm === null ? undefined : byStrike(chain.calls).get(atm);
  const put = atm === null ? undefined : byStrike(chain.puts).get(atm);
  const callMid = mid(call);
  const putMid = mid(put);
  const straddle =
    callMid === null || putMid === null ? null : callMid + putMid;
  return {
    atm_strike: atm,
    call_iv: percent(call?.iv ?? null),
    put_iv: percent(put?.iv ?? null),
    straddle: round(straddle),
    implied_move_pct:
      straddle === null || price === null || price <= 0
        ? null
        : round((straddle / price) * 100),
    put_call_oi: ratio(
      sum(chain.puts, "openInterest"),
      sum(chain.calls, "openInterest"),
    ),
    put_call_volume: ratio(
      sum(chain.puts, "volume"),
      sum(chain.calls, "volume"),
    ),
    top_call_oi: topOi(chain.calls),
    top_put_oi: topOi(chain.puts),
  };
}

const side = (c: OptionContract | undefined) =>
  c === undefined
    ? null
    : {
        bid: c.bid,
        ask: c.ask,
        mid: round(mid(c)),
        last: c.last,
        last_trade_at: iso(c.lastTradeAt),
        volume: c.volume,
        open_interest: c.openInterest,
        iv: percent(c.iv),
        in_the_money: c.inTheMoney,
      };

// strikes within CHAIN_BAND percent of the price, lowest first
export function chainRows(chain: Chain, price: number | null) {
  if (price === null) return [];
  const calls = byStrike(chain.calls);
  const puts = byStrike(chain.puts);
  const band = (price * CHAIN_BAND) / 100;
  return [...new Set([...calls.keys(), ...puts.keys()])]
    .filter((s) => Math.abs(s - price) <= band)
    .sort((a, b) => a - b)
    .map((strike) => ({
      strike,
      call: side(calls.get(strike)),
      put: side(puts.get(strike)),
    }));
}

// listed dates an expiry not listed is answered with
export const NEAREST_LISTED = 3;

// the listed dates nearest one that is not listed, in date order
export function nearestListed(
  expiries: readonly number[],
  date: string,
  count = NEAREST_LISTED,
): string[] {
  const at = wallOfDate(date);
  return [...expiries]
    .sort((a, b) => Math.abs(a - at) - Math.abs(b - at) || a - b)
    .slice(0, count)
    .map(expiryDate)
    .sort();
}
