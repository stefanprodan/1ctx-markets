// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// a filings run per share, scoped to the instrument, so one failure is stale alone

import { readSession } from "../../market/calendars.ts";
import type { Instrument } from "../../market/instruments.ts";
import {
  addDays,
  fromWallTime,
  localDate,
  wallOfDate,
  wallTime,
} from "../../market/zone.ts";
import { DAY_MS, MINUTE_MS } from "../../runtime/clock.ts";
import type { Db } from "../../storage/db/index.ts";
import { failedRun, lastStarted } from "../../storage/runs.ts";
import { phraseOf } from "../source.ts";
import {
  type Filing,
  filingUrl,
  LATE_FORMS,
  OFFERING_FORMS,
  SOURCE,
  type Submissions,
} from "./client.ts";
import { NON_RELIANCE, RESULTS } from "./items.ts";

export const FILINGS_JOB = "filings";
// SEC's map covers every US filer, so its runs are the market's
export const TICKERS = { job: "tickers", scope: "US" } as const;
// new listings join the map; a week keeps them within days
export const TICKERS_EVERY_MS = 7 * DAY_MS;
// a failed fetch is asked again after this, not each tick
export const RETRY_MS = 60 * MINUTE_MS;
// after-close 8-Ks land in the hour or two after the session ends
export const AFTER_CLOSE_MS = 2 * 60 * MINUTE_MS;
// two years: the restatement flag reads one, a reader the year before it
export const KEPT_MS = 730 * DAY_MS;

// one quarter, as a 10-Q is due within one
export const LATE_DAYS = 90;
export const RESTATEMENT_DAYS = 365;
export const OFFERING_DAYS = 90;
// an 8-K with results from a day before an event's date (a date set
// late) to three after it (results that slipped) is taken for its release
export const FILED_BEFORE_DAYS = 1;
export const FILED_AFTER_DAYS = 3;

// what a read answers while the source is off, never an error
export const NO_DATA = "no data from EDGAR";
export const NOT_COVERED =
  "no data from EDGAR: it covers US-listed shares only";
export const REASONS = {
  foreign: "foreign filer",
  noCik: "not in SEC's ticker list",
} as const;

export const STALE_FILINGS = {
  failed: "filings sync failed",
  pending: "filings sync pending",
  none: "no filings yet",
} as const;

// EDGAR holds US filers; only shares are asked, as Finnhub's are
export function eligible(i: Pick<Instrument, "market" | "type">): boolean {
  return i.market === "US" && i.type === "EQUITY";
}

export function storeTickers(
  db: Db,
  ciks: ReadonlyMap<string, number>,
): number {
  db.query("delete from edgar_tickers").run();
  const insert = db.query(
    "insert into edgar_tickers (ticker, cik) values (?, ?)",
  );
  for (const [ticker, cik] of ciks) insert.run(ticker, cik);
  return ciks.size;
}

export const cikOf = (db: Db, symbol: string): number | null =>
  db
    .query<{ cik: number }, [string]>(
      "select cik from edgar_tickers where ticker = ?",
    )
    .get(symbol)?.cik ?? null;

export const tickersFetched = (db: Db): boolean =>
  lastStarted(db, SOURCE, TICKERS.job, TICKERS.scope, "ok") !== null;

// a foreign filer keeps none: its 6-Ks and 20-Fs are out of scope
export function storeFilings(
  db: Db,
  instrument: string,
  cik: number | null,
  answer: Submissions | null,
  now: number,
): number {
  const foreign = answer?.foreign === true;
  db.query(
    `insert into edgar_filers (instrument, cik, foreign_filer, fetched_at)
     values (?, ?, ?, ?)
     on conflict (instrument) do update set cik = excluded.cik,
       foreign_filer = excluded.foreign_filer, fetched_at = excluded.fetched_at`,
  ).run(instrument, cik, foreign ? 1 : 0, answer?.fetchedAt ?? now);
  // a share whose ticker moved to another company keeps none of the old one's
  db.query(
    "delete from filings where instrument = ?1 and (?2 = 1 or url not like ?3)",
  ).run(instrument, foreign || cik === null ? 1 : 0, `%/data/${cik}/%`);
  if (answer === null || foreign || cik === null) return 0;
  const upsert = db.query(
    `insert into filings (instrument, accession, form, accepted_at, filed,
       period, items, url, fetched_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (instrument, accession) do update set
       form = excluded.form, accepted_at = excluded.accepted_at,
       filed = excluded.filed, period = excluded.period,
       items = excluded.items, url = excluded.url,
       fetched_at = excluded.fetched_at`,
  );
  let rows = 0;
  for (const f of answer.filings) {
    if (f.acceptedAt <= now - KEPT_MS) continue;
    upsert.run(
      instrument,
      f.accession,
      f.form,
      f.acceptedAt,
      f.filed,
      f.period,
      f.items.join(","),
      filingUrl(cik, f.accession),
      answer.fetchedAt,
    );
    rows++;
  }
  return rows;
}

