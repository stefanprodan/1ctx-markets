// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Earnings events between two dates, of the tracked shares or the ones
// named, each scheduled, awaiting results or reported. Only actuals
// report an event; its date or an after-close label never do.

import {
  eligible,
  NO_EVENTS,
  NOT_COVERED,
  readEvents,
} from "../finnhub/store.ts";
import { type Instrument, readInstrument } from "../instruments.ts";
import { trackedInstruments } from "../tracking.ts";
import {
  cursor,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, date, fields, optionalText, symbols } from "./args.ts";
import { eventItem, researchTargets } from "./research.ts";
import { distinct } from "./sets.ts";
import type { Markets } from "./targets.ts";

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
  if (args.symbols === null) {
    instruments = trackedInstruments(m.db, m.clock.now(), m.trackMs).filter(
      eligible,
    );
  } else {
    const { targets, inline } = await researchTargets(m, args.symbols);
    const { resolved, errors } = distinct(targets);
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
  const page = fitPage(
    items.map((x) => x.item),
    (count) => ({
      from: args.from,
      to: args.to,
      source: "finnhub",
      ...(start === null && notes.length > 0 ? { unavailable: notes } : {}),
      next: count < items.length ? cursor(items[count]!.key, asked) : null,
    }),
    "events",
  );
  return textResult(page.text);
}
