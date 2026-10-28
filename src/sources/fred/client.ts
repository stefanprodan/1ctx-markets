// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// FRED takes its key only in the URL, so no error or text made here carries one

import { wallOfDate } from "../../market/zone.ts";
import type { Clock } from "../../runtime/clock.ts";
import { MINUTE_MS } from "../../runtime/clock.ts";
import { FRED } from "../ids.ts";
import {
  type Backoff,
  DeadlinePassed,
  type Fetch,
  type Queue,
  QueueClosed,
  queue,
  type RunOptions,
  SourceError,
  scrub,
  Unreadable,
} from "../source.ts";

export { scrub };

export const SOURCE = FRED;
export const HOST = "https://api.stlouisfed.org/fred";
const CONCURRENCY = 1;
const TIMEOUT_MS = 30_000;
// half of the 120 a minute FRED allows
export const CALLS_PER_MINUTE = 60;

export type SeriesMeta = {
  id: string;
  title: string;
  // the long form, e.g. "Percent", "Index", "Dollars per Barrel"
  units: string;
  unitsShort: string;
  frequencyShort: string;
  notes: string | null;
  // UTC epoch ms, null when FRED's form is not readable
  lastUpdated: number | null;
  // the notes forbid passing the values on: served to own callers only
  restricted: boolean;
};

export type Observation = { date: string; value: number };

export type Observations = {
  // ascending by date, without the days FRED writes as "."
  observations: Observation[];
  // every date answered, "." days included, which bounds what an
  // answer can drop
  dates: string[];
  fetchedAt: number;
};

export type ObservationRange =
  // limit: the latest n, newest first on the wire; start: from that date on
  { limit: number } | { start: string };

export type Fred = {
  series(id: string): Promise<SeriesMeta>;
  observations(id: string, range: ObservationRange): Promise<Observations>;
  failFast(): Fred;
  within(live: () => boolean): Fred;
  backoff(): Backoff | null;
  close(): void;
};

export type FredOptions = {
  clock: Clock;
  key: string;
  fetch?: Fetch;
  host?: string;
  queue?: Queue;
};

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw malformed(`no ${what}`);
  return v;
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw malformed(`no ${what}`);
  return v.trim();
}

