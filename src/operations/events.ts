// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Only actuals mark an event reported, never its date or after-close label.

import { iso } from "../market/format.ts";
import { type Instrument, readInstrument } from "../market/instruments.ts";
import { trackedInstruments } from "../market/tracking.ts";
import { localDate } from "../market/zone.ts";
import {
  type EventStatus,
  eventStatus,
  readEvents,
} from "../sources/finnhub/read.ts";
import {
  eligible,
  NO_DATA,
  NO_EVENTS,
  NOT_COVERED,
} from "../sources/finnhub/store.ts";
import { FINNHUB as SOURCE } from "../sources/ids.ts";
import { failedRun, lastStarted } from "../storage/runs.ts";
import {
  cursor,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, optionalText, symbols } from "./args.ts";
import type { Markets } from "./markets.ts";
import { eventItem, researchTargets } from "./research.ts";
import { distinct, type Resolved } from "./sets.ts";
import { RETRY } from "./targets.ts";

export const MAX_EVENT_SYMBOLS = 100;

export type EventsArgs = {
  from: string;
  to: string;
  symbols: string[] | null;
  next: string | null;
};

export function parseEvents(input: unknown): EventsArgs {
  const f = fields(input, ["from", "to", "symbols", "next"]);
  const from = date(f.from, "from");
  const to = date(f.to, "to");
  if (from === null) throw new ArgError("from must be a date, YYYY-MM-DD");
  if (to === null) throw new ArgError("to must be a date, YYYY-MM-DD");
  if (from > to) throw new ArgError("from is after to");
  return {
    from,
    to,
    symbols:
      f.symbols === undefined || f.symbols === null
        ? null
        : symbols(f.symbols, "symbols", MAX_EVENT_SYMBOLS),
    next: optionalText(f.next, "next", 300),
  };
}

type Note = { input: string; id?: string; error?: string; message: string };

// the unavailable list's share of a page; past it, the rest are counted
export const UNAVAILABLE_BYTES = 8 * 1024;

// its own share, so neither list crowds out the other
export const NO_EVENT_BYTES = UNAVAILABLE_BYTES;

export function capNotes<T>(
  notes: readonly T[],
  share: number,
): { listed: T[]; more: number } {
  const listed: T[] = [];
  let bytes = 0;
  for (const n of notes) {
    bytes += Buffer.byteLength(JSON.stringify(n)) + 1;
    if (bytes > share) break;
    listed.push(n);
  }
  return { listed, more: notes.length - listed.length };
}

type Nearest = { date: string; hour: string; status: EventStatus } | null;

// so a share with nothing in the range is never read as missing data
function nearest(m: Markets, i: Instrument, from: string, to: string) {
  const today = localDate(i.zone, m.clock.now());
  const one = (sql: string, date: string): Nearest => {
    const e = m.db
      .query<
        { date: string; hour: string; reportedSeenAt: number | null },
        [string, string]
      >(
        `select date, hour, reported_seen_at as reportedSeenAt from events
         where instrument = ? and ${sql} limit 1`,
      )
      .get(i.id, date);
    return e === null
      ? null
      : { date: e.date, hour: e.hour, status: eventStatus(e, today) };
  };
  return {
    last: one("date < ? order by date desc", from),
    next: one("date > ? order by date", to),
  };
}

// so an empty list is never read as no earnings ahead; null once data came
function noCalendar(m: Markets, input: string, i: Instrument): Note | null {
  const ok = lastStarted(m.db, SOURCE, "calendar", i.id, "ok");
  const last = lastStarted(m.db, SOURCE, "calendar", i.id);
  // a refresh that failed since: an empty range then is not "no event"
  // a run cut by shutdown is no failure: the next run settles it
  if (ok !== null && failedRun(last)) {
    return {
      input,
      id: i.id,
      error: "source_error",
      message: `calendar not refreshed: its fetch failed (${last.error}); events are from ${iso(ok.startedAt)}; ${RETRY} later`,
    };
  }
  if (ok !== null) {
    // a 403 or an empty answer; events kept from before show stale
    return ok.rows === 0 ? { input, id: i.id, message: NO_DATA } : null;
  }
  return failedRun(last)
    ? {
        input,
        id: i.id,
        error: "source_error",
        message: `no calendar yet: its fetch failed (${last.error}); ${RETRY} later`,
      }
    : {
        input,
        id: i.id,
        message: `no calendar yet: never fetched; ${RETRY} later`,
      };
}

