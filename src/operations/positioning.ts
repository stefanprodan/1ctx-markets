// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// research's positioning: a CFTC market's weeks, fetched inside the call and
// kept in memory, never stored.

import { iso } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { cftcPair } from "../market/world.ts";
import { dateOfWall } from "../market/zone.ts";
import { DAY_MS } from "../runtime/clock.ts";
import {
  CODE,
  type Market,
  REPORTS,
  type Report,
  type Week,
  type Weeks,
} from "../sources/cftc/client.ts";
import {
  COT_WEEKS,
  HISTORY_WEEKS,
  POSITIONING_MS,
  POSITIONING_WEEKS,
} from "../sources/cftc/list.ts";
import { CFTC, CFTC_MARKET, YAHOO } from "../sources/ids.ts";
import { ArgError } from "./args.ts";
import { type CftcReads, type Markets, shared } from "./markets.ts";
import { type ItemError, itemError, timeout } from "./targets.ts";

const WEEK_MS = 7 * DAY_MS;

export const NOT_COVERED =
  "no data from the CFTC: it reports futures markets; search for the market's name and read its CFTC:<code>";
export const RETIRED =
  "no data from the CFTC: this market has had no report in a year; search for the market's name";
export const SECTION_NOT_COVERED =
  "no data: a CFTC market has the overview and positioning sections only";
export const UNKNOWN_MARKET =
  "no CFTC market with this code reported within a year; try search";
export const READ_WITH = "research section positioning";

const PREFIX = `${CFTC_MARKET}:`;

// a CFTC:<code> input's code, else null; a malformed code is refused
export function cftcCode(input: string): string | null {
  const upper = input.trim().toUpperCase();
  if (!upper.startsWith(PREFIX)) return null;
  const code = upper.slice(PREFIX.length).trim();
  if (!CODE.test(code)) {
    throw new ArgError(
      "a CFTC market is CFTC:<code>, six letters, digits or +",
    );
  }
  return code;
}

export const cftcId = (code: string) => `${PREFIX}${code}`;

// the part after the last " - ": the CFTC names a market and its exchange
const exchangeOf = (name: string): string | null => {
  const at = name.lastIndexOf(" - ");
  return at < 0 ? null : name.slice(at + 3).trim() || null;
};

// a Yahoo listing World markets pairs with a CFTC market, else null
export function pairedCode(instrument: Instrument): string | null {
  if (instrument.source !== YAHOO) return null;
  return cftcPair(instrument.sourceSymbol)?.code ?? null;
}

// the overview's pointer: no CFTC call, the name once the list is held
export function positioningPointer(m: Markets, instrument: Instrument) {
  const code = pairedCode(instrument);
  if (code === null) return undefined;
  return {
    id: cftcId(code),
    name: m.cftc?.list.find(code)?.market.name ?? null,
    read_with: READ_WITH,
  };
}

const EXPIRED = Symbol("expired");

type Found =
  | { kind: "ok"; report: Report; market: Market; latest: string; weeks: Weeks }
  | { kind: "missing" }
  | { kind: "error"; error: ItemError };

// each report's list until the code is found, fetched inline when not held
async function findMarket(
  m: Markets,
  cftc: CftcReads,
  code: string,
  deadline: number,
) {
  // one report's failure must not hide a market the other lists
  let failure: unknown = null;
  for (const report of REPORTS) {
    const found = cftc.list.find(code);
    if (found !== null) return found;
    if (cftc.list.held(report) !== null) continue;
    try {
      await shared(m, `cftc-markets:${report}`, deadline, (live) =>
        cftc.list.fetch(cftc.client.within(live), report),
      );
    } catch (error) {
      failure ??= error;
    }
  }
  const found = cftc.list.find(code);
  if (found === null && failure !== null) throw failure;
  return found;
}

async function weeksOf(
  m: Markets,
  cftc: CftcReads,
  report: Report,
  market: Market,
  deadline: number,
): Promise<Weeks> {
  const code = market.code;
  const cached = m.positioning.get(code);
  // a list refreshed since the fetch may know a report the weeks miss
  const behind = (cached?.answer.weeks[0]?.date ?? "") < market.latest;
  if (cached !== undefined && m.clock.now() < cached.until && !behind) {
    return cached.answer;
  }
  // one week above the history, so its oldest row has a change too
  const answer = await shared(m, `positioning:${code}`, deadline, (live) =>
    cftc.client.within(live).weeks(report, code, HISTORY_WEEKS + 1),
  );
  const now = m.clock.now();
  for (const [k, v] of m.positioning)
    if (v.until <= now) m.positioning.delete(k);
  m.positioning.set(code, { until: answer.fetchedAt + POSITIONING_MS, answer });
  return answer;
}