const optionalText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// "2026-10-23 15:16:51-05": Central time with an hour-only offset
export function parseLastUpdated(v: unknown): number | null {
  const s = optionalText(v);
  const m = s && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2})$/.exec(s);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:00`);
  return Number.isNaN(at) ? null : at;
}

// ICE's terms in the high-yield spread's notes: "internal use only",
// "Reproduction of this data in any form is prohibited"
const RESTRICTED =
  /internal use only|not (?:authorized|permitted) to (?:publish|distribute|redistribute)|reproduction of this data[^.]*prohibited/i;

function scrubbed(meta: SeriesMeta, key: string): SeriesMeta {
  const s = (v: string) => scrub(v, key);
  return {
    ...meta,
    id: s(meta.id),
    title: s(meta.title),
    units: s(meta.units),
    unitsShort: s(meta.unitsShort),
    frequencyShort: s(meta.frequencyShort),
    notes: meta.notes === null ? null : s(meta.notes),
  };
}

export function parseSeries(body: unknown): SeriesMeta {
  const list = obj(body, "body").seriess;
  if (!Array.isArray(list) || list.length !== 1) {
    throw malformed("not one series");
  }
  const s = obj(list[0], "series");
  const notes = optionalText(s.notes);
  return {
    id: text(s.id, "series id"),
    title: text(s.title, "title"),
    units: text(s.units, "units"),
    unitsShort: text(s.units_short, "short units"),
    frequencyShort: text(s.frequency_short, "frequency"),
    notes,
    lastUpdated: parseLastUpdated(s.last_updated),
    restricted: notes !== null && RESTRICTED.test(notes),
  };
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function wholeNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw malformed(`no ${what}`);
  }
  return v;
}

// exactly the envelope's rows on one page, or stored bars are rewritten
export function parseObservations(
  body: unknown,
  fetchedAt: number,
  whole = false,
): Observations {
  const envelope = obj(body, "body");
  const list = envelope.observations;
  if (!Array.isArray(list)) throw malformed("no observations");
  const count = wholeNumber(envelope.count, "count");
  const offset = wholeNumber(envelope.offset, "offset");
  const limit = wholeNumber(envelope.limit, "limit");
  // no offset is ever asked for
  if (offset !== 0) throw malformed("a page past the first");
  if (list.length !== Math.min(count, limit)) {
    throw malformed("observations do not match the count");
  }
  if (whole && count > list.length) throw malformed("a history cut short");
  const byDate = new Map<string, number | null>();
  for (const entry of list) {
    const o = obj(entry, "observation");
    const date = text(o.date, "observation date");
    try {
      wallOfDate(date);
    } catch {
      throw malformed("observation date");
    }
    if (byDate.has(date)) throw malformed("a date answered twice");
    // untrimmed: a plain decimal has no spaces around it
    const raw = o.value;
    if (typeof raw !== "string") throw malformed("observation value");
    // a day with no observation, never a zero
    if (raw === ".") {
      byDate.set(date, null);
      continue;
    }
    // Number() would read "0x10" as 16 and "" as 0
    if (!DECIMAL.test(raw)) throw malformed("observation value");
    const value = Number(raw);
    if (!Number.isFinite(value)) throw malformed("observation value");
    byDate.set(date, value);
  }
  const dates = [...byDate.keys()].sort();
  return {
    observations: dates.flatMap((date) => {
      const value = byDate.get(date);
      return value === null || value === undefined ? [] : [{ date, value }];
    }),
    dates,
    fetchedAt,
  };
}

// FRED answers 400 for both an unknown series and a refused key, told
// apart only by its message, which is never repeated
function refusal(body: unknown): SourceError {
  const message = isObj(body) ? optionalText(body.error_message) : null;
  if (message !== null && /api_key/i.test(message)) {
    return new SourceError("key refused");
  }
  if (message !== null && /series does not exist/i.test(message)) {
    return new SourceError("not found");
  }
  return new SourceError("bad request");
}

export function fred(options: FredOptions): Fred {
  const { clock, key } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = options.queue ?? queue(clock, CONCURRENCY);
  // start times of the calls in the last minute
  const started: number[] = [];
  let closed = false;
  const waits = new Set<{ cancel: () => void; reject: (e: unknown) => void }>();

  // waits, holding the queue's slot, until a call fits the minute
  const slot = async (): Promise<void> => {
    for (;;) {
      if (closed) throw new QueueClosed();
      const now = clock.now();
      while (started.length > 0 && started[0]! <= now - MINUTE_MS) {
        started.shift();
      }
      if (started.length < CALLS_PER_MINUTE) {
        started.push(now);
        return;
      }
      const until = started[0]! + MINUTE_MS;
      await new Promise<void>((resolve, reject) => {
        const wait = {
          cancel: () => {},
          reject,
        };
        wait.cancel = clock.at(until, () => {
          waits.delete(wait);
          resolve();
        });
        waits.add(wait);
      });
    }
  };

  const get = <T>(
    path: string,
    params: Record<string, string>,
    run: RunOptions,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> =>
    calls.run(async () => {
      await slot();
      // closed, or past the caller's deadline, while it waited
      if (closed) throw new QueueClosed();
      if (run.live !== undefined && !run.live()) throw new DeadlinePassed();
      const query = new URLSearchParams({
        ...params,
        api_key: key,
        file_type: "json",
      });
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(`${host}/${path}?${query}`, {
            headers: { Accept: "application/json" },
            signal: abort.signal,
          });
          raw = await res.text();
        } catch {
          // a fetch error can quote the URL, and with it the key
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
        if (res.status === 429) throw new SourceError("rate limited");
        if (res.status === 400) throw refusal(body);
        if (res.status === 404) throw new SourceError("not found");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        if (body === undefined) throw new Unreadable();
        return parse(body, fetchedAt);
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Fred => ({
    series: (id) =>
      get("series", { series_id: id }, run, (body) =>
        scrubbed(parseSeries(body), key),
      ),
    observations(id, range) {
      const params: Record<string, string> =
        "limit" in range
          ? {
              series_id: id,
              sort_order: "desc",
              limit: String(range.limit),
            }
          : { series_id: id, observation_start: range.start };
      return get("series/observations", params, run, (body, at) =>
        parseObservations(body, at, "start" in range),
      );
    },
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    backoff: () => calls.backoff(),
    close() {
      closed = true;
      calls.close();
      for (const wait of waits) {
        wait.cancel();
        wait.reject(new QueueClosed());
      }
      waits.clear();
    },
  });
  return client({});
}
