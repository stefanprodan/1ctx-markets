// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Bucharest Stock Exchange read directly: its site's pages (ASP.NET,
// in Romanian) and the chart feed its pages call.

import type { Clock } from "../../runtime/clock.ts";
import { BVB, BVB_MARKET } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  type Limiter,
  limiter,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";
import {
  type BondsPage,
  DAY_S,
  type Detail,
  type History,
  type IndicesPage,
  type Listing,
  type Meta,
  pageKey,
  parseBonds,
  parseDetail,
  parseHistory,
  parseIndices,
  parseMeta,
  parseSchedule,
  parseSearch,
  parseShares,
  parseTypes,
  type Schedule,
  type SharesPage,
} from "./parse.ts";

export const SOURCE = BVB;
export const MARKET = BVB_MARKET;
export const SITE = "https://bvb.ro";
export const WAPI = "https://wapi.bvb.ro/api";
// the probes' pace, which the site never refused
export const SPACING_MS = 2000;
const TIMEOUT_MS = 30_000;
// the User-Agent the probes were answered with
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_SEARCH = 64;

export type Bvb = {
  shares(): Promise<SharesPage>;
  // fund units, exchange-traded funds among them: the shares page's columns
  units(): Promise<SharesPage>;
  bonds(): Promise<BondsPage>;
  indices(): Promise<IndicesPage>;
  detail(symbol: string): Promise<Detail>;
  schedule(): Promise<Schedule>;
  meta(symbol: string): Promise<Meta>;
  // adjusted daily bars from and to UTC epoch ms
  history(
    symbol: string,
    currency: string | null,
    from: number,
    to: number,
  ): Promise<History>;
  search(text: string): Promise<Listing[]>;
  // the chart feed's search, for each listing's type, which the site's
  // search lacks; symbol is a listing whose page gives a key if refused
  types(text: string, symbol: string): Promise<Map<string, string>>;
  // the symbols, uppercased, on the list pages last read; null until all
  // are read, as an unread kind may hold the symbol
  listed(): ReadonlySet<string> | null;
  // when the list page of a kind was last read, null if never
  listedAt(kind: ListKind): number | null;
  failFast(): Bvb;
  within(live: () => boolean): Bvb;
  due(): number | null;
  backoff(): Backoff | null;
  close(): void;
};

export const LISTS = ["shares", "units", "bonds", "indices"] as const;
export type ListKind = (typeof LISTS)[number];

export type BvbOptions = { clock: Clock; fetch?: Fetch };

type Raw = { status: number; text: string; fetchedAt: number };

