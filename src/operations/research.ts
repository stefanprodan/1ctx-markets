// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { iso, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { dateOfWall, localDate, wallOfDate } from "../market/zone.ts";
import { DAY_MS } from "../runtime/clock.ts";
import {
  type EventRow,
  eventStatus,
  kindColumns,
  nextEvent,
  type ResearchKind,
  type ResearchRow,
  readResearch,
  sectionState,
} from "../sources/finnhub/read.ts";
import {
  eligible,
  NO_DATA,
  NOT_COVERED,
  OTHER_LISTING,
  SECTIONS,
  type Section,
} from "../sources/finnhub/store.ts";
import { refreshResearch, unfetched } from "../sources/finnhub/sync.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { cut } from "../sources/massive/client.ts";
import {
  countNews,
  KEPT_MS,
  NEWS_NOT_COVERED,
  type NewsRow,
  NO_NEWS,
  newsAsked,
  eligible as newsEligible,
  newsState,
  readNews,
  refreshNews,
  topNews,
} from "../sources/massive/store.ts";
import { ArgError, date, fields, symbols } from "./args.ts";
import { type Markets, shared } from "./markets.ts";
import { briefItem, quoteItem, readLatest } from "./quote.ts";
import {
  type ItemError,
  itemError,
  readTargets,
  type Target,
  timeout,
} from "./targets.ts";

export const HEADLINES = 5;
// rows a news page reads before fitting them under 32 KiB
export const NEWS_PAGE_ROWS = 50;
// the span a daily reader needs, when since is left out
export const WEEK_MS = 7 * DAY_MS;
// counts give the balance, a few items the reasons
export const WEEK_ITEMS = 3;
// a budget that keeps five shares short, not a display width
export const WEEK_TITLE = 160;
export const WEEK_PUBLISHER = 60;
export const WEEK_REASONING = 280;
export const WEEK_URL = 300;
// since goes back only as far as news is kept
export const SINCE_DAYS = KEPT_MS / DAY_MS;
export const KINDS: Record<"analysts" | "earnings" | "insiders", ResearchKind> =
  {
    analysts: "analysts",
    earnings: "earnings",
    insiders: "insider",
  };

export const SECTION_OF: Record<ResearchKind, Section> = {
  analysts: "analysts",
  earnings: "earnings",
  insider: "insider",
  metric: "metric",
};

// five never-fetched shares cost 25 of the free key's 60 calls a minute
export const MAX_RESEARCH_SYMBOLS = 5;

// fixed so five summaries stay short; the reasons are in docs/api.md
export const HTTP_HISTORY = { analysts: 2, earnings: 4, insider: 3 } as const;
type HistoryKind = keyof typeof HTTP_HISTORY;

export type Inline =
  | { kind: "off" }
  | { kind: "not covered" }
  | { kind: "stored" }
  | { kind: "failed"; error: ItemError };

const EXPIRED = Symbol("expired");

// The next call finishes a pass cut short; its sections land in one write,
// and a passed deadline stores none.
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

// a share's own rows carry neither field
export const listingFields = (listing: string | null) =>
  listing === null ? {} : { listing, note: OTHER_LISTING };

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

export const rowItem = (kind: ResearchKind, r: ResearchRow) => ({
  period: r.period,
  ...valuesOf(kind, r),
  fetched_at: iso(r.fetchedAt),
});

function latestSection(
  m: Markets,
  instrument: Instrument,
  kind: ResearchKind,
  history = 0,
) {
  const state = sectionState(
    m.db,
    instrument.id,
    SECTION_OF[kind],
    m.clock.now(),
  );
  const rows = readResearch(m.db, instrument.id, kind, Math.max(history, 1));
  // a fetch replaces the kind's rows, so the section's listing is its rows'
  const past =
    history > 0 ? { history: rows.map((r) => rowItem(kind, r)) } : {};
  const row = rows[0];
  if (row === undefined) {
    return {
      period: null,
      fetched_at: iso(state.fetchedAt),
      stale: state.stale,
      ...(state.noData ? { message: NO_DATA } : {}),
      ...past,
    };
  }
  return {
    period: row.period,
    fetched_at: iso(row.fetchedAt),
    stale: state.stale,
    ...listingFields(row.listing),
    ...valuesOf(kind, row),
    ...past,
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
    ...listingFields(e.listing),
  };
}

export const messageOf = (inline: Inline | undefined): string | null =>
  inline?.kind === "off"
    ? NO_DATA
    : inline?.kind === "not covered"
      ? NOT_COVERED
      : null;

export function researchSummary(
  m: Markets,
  instrument: Instrument,
  inline: Inline | undefined,
  history: Partial<Record<HistoryKind, number>> = {},
) {
  const message = messageOf(inline);
  if (message !== null) return { source: "finnhub", message };
  const event = nextEvent(m.db, instrument, m.clock.now());
  const section = (kind: HistoryKind) =>
    latestSection(m, instrument, kind, history[kind]);
  return {
    source: "finnhub",
    ...(inline?.kind === "failed" ? inline.error : {}),
    metric: latestSection(m, instrument, "metric"),
    analysts: section("analysts"),
    earnings: section("earnings"),
    insider: section("insider"),
    next_event: event === null ? null : eventItem(m, instrument, event),
  };
}

