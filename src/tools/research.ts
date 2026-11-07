// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The research tool's page: one section of one share, paged by cursor.

import { iso } from "../market/format.ts";
import { dateOfWall, wallOfDate } from "../market/zone.ts";
import { analysisField } from "../operations/analysis.ts";
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
import { fundHoldingsAnswer, noFund, seenFund } from "../operations/funds.ts";
import type { Markets } from "../operations/markets.ts";
import { type OptionsSection, readOptions } from "../operations/options.ts";
import {
  cftcCode,
  cftcId,
  cotIndex,
  marketOf,
  noteRetired,
  positioningHead,
  positioningPointer,
  positioningSince,
  RETIRED,
  readPositioning,
  SECTION_NOT_COVERED,
  UNKNOWN_MARKET,
  weekRows,
} from "../operations/positioning.ts";
import { quoteItem, readLatest } from "../operations/quote.ts";
import {
  FILINGS_PAGE_ROWS,
  figuresCurrency,
  filingItem,
  filingsHead,
  filingsSummary,
  KINDS,
  listingFields,
  messageOf,
  NEWS_PAGE_ROWS,
  newsItem,
  newsMessage,
  newsSummary,
  reportsFor,
  researchSummary,
  researchTargets,
  rowItem,
  SECTION_OF,
  SINCE_DAYS,
  topHoldingsOf,
  topHoldingsSummary,
  valuationSummary,
} from "../operations/research.ts";
import { NO_ACCESS, type Who } from "../operations/who.ts";
import { isFundKey } from "../portfolios/funds.ts";
import { type FilingCursor, readFilings } from "../sources/edgar/store.ts";
import { readResearch, sectionState } from "../sources/finnhub/read.ts";
import { NO_DATA, SECTIONS, type Section } from "../sources/finnhub/store.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { CFTC } from "../sources/ids.ts";
import {
  countNews,
  KEPT_MS,
  type NewsCursor,
  type NewsRow,
  newsState,
  readNews,
} from "../sources/massive/store.ts";
import { CHAIN_BAND } from "../sources/yahoo/options.ts";

export const RESEARCH_SECTIONS = [
  "overview",
  "analysts",
  "earnings",
  "insiders",
  "news",
  "filings",
  "top_holdings",
  "options",
  "positioning",
] as const;
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number];

// Finnhub sections each research section reads; news and filings none
export const SECTIONS_OF: Record<ResearchSection, readonly Section[]> = {
  overview: SECTIONS,
  analysts: ["analysts"],
  earnings: ["earnings"],
  insiders: ["insider"],
  news: [],
  filings: [],
  top_holdings: [],
  options: [],
  positioning: [],
};

// a news page goes on below the last article it showed
const newsPosition = (r: NewsRow): string => `${r.publishedAt}.${r.id}`;

function readNewsPosition(position: string): NewsCursor | null {
  const m = /^(\d{1,15})\.(.+)$/.exec(position);
  return m === null ? null : { publishedAt: Number(m[1]), id: m[2]! };
}

const filingPosition = (r: { acceptedAt: number; accession: string }) =>
  `${r.acceptedAt}.${r.accession}`;

function readFilingPosition(position: string): FilingCursor | null {
  const m = /^(\d{1,15})\.(\d{10}-\d{2}-\d{6})$/.exec(position);
  return m === null ? null : { acceptedAt: Number(m[1]), accession: m[2]! };
}

export type ResearchArgs = {
  symbol: string;
  section: ResearchSection;
  since: string | null;
  expiry: string | null;
  next: string | null;
};

export function parseResearch(input: unknown): ResearchArgs {
  const f = fields(input, ["symbol", "section", "since", "expiry", "next"]);
  return {
    symbol: text(f.symbol, "symbol"),
    section: oneOf(f.section, "section", RESEARCH_SECTIONS, "overview"),
    since: date(f.since, "since"),
    expiry: date(f.expiry, "expiry"),
    next: optionalText(f.next, "next", 300),
  };
}

type Strike = { strike: number };

