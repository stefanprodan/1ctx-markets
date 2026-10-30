// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { checkStored, type Instrument } from "../../market/instruments.ts";
import type { Clock } from "../../runtime/clock.ts";
import { exclusive } from "../../runtime/lock.ts";
import type { Db } from "../../storage/db/index.ts";
import { failedRun, lastStarted } from "../../storage/runs.ts";
import type { Writer } from "../../storage/writer.ts";
import { WriterClosed } from "../../storage/writer.ts";
import {
  DeadlinePassed,
  Paused,
  PHRASES,
  QueueClosed,
  SourceError,
} from "../source.ts";
import { type Edgar, SOURCE, type Submissions } from "./client.ts";
import {
  cikOf,
  FILINGS_JOB,
  filingsFetched,
  RETRY_MS,
  recordRun,
  storeFilings,
  storeTickers,
  TICKERS,
  tickersFetched,
} from "./store.ts";

// null while the source is off
export type EdgarContext = {
  db: Db;
  clock: Clock;
  writer: Writer;
  edgar: Edgar | null;
};

export type Result =
  | { status: "ok"; rows: number }
  | { status: "failed"; error: unknown };

// a closing server or a read past its deadline says nothing about the
// source, so no run is recorded for it
const aborts = (error: unknown): boolean =>
  error instanceof QueueClosed ||
  error instanceof WriterClosed ||
  error instanceof DeadlinePassed ||
  error instanceof Paused;

// one lock for the map, so calls naming new shares fetch it once
export function refreshTickers(
  ctx: EdgarContext,
  options: { live?: () => boolean; client?: Edgar; missing?: boolean } = {},
): Promise<Result> {
  const client = options.client ?? ctx.edgar;
  if (client === null) throw new Error("edgar is off");
  const live = options.live ?? (() => true);
  return exclusive(ctx.db, `${SOURCE}:tickers`, async () => {
    if (options.missing && tickersFetched(ctx.db)) {
      return { status: "ok", rows: 0 };
    }
    // a call's own fetch waits out a failure as the job does, or every
    // share in every call would ask for the whole map again
    const last = lastStarted(ctx.db, SOURCE, TICKERS.job, TICKERS.scope);
    if (
      options.missing &&
      failedRun(last) &&
      ctx.clock.now() - last.startedAt < RETRY_MS
    ) {
      const phrase = PHRASES.find((p) => p === last.error) ?? "source error";
      return { status: "failed", error: new SourceError(phrase) };
    }
    if (!live()) throw new DeadlinePassed();
    const startedAt = ctx.clock.now();
    let outcome: { rows: number } | { error: unknown };
    let ciks: Map<string, number> | null = null;
    try {
      ciks = (await client.tickers()).ciks;
      outcome = { rows: ciks.size };
    } catch (error) {
      if (aborts(error)) throw error;
      outcome = { error };
    }
    return ctx.writer.write((db): Result => {
      if (!live()) throw new DeadlinePassed();
      if (ciks !== null) storeTickers(db, ciks);
      recordRun(
        db,
        TICKERS.job,
        TICKERS.scope,
        startedAt,
        ctx.clock.now(),
        outcome,
      );
      return "error" in outcome
        ? { status: "failed", error: outcome.error }
        : { status: "ok", rows: outcome.rows };
    });
  });
}

// The map first when none was ever stored; a share it lacks is stored as
// without a CIK, a good run, so the daily pass asks the map again only weekly.
export async function refreshFilings(
  ctx: EdgarContext,
  instrument: Instrument,
  options: {
    // false past a read's deadline: nothing is stored
    live?: () => boolean;
    client?: Edgar;
    // only while it has no good run once the lock is held, so a call
    // that waited on another's fetch asks nothing again
    unfetched?: boolean;
  } = {},
): Promise<Result> {
  const client = options.client ?? ctx.edgar;
  if (client === null) throw new Error("edgar is off");
  const live = options.live ?? (() => true);
  return exclusive(ctx.db, `${SOURCE}:${instrument.id}`, async () => {
    if (options.unfetched && filingsFetched(ctx.db, instrument.id)) {
      return { status: "ok", rows: 0 };
    }
    const startedAt = ctx.clock.now();
    const map = tickersFetched(ctx.db)
      ? null
      : await refreshTickers(ctx, { live, client, missing: true });
    let outcome: { answer: Submissions | null } | { error: unknown };
    const cik = cikOf(ctx.db, instrument.symbol);
    if (map?.status === "failed") outcome = { error: map.error };
    else if (cik === null) outcome = { answer: null };
    else {
      if (!live()) throw new DeadlinePassed();
      try {
        outcome = { answer: await client.submissions(cik) };
      } catch (error) {
        if (aborts(error)) throw error;
        outcome = { error };
      }
    }
    return ctx.writer.write((db): Result => {
      if (!live()) throw new DeadlinePassed();
      checkStored(db, instrument.id);
      const now = ctx.clock.now();
      if ("error" in outcome) {
        recordRun(db, FILINGS_JOB, instrument.id, startedAt, now, outcome);
        return { status: "failed", error: outcome.error };
      }
      const rows = storeFilings(db, instrument.id, cik, outcome.answer, now);
      recordRun(db, FILINGS_JOB, instrument.id, startedAt, now, { rows });
      return { status: "ok", rows };
    });
  });
}