export const newsMessage = (n: Inline | undefined): string | null =>
  n?.kind === "off"
    ? NO_NEWS
    : n?.kind === "not covered"
      ? NEWS_NOT_COVERED
      : null;

export const newsItem = (r: NewsRow) => ({
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

// No fetch: a share never walked answers counts of 0 and why it is stale.
export function newsWeek(
  m: Markets,
  instrument: Instrument,
  since = m.clock.now() - WEEK_MS,
) {
  const message =
    m.massive === null
      ? NO_NEWS
      : newsEligible(instrument)
        ? null
        : NEWS_NOT_COVERED;
  if (message !== null) return { source: "massive", message };
  const now = m.clock.now();
  const state = newsState(m.db, instrument.id, now);
  return {
    source: "massive",
    since: iso(since),
    fetched_at: iso(state.fetchedAt),
    stale: state.stale,
    counts: countNews(m.db, instrument.id, now, since),
    items: topNews(m.db, instrument.id, now, since, WEEK_ITEMS).map(weekItem),
  };
}

const capped = (v: string | null, max: number) =>
  v === null ? null : cut(v, max);

function weekItem(r: NewsRow) {
  const title = cut(r.title, WEEK_TITLE);
  const publisher = capped(r.publisher, WEEK_PUBLISHER);
  const reasoning = capped(r.reasoning, WEEK_REASONING);
  // a URL cut is a broken link, so a long one is left out
  const url = r.url.length > WEEK_URL ? null : r.url;
  return {
    published_at: iso(r.publishedAt),
    publisher,
    sentiment: r.sentiment,
    title,
    reasoning,
    url,
    truncated:
      r.truncated ||
      title !== r.title ||
      publisher !== r.publisher ||
      reasoning !== r.reasoning ||
      url === null,
  };
}

export const RESEARCH_PARTS = [
  "metric",
  "analysts",
  "earnings",
  "insider",
  "next_event",
  "news",
] as const;
export type ResearchPart = (typeof RESEARCH_PARTS)[number];

type FinnhubPart = Exclude<ResearchPart, "news">;

const SECTION_OF_PART: Record<FinnhubPart, Section> = {
  metric: "metric",
  analysts: "analysts",
  earnings: "earnings",
  insider: "insider",
  next_event: "calendar",
};

export type ResearchListArgs = {
  symbols: string[];
  parts: ResearchPart[];
  since: string | null;
};

export function parseResearchList(input: unknown): ResearchListArgs {
  const f = fields(input, ["symbols", "sections", "since"]);
  const list = symbols(f.symbols, "symbols", MAX_RESEARCH_SYMBOLS);
  let parts: ResearchPart[] = [...RESEARCH_PARTS];
  if (f.sections !== undefined && f.sections !== null) {
    const asked = f.sections;
    if (
      !Array.isArray(asked) ||
      asked.length === 0 ||
      !asked.every((v) => (RESEARCH_PARTS as readonly unknown[]).includes(v))
    ) {
      throw new ArgError(`sections is a list of ${RESEARCH_PARTS.join(", ")}`);
    }
    parts = RESEARCH_PARTS.filter((p) => asked.includes(p));
  }
  const since = date(f.since, "since");
  if (since !== null && !parts.includes("news")) {
    throw new ArgError("since is for the news section only");
  }
  return { symbols: list, parts, since };
}

// fetches the Finnhub sections asked that never ended well, but never news
export async function researchList(m: Markets, args: ResearchListArgs) {
  let since = m.clock.now() - WEEK_MS;
  if (args.since !== null) {
    // a UTC date, as published times are
    const earliest = dateOfWall(m.clock.now() - KEPT_MS);
    if (args.since < earliest) {
      throw new ArgError(
        `since must be at most ${SINCE_DAYS} days back, ${earliest} or later`,
      );
    }
    since = wallOfDate(args.since);
  }
  const finnhub = args.parts.filter((p): p is FinnhubPart => p !== "news");
  const left = (Object.keys(SECTION_OF_PART) as FinnhubPart[]).filter(
    (p) => !finnhub.includes(p),
  );
  const { targets, inline } = await researchTargets(m, args.symbols, {
    sections: finnhub.map((p) => SECTION_OF_PART[p]),
  });
  const now = m.clock.now();
  const items = targets.map((t) => {
    if ("error" in t) return { input: t.input, ...t.error };
    const latest = readLatest(m.db, t.instrument, now, m.quoteEveryMs);
    const item = quoteItem(m.db, t.input, t.instrument, latest);
    const quote = briefItem(m.db, item, latest);
    const research: Record<string, unknown> = researchSummary(
      m,
      t.instrument,
      inline.get(t.instrument.id),
      HTTP_HISTORY,
    );
    for (const p of left) delete research[p];
    return {
      ...quote,
      ...(finnhub.length > 0 ? { research } : {}),
      ...(args.parts.includes("news")
        ? { news: newsWeek(m, t.instrument, since) }
        : {}),
    };
  });
  // once per answer that holds a FRED value
  const fred = items.some((i) => "observation" in i && i.observation);
  return { ...(fred ? { attribution: ATTRIBUTION } : {}), items };
}
