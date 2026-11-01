// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { iso, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { quoteStale } from "../market/stale.ts";
import { dateOfWall, localDate, wallOfDate } from "../market/zone.ts";
import { DAY_MS } from "../runtime/clock.ts";
import { itemName } from "../sources/edgar/items.ts";
import {
  NOT_COVERED as EDGAR_NOT_COVERED,
  eligible as edgarEligible,
  type FilingRow,
  filedAt,
  filerState,
  filingsFetched,
  flags,
  NO_DATA as NO_EDGAR,
  NO_FLAGS,
  readFilings,
} from "../sources/edgar/store.ts";
import { refreshFilings } from "../sources/edgar/sync.ts";
import { shareClass } from "../sources/finnhub/client.ts";
import {
  type EventRow,
  eventStatus,
  kindColumns,
  nextEvent,
  type ResearchKind,
  type ResearchRow,
  readResearch,
  reportedEvents,
  reportOf,
  sectionState,
} from "../sources/finnhub/read.ts";
import {
  eligible,
  NO_DATA,
  NOT_COVERED,
  OTHER_LISTING,
  SECTIONS,
  type Section,
  SHARE_CLASS,
} from "../sources/finnhub/store.ts";
import { refreshResearch, unfetched } from "../sources/finnhub/sync.ts";
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
import {
  inlineDue,
  isFund,
  NO_TOP_HOLDINGS,
  NOT_A_FUND,
  readTopHoldings,
  refreshTopHoldings,
  TOP_ONLY,
  asked as topHoldingsAsked,
  topHoldingsFetched,
  topHoldingsState,
} from "../sources/yahoo/top-holdings.ts";
import {
  covered,
  PER_US_SHARE,
  readValuation,
  refreshValuation,
  valuationFetched,
  valuationState,
} from "../sources/yahoo/valuation.ts";
import { ArgError, date, fields, symbols } from "./args.ts";
import { type Markets, shared } from "./markets.ts";
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

// fixed so five summaries stay short; the reasons are in docs/research.md
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
  options: {
    news?: boolean;
    filings?: boolean;
    sections?: readonly Section[];
    // Yahoo's figures for a share Finnhub answers from a foreign listing
    valuation?: boolean;
    topHoldings?: boolean;
  } = {},
): Promise<{
  targets: Target[];
  inline: Map<string, Inline>;
  news: Map<string, Inline>;
  filings: Map<string, Inline>;
  valuation: Map<string, Inline>;
  topHoldings: Map<string, Inline>;
}> {
  const deadline = m.clock.now() + m.callMs;
  const targets = await readTargets(m, inputs);
  const inline = new Map<string, Inline>();
  const news = new Map<string, Inline>();
  const filings = new Map<string, Inline>();
  const valuation = new Map<string, Inline>();
  // each share's Finnhub fetch, which says whether its listing is foreign
  const research = new Map<string, Promise<unknown>>();
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
    if (
      !options.filings ||
      !("instrument" in t) ||
      filings.has(t.instrument.id)
    ) {
      continue;
    }
    const instrument = t.instrument;
    const client = m.edgar;
    if (client === null) {
      filings.set(instrument.id, { kind: "off" });
      continue;
    }
    if (!edgarEligible(instrument)) {
      filings.set(instrument.id, { kind: "not covered" });
      continue;
    }
    filings.set(instrument.id, { kind: "stored" });
    if (filingsFetched(m.db, instrument.id)) continue;
    if (m.clock.now() >= deadline) {
      filings.set(instrument.id, { kind: "failed", error: timeout(m) });
      continue;
    }
    const fetch = shared(m, `filings:${instrument.id}`, deadline, (live) =>
      refreshFilings(
        { db: m.db, clock: m.clock, writer: m.writer, edgar: client },
        instrument,
        { live, client: client.within(live), unfetched: true },
      ).then((r) => {
        // the run's own failure, recorded as its run, is this answer's
        if (r.status === "failed") throw r.error;
      }),
    );
    settle(filings, instrument.id, fetch);
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
      ).then((results) => {
        // a section's failure is recorded as its run and resolves, not
        // rejects; read as stored it answers a missing value as none
        const failed = results.find((r) => r.status === "failed");
        if (failed !== undefined && "error" in failed) throw failed.error;
      }),
    );
    research.set(instrument.id, fetch);
    settle(inline, instrument.id, fetch);
  }
  for (const t of targets) {
    if (
      !options.valuation ||
      m.finnhub === null ||
      !("instrument" in t) ||
      !eligible(t.instrument) ||
      valuation.has(t.instrument.id)
    ) {
      continue;
    }
    const instrument = t.instrument;
    valuation.set(instrument.id, { kind: "stored" });
    // the metric's own failure is the research summary's, not this one's
    const fetch = (research.get(instrument.id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (
          !covered(m.db, instrument) ||
          valuationFetched(m.db, instrument.id)
        ) {
          return;
        }
        return shared(m, `valuation:${instrument.id}`, deadline, (live) =>
          refreshValuation(m, instrument, {
            live,
            client: m.yahoo.within(live),
            due: (db) => !valuationFetched(db, instrument.id),
          }).then((r) => {
            if (r?.status === "failed") throw r.error;
          }),
        );
      });
    settle(valuation, instrument.id, fetch);
  }
  const topHoldings = new Map<string, Inline>();
  if (options.topHoldings) {
    const funds = targets.flatMap((t) =>
      "instrument" in t ? [t.instrument] : [],
    );
    work.push(
      topHoldingsInline(m, funds, deadline).then((got) => {
        for (const [id, v] of got) topHoldings.set(id, v);
      }),
    );
  }
  try {
    await Promise.all(work);
  } finally {
    cancel();
  }
  // the share is quoted; it is the quote summary Yahoo has none of
  for (const [id, v] of valuation) {
    if (v.kind === "failed" && v.error.error === "not_found") {
      valuation.set(id, {
        kind: "failed",
        error: { error: "not_found", message: NO_VALUATION },
      });
    }
  }
  return { targets, inline, news, filings, valuation, topHoldings };
}

