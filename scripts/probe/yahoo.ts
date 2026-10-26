// Records Yahoo Finance chart, search and quote answers as test fixtures.
// Usage: bun scripts/probe/yahoo.ts [case-name ...]   (no names = all cases)
// Requests are spaced and few on purpose: Yahoo's limits are unpublished.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "..", "..", "test", "fixtures", "yahoo");
const GAP_MS = 3000;

// a full Chrome UA draws 429s (chart-429-chrome-ua.json); the bare token passes
const UA = "Mozilla/5.0";

const Q1 = "https://query1.finance.yahoo.com";
const Q2 = "https://query2.finance.yahoo.com";

const utc = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const chart = (
  host: string,
  symbol: string,
  params: Record<string, string | number | boolean>,
) =>
  `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${new URLSearchParams(
    Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]),
  )}`;

const search = (q: string) =>
  `${Q1}/v1/finance/search?${new URLSearchParams({ q, quotesCount: "10", newsCount: "0", listsCount: "0" })}`;

type Case = { name: string; url: string };

const CASES: Case[] = [
  // Access without cookie or crumb, both hosts, and the UA quirk.
  {
    name: "chart-sol-usd-5d-1d",
    url: chart(Q1, "SOL-USD", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-sol-usd-5d-1d-query2",
    url: chart(Q2, "SOL-USD", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-unknown-symbol",
    url: chart(Q1, "NOPE-ZZZZ", { range: "5d", interval: "1d" }),
  },

  // A live day (crypto trades on weekends).
  {
    name: "chart-btc-usd-5d-1d",
    url: chart(Q1, "BTC-USD", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-btc-usd-1d-15m",
    url: chart(Q1, "BTC-USD", { range: "1d", interval: "15m" }),
  },
  {
    name: "chart-sol-usd-5d-1h",
    url: chart(Q1, "SOL-USD", { range: "5d", interval: "1h" }),
  },
  // Daily bars to check which days a crypto 1wk bar holds.
  {
    name: "chart-sol-usd-1mo-1d",
    url: chart(Q1, "SOL-USD", { range: "1mo", interval: "1d" }),
  },

  // NVDA 10-for-1 split, effective 2024-06-10.
  {
    name: "chart-nvda-split-2024",
    url: chart(Q1, "NVDA", {
      period1: utc("2024-05-20T00:00:00Z"),
      period2: utc("2024-06-22T00:00:00Z"),
      interval: "1d",
      events: "div,split",
    }),
  },
  // A Bucharest bonus-share issue, which Yahoo gives as a split (114.42:100).
  {
    name: "chart-tlv-ro-bonus-2026",
    url: chart(Q1, "TLV.RO", {
      period1: utc("2026-07-01T00:00:00Z"),
      period2: utc("2026-08-01T00:00:00Z"),
      interval: "1d",
      events: "div,split",
    }),
  },
  {
    name: "chart-nvda-5y-1d",
    url: chart(Q1, "NVDA", {
      range: "5y",
      interval: "1d",
      events: "div,split",
    }),
  },

  // Weekly bar boundaries.
  {
    name: "chart-vvsm-de-3mo-1wk",
    url: chart(Q1, "VVSM.DE", { range: "3mo", interval: "1wk" }),
  },
  {
    name: "chart-nvda-3mo-1wk",
    url: chart(Q1, "NVDA", { range: "3mo", interval: "1wk" }),
  },
  {
    name: "chart-sol-usd-3mo-1wk",
    url: chart(Q1, "SOL-USD", { range: "3mo", interval: "1wk" }),
  },

  // Trading periods and zones (intraday intervals carry tradingPeriods).
  {
    name: "chart-vvsm-de-5d-1d",
    url: chart(Q1, "VVSM.DE", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-vvsm-de-5d-1h",
    url: chart(Q1, "VVSM.DE", { range: "5d", interval: "1h" }),
  },
  {
    name: "chart-nvda-5d-1d",
    url: chart(Q1, "NVDA", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-nvda-5d-1h-prepost",
    url: chart(Q1, "NVDA", {
      range: "5d",
      interval: "1h",
      includePrePost: true,
    }),
  },
  {
    name: "chart-nvda-5d-1h",
    url: chart(Q1, "NVDA", { range: "5d", interval: "1h" }),
  },
  // Search lists Bucharest listings under exchange BVB.
  {
    name: "chart-h2o-ro-5d-1d",
    url: chart(Q1, "H2O.RO", { range: "5d", interval: "1d" }),
  },

  // Market instruments.
  {
    name: "chart-vix-5d-1d",
    url: chart(Q1, "^VIX", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-tnx-5d-1d",
    url: chart(Q1, "^TNX", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-cl-f-5d-1d",
    url: chart(Q1, "CL=F", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-hyg-5d-1d",
    url: chart(Q1, "HYG", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-sox-5d-1d",
    url: chart(Q1, "^SOX", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-gspc-5d-1d",
    url: chart(Q1, "^GSPC", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-ndx-5d-1d",
    url: chart(Q1, "^NDX", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-eurusd-x-5d-1d",
    url: chart(Q1, "EURUSD=X", { range: "5d", interval: "1d" }),
  },

  { name: "search-nvda", url: search("NVDA") },
  { name: "search-vvsm", url: search("VVSM") },
  { name: "search-hidroelectrica", url: search("Hidroelectrica") },
  { name: "search-tlv", url: search("TLV") },
  { name: "search-solana", url: search("Solana") },
  // A NYSE listing, for its exchange code.
  { name: "search-ko", url: search("KO") },

  {
    name: "quote-v7-batch",
    url: `${Q1}/v7/finance/quote?symbols=NVDA,VVSM.DE,SOL-USD`,
  },
  {
    name: "quote-v7-batch-query2",
    url: `${Q2}/v7/finance/quote?symbols=NVDA,VVSM.DE,SOL-USD`,
  },
  {
    name: "spark-v8-batch",
    url: `${Q1}/v8/finance/spark?symbols=NVDA,VVSM.DE,SOL-USD&range=5d&interval=1d`,
  },
  // v7 spark carries a chart meta per symbol (price time, session); v8 does not.
  {
    name: "spark-v7-batch",
    url: `${Q1}/v7/finance/spark?symbols=NVDA,VVSM.DE,SOL-USD,TLV.RO,EURUSD%3DX&range=1d&interval=5m`,
  },
  // Yahoo caps a spark call at 20 symbols; 21 is a 400.
  {
    name: "spark-v7-21-symbols",
    url: `${Q1}/v7/finance/spark?symbols=A,B,C,D,F,GE,HD,IBM,JPM,KO,MA,MO,MU,NKE,PG,T,UL,V,VZ,WMT,XOM&range=1d&interval=5m`,
  },
];

// Only headers a client may act on; cookies are never stored.
const KEEP =
  /^(content-type|cache-control|retry-after|x-ratelimit-.*|ratelimit.*|age)$/i;

async function record(c: Case) {
  const res = await fetch(c.url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (KEEP.test(k)) headers[k] = v;
  });
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const fixture = {
    recordedAt: new Date().toISOString(),
    request: { method: "GET", url: c.url },
    status: res.status,
    headers,
    body,
  };
  const out = JSON.stringify(fixture, null, 2) + "\n";
  writeFileSync(join(OUT, `${c.name}.json`), out);
  const extra = Object.entries(headers)
    .filter(([k]) => !/^(content-type|cache-control|age)$/.test(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `${res.status} ${c.name} ${(out.length / 1024).toFixed(1)} KiB ${extra}`,
  );
}

const wanted = process.argv.slice(2);
const run = wanted.length
  ? CASES.filter((c) => wanted.includes(c.name))
  : CASES;
const missing = wanted.filter((w) => !CASES.some((c) => c.name === w));
if (missing.length) throw new Error(`unknown case: ${missing.join(", ")}`);

mkdirSync(OUT, { recursive: true });
for (const [i, c] of run.entries()) {
  if (i > 0) await Bun.sleep(GAP_MS);
  await record(c);
}
