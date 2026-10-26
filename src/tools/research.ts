// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  type EventRow,
  eligible,
  eventStatus,
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
  unfetched,
} from "../finnhub/store.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import type { Instrument } from "../instruments.ts";
import { errorFields } from "../log.ts";
import {
  NEWS_NOT_COVERED,
  type NewsCursor,
  type NewsRow,
  NO_NEWS,
  newsAsked,
  eligible as newsEligible,
  newsState,
  readNews,
  refreshNews,
} from "../massive/store.ts";
import { localDate } from "../zone.ts";
import {
  cursor,
  errorResult,
  fitPage,
  fits,
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

// headlines the overview shows
export const HEADLINES = 5;
// rows a news page reads before fitting them under 32 KiB
const NEWS_PAGE_ROWS = 50;

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

export type Inline =
  | { kind: "off" }
  | { kind: "not covered" }
  | { kind: "stored" }
  | { kind: "failed"; error: ItemError };

const EXPIRED = Symbol("expired");

// Finnhub sections each research section reads; news reads none
export const SECTIONS_OF: Record<ResearchSection, readonly Section[]> = {
  overview: SECTIONS,
  analysts: ["analysts"],
  earnings: ["earnings"],
  insiders: ["insider"],
  news: [],
};

// Each share gets the sections asked that never ended well, so a pass
// cut short is finished by the next call that needs what it left. The
// sections fetched land in one write, a passed deadline stores none;
// news gets its newest page.
export async function researchTargets(
  m: Markets,
  inputs: readonly string[],
  options: { news?: boolean; sections?: readonly Section[] } = {},
): Promise<{
  targets: Target[];
  inline: Map<string, Inline>;
  news: Map<string, Inline>;
}> {
  const deadline = m.clock.now() + m.callMs;
  const targets = await readTargets(m, inputs);
  const inline = new Map<string, Inline>();
  const news = new Map<string, Inline>();
  const work: Promise<void>[] = [];
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  // the race only answers timeout; the fetch's own live() refuses a late write
  const settle = (
    into: Map<string, Inline>,
    id: string,
    fetch: Promise<unknown>,
  ) =>
    work.push(
      Promise.race([fetch, expired]).then(
        (done) => {
          if (done === EXPIRED) {
            into.set(id, { kind: "failed", error: timeout(m) });
          }
        },
        (error: unknown) => {
          into.set(id, { kind: "failed", error: itemError(m, error) });
        },
      ),
    );
  for (const t of targets) {
    if (!options.news || !("instrument" in t) || news.has(t.instrument.id)) {
      continue;
    }
    const instrument = t.instrument;
    const client = m.massive;
    if (client === null) {
      news.set(instrument.id, { kind: "off" });
      continue;
    }
    if (!newsEligible(instrument)) {
      news.set(instrument.id, { kind: "not covered" });
      continue;
    }
    news.set(instrument.id, { kind: "stored" });
    if (newsAsked(m.db, instrument.id)) continue;
    if (m.clock.now() >= deadline) {
      news.set(instrument.id, { kind: "failed", error: timeout(m) });
      continue;
    }
    const fetch = shared(m, `news:${instrument.id}`, deadline, (live) =>
      refreshNews(
        { db: m.db, clock: m.clock, writer: m.writer, massive: client },
        instrument,
        { live, maxPages: 1, client: client.within(live) },
      ).then((r) => {
        // the walk's own failure, recorded as its run, is this answer's
        if (r.status === "failed") throw r.error;
      }),
    );
    settle(news, instrument.id, fetch);
  }
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
    const missing = unfetched(
      m.db,
      instrument.id,
      options.sections ?? SECTIONS,
    );
    if (missing.length === 0) continue;
    if (m.clock.now() >= deadline) {
      inline.set(instrument.id, { kind: "failed", error: timeout(m) });
      continue;
    }
    // keyed by the sections, so a call never waits on ones it did not ask
    const key = `research:${instrument.id}:${missing.join(",")}`;
    const fetch = shared(m, key, deadline, (live) =>
      refreshResearch(
        { db: m.db, clock: m.clock, writer: m.writer, finnhub: client },
        instrument,
        missing,
        {
          live,
          hooks: m.hooks,
          client: client.within(live),
          unfetched: true,
        },
      ),
    );
    settle(inline, instrument.id, fetch);
  }
  try {
    await Promise.all(work);
  } finally {
    cancel();
  }
  return { targets, inline, news };
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

const newsMessage = (n: Inline | undefined): string | null =>
  n?.kind === "off"
    ? NO_NEWS
    : n?.kind === "not covered"
      ? NEWS_NOT_COVERED
      : null;

const newsItem = (r: NewsRow) => ({
  published_at: iso(r.publishedAt),
  title: r.title,
  publisher: r.publisher,
  url: r.url,
  sentiment: r.sentiment,
  reasoning: r.reasoning,
  truncated: r.truncated,
});

export function newsSummary(
  m: Markets,
  instrument: Instrument,
  n: Inline | undefined,
) {
  const message = newsMessage(n);
  if (message !== null) return { source: "massive", message };
  const state = newsState(m.db, instrument.id, m.clock.now());
  return {
    source: "massive",
    ...(n?.kind === "failed" ? n.error : {}),
    fetched_at: iso(state.fetchedAt),
    stale: state.stale,
    headlines: readNews(m.db, instrument.id, m.clock.now(), HEADLINES).map(
      (r) => ({
        published_at: iso(r.publishedAt),
        title: r.title,
        publisher: r.publisher,
        sentiment: r.sentiment,
        truncated: r.truncated,
      }),
    ),
  };
}

// a news page goes on below the last article it showed
const newsPosition = (r: NewsRow): string => `${r.publishedAt}.${r.id}`;

function readNewsPosition(position: string): NewsCursor | null {
  const m = /^(\d{1,15})\.(.+)$/.exec(position);
  return m === null ? null : { publishedAt: Number(m[1]), id: m[2]! };
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
    next: optionalText(f.next, "next", 300),
  };
}

