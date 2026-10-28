// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The research tool's page: one section of one share, paged by cursor.

import { iso } from "../market/format.ts";
import { dateOfWall, wallOfDate } from "../market/zone.ts";
import {
  cursor,
  errorResult,
  fitPage,
  fits,
  PageOverflow,
  readCursor,
  type ToolResult,
  textResult,
} from "../operations/answer.ts";
import {
  ArgError,
  date,
  fields,
  oneOf,
  optionalText,
  text,
} from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import { quoteItem, readLatest } from "../operations/quote.ts";
import {
  KINDS,
  listingFields,
  messageOf,
  NEWS_PAGE_ROWS,
  newsItem,
  newsMessage,
  newsSummary,
  researchSummary,
  researchTargets,
  rowItem,
  SECTION_OF,
  SINCE_DAYS,
} from "../operations/research.ts";
import { readResearch, sectionState } from "../sources/finnhub/read.ts";
import { NO_DATA, SECTIONS, type Section } from "../sources/finnhub/store.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import {
  countNews,
  KEPT_MS,
  type NewsCursor,
  type NewsRow,
  newsState,
  readNews,
} from "../sources/massive/store.ts";

export const RESEARCH_SECTIONS = [
  "overview",
  "analysts",
  "earnings",
  "insiders",
  "news",
] as const;
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number];

// Finnhub sections each research section reads; news reads none
export const SECTIONS_OF: Record<ResearchSection, readonly Section[]> = {
  overview: SECTIONS,
  analysts: ["analysts"],
  earnings: ["earnings"],
  insiders: ["insider"],
  news: [],
};

// a news page goes on below the last article it showed
const newsPosition = (r: NewsRow): string => `${r.publishedAt}.${r.id}`;

function readNewsPosition(position: string): NewsCursor | null {
  const m = /^(\d{1,15})\.(.+)$/.exec(position);
  return m === null ? null : { publishedAt: Number(m[1]), id: m[2]! };
}

export type ResearchArgs = {
  symbol: string;
  section: ResearchSection;
  since: string | null;
  next: string | null;
};

export function parseResearch(input: unknown): ResearchArgs {
  const f = fields(input, ["symbol", "section", "since", "next"]);
  return {
    symbol: text(f.symbol, "symbol"),
    section: oneOf(f.section, "section", RESEARCH_SECTIONS, "overview"),
    since: date(f.since, "since"),
    next: optionalText(f.next, "next", 300),
  };
}

export async function researchAnswer(
  m: Markets,
  args: ResearchArgs,
): Promise<ToolResult> {
  const { next, since: given, ...rest } = args;
  // without since the digest is what cursors were bound to before it
  const asked = given === null ? rest : { ...rest, since: given };
  let since: number | null = null;
  if (args.since !== null) {
    if (args.section !== "news") {
      throw new ArgError("since is for the news section only");
    }
    // a UTC date, as published times are
    const earliest = dateOfWall(m.clock.now() - KEPT_MS);
    if (args.since < earliest) {
      throw new ArgError(
        `since must be at most ${SINCE_DAYS} days back, ${earliest} or later`,
      );
    }
    since = wallOfDate(args.since);
  }
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
    const now = m.clock.now();
    const rows =
      message === null
        ? readNews(m.db, instrument.id, now, NEWS_PAGE_ROWS + 1, from, since)
        : [];
    // the first page counts the whole window before its articles
    const counts =
      message === null && from === null
        ? { counts: countNews(m.db, instrument.id, now, since ?? 0) }
        : {};
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
              ...counts,
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
  const items = rows.map((r) => rowItem(kind, r));
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
            // a fetch replaces the kind's rows, so all are of one listing
            ...listingFields(rows[0]?.listing ?? null),
          }),
      next: count < items.length ? cursor(items[count]!.period, asked) : null,
    }),
    "rows",
  );
  return textResult(page.text);
}