export function recordRun(
  db: Db,
  job: string,
  scope: string,
  startedAt: number,
  now: number,
  outcome: { rows: number } | { error: unknown },
): void {
  const failed = "error" in outcome;
  db.query(
    `insert into sync_runs (source, job, scope, started_at, ended_at, status,
       rows, error)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE,
    job,
    scope,
    startedAt,
    now,
    failed ? "failed" : "ok",
    failed ? 0 : outcome.rows,
    failed ? phraseOf(outcome.error) : null,
  );
}

// a seek per instrument on the bars key, never a scan of every bar
export const BAR_BEFORE = `select max(d) as date from (
  select (select max(b.date) from bars b where b.instrument = i.id
    and b.interval = '1d' and b.date < ?2) as d
  from instruments i where i.market = ?1)`;

// the market's last trading day before this date, from its bars since no
// holiday list is kept; with none, the calendar day before
export function dayBefore(db: Db, market: string, day: string): string {
  return (
    db
      .query<{ date: string | null }, [string, string]>(BAR_BEFORE)
      .get(market, day)?.date ?? addDays(day, -1)
  );
}

// past far enough to reach any market's previous session, holidays included
const MAX_STEPS = 14;

// AFTER_CLOSE_MS past the end of the market's latest finished session,
// never later than now: while the stored session runs, in the hours after
// its close, or when it was stored before it starts, the trading days
// before it are tried in turn. With no session stored, a day ago.
export function dueAt(db: Db, market: string, now: number): number {
  const s = readSession(db, market);
  if (s === null) return now - DAY_MS;
  if (s.end + AFTER_CLOSE_MS <= now) return s.end + AFTER_CLOSE_MS;
  const close = wallTime(s.zone, s.end) - wallOfDate(localDate(s.zone, s.end));
  let day = localDate(s.zone, s.start);
  for (let k = 0; k < MAX_STEPS; k++) {
    day = dayBefore(db, market, day);
    const due = fromWallTime(s.zone, wallOfDate(day) + close) + AFTER_CLOSE_MS;
    if (due <= now) return due;
  }
  return now - DAY_MS;
}

// due, when given, is the market's dueAt, read once for a pass of shares
export function filingsDue(
  db: Db,
  i: Pick<Instrument, "id" | "market">,
  now: number,
  due: number = dueAt(db, i.market, now),
): boolean {
  const ok = lastStarted(db, SOURCE, FILINGS_JOB, i.id, "ok");
  return ok === null || ok.startedAt < due;
}

export const filingsFetched = (db: Db, instrument: string): boolean =>
  lastStarted(db, SOURCE, FILINGS_JOB, instrument, "ok") !== null;

export type FilerState = {
  // when the last good run ended, null before the first
  fetchedAt: number | null;
  stale: string[];
  // why there are no filings to show, null when there can be
  reason: string | null;
};

export function filerState(
  db: Db,
  i: Pick<Instrument, "id" | "market">,
  now: number,
): FilerState {
  const ok = lastStarted(db, SOURCE, FILINGS_JOB, i.id, "ok");
  const last = lastStarted(db, SOURCE, FILINGS_JOB, i.id);
  const stale: string[] = [];
  if (ok === null) stale.push(STALE_FILINGS.none);
  // a run cut by shutdown is no failure: the next run settles it
  if (failedRun(last)) stale.push(STALE_FILINGS.failed);
  else if (ok !== null) {
    if (ok.startedAt < dueAt(db, i.market, now)) {
      stale.push(STALE_FILINGS.pending);
    }
  }
  const filer = db
    .query<{ cik: number | null; abroad: number }, [string]>(
      "select cik, foreign_filer as abroad from edgar_filers where instrument = ?",
    )
    .get(i.id);
  const reason =
    filer === null
      ? null
      : filer.cik === null
        ? REASONS.noCik
        : filer.abroad === 1
          ? REASONS.foreign
          : null;
  return { fetchedAt: ok?.endedAt ?? null, stale, reason };
}

export type FilingRow = Filing & { url: string };

type Stored = Omit<FilingRow, "items"> & { items: string };

const COLUMNS = `accession, form, accepted_at as acceptedAt, filed, period,
  items, url`;

const asRow = (r: Stored): FilingRow => ({
  ...r,
  items: r.items === "" ? [] : r.items.split(","),
});

export type FilingCursor = { acceptedAt: number; accession: string };

// newest first, ties by accession, below the cursor when given
export function readFilings(
  db: Db,
  instrument: string,
  limit: number,
  from: FilingCursor | null = null,
): FilingRow[] {
  return db
    .query<Stored, [string, number, string, number]>(
      `select ${COLUMNS} from filings where instrument = ?1
         and (?2 < 0 or accepted_at < ?2
           or (accepted_at = ?2 and accession < ?3))
       order by accepted_at desc, accession desc limit ?4`,
    )
    .all(instrument, from?.acceptedAt ?? -1, from?.accession ?? "", limit)
    .map(asRow);
}

const any = (
  db: Db,
  instrument: string,
  forms: readonly string[],
  since: number,
  item: string | null = null,
): boolean =>
  db
    .query<{ n: number }, [string, string, number, string | null]>(
      `select 1 as n from filings where instrument = ?1
         and form in (select value from json_each(?2)) and accepted_at > ?3
         and (?4 is null or ',' || items || ',' like '%,' || ?4 || ',%')
       limit 1`,
    )
    .get(instrument, JSON.stringify(forms), since, item) !== null;

export type Flags = {
  late_filing: boolean | null;
  restatement: boolean | null;
  offering: boolean | null;
};

export const NO_FLAGS: Flags = {
  late_filing: null,
  restatement: null,
  offering: null,
};

// from stored filings: a share never fetched, without a CIK or foreign
// has no flags, never false ones
export function flags(
  db: Db,
  instrument: string,
  state: FilerState,
  now: number,
): Flags {
  if (state.fetchedAt === null || state.reason !== null) return NO_FLAGS;
  return {
    late_filing: any(db, instrument, LATE_FORMS, now - LATE_DAYS * DAY_MS),
    restatement: any(
      db,
      instrument,
      ["8-K", "8-K/A"],
      now - RESTATEMENT_DAYS * DAY_MS,
      NON_RELIANCE,
    ),
    offering: any(db, instrument, OFFERING_FORMS, now - OFFERING_DAYS * DAY_MS),
  };
}

// The 8-K with results whose date in the exchange's zone is nearest the
// event's, the earlier on a tie: a preliminary release and the final
// one can both fall in the window.
export function filedAt(
  db: Db,
  i: Pick<Instrument, "id" | "zone">,
  date: string,
): number | null {
  const rows = db
    .query<{ at: number }, [string, string]>(
      `select accepted_at as at from filings where instrument = ?1
         and form = '8-K' and ',' || items || ',' like '%,' || ?2 || ',%'
       order by accepted_at`,
    )
    .all(i.id, RESULTS);
  const from = addDays(date, -FILED_BEFORE_DAYS);
  const to = addDays(date, FILED_AFTER_DAYS);
  const event = wallOfDate(date);
  let best: { at: number; off: number } | null = null;
  for (const r of rows) {
    const day = localDate(i.zone, r.at);
    if (day < from || day > to) continue;
    const off = Math.abs(wallOfDate(day) - event);
    // rows come oldest first, so a tie keeps the earlier
    if (best === null || off < best.off) best = { at: r.at, off };
  }
  return best?.at ?? null;
}

export function pruneFilings(db: Db, now: number): number {
  return db
    .query("delete from filings where accepted_at <= ?")
    .run(now - KEPT_MS).changes;
}
