// Requests are spaced and few on purpose: Yahoo's limits are unpublished.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrub } from "../../src/sources/source.ts";

const OUT = join(import.meta.dir, "..", "..", "test", "fixtures", "yahoo");
const GAP_MS = 3000;
// a dated recording keeps the baseline fixture: PROBE_SUFFIX=open-0800
const SUFFIX = process.env.PROBE_SUFFIX ? `-${process.env.PROBE_SUFFIX}` : "";

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

// session: asked with the cookie and crumb, which are scrubbed before writing
type Case = { name: string; url: string; session?: boolean };

const summary = (symbol: string, modules = "defaultKeyStatistics,price") =>
  `${Q2}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;

const holdings = (symbol: string) => summary(symbol, "topHoldings,price");

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
  // an index and its CME futures, recorded dated (PROBE_SUFFIX) with the
  // index closed: overnight, CME's daily break and a weekend
  ...["^GSPC", "ES=F", "^N225", "NIY=F"].flatMap((symbol) => {
    const slug = symbol.toLowerCase().replace(/[\^]/g, "").replace("=", "-");
    return [
      {
        name: `chart-${slug}-5d-1d`,
        url: chart(Q1, symbol, { range: "5d", interval: "1d" }),
      },
      {
        name: `chart-${slug}-1d-5m`,
        url: chart(Q1, symbol, { range: "1d", interval: "5m" }),
      },
    ];
  }),
  {
    name: "spark-v7-index-futures",
    url: `${Q1}/v7/finance/spark?symbols=%5EGSPC,ES%3DF,%5EN225,NIY%3DF&range=1d&interval=5m`,
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
    name: "chart-dji-5d-1d",
    url: chart(Q1, "^DJI", { range: "5d", interval: "1d" }),
  },
  // a future other than oil, on another exchange
  {
    name: "chart-gc-f-5d-1d",
    url: chart(Q1, "GC=F", { range: "5d", interval: "1d" }),
  },
  {
    name: "chart-eurusd-x-5d-1d",
    url: chart(Q1, "EURUSD=X", { range: "5d", interval: "1d" }),
  },
  // No currency in its meta, and on a weekday no grid row for today.
  {
    name: "chart-eurron-x-5d-1d",
    url: chart(Q1, "EURRON=X", { range: "5d", interval: "1d" }),
  },

  { name: "search-nvda", url: search("NVDA") },
  { name: "search-vvsm", url: search("VVSM") },
  { name: "search-hidroelectrica", url: search("Hidroelectrica") },
  { name: "search-tlv", url: search("TLV") },
  { name: "search-solana", url: search("Solana") },
  // A NYSE listing, for its exchange code.
  { name: "search-ko", url: search("KO") },
  // how Yahoo names the Bucharest indices
  { name: "search-bet", url: search("BET") },
  // a live session's intraday bars, for the trailing row and the delay
  {
    name: "chart-tlv-ro-1d-5m",
    url: chart(Q1, "TLV.RO", { range: "1d", interval: "5m" }),
  },
  {
    name: "chart-vvsm-de-1d-5m",
    url: chart(Q1, "VVSM.DE", { range: "1d", interval: "5m" }),
  },

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
  // Extended hours: 1-minute bars with pre and post trading, recorded
  // dated (PROBE_SUFFIX) in the post window, overnight and pre-market.
  ...["HOOD", "VWCE.DE", "BTC-USD", "TLV.RO"].map((symbol) => ({
    name: `chart-${symbol.toLowerCase().replace(".", "-")}-1d-1m-prepost`,
    url: chart(Q1, symbol, {
      range: "1d",
      interval: "1m",
      includePrePost: true,
    }),
  })),
  {
    name: "chart-hood-2d-1m-prepost",
    url: chart(Q1, "HOOD", {
      range: "2d",
      interval: "1m",
      includePrePost: true,
    }),
  },
  {
    name: "spark-v7-extended",
    url: `${Q1}/v7/finance/spark?symbols=HOOD,VWCE.DE,BTC-USD,TLV.RO&range=1d&interval=5m`,
  },
  // five sessions of regular-hours 5-minute closes, for the points backfill
  ...["AAPL", "EURUSD=X", "BTC-USD"].map((symbol) => ({
    name: `chart-${symbol.toLowerCase().replace("=", "-")}-5d-5m`,
    url: chart(Q1, symbol, {
      range: "5d",
      interval: "5m",
      includePrePost: false,
    }),
  })),
  // The quote summary needs the session a browser gets; without it, 401.
  { name: "quotesummary-tsm", url: summary("TSM"), session: true },
  { name: "quotesummary-asml", url: summary("ASML"), session: true },
  { name: "quotesummary-no-crumb", url: summary("TSM") },
  // A fund's top holdings: an ETF, a mutual fund, a bond fund, two
  // UCITS ETFs (one without holdings); a fund Yahoo has none for and a
  // share answer their price alone, never a 404, since price is asked.
  { name: "topholdings-qqq", url: holdings("QQQ"), session: true },
  { name: "topholdings-vfiax", url: holdings("VFIAX"), session: true },
  { name: "topholdings-agg", url: holdings("AGG"), session: true },
  { name: "topholdings-icga-de", url: holdings("ICGA.DE"), session: true },
  { name: "topholdings-xcha-de", url: holdings("XCHA.DE"), session: true },
  {
    name: "topholdings-tvbetetf-ro",
    url: holdings("TVBETETF.RO"),
    session: true,
  },
  { name: "topholdings-aapl", url: holdings("AAPL"), session: true },
  // Yahoo caps a spark call at 20 symbols; 21 is a 400.
  {
    name: "spark-v7-21-symbols",
    url: `${Q1}/v7/finance/spark?symbols=A,B,C,D,F,GE,HD,IBM,JPM,KO,MA,MO,MU,NKE,PG,T,UL,V,VZ,WMT,XOM&range=1d&interval=5m`,
  },
];

// Only headers a client may act on; cookies are never stored.
const KEEP =
  /^(content-type|cache-control|retry-after|x-ratelimit-.*|ratelimit.*|age)$/i;

type Session = { cookie: string; crumb: string };
let session: Session | null = null;

// a fetch error can quote the URL, which holds the crumb: none is printed
async function get(
  what: string,
  url: string,
  init: RequestInit,
): Promise<{ res: Response; text: string }> {
  try {
    const res = await fetch(url, init);
    return { res, text: await res.text() };
  } catch {
    throw new Error(`${what}: request failed`);
  }
}

// fc.yahoo.com sets the cookie whatever its status; getcrumb answers the
// crumb as text. Neither value is printed or written.
async function startSession(): Promise<Session> {
  const fc = await get("fc.yahoo.com", "https://fc.yahoo.com/", {
    headers: { "User-Agent": UA },
    redirect: "manual",
  });
  const cookie = fc.res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!.trim())
    .join("; ");
  if (cookie === "") throw new Error(`no cookie (HTTP ${fc.res.status})`);
  console.log(`${fc.res.status} fc.yahoo.com`);
  await Bun.sleep(GAP_MS);
  const res = await get("getcrumb", `${Q1}/v1/test/getcrumb`, {
    headers: { "User-Agent": UA, Cookie: cookie },
  });
  const crumb = res.text.trim();
  console.log(`${res.res.status} getcrumb`);
  if (!res.res.ok || crumb === "") {
    throw new Error(`no crumb (HTTP ${res.res.status})`);
  }
  await Bun.sleep(GAP_MS);
  return { cookie, crumb };
}

// the crumb, the cookie, each of its pairs and each value, raw and
// JSON-escaped; scrub() adds the URL- and form-encoded forms of each
function secrets(s: Session): string[] {
  const pairs = s.cookie.split(";").map((p) => p.trim());
  const values = pairs.map((p) => p.slice(p.indexOf("=") + 1));
  const out = new Set<string>();
  for (const v of [s.crumb, s.cookie, ...pairs, ...values]) {
    if (v.length < 4) continue;
    const json = JSON.stringify(v).slice(1, -1);
    for (const f of [v, json, json.replaceAll("/", "\\/")]) out.add(f);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const hide = (text: string, s: Session | null) =>
  s === null ? text : secrets(s).reduce((t, f) => scrub(t, f), text);

function clean(value: unknown, s: Session | null): unknown {
  if (typeof value === "string") return hide(value, s);
  if (Array.isArray(value)) return value.map((v) => clean(v, s));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [hide(k, s), clean(v, s)]),
    );
  }
  return value;
}

async function record(c: Case) {
  if (c.session && session === null) session = await startSession();
  const s = c.session ? session : null;
  const url =
    s === null ? c.url : `${c.url}&crumb=${encodeURIComponent(s.crumb)}`;
  const { res, text: raw } = await get(c.name, url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...(s === null ? {} : { Cookie: s.cookie }),
    },
  });
  // the text before parsing, for escaped forms; the values after, for raw
  const text = hide(raw, s);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (KEEP.test(k)) headers[k] = hide(v, s);
  });
  let body: unknown = text;
  try {
    body = clean(JSON.parse(text), s);
  } catch {}
  const fixture = {
    recordedAt: new Date().toISOString(),
    request: {
      method: "GET",
      url: s === null ? c.url : `${c.url}&crumb=REDACTED`,
    },
    status: res.status,
    headers,
    body,
  };
  const out = `${JSON.stringify(fixture, null, 2)}\n`;
  if (s !== null && secrets(s).some((f) => out.includes(f))) {
    throw new Error(`${c.name}: the session is still in the fixture`);
  }
  writeFileSync(join(OUT, `${c.name}${SUFFIX}.json`), out);
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
