// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One share's research: the live quote and latest signals beside
// Finnhub's metrics, analyst counts, earnings surprises, insider months
// and next earnings event, each with its period, fetch time and
// staleness. A share Finnhub covers with no research yet is fetched
// inside the call. GET /research answers the same summaries for scripts.

import {
  type EventRow,
  eligible,
  eventStatus,
  hasResearch,
  kindColumns,
  NO_DATA,
  NOT_COVERED,
  nextEvent,
  type ResearchKind,
  readResearch,
  refreshResearch,
  SECTIONS,
  type Section,
  sectionState,
} from "../finnhub/store.ts";
import type { Instrument } from "../instruments.ts";
import { errorFields } from "../log.ts";
import { localDate } from "../zone.ts";
import {
  cursor,
  errorResult,
  fitPage,
  iso,
  PageOverflow,
  readCursor,
  round,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, fields, oneOf, optionalText, quoted, text } from "./args.ts";
import { briefItem, quoteItem, readLatest } from "./quote.ts";
import {
  type ItemError,
  itemError,
  type Markets,
  readTargets,
  shared,
  type Target,
  timeout,
} from "./targets.ts";

// news is read from Massive, which is not served yet
export const NEWS_PENDING = "news comes from Massive";

export const RESEARCH_SECTIONS = [
  "overview",
  "analysts",
  "earnings",
  "insiders",
  "news",
] as const;
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number];

// the tool's section names to the stored kinds
const KINDS: Record<"analysts" | "earnings" | "insiders", ResearchKind> = {
  analysts: "analysts",
  earnings: "earnings",
  insiders: "insider",
};

const SECTION_OF: Record<ResearchKind, Section> = {
  analysts: "analysts",
  earnings: "earnings",
  insider: "insider",
  metric: "metric",
};

// GET /research names at most this many symbols
export const MAX_RESEARCH_SYMBOLS = 5;

// The instrument's research before the answer: off, not covered, a
// share fetched inside the call, or one not done by the deadline.
export type Inline =
  | { kind: "off" }
  | { kind: "not covered" }
  | { kind: "stored" }
  | { kind: "failed"; error: ItemError };

const EXPIRED = Symbol("expired");

// Each resolved share Finnhub covers and has never answered for is
// fetched inside the same deadline as its resolution: five calls, all
// stored together or none. Two calls naming it share one fetch.
export async function researchTargets(
  m: Markets,
  inputs: readonly string[],
): Promise<{ targets: Target[]; inline: Map<string, Inline> }> {
  const deadline = m.clock.now() + m.callMs;
  const targets = await readTargets(m, inputs);
  const inline = new Map<string, Inline>();
  const work: Promise<void>[] = [];
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  for (const t of targets) {
    if (!("instrument" in t) || inline.has(t.instrument.id)) continue;
    const instrument = t.instrument;
    const client = m.finnhub;
    if (client === null) {
      inline.set(instrument.id, { kind: "off" });
      continue;
    }
    if (!eligible(instrument)) {
      inline.set(instrument.id, { kind: "not covered" });
      continue;
    }
    inline.set(instrument.id, { kind: "stored" });
    if (hasResearch(m.db, instrument.id)) continue;
    if (m.clock.now() >= deadline) {
      inline.set(instrument.id, { kind: "failed", error: timeout(m) });
      continue;
    }
    const fetch = shared(m, `research:${instrument.id}`, deadline, (live) =>
      refreshResearch(
        { db: m.db, clock: m.clock, writer: m.writer, finnhub: client },
        instrument,
        SECTIONS,
        { live, hooks: m.hooks, client: client.within(live) },
      ),
    );
    work.push(
      Promise.race([fetch, expired]).then(
        (done) => {
          if (done === EXPIRED) {
            inline.set(instrument.id, { kind: "failed", error: timeout(m) });
          }
        },
        (error: unknown) => {
          inline.set(instrument.id, {
            kind: "failed",
            error: itemError(m, error),
          });
        },
      ),
    );
  }
  try {
    await Promise.all(work);
  } finally {
    cancel();
  }
  return { targets, inline };
}