// Fetched inline only while never fetched well and not failed within the
// retry wait, under the caller's deadline; past it the stored answer stands.
export async function topHoldingsInline(
  m: Markets,
  instruments: readonly Instrument[],
  deadline: number,
): Promise<Map<string, Inline>> {
  const out = new Map<string, Inline>();
  const work: Promise<void>[] = [];
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  for (const instrument of instruments) {
    if (!topHoldingsAsked(instrument) || out.has(instrument.id)) continue;
    out.set(instrument.id, { kind: "stored" });
    if (!inlineDue(m.db, instrument.id, m.clock.now())) continue;
    if (m.clock.now() >= deadline) {
      out.set(instrument.id, { kind: "failed", error: timeout(m) });
      continue;
    }
    const fetch = shared(m, `top_holdings:${instrument.id}`, deadline, (live) =>
      refreshTopHoldings(m, instrument, {
        live,
        client: m.yahoo.within(live),
        due: (db) => inlineDue(db, instrument.id, m.clock.now()),
      }).then((r) => {
        if (r?.status === "failed") throw r.error;
      }),
    );
    work.push(
      Promise.race([fetch, expired]).then(
        (done) => {
          if (done === EXPIRED) {
            out.set(instrument.id, { kind: "failed", error: timeout(m) });
          }
        },
        (error: unknown) => {
          out.set(instrument.id, {
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
  return out;
}

// weights are stored as Yahoo's fractions
const percent = (v: number | null): number | null =>
  v === null ? null : Math.round(v * 10_000) / 100;

// for a fund only, else undefined; a share asked by name gets NOT_A_FUND
export function topHoldingsSummary(
  m: Markets,
  instrument: Instrument,
  v: Inline | undefined,
) {
  if (!isFund(instrument)) return undefined;
  if (!topHoldingsAsked(instrument)) {
    return { source: "yahoo", message: NO_TOP_HOLDINGS };
  }
  const state = topHoldingsState(m.db, instrument.id, m.clock.now());
  const row = readTopHoldings(m.db, instrument.id);
  const failure = v?.kind === "failed" ? v.error : {};
  // an ok run that kept nothing: Yahoo has none for this fund
  if (row === null && topHoldingsFetched(m.db, instrument.id)) {
    return {
      source: "yahoo",
      message: NO_TOP_HOLDINGS,
      fetched_at: iso(state.fetchedAt),
      stale: state.stale,
    };
  }
  const top = (row?.holdings ?? []).map((h) => ({
    rank: h.rank,
    symbol: h.symbol,
    id: h.id,
    name: h.name,
    weight_percent: percent(h.weight),
  }));
  const p = row?.positions;
  return {
    source: "yahoo",
    ...failure,
    fetched_at: iso(row?.fetchedAt ?? state.fetchedAt),
    stale: state.stale,
    top,
    top_weight_percent:
      row === null || row.holdings.length === 0
        ? null
        : percent(row.holdings.reduce((sum, h) => sum + h.weight, 0)),
    assets:
      p === undefined
        ? null
        : {
            stock_percent: percent(p.stock),
            bond_percent: percent(p.bond),
            cash_percent: percent(p.cash),
            other_percent: percent(p.other),
            preferred_percent: percent(p.preferred),
            convertible_percent: percent(p.convertible),
          },
    sectors: (row?.sectors ?? []).map((s) => ({
      sector: s.key,
      weight_percent: percent(s.weight),
    })),
    bond_ratings: (row?.ratings ?? []).map((r) => ({
      rating: r.key,
      weight_percent: percent(r.weight),
    })),
    government_bonds_percent: percent(row?.government ?? null),
    note: TOP_ONLY,
  };
}

// the section asked by name: anything but a fund says why it has none
export const topHoldingsOf = (
  m: Markets,
  instrument: Instrument,
  v: Inline | undefined,
) =>
  topHoldingsSummary(m, instrument, v) ?? {
    source: "yahoo",
    message: NOT_A_FUND,
  };

type Values = Record<string, number | string | null>;

// a share's own rows carry neither field
export const listingFields = (listing: string | null) =>
  listing === null
    ? {}
    : { listing, note: shareClass(listing) ? SHARE_CLASS : OTHER_LISTING };

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

// the events read for earnings rows' revenue, none for another kind
export const reportsFor = (
  m: Markets,
  instrument: string,
  kind: ResearchKind,
): EventRow[] => (kind === "earnings" ? reportedEvents(m.db, instrument) : []);

const surprisePercent = (actual: number | null, estimate: number | null) =>
  actual === null || estimate === null || estimate === 0
    ? null
    : round(((actual - estimate) / Math.abs(estimate)) * 100);

// Finnhub's earnings carry EPS only; revenue is the quarter's report's
const revenueOf = (
  kind: ResearchKind,
  period: string,
  reported: readonly EventRow[],
) => {
  if (kind !== "earnings") return {};
  const e = reportOf(reported, period);
  const estimate = e?.revenueEstimate ?? null;
  const actual = e?.revenueActual ?? null;
  return {
    revenue_estimate: estimate,
    revenue_actual: actual,
    revenue_surprise_percent: surprisePercent(actual, estimate),
  };
};

export const rowItem = (
  kind: ResearchKind,
  r: ResearchRow,
  reported: readonly EventRow[],
) => ({
  period: r.period,
  ...valuesOf(kind, r),
  ...revenueOf(kind, r.period, reported),
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
  const reported = reportsFor(m, instrument.id, kind);
  // a fetch replaces the kind's rows, so the section's listing is its rows'
  const past =
    history > 0 ? { history: rows.map((r) => rowItem(kind, r, reported)) } : {};
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
    ...revenueOf(kind, row.period, reported),
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
    filed_at: m.edgar === null ? null : iso(filedAt(m.db, instrument, e.date)),
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

export const NO_VALUATION = "Yahoo has no valuation for this share";

// The quote's price over stored EPS, so P/E follows the live price; an EPS
// of zero or below has none, as an exchange leaves P/E blank for a loss.
const earningsMultiple = (price: number | null, eps: number | null) =>
  price === null || eps === null || eps <= 0 ? null : round(price / eps);

// only for a share Finnhub answers from a foreign listing, else undefined
export function valuationSummary(
  m: Markets,
  instrument: Instrument,
  v: Inline | undefined,
) {
  if (m.finnhub === null || !covered(m.db, instrument)) return undefined;
  const state = valuationState(m.db, instrument.id, m.clock.now());
  const row = readValuation(m.db, instrument.id);
  const priced = row !== null && row.currency === instrument.currency;
  const price = priced ? (readQuote(m.db, instrument.id)?.price ?? null) : null;
  const peTtm = earningsMultiple(price, priced ? row.epsTtm : null);
  const forwardPe = earningsMultiple(price, priced ? row.epsForward : null);
  // a P/E on a stale price says so, as the route has no quote beside it
  const quoted =
    peTtm === null && forwardPe === null
      ? []
      : quoteStale(m.db, instrument, {
          now: m.clock.now(),
          everyMs: m.quoteEveryMs,
        }).map((r) => `quote: ${r}`);
  return {
    source: "yahoo",
    ...(v?.kind === "failed" ? v.error : {}),
    fetched_at: iso(row?.fetchedAt ?? state.fetchedAt),
    stale: [...state.stale, ...quoted],
    currency: row?.currency ?? instrument.currency,
    pe_ttm: peTtm,
    forward_pe: forwardPe,
    forward_peg: priced ? round(row.peg) : null,
    eps_ttm: priced ? round(row.epsTtm) : null,
    eps_forward: priced ? round(row.epsForward) : null,
    note: PER_US_SHARE,
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

// the overview's few: a flag says what to read, the section has the rest
export const FILINGS_RECENT = 5;
// rows a filings page reads before fitting them under 32 KiB
export const FILINGS_PAGE_ROWS = 50;

export const filingsMessage = (f: Inline | undefined): string | null =>
  f?.kind === "off"
    ? NO_EDGAR
    : f?.kind === "not covered"
      ? EDGAR_NOT_COVERED
      : null;

export const filingItem = (r: FilingRow) => ({
  accession: r.accession,
  form: r.form,
  accepted_at: iso(r.acceptedAt),
  filed: r.filed,
  period: r.period,
  items: r.items.map((code) => ({ code, name: itemName(code) })),
  url: r.url,
});

// the head every filings answer shares: off, not covered, no CIK and a
// foreign filer each answer no data with no flags, never false ones
export function filingsHead(
  m: Markets,
  instrument: Instrument,
  f: Inline | undefined,
) {
  const message = filingsMessage(f);
  if (message !== null) {
    return { head: { source: "edgar", message, ...NO_FLAGS }, rows: false };
  }
  const now = m.clock.now();
  const state = filerState(m.db, instrument, now);
  return {
    head: {
      source: "edgar",
      ...(f?.kind === "failed" ? f.error : {}),
      ...(state.reason === null
        ? {}
        : { message: NO_EDGAR, reason: state.reason }),
      fetched_at: iso(state.fetchedAt),
      stale: state.stale,
      ...flags(m.db, instrument.id, state, now),
    },
    rows: state.reason === null,
  };
}

export function filingsSummary(
  m: Markets,
  instrument: Instrument,
  f: Inline | undefined,
) {
  const { head, rows } = filingsHead(m, instrument, f);
  return {
    ...head,
    recent: rows
      ? readFilings(m.db, instrument.id, FILINGS_RECENT).map(filingItem)
      : [],
  };
}

export const RESEARCH_PARTS = [
  "metric",
  "analysts",
  "earnings",
  "insider",
  "next_event",
  "news",
  "filings",
  "top_holdings",
] as const;
export type ResearchPart = (typeof RESEARCH_PARTS)[number];

// answered only when asked, so a call without sections answers as before
const DEFAULT_PARTS = RESEARCH_PARTS.filter((p) => p !== "top_holdings");

type FinnhubPart = Exclude<ResearchPart, "news" | "filings" | "top_holdings">;

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
  let parts: ResearchPart[] = [...DEFAULT_PARTS];
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
  const finnhub = args.parts.filter(
    (p): p is FinnhubPart =>
      p !== "news" && p !== "filings" && p !== "top_holdings",
  );
  const left = (Object.keys(SECTION_OF_PART) as FinnhubPart[]).filter(
    (p) => !finnhub.includes(p),
  );
  const withFilings = args.parts.includes("filings");
  // valuation goes with the metric, which says whether the listing is foreign
  const withValuation = args.parts.includes("metric");
  const withTopHoldings = args.parts.includes("top_holdings");
  const { targets, inline, filings, valuation, topHoldings } =
    await researchTargets(m, args.symbols, {
      sections: finnhub.map((p) => SECTION_OF_PART[p]),
      filings: withFilings,
      valuation: withValuation,
      topHoldings: withTopHoldings,
    });
  // no quote: /quotes answers prices for many symbols in one call
  return targets.map((t) => {
    if ("error" in t) return { input: t.input, ...t.error };
    const company: Record<string, unknown> = researchSummary(
      m,
      t.instrument,
      inline.get(t.instrument.id),
      HTTP_HISTORY,
    );
    for (const p of left) delete company[p];
    const value = withValuation
      ? valuationSummary(m, t.instrument, valuation.get(t.instrument.id))
      : undefined;
    return {
      input: t.input,
      id: t.instrument.id,
      ...(finnhub.length > 0 ? { company } : {}),
      ...(value === undefined ? {} : { valuation: value }),
      ...(args.parts.includes("news")
        ? { news: newsWeek(m, t.instrument, since) }
        : {}),
      ...(withFilings
        ? {
            filings: filingsSummary(
              m,
              t.instrument,
              filings.get(t.instrument.id),
            ),
          }
        : {}),
      ...(withTopHoldings
        ? {
            top_holdings: topHoldingsOf(
              m,
              t.instrument,
              topHoldings.get(t.instrument.id),
            ),
          }
        : {}),
    };
  });
}
