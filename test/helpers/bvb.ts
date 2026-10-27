// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Bucharest exchange answered from its recordings by URL. The pages
// were recorded on a Sunday with the market closed and the page key
// stripped, so an open market and a key are made up here, in code.

import { join } from "node:path";
import type { Fetch } from "../../src/source.ts";
import { sources } from "./sources.ts";
import { clone, fakeFetch, type Recorded } from "./yahoo.ts";

const BVB = join(import.meta.dir, "..", "fixtures", "bvb");

export async function bvbRecorded(name: string): Promise<Recorded> {
  return Bun.file(join(BVB, `${name}.json`)).json();
}

// made up: the recordings strip the key each page embeds
export const PAGE_KEY = "test-page-key-1";

// a recorded page with the market status read as open
export function opened(fx: Recorded, status = "DESCHISA"): Recorded {
  const out = clone(fx);
  out.body = (out.body as string).replace(
    '<span id="statusMarket">INCHISA</span>',
    `<span id="statusMarket">${status}</span>`,
  );
  return out;
}

// a recorded instrument page with a key script, as the live page has
export function keyed(fx: Recorded, key = PAGE_KEY): Recorded {
  const out = clone(fx);
  out.body = `<script>var sk = '${key}';</script>\n${out.body}`;
  return out;
}

export const made = (status: number, body: unknown): Recorded => ({
  recordedAt: "",
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body,
});

const DETAILS: Record<string, string> = {
  TLV: "detail-tlv",
  SNP: "detail-snp",
  H2O: "detail-h2o",
  R2807A: "detail-bond-r2807a",
  BTBETRETF: "detail-btbetretf",
};

const METAS: Record<string, string> = {
  TLV: "wapi-symbols-tlv",
  BTBETRETF: "wapi-symbols-btbetretf",
  BET: "wapi-symbols-bet",
  R2807A: "wapi-symbols-r2807a",
};

const HISTORIES: Record<string, string> = {
  TLV: "wapi-history-tlv-1d",
  SNP: "wapi-history-snp-1d",
  H2O: "wapi-history-h2o-1d",
  BET: "wapi-history-bet-1d",
  R2807A: "wapi-history-r2807a-1d",
  BTBETRETF: "wapi-history-btbetretf-1d",
};

// the chart feed's searches by query; any other finds nothing
const SEARCHES: Record<string, string> = {
  PETROM: "wapi-search-petrom",
  BTBETRETF: "wapi-search-btbetretf",
  TRANSILVANIA: "wapi-search-transilvania",
};

export type BvbRoutes = {
  // the market status every page reads, closed as recorded by default
  open?: boolean;
  // histories by symbol, in place of the recorded ones
  histories?: Record<string, Recorded>;
  // holds a call until it resolves, or answers it instead
  hold?: (url: URL) => Recorded | Promise<Recorded | undefined> | undefined;
};

// a symbol answer for any symbol the recordings lack, as the feed's
// unknown-symbol answer: never recorded, so made up
const UNKNOWN_META = made(200, { s: "error", errmsg: "unknown_symbol" });

export async function bvbAnswer(
  url: URL,
  routes: BvbRoutes = {},
): Promise<Recorded | undefined> {
  const page = async (name: string) => {
    const fx = await bvbRecorded(name);
    return routes.open ? opened(fx) : fx;
  };
  if (url.hostname === "bvb.ro") {
    switch (url.pathname) {
      case "/FinancialInstruments/Markets/Shares":
        return page("shares-list");
      case "/FinancialInstruments/Markets/FundUnits":
        return page("fund-units-list");
      case "/FinancialInstruments/Markets/Bonds":
        return page("bonds-list");
      case "/TradingAndStatistics/Trading/MarketsToday":
        return page("markets-today");
      case "/TradingAndStatistics/TradingSessionSchedule":
        return page("trading-schedule");
      case "/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx": {
        const s = (url.searchParams.get("s") ?? "").toUpperCase();
        return keyed(await page(DETAILS[s] ?? "detail-unknown"));
      }
      case "/proxyshld.aspx/GetInstrumentsList":
        return bvbRecorded("instruments-autocomplete-petrom");
    }
    return undefined;
  }
  if (url.hostname === "wapi.bvb.ro") {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    if (url.pathname === "/api/symbols") {
      return METAS[symbol] ? bvbRecorded(METAS[symbol]) : UNKNOWN_META;
    }
    if (url.pathname === "/api/search") {
      const name =
        SEARCHES[(url.searchParams.get("query") ?? "").toUpperCase()];
      return name === undefined ? made(200, []) : bvbRecorded(name);
    }
    if (url.pathname === "/api/history") {
      const given = routes.histories?.[symbol];
      if (given !== undefined) return given;
      return bvbRecorded(HISTORIES[symbol] ?? "wapi-history-unknown");
    }
  }
  return undefined;
}

// every site search but petrom's and the fund unit's finds nothing
export async function bvbFetch(routes: BvbRoutes = {}): Promise<{
  fetch: Fetch;
  urls: URL[];
  headers: Headers[];
  bodies: (string | null)[];
}> {
  const bodies: (string | null)[] = [];
  const f = fakeFetch(async (url) => {
    const held = await routes.hold?.(url);
    if (held !== undefined) return held;
    return bvbAnswer(url, routes);
  });
  const fetch: Fetch = async (raw, init) => {
    const body = typeof init.body === "string" ? init.body : null;
    bodies.push(body);
    if (
      body !== null &&
      new URL(raw).pathname === "/proxyshld.aspx/GetInstrumentsList" &&
      /btbetretf/i.test(body)
    ) {
      f.urls.push(new URL(raw));
      f.headers.push(new Headers(init.headers));
      const fx = await bvbRecorded("instruments-autocomplete-btbetretf");
      return new Response(JSON.stringify(fx.body), { status: 200 });
    }
    if (
      body !== null &&
      new URL(raw).pathname === "/proxyshld.aspx/GetInstrumentsList" &&
      !/petrom/i.test(body)
    ) {
      f.urls.push(new URL(raw));
      f.headers.push(new Headers(init.headers));
      return new Response(JSON.stringify({ d: [] }), { status: 200 });
    }
    return f.fetch(raw, init);
  };
  return { fetch, urls: f.urls, headers: f.headers, bodies };
}

export const wapi = (urls: URL[], path: string) =>
  urls.filter((u) => u.hostname === "wapi.bvb.ro" && u.pathname === path);

export const site = (urls: URL[], path: string) =>
  urls.filter((u) => u.hostname === "bvb.ro" && u.pathname === path);

// Yahoo and FRED from sources(), the exchange from its recordings
export async function bothSources(
  options: {
    charts?: Record<string, Recorded>;
    hold?: (url: URL) => Recorded | Promise<Recorded | undefined> | undefined;
  } = {},
): Promise<{ fetch: Fetch; exchange: URL[] }> {
  const hold = options.hold;
  const yahoo = await sources({
    charts: options.charts,
    hold: hold === undefined ? undefined : async (url) => hold(url),
  });
  const exchange = await bvbFetch({ hold });
  const fetch: Fetch = (raw, init) => {
    const host = new URL(raw).hostname;
    return host === "bvb.ro" || host === "wapi.bvb.ro"
      ? exchange.fetch(raw, init)
      : yahoo.fetch(raw, init);
  };
  return { fetch, exchange: exchange.urls };
}