type Values = Record<string, number | string | null>;

const valuesOf = (kind: ResearchKind, row: Values): Values => {
  const out: Values = {};
  for (const c of kindColumns(kind)) {
    // insider_change is the column; the answer says change
    out[c === "insider_change" ? "change" : c] = round(
      (row[c] as number | null) ?? null,
    );
  }
  return out;
};

// One section's latest row with its period, fetch time and stale
// reasons; with no row, why there is none.
function latestSection(m: Markets, instrument: Instrument, kind: ResearchKind) {
  const state = sectionState(
    m.db,
    instrument.id,
    SECTION_OF[kind],
    m.clock.now(),
  );
  const [row] = readResearch(m.db, instrument.id, kind, 1);
  if (row === undefined) {
    return {
      period: null,
      fetched_at: iso(state.fetchedAt),
      stale: state.stale,
      ...(state.noData ? { message: NO_DATA } : {}),
    };
  }
  return {
    period: row.period,
    fetched_at: iso(row.fetchedAt),
    stale: state.stale,
    ...valuesOf(kind, row),
  };
}

export function eventItem(m: Markets, instrument: Instrument, e: EventRow) {
  const state = sectionState(m.db, instrument.id, "calendar", m.clock.now());
  return {
    id: instrument.id,
    name: instrument.name,
    fiscal_year: e.fiscalYear,
    fiscal_quarter: e.fiscalQuarter,
    date: e.date,
    hour: e.hour,
    status: eventStatus(e, localDate(instrument.zone, m.clock.now())),
    currency: instrument.currency,
    eps_estimate: round(e.epsEstimate),
    eps_actual: round(e.epsActual),
    revenue_estimate: e.revenueEstimate,
    revenue_actual: e.revenueActual,
    reported_seen_at: iso(e.reportedSeenAt),
    fetched_at: iso(e.fetchedAt),
    stale: state.stale,
  };
}

const messageOf = (inline: Inline | undefined): string | null =>
  inline?.kind === "off"
    ? NO_DATA
    : inline?.kind === "not covered"
      ? NOT_COVERED
      : null;

// Finnhub's part of an answer: each section's latest, or one message
// when Finnhub is off, does not cover the share or was not done in time.
export function researchSummary(
  m: Markets,
  instrument: Instrument,
  inline: Inline | undefined,
) {
  const message = messageOf(inline);
  if (message !== null) return { source: "finnhub", message };
  const event = nextEvent(m.db, instrument, m.clock.now());
  return {
    source: "finnhub",
    ...(inline?.kind === "failed" ? inline.error : {}),
    metric: latestSection(m, instrument, "metric"),
    analysts: latestSection(m, instrument, "analysts"),
    earnings: latestSection(m, instrument, "earnings"),
    insider: latestSection(m, instrument, "insider"),
    next_event: event === null ? null : eventItem(m, instrument, event),
  };
}

export type ResearchArgs = {
  symbol: string;
  section: ResearchSection;
  next: string | null;
};

export function parseResearch(input: unknown): ResearchArgs {
  const f = fields(input, ["symbol", "section", "next"]);
  return {
    symbol: text(f.symbol, "symbol"),
    section: oneOf(f.section, "section", RESEARCH_SECTIONS, "overview"),
    next: optionalText(f.next, "next", 200),
  };
}