export async function researchAnswer(
  m: Markets,
  args: ResearchArgs,
): Promise<ToolResult> {
  const { next, ...asked } = args;
  let start: string | null = null;
  if (next !== null) {
    if (args.section === "overview") {
      throw new ArgError(`${args.section} has no next page`);
    }
    start = readCursor(next, asked);
    if (
      start === null ||
      (args.section === "news" && readNewsPosition(start) === null)
    ) {
      throw new ArgError("next does not continue these arguments");
    }
  }
  const withNews = args.section === "overview" || args.section === "news";
  const { targets, inline, news } = await researchTargets(m, [args.symbol], {
    news: withNews,
    sections: SECTIONS_OF[args.section],
  });
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
    const summary = newsSummary(m, instrument, news.get(instrument.id));
    const answer = () =>
      JSON.stringify({
        ...head,
        quote,
        research: researchSummary(m, instrument, inline.get(instrument.id)),
        news: summary,
        ...(quote.observation != null ? { attribution: ATTRIBUTION } : {}),
      });
    // headlines are dropped first to fit the page
    let text = answer();
    while (!fits(text) && "headlines" in summary && summary.headlines.length) {
      summary.headlines.pop();
      text = answer();
    }
    if (!fits(text)) throw new PageOverflow();
    return textResult(text);
  }
  if (args.section === "news") {
    const own = news.get(instrument.id);
    const message = newsMessage(own);
    const state = newsState(m.db, instrument.id, m.clock.now());
    const from = start === null ? null : readNewsPosition(start);
    const rows =
      message === null
        ? readNews(m.db, instrument.id, m.clock.now(), NEWS_PAGE_ROWS + 1, from)
        : [];
    const items = rows.slice(0, NEWS_PAGE_ROWS).map(newsItem);
    const page = fitPage(
      items,
      (count) => ({
        ...head,
        source: "massive",
        ...(message !== null
          ? { message }
          : {
              ...(own?.kind === "failed" ? own.error : {}),
              fetched_at: iso(state.fetchedAt),
              stale: state.stale,
            }),
        next:
          count > 0 && count < rows.length
            ? cursor(newsPosition(rows[count - 1]!), asked)
            : null,
      }),
      "articles",
    );
    return textResult(page.text);
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
      // once per answer that holds a FRED value
      const fred = items.some((i) => "observation" in i && i.observation);
      const page = fitPage(items, () =>
        fred ? { attribution: ATTRIBUTION } : {},
      );
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