// Unpaged: the strikes farthest from the price go first, both sides of a
// tie together, so every strike within band_pct is shown.
function optionsText(
  head: Record<string, unknown>,
  section: OptionsSection,
): string {
  const { strikes, ...rest } = section as OptionsSection & {
    strikes?: Strike[];
  };
  const price = rest.price as number | null | undefined;
  if (strikes === undefined || price == null || price <= 0) {
    return JSON.stringify({ ...head, ...section });
  }
  const off = (s: Strike) => Math.abs(s.strike - price);
  let kept = strikes;
  let band = CHAIN_BAND;
  for (;;) {
    const text = JSON.stringify({
      ...head,
      ...rest,
      band_pct: band,
      strikes: kept,
    });
    if (fits(text) || kept.length === 0) return text;
    const far = Math.max(...kept.map(off));
    kept = kept.filter((s) => off(s) < far);
    const widest = kept.length === 0 ? 0 : Math.max(...kept.map(off));
    band = Math.floor((widest / price) * 10_000) / 100;
  }
}

export async function researchAnswer(
  m: Markets,
  args: ResearchArgs,
  who: Who = NO_ACCESS,
): Promise<ToolResult> {
  const started = m.clock.now();
  const { next, since: given, expiry, ...rest } = args;
  // without since or expiry the digest is what cursors were bound to before
  const asked = {
    ...rest,
    ...(given === null ? {} : { since: given }),
    ...(expiry === null ? {} : { expiry }),
  };
  if (expiry !== null && args.section !== "options") {
    throw new ArgError("expiry is for the options section only");
  }
  let since: number | null = null;
  if (args.since !== null && args.section === "positioning") {
    positioningSince(m, args.since);
  } else if (args.since !== null) {
    if (args.section !== "news") {
      throw new ArgError("since is for the news and positioning sections only");
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
    if (
      args.section === "overview" ||
      args.section === "top_holdings" ||
      args.section === "options"
    ) {
      throw new ArgError(`${args.section} has no next page`);
    }
    start = readCursor(next, asked);
    if (
      start === null ||
      (args.section === "news" && readNewsPosition(start) === null) ||
      (args.section === "filings" && readFilingPosition(start) === null) ||
      (args.section === "positioning" && !/^\d{4}-\d{2}-\d{2}$/.test(start))
    ) {
      throw new ArgError("next does not continue these arguments");
    }
  }
  // a CFTC market is no instrument: nothing is resolved or tracked
  const code = cftcCode(args.symbol);
  if (code !== null) {
    return cftcAnswer(m, args, code, start, asked, started + m.callMs);
  }
  // a fund the owner prices has only the holdings entered for it
  if (args.section === "top_holdings" && isFundKey(args.symbol)) {
    const fund = seenFund(m.db, who, args.symbol);
    if (fund === null) return errorResult({ input: args.symbol, ...noFund });
    const text = JSON.stringify({
      id: fund.id,
      name: fund.name,
      type: fund.type,
      currency: fund.currency,
      section: args.section,
      ...fundHoldingsAnswer(m.db, fund.id),
    });
    if (!fits(text)) throw new PageOverflow();
    return textResult(text);
  }
  const withNews = args.section === "overview" || args.section === "news";
  const withFilings = args.section === "overview" || args.section === "filings";
  const { targets, inline, news, filings, valuation, topHoldings } =
    await researchTargets(m, [args.symbol], {
      news: withNews,
      filings: withFilings,
      sections: SECTIONS_OF[args.section],
      valuation: args.section === "overview",
      topHoldings:
        args.section === "overview" || args.section === "top_holdings",
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
    const value = valuationSummary(m, instrument, valuation.get(instrument.id));
    const fund = topHoldingsSummary(
      m,
      instrument,
      topHoldings.get(instrument.id),
    );
    const pointer = positioningPointer(m, instrument);
    const answer = () =>
      JSON.stringify({
        ...head,
        quote,
        ...analysisField(m, who, instrument.id),
        ...(pointer === undefined ? {} : { positioning: pointer }),
        ...(fund === undefined ? {} : { top_holdings: fund }),
        research: researchSummary(m, instrument, inline.get(instrument.id)),
        ...(value === undefined ? {} : { valuation: value }),
        news: summary,
        filings: filingsSummary(m, instrument, filings.get(instrument.id)),
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
  if (args.section === "options") {
    const section = await readOptions(
      m,
      instrument,
      expiry,
      started + m.callMs,
    );
    const text = optionsText(head, section);
    if (!fits(text)) throw new PageOverflow();
    return textResult(text);
  }
  if (args.section === "positioning") {
    const of = marketOf(args.symbol, instrument);
    if ("message" in of) {
      return textResult(JSON.stringify({ ...head, source: CFTC, ...of }));
    }
    const found = await readPositioning(m, of.code, started + m.callMs);
    if (found.kind === "error") {
      return textResult(
        JSON.stringify({ ...head, source: CFTC, ...found.error }),
      );
    }
    if (found.kind === "missing") {
      noteRetired(m, of.code, args.symbol);
      return textResult(
        JSON.stringify({ ...head, source: CFTC, message: RETIRED }),
      );
    }
    return textResult(
      positioningPage(m, head, found, args.since, start, asked),
    );
  }
  if (args.section === "top_holdings") {
    const text = JSON.stringify({
      ...head,
      ...topHoldingsOf(m, instrument, topHoldings.get(instrument.id)),
    });
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
  if (args.section === "filings") {
    const { head: own, rows: any } = filingsHead(
      m,
      instrument,
      filings.get(instrument.id),
    );
    const from = start === null ? null : readFilingPosition(start);
    const rows = any
      ? readFilings(m.db, instrument.id, FILINGS_PAGE_ROWS + 1, from)
      : [];
    const items = rows.slice(0, FILINGS_PAGE_ROWS).map(filingItem);
    // the flags on the first page only, as news counts are
    const first =
      from === null
        ? own
        : {
            source: own.source,
            ...("message" in own ? { message: own.message } : {}),
            ...("fetched_at" in own
              ? { fetched_at: own.fetched_at, stale: own.stale }
              : {}),
          };
    const page = fitPage(
      items,
      (count) => ({
        ...head,
        ...first,
        next:
          count > 0 && count < rows.length
            ? cursor(filingPosition(rows[count - 1]!), asked)
            : null,
      }),
      "filings",
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
  const reported = reportsFor(m, instrument.id, kind);
  const items = rows.map((r) => rowItem(kind, r, reported));
  const page = fitPage(
    items,
    (count) => ({
      ...head,
      // the rows' figures are in it, which a foreign filer's are not
      ...(kind === "earnings"
        ? {
            currency: figuresCurrency(m, instrument, rows[0]?.listing ?? null),
          }
        : {}),
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

type Found = Extract<
  Awaited<ReturnType<typeof readPositioning>>,
  { kind: "ok" }
>;

// newest first from the cursor's week; the first page carries cot_index, as
// news carries counts
function positioningPage(
  m: Markets,
  head: Record<string, unknown>,
  found: Found,
  given: string | null,
  start: string | null,
  asked: unknown,
): string {
  const since = positioningSince(m, given);
  const rows = weekRows(found.weeks.weeks).filter(
    (r) => r.report_date >= since && (start === null || r.report_date < start),
  );
  return fitPage(
    rows,
    (count) => ({
      ...head,
      ...positioningHead(found),
      since,
      ...(start === null ? { cot_index: cotIndex(found.weeks.weeks) } : {}),
      next:
        count > 0 && count < rows.length
          ? cursor(rows[count - 1]!.report_date, asked)
          : null,
    }),
    "weeks",
  ).text;
}

// A CFTC id's overview is its latest week, positioning its weeks; every
// other section has none.
async function cftcAnswer(
  m: Markets,
  args: ResearchArgs,
  code: string,
  start: string | null,
  asked: unknown,
  deadline: number,
): Promise<ToolResult> {
  const id = cftcId(code);
  if (args.section !== "overview" && args.section !== "positioning") {
    return textResult(
      JSON.stringify({
        id,
        name: m.cftc?.list.find(code)?.market.name ?? null,
        section: args.section,
        source: CFTC,
        message: SECTION_NOT_COVERED,
      }),
    );
  }
  const found = await readPositioning(m, code, deadline);
  if (found.kind === "error") {
    return errorResult({ input: args.symbol, ...found.error });
  }
  if (found.kind === "missing") {
    return errorResult({
      input: args.symbol,
      error: "not_found",
      message: UNKNOWN_MARKET,
    });
  }
  const head = { id, name: found.market.name, section: args.section };
  if (args.section === "positioning") {
    return textResult(
      positioningPage(m, head, found, args.since, start, asked),
    );
  }
  const text = JSON.stringify({
    ...head,
    ...positioningHead(found),
    cot_index: cotIndex(found.weeks.weeks),
    latest: weekRows(found.weeks.weeks)[0] ?? null,
  });
  if (!fits(text)) throw new PageOverflow();
  return textResult(text);
}