export async function researchAnswer(
  m: Markets,
  args: ResearchArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  let start: string | null = null;
  if (next !== null) {
    if (args.section === "overview" || args.section === "news") {
      throw new ArgError(`${args.section} has no next page`);
    }
    start = readCursor(next, asked);
    if (start === null) {
      throw new ArgError("next does not continue these arguments");
    }
  }
  const { targets, inline } = await researchTargets(m, [args.symbol]);
  const target = targets[0]!;
  if ("error" in target) {
    return errorResult({ input: target.input, ...target.error });
  }
  const instrument = target.instrument;
  const head = {
    id: instrument.id,
    name: instrument.name,
    type: instrument.type,
    currency: instrument.currency,
    section: args.section,
  };
  if (args.section === "overview") {
    const latest = readLatest(m.db, instrument, m.clock.now(), m.quoteEveryMs);
    const { input: _, ...quote } = quoteItem(
      m.db,
      target.input,
      instrument,
      latest,
    );
    return textResult(
      JSON.stringify({
        ...head,
        quote,
        research: researchSummary(m, instrument, inline.get(instrument.id)),
        news: { message: NEWS_PENDING },
      }),
    );
  }
  if (args.section === "news") {
    return textResult(JSON.stringify({ ...head, message: NEWS_PENDING }));
  }
  const kind = KINDS[args.section];
  const own = inline.get(instrument.id);
  const message = messageOf(own);
  const state = sectionState(
    m.db,
    instrument.id,
    SECTION_OF[kind],
    m.clock.now(),
  );
  const rows =
    message === null
      ? readResearch(m.db, instrument.id, kind).filter(
          (r) => start === null || r.period <= start,
        )
      : [];
  const items = rows.map((r) => ({
    period: r.period,
    ...valuesOf(kind, r),
    fetched_at: iso(r.fetchedAt),
  }));
  const page = fitPage(
    items,
    (count) => ({
      ...head,
      source: "finnhub",
      ...(message !== null
        ? { message }
        : {
            ...(own?.kind === "failed" ? own.error : {}),
            ...(items.length === 0 && state.noData ? { message: NO_DATA } : {}),
            fetched_at: iso(state.fetchedAt),
            stale: state.stale,
          }),
      next: count < items.length ? cursor(items[count]!.period, asked) : null,
    }),
    "rows",
  );
  return textResult(page.text);
}

const json = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const failed = (status: number, error: string, message: string) =>
  json(JSON.stringify({ error, message }), status);

// GET /research?symbols=a,b: at most five summaries, the quote's brief
// projection beside Finnhub's part, under the same deadline and
// tracking as the research tool.
export function researchHandler(
  m: Markets,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const params = new URL(req.url).searchParams;
    try {
      for (const name of params.keys()) {
        if (name !== "symbols") {
          throw new ArgError(`unknown argument ${quoted(name)}`);
        }
      }
      if (params.getAll("symbols").length !== 1) {
        throw new ArgError("symbols must be given once, comma-separated");
      }
      const list = params.get("symbols")!.split(",");
      if (list.length > MAX_RESEARCH_SYMBOLS) {
        throw new ArgError(
          `symbols must be a list of 1 to ${MAX_RESEARCH_SYMBOLS} symbols`,
        );
      }
      const symbols = list.map((v, k) => text(v, `symbols[${k}]`));
      const { targets, inline } = await researchTargets(m, symbols);
      const now = m.clock.now();
      const items = targets.map((t) => {
        if ("error" in t) return { input: t.input, ...t.error };
        const latest = readLatest(m.db, t.instrument, now, m.quoteEveryMs);
        const quote = briefItem(quoteItem(m.db, t.input, t.instrument, latest));
        return {
          ...quote,
          research: researchSummary(
            m,
            t.instrument,
            inline.get(t.instrument.id),
          ),
        };
      });
      const page = fitPage(items, () => ({}));
      // five summaries fit a page by far; none is ever dropped in silence
      if (page.count < items.length) throw new PageOverflow();
      return json(page.text, 200);
    } catch (error) {
      if (error instanceof ArgError) {
        return failed(400, "bad_arguments", error.message);
      }
      m.log.error("research failed", errorFields(error));
      return failed(500, "internal", "internal error");
    }
  };
}
