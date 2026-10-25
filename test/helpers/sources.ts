// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Yahoo and FRED answered from the recordings by URL, for reads that
// fetch inside the call: NVDA's five years and its spark quote, ^GSPC
// as a benchmark, the recorded searches and the FRED series.

import { join } from "node:path";
import type { Fetch } from "../../src/source.ts";
import {
  backTo,
  chartSymbol,
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./yahoo.ts";

const FRED = join(import.meta.dir, "..", "fixtures", "fred");
const FRED_SERIES = ["DGS10", "BAMLH0A0HYM2", "VIXCLS", "DCOILWTICO"];
// made up: no real key is ever read by a test
export const FRED_KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

// the spark batch was recorded at 21:04 UTC on Sunday 25 October
export const NOW = Date.parse("2026-10-25T21:05:00Z");

const fred = (name: string): Promise<Recorded> =>
  Bun.file(join(FRED, `${name}.json`)).json();

async function fredAnswer(url: URL): Promise<Recorded> {
  const id = url.searchParams.get("series_id")!;
  if (!FRED_SERIES.includes(id)) return fred("observations-unknown");
  if (url.pathname === "/fred/series") {
    return fred(`series-${id.toLowerCase()}`);
  }
  const fx = await fred(`observations-${id.toLowerCase()}`);
  // asked from a start date, FRED answers the whole history ascending
  if (!url.searchParams.has("observation_start")) return fx;
  const out = clone(fx);
  out.body.sort_order = "asc";
  out.body.limit = 100_000;
  out.body.count = out.body.observations.length;
  return out;
}

const SEARCHES: Record<string, string> = {
  NVDA: "search-nvda",
  NVIDIA: "search-nvda",
  KO: "search-ko",
  TLV: "search-tlv",
  VVSM: "search-vvsm",
  SOLANA: "search-solana",
};

export type Calls = {
  urls: URL[];
  // yahoo calls by kind
  searches: () => URL[];
  charts: (symbol?: string) => URL[];
  sparks: () => URL[];
};

export async function sources(
  options: {
    // holds a call until it resolves, or answers it instead
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
  } = {},
): Promise<{ fetch: Fetch; calls: Calls }> {
  const nvda = listed(await recorded("chart-nvda-5y-1d"));
  const gspc = listed(backTo(await recorded("chart-gspc-5d-1d"), "2026-01-05"));
  const charts: Record<string, Recorded> = { NVDA: nvda, "^GSPC": gspc };
  const batch = await recorded("spark-v7-batch");
  const metas = new Map<string, unknown>(
    batch.body.spark.result.map((r: any) => [r.symbol, r.response[0].meta]),
  );
  metas.set("^GSPC", gspc.body.chart.result[0].meta);
  const spark = (url: URL): Recorded => {
    const out = clone(batch);
    out.body.spark.result = url.searchParams
      .get("symbols")!
      .split(",")
      .map((symbol) => ({
        symbol,
        response: metas.has(symbol) ? [{ meta: clone(metas.get(symbol)) }] : [],
      }));
    return out;
  };
  const f = fakeFetch(async (url) => {
    const held = await options.hold?.(url);
    if (held !== undefined) return held;
    if (url.hostname === "api.stlouisfed.org") return fredAnswer(url);
    const symbol = chartSymbol(url);
    if (symbol !== null) {
      return charts[symbol] ?? (await recorded("chart-unknown-symbol"));
    }
    if (url.pathname === "/v7/finance/spark") return spark(url);
    if (url.pathname === "/v1/finance/search") {
      const name = SEARCHES[(url.searchParams.get("q") ?? "").toUpperCase()];
      return name === undefined
        ? {
            recordedAt: "",
            status: 200,
            headers: {},
            body: { quotes: [] },
          }
        : recorded(name);
    }
    return undefined;
  });
  const yahoo = () => f.urls.filter((u) => u.hostname.includes("yahoo"));
  return {
    fetch: f.fetch,
    calls: {
      urls: f.urls,
      searches: () =>
        yahoo().filter((u) => u.pathname === "/v1/finance/search"),
      charts: (symbol) =>
        yahoo().filter((u) => {
          const s = chartSymbol(u);
          return s !== null && (symbol === undefined || s === symbol);
        }),
      sparks: () => yahoo().filter((u) => u.pathname === "/v7/finance/spark"),
    },
  };
}

// a call held in the fake fetch until released
export function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    // waits in the fake fetch until released
    async hold(): Promise<undefined> {
      reached();
      await opened;
      return undefined;
    },
    arrived,
    release: open,
  };
}