export type EventsRead =
  | { off: true }
  | {
      off: false;
      // keyed by date, share and quarter, the order events go out in
      events: { key: string; item: object }[];
      notes: Note[];
      quiet: object[];
    };

// a null start is the range's first event
export async function readEventsOf(
  m: Markets,
  args: EventsArgs,
  start: string | null,
): Promise<EventsRead> {
  if (m.finnhub === null) return { off: true };
  let instruments: Instrument[];
  const notes: Note[] = [];
  let resolvedOnce: Resolved[] = [];
  if (args.symbols === null) {
    instruments = trackedInstruments(m.db, m.clock.now(), m.tracking).filter(
      eligible,
    );
    for (const i of instruments) {
      const note = noCalendar(m, i.id, i);
      if (note !== null) notes.push(note);
    }
  } else {
    const { targets, inline } = await researchTargets(m, args.symbols, {
      sections: ["calendar"],
    });
    const { resolved, errors } = distinct(targets);
    resolvedOnce = resolved;
    for (const e of errors) notes.push(e);
    instruments = [];
    for (const r of resolved) {
      const state = inline.get(r.instrument.id);
      if (state?.kind === "not covered") {
        notes.push({
          input: r.input,
          id: r.instrument.id,
          message: NOT_COVERED,
        });
        continue;
      }
      const note = noCalendar(m, r.input, r.instrument);
      // a failed run says more than the call's error; a timeout leaves none
      if (state?.kind === "failed" && note?.error === undefined) {
        notes.push({ input: r.input, id: r.instrument.id, ...state.error });
      } else if (note !== null) notes.push(note);
      instruments.push(r.instrument);
    }
  }
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const rows = readEvents(m.db, args.from, args.to, [...byId.keys()]);
  const key = (r: (typeof rows)[number]) =>
    `${r.date}|${r.instrument}|${r.fiscalYear}|${r.fiscalQuarter}`;
  const events = rows
    .filter((r) => start === null || key(r) >= start)
    .map((r) => ({
      key: key(r),
      item: eventItem(
        m,
        byId.get(r.instrument) ?? readInstrument(m.db, r.instrument)!,
        r,
      ),
    }));
  // every tracked share would list here, most with nothing in a short range
  const quiet: object[] = [];
  if (start === null && args.symbols !== null) {
    const noted = new Set(notes.map((n) => n.id));
    const dated = new Set(rows.map((r) => r.instrument));
    for (const r of resolvedOnce) {
      const id = r.instrument.id;
      if (noted.has(id) || dated.has(id) || !byId.has(id)) continue;
      quiet.push({
        input: r.input,
        id,
        ...nearest(m, r.instrument, args.from, args.to),
      });
    }
  }
  return { off: false, events, notes, quiet };
}

export async function eventsAnswer(
  m: Markets,
  args: EventsArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  let start: string | null = null;
  if (next !== null) {
    start = readCursor(next, asked);
    if (start === null) {
      throw new ArgError("next does not continue these arguments");
    }
  }
  const read = await readEventsOf(m, args, start);
  if (read.off) {
    return textResult(
      JSON.stringify({
        from: args.from,
        to: args.to,
        message: NO_EVENTS,
        next: null,
        events: [],
      }),
    );
  }
  const { events: items, notes, quiet } = read;
  const { listed, more } = capNotes(notes, UNAVAILABLE_BYTES);
  const none = capNotes(quiet, NO_EVENT_BYTES);
  const page = fitPage(
    items.map((x) => x.item),
    (count) => ({
      from: args.from,
      to: args.to,
      source: "finnhub",
      ...(start === null && notes.length > 0 ? { unavailable: listed } : {}),
      ...(start === null && more > 0 ? { unavailable_more: more } : {}),
      ...(quiet.length > 0 ? { no_event: none.listed } : {}),
      ...(none.more > 0 ? { no_event_more: none.more } : {}),
      next: count < items.length ? cursor(items[count]!.key, asked) : null,
    }),
    "events",
  );
  return textResult(page.text);
}
