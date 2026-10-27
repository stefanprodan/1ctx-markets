// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Earnings events between two dates, of the tracked shares or the ones
// named, each scheduled, awaiting results or reported. Only actuals
// report an event; its date or an after-close label never do.

import { SOURCE } from "../finnhub/client.ts";
import {
  type EventStatus,
  eligible,
  eventStatus,
  NO_DATA,
  NO_EVENTS,
  NOT_COVERED,
  readEvents,
} from "../finnhub/store.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { lastStarted } from "../runs.ts";
import { trackedInstruments } from "../tracking.ts";
import { localDate } from "../zone.ts";
import {
  cursor,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, optionalText, symbols } from "./args.ts";
import { eventItem, researchTargets } from "./research.ts";
import { distinct, type Resolved } from "./sets.ts";
import { type Markets, RETRY } from "./targets.ts";

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

// the no_event list's share, so neither list crowds out the other
export const NO_EVENT_BYTES = UNAVAILABLE_BYTES;

// the notes that fit the share, in order, and how many were left out
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

// The stored events either side of the range, so a share with nothing
// in it is never read as missing data.
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

// why a share has no calendar, so an empty list is never read as no
// earnings ahead; null once its last good fetch had data
function noCalendar(m: Markets, input: string, i: Instrument): Note | null {
  const ok = lastStarted(m.db, SOURCE, "calendar", i.id, "ok");
  if (ok !== null) {
    // a 403 or an empty answer; events kept from before show stale
    return ok.rows === 0 ? { input, id: i.id, message: NO_DATA } : null;
  }
  const last = lastStarted(m.db, SOURCE, "calendar", i.id);
  return last?.status === "failed"
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
  if (m.finnhub === null) {
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
  let instruments: Instrument[];
  const notes: Note[] = [];
  let resolvedOnce: Resolved[] = [];
  if (args.symbols === null) {
    instruments = trackedInstruments(m.db, m.clock.now(), m.trackMs).filter(
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
      if (state?.kind === "failed") {
        notes.push({ input: r.input, id: r.instrument.id, ...state.error });
      } else {
        const note = noCalendar(m, r.input, r.instrument);
        if (note !== null) notes.push(note);
      }
      instruments.push(r.instrument);
    }
  }
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const rows = readEvents(m.db, args.from, args.to, [...byId.keys()]);
  const key = (r: (typeof rows)[number]) =>
    `${r.date}|${r.instrument}|${r.fiscalYear}|${r.fiscalQuarter}`;
  const items = rows
    .filter((r) => start === null || key(r) >= start)
    .map((r) => ({
      key: key(r),
      item: eventItem(
        m,
        byId.get(r.instrument) ?? readInstrument(m.db, r.instrument)!,
        r,
      ),
    }));
  const { listed, more } = capNotes(notes, UNAVAILABLE_BYTES);
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