export function bvb(options: BvbOptions): Bvb {
  const { clock } = options;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls: Limiter = limiter(clock, SPACING_MS);
  // the chart feed's key, from the last instrument page read
  let key: string | null = null;
  // each list page's symbols, from its last read
  const lists = new Map<
    ListKind,
    { symbols: ReadonlySet<string>; at: number }
  >();
  const keep = <T extends { rows: { symbol: string }[]; fetchedAt: number }>(
    kind: ListKind,
    page: T,
  ): T => {
    lists.set(kind, {
      symbols: new Set(page.rows.map((r) => r.symbol.toUpperCase())),
      at: page.fetchedAt,
    });
    return page;
  };

  const request = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Raw> => {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
      timedOut = true;
      abort.abort();
    });
    try {
      const res = await doFetch(url, {
        method: init.method ?? "GET",
        headers: { "User-Agent": USER_AGENT, ...init.headers },
        body: init.body,
        redirect: "manual",
        signal: abort.signal,
      });
      return {
        status: res.status,
        text: await res.text(),
        fetchedAt: clock.now(),
      };
    } catch {
      throw new SourceError(timedOut ? "timed out" : "network error");
    } finally {
      cancel();
    }
  };

  const refuse = (status: number): void => {
    if (status === 429) throw new SourceError("rate limited");
    if (status === 400) throw new SourceError("bad request");
    if (status === 404) throw new SourceError("not found");
    if (status < 200 || status > 299) {
      throw new SourceError("source error", `HTTP ${status}`);
    }
  };

  const json = (raw: Raw): unknown => {
    try {
      return JSON.parse(raw.text);
    } catch {
      throw new Unreadable();
    }
  };

  const client = (run: RunOptions): Bvb => {
    // parsed inside the queued call, so a page that does not read backs
    // the queue off: a proxy or consent page is HTML too
    const page = <T>(
      path: string,
      parse: (html: string, fetchedAt: number) => T,
    ): Promise<T> =>
      calls.run(async () => {
        const raw = await request(`${SITE}${path}`, {});
        refuse(raw.status);
        try {
          return parse(raw.text, raw.fetchedAt);
        } catch (error) {
          if (
            error instanceof SourceError &&
            error.phrase === "malformed answer" &&
            !(error instanceof Unreadable)
          ) {
            throw new Unreadable(error.detail ?? "a page that does not read");
          }
          throw error;
        }
      }, run);

    const detailPath = (symbol: string) =>
      `/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${encodeURIComponent(symbol)}`;

    // a 401 resolves rather than throws, so the key refresh does not wait
    // out a back-off
    const feed = <T>(
      path: string,
      symbol: string,
      parse: (body: unknown, fetchedAt: number) => T,
    ): Promise<T> => {
      // only the first 401 resolves; the last is a refusal like any other
      const once = (last: boolean) =>
        calls.run(async () => {
          const headers: Record<string, string> = {
            Accept: "application/json",
            Origin: SITE,
            Referer: `${SITE}/`,
          };
          if (key !== null) headers["X-SK-API"] = key;
          const raw = await request(`${WAPI}${path}`, { headers });
          if (raw.status === 401) {
            if (last) throw new SourceError("key refused");
            return { refused: true as const };
          }
          refuse(raw.status);
          return {
            refused: false as const,
            value: parse(json(raw), raw.fetchedAt),
          };
        }, run);
      return once(false).then(async (first) => {
        if (!first.refused) return first.value;
        await calls.run(async () => {
          const raw = await request(`${SITE}${detailPath(symbol)}`, {});
          refuse(raw.status);
          key = pageKey(raw.text);
          if (key === null) throw new SourceError("key refused");
        }, run);
        const second = await once(true);
        if (second.refused) throw new SourceError("key refused");
        return second.value;
      });
    };

    return {
      shares: () =>
        page("/FinancialInstruments/Markets/Shares", parseShares).then((p) =>
          keep("shares", p),
        ),
      units: () =>
        page("/FinancialInstruments/Markets/FundUnits", parseShares).then((p) =>
          keep("units", p),
        ),
      bonds: () =>
        page("/FinancialInstruments/Markets/Bonds", parseBonds).then((p) =>
          keep("bonds", p),
        ),
      indices: () =>
        page("/TradingAndStatistics/Trading/MarketsToday", parseIndices).then(
          (p) => keep("indices", p),
        ),
      detail: (symbol) =>
        page(detailPath(symbol), (html, fetchedAt) => {
          key = pageKey(html) ?? key;
          return parseDetail(html, fetchedAt);
        }),
      schedule: () =>
        page("/TradingAndStatistics/TradingSessionSchedule", parseSchedule),
      meta: (symbol) =>
        feed(`/symbols?symbol=${encodeURIComponent(symbol)}`, symbol, (b) =>
          parseMeta(b),
        ),
      history(symbol, currency, from, to) {
        const first = Math.floor(from / 1000);
        const last = Math.ceil(to / 1000);
        // countback is required and wins over from: the window's weekdays
        // and a margin, about 252 trading days a year
        const countback = Math.ceil((((last - first) / DAY_S) * 5) / 7) + 5;
        const params = new URLSearchParams({
          symbol,
          from: String(first),
          to: String(last),
          rs: "1D",
          // adjusted, so averages do not drop on a bonus issue
          ajust: "1",
          countback: String(countback),
          currencyCode: currency ?? "-",
        });
        return feed(`/history?${params}`, symbol, (b, fetchedAt) =>
          parseHistory(b, from, to, fetchedAt),
        );
      },
      search: (text) =>
        calls.run(async () => {
          const raw = await request(
            `${SITE}/proxyshld.aspx/GetInstrumentsList`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Accept: "application/json",
              },
              body: JSON.stringify({ searchtext: text.slice(0, MAX_SEARCH) }),
            },
          );
          refuse(raw.status);
          return parseSearch(json(raw));
        }, run),
      types: (text, symbol) => {
        const params = new URLSearchParams({
          // the most the feed takes
          limit: "30",
          query: text.slice(0, MAX_SEARCH),
          type: "",
          exchange: "",
        });
        return feed(`/search?${params}`, symbol, parseTypes);
      },
      listed: () =>
        !LISTS.every((k) => lists.has(k))
          ? null
          : new Set([...lists.values()].flatMap((l) => [...l.symbols])),
      listedAt: (kind) => lists.get(kind)?.at ?? null,
      failFast: () => client({ failFast: true }),
      within: (live) => client({ failFast: true, live }),
      due: () => calls.due(),
      backoff: () => calls.backoff(),
      close: () => calls.close(),
    };
  };
  return client({});
}