// the market's weeks under the deadline; one call once the list is held
export async function readPositioning(
  m: Markets,
  code: string,
  deadline: number,
): Promise<Found> {
  const cftc = m.cftc;
  if (cftc === null) {
    return {
      kind: "error",
      error: { error: "source_error", message: "the CFTC is not set up" },
    };
  }
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  try {
    const found = await Promise.race([
      findMarket(m, cftc, code, deadline),
      expired,
    ]);
    if (found === EXPIRED) return { kind: "error", error: timeout(m) };
    if (found === null) return { kind: "missing" };
    const weeks = await Promise.race([
      weeksOf(m, cftc, found.report, found.market, deadline),
      expired,
    ]);
    if (weeks === EXPIRED) return { kind: "error", error: timeout(m) };
    const held = cftc.list.held(found.report)!;
    const newest = weeks.weeks[0]?.date ?? "";
    return {
      kind: "ok",
      report: found.report,
      market: found.market,
      // a report published since the list was fetched is in the weeks
      latest: [newest, held.latest].sort()[1]!,
      weeks,
    };
  } catch (error) {
    return { kind: "error", error: itemError(m, error) };
  } finally {
    cancel();
  }
}

// a World markets code no longer listed is logged once a day
export function noteRetired(m: Markets, code: string, input: string) {
  const list = m.cftc?.list;
  if (list === undefined) return;
  const last = list.retired.get(code);
  const now = m.clock.now();
  if (last !== undefined && now - last < DAY_MS) return;
  list.retired.set(code, now);
  m.log.warn("cftc market retired", { code, symbol: input });
}

type Row = Record<string, unknown> & { report_date: string };

// percent and index points to one decimal, the precision the CFTC prints
const tenth = (v: number) => Math.round(v * 10) / 10;

const percentOf = (part: number, whole: number) =>
  whole === 0 ? null : tenth((part / whole) * 100);

// newest first; the oldest fetched week only gives the change to its successor
export function weekRows(weeks: readonly Week[]): Row[] {
  return weeks.slice(0, HISTORY_WEEKS).map((w, i) => {
    const before = weeks[i + 1];
    const row: Row = { report_date: w.date, open_interest: w.openInterest };
    for (const [group, g] of Object.entries(w.groups)) {
      const net = g.long - g.short;
      const prior = before?.groups[group];
      row[group] = {
        long: g.long,
        short: g.short,
        spread: g.spread,
        net,
        net_pct_oi: percentOf(net, w.openInterest),
        net_change:
          prior === undefined ? null : net - (prior.long - prior.short),
        traders_long: g.tradersLong,
        traders_short: g.tradersShort,
      };
    }
    return row;
  });
}

// the latest net placed in the range of the last HISTORY_WEEKS nets, 0 to 100
export function cotIndex(weeks: readonly Week[]) {
  const read = weeks.slice(0, HISTORY_WEEKS);
  const out: Record<string, { value: number | null; weeks: number } | null> =
    {};
  for (const group of Object.keys(read[0]?.groups ?? {})) {
    if (read.length < COT_WEEKS) {
      out[group] = null;
      continue;
    }
    const nets = read.map(
      (w) => w.groups[group]!.long - w.groups[group]!.short,
    );
    const low = Math.min(...nets);
    const high = Math.max(...nets);
    out[group] = {
      value:
        high === low ? null : tenth(((nets[0]! - low) / (high - low)) * 100),
      weeks: read.length,
    };
  }
  return out;
}

// what every positioning answer opens with
export function positioningHead(found: Extract<Found, { kind: "ok" }>) {
  const code = found.market.code;
  return {
    source: CFTC,
    cftc: {
      id: cftcId(code),
      name: found.market.name,
      exchange: exchangeOf(found.market.name),
      report: found.report,
    },
    fetched_at: iso(found.weeks.fetchedAt),
    latest_report: found.latest,
    // a market that skipped the latest report: an answer, never stale
    in_latest_report: found.weeks.weeks[0]?.date === found.latest,
  };
}

// since as asked, or POSITIONING_WEEKS back; at most HISTORY_WEEKS
export function positioningSince(m: Markets, since: string | null): string {
  const now = m.clock.now();
  const earliest = dateOfWall(now - HISTORY_WEEKS * WEEK_MS);
  if (since === null) return dateOfWall(now - POSITIONING_WEEKS * WEEK_MS);
  if (since < earliest) {
    throw new ArgError(
      `since must be at most ${HISTORY_WEEKS} weeks back, ${earliest} or later`,
    );
  }
  return since;
}

// the market of a positioning read, or the plain answer why there is none
export function marketOf(
  input: string,
  instrument: Instrument | null,
): { code: string; world: boolean } | { message: string } {
  if (instrument === null) {
    const code = cftcCode(input);
    if (code === null) return { message: NOT_COVERED };
    return { code, world: false };
  }
  const code = pairedCode(instrument);
  if (code === null) return { message: NOT_COVERED };
  return { code, world: true };
}

// the REST route's positioning: the default weeks, unpaged
export async function positioningSummary(
  m: Markets,
  input: string,
  instrument: Instrument | null,
  deadline: number,
): Promise<Record<string, unknown>> {
  const of = marketOf(input, instrument);
  if ("message" in of) return { source: CFTC, message: of.message };
  const found = await readPositioning(m, of.code, deadline);
  if (found.kind === "error") return { source: CFTC, ...found.error };
  if (found.kind === "missing") {
    if (!of.world)
      return { source: CFTC, error: "not_found", message: UNKNOWN_MARKET };
    noteRetired(m, of.code, input);
    return { source: CFTC, message: RETIRED };
  }
  const since = positioningSince(m, null);
  return {
    ...positioningHead(found),
    since,
    cot_index: cotIndex(found.weeks.weeks),
    weeks: weekRows(found.weeks.weeks).filter((r) => r.report_date >= since),
  };
}
