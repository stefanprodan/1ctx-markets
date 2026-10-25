// Records Bucharest Stock Exchange (bvb.ro) answers as test fixtures.
// Run: bun scripts/probe/bvb.ts [case ...]   (no args records every case)
// The exchange has no documented API: pages are ASP.NET WebForms HTML, and
// the chart feed at wapi.bvb.ro needs the X-SK-API key that each instrument
// details page embeds. Calls are spaced so the site is never hammered.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://bvb.ro";
const WAPI = "https://wapi.bvb.ro/api";
const OUT = join(import.meta.dir, "../../test/fixtures/bvb");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const GAP_MS = 2500;
const MAX_BYTES = 1_000_000;

let lastCall = 0;
let calls = 0;

async function spaced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await Bun.sleep(wait);
  try {
    return await fn();
  } finally {
    lastCall = Date.now();
    calls++;
  }
}

type Answer = {
  status: number;
  contentType: string;
  text: string;
  cookies: string[];
};

async function call(
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Answer> {
  return spaced(async () => {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": UA, ...headers },
      body,
      redirect: "manual",
    });
    const text = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text,
      cookies: res.headers.getSetCookie().map((c) => c.split(";")[0]!),
    };
  });
}

// Fixtures must never carry a key or a session: the page key and any
// cookie-looking value are replaced before writing.
function scrub(text: string): string {
  return text
    .replace(/sk = '[^']*'/g, "sk = '[stripped]'")
    .replace(
      /(__VIEWSTATE|__EVENTVALIDATION)" value="[^"]*"/g,
      '$1" value="[stripped]"',
    );
}

function save(
  name: string,
  method: string,
  url: string,
  a: Answer,
  body: unknown,
  note?: string,
  requestBody?: string,
) {
  const fixture: Record<string, unknown> = {
    recordedAt: new Date().toISOString(),
    request:
      requestBody === undefined
        ? { method, url }
        : { method, url, body: requestBody },
    status: a.status,
    headers: { "content-type": a.contentType },
    body,
  };
  if (note) fixture.note = note;
  const json = JSON.stringify(fixture, null, 2) + "\n";
  if (json.length > MAX_BYTES)
    throw new Error(`${name}: fixture is ${json.length} bytes, trim it`);
  writeFileSync(join(OUT, `${name}.json`), json);
  console.log(`${name}: ${a.status} ${a.contentType} ${json.length}B`);
}

function parsed(a: Answer): unknown {
  if (!a.contentType.includes("json")) return a.text;
  try {
    return JSON.parse(a.text);
  } catch {
    return a.text;
  }
}

// HTML trimming: keep only the fragments that hold data.
function between(html: string, start: string, end: string): string {
  const i = html.indexOf(start);
  if (i < 0) return "";
  const j = html.indexOf(end, i + start.length);
  return j < 0 ? html.slice(i) : html.slice(i, j + end.length);
}

function tableById(html: string, id: string): string {
  const m = html.match(new RegExp(`<table[^>]*id="${id}"`));
  if (!m || m.index === undefined) return "";
  const j = html.indexOf("</table>", m.index);
  return html.slice(m.index, j + "</table>".length);
}

function fragments(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `<!-- fragment: ${k} -->\n${v.trim()}`)
    .join("\n");
}

const statusBlock = (html: string) =>
  between(html, '<div id="status">', "</div>");

function detailFragments(html: string): string {
  return scrub(
    fragments({
      status: statusBlock(html),
      header: between(
        html,
        '<div class="boxBC',
        '<div id="ctl00_body_HeaderControl_optionTools">',
      ),
      delayMarker: between(html, '<img class="delayedTimeImg', "/>"),
      prices: tableById(html, "ctl00_body_ctl02_PricesControl_dvCPrices"),
      indicators: tableById(
        html,
        "ctl00_body_ctl02_IndicatorsControl_dvIndicators",
      ),
      issue: tableById(html, "dvInfo"),
    }),
  );
}

const pageKey = (html: string) => html.match(/sk = '([^']+)'/)?.[1] ?? "";
const pageNote =
  "HTML trimmed to the data fragments (each preceded by a 'fragment:' comment); the page key and form state are stripped.";

let key = "";
async function wapi(
  name: string,
  path: string,
  opts: { noKey?: boolean; noReferer?: boolean; note?: string } = {},
) {
  const url = `${WAPI}/${path}`;
  const headers: Record<string, string> = opts.noReferer
    ? {}
    : { Origin: SITE, Referer: `${SITE}/` };
  if (!opts.noKey) headers["X-SK-API"] = key;
  const a = await call("GET", url, headers);
  save(name, "GET", url, a, parsed(a), opts.note);
}

async function detail(name: string, symbol: string, note?: string) {
  const url = `${SITE}/FinancialInstruments/Details/FinancialInstrumentsDetails.aspx?s=${symbol}`;
  const a = await call("GET", url);
  key ||= pageKey(a.text);
  save(
    name,
    "GET",
    url,
    a,
    detailFragments(a.text),
    note ? `${note} ${pageNote}` : pageNote,
  );
}

// Unix seconds for the history windows. A fixed "to" keeps re-recordings
// comparable; countback is required by the route (404 without it).
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const BONUS_FROM = Date.parse("2026-07-01T00:00:00Z") / 1000;
const BONUS_TO = Date.parse("2026-08-01T00:00:00Z") / 1000;

const cases: Record<string, () => Promise<void>> = {
  "detail-tlv": () => detail("detail-tlv", "TLV"),
  "detail-snp": () => detail("detail-snp", "SNP"),
  "detail-h2o": () => detail("detail-h2o", "H2O"),
  "detail-bond-r2807a": () =>
    detail(
      "detail-bond-r2807a",
      "R2807A",
      "Fidelis RON bond (prospectus link names Fidelis).",
    ),
  "detail-unknown": () => detail("detail-unknown", "ZZZZ", "Unknown symbol."),

  "wapi-config": () => wapi("wapi-config", "config?withNews=false&lang=ro"),
  "wapi-time": () =>
    wapi("wapi-time", "time", {
      note: "Server time, Unix seconds UTC, as a bare number.",
    }),
  "wapi-symbols-tlv": () => wapi("wapi-symbols-tlv", "symbols?symbol=TLV"),
  "wapi-symbols-bet": () => wapi("wapi-symbols-bet", "symbols?symbol=BET"),
  "wapi-symbols-r2807a": () =>
    wapi("wapi-symbols-r2807a", "symbols?symbol=R2807A"),
  "wapi-symbols-unknown": () =>
    wapi("wapi-symbols-unknown", "symbols?symbol=ZZZZ"),
  "wapi-history-tlv-1d": () =>
    wapi(
      "wapi-history-tlv-1d",
      `history?symbol=TLV&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-tlv-1d-unadjusted": () =>
    wapi(
      "wapi-history-tlv-1d-unadjusted",
      `history?symbol=TLV&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=0&countback=30&currencyCode=RON`,
    ),
  "wapi-history-tlv-1w": () =>
    wapi(
      "wapi-history-tlv-1w",
      `history?symbol=TLV&from=${now - 120 * DAY}&to=${now}&rs=1W&ajust=1&countback=12&currencyCode=RON`,
    ),
  // The 2026-07-16 bonus-share issue: does ajust=1 rewrite the bars before it?
  "wapi-history-tlv-1d-bonus-2026": () =>
    wapi(
      "wapi-history-tlv-1d-bonus-2026",
      `history?symbol=TLV&from=${BONUS_FROM}&to=${BONUS_TO}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-tlv-1d-bonus-2026-unadjusted": () =>
    wapi(
      "wapi-history-tlv-1d-bonus-2026-unadjusted",
      `history?symbol=TLV&from=${BONUS_FROM}&to=${BONUS_TO}&rs=1D&ajust=0&countback=30&currencyCode=RON`,
    ),
  "wapi-history-snp-1d": () =>
    wapi(
      "wapi-history-snp-1d",
      `history?symbol=SNP&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-h2o-1d": () =>
    wapi(
      "wapi-history-h2o-1d",
      `history?symbol=H2O&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-tlv-1min-closed": () =>
    wapi(
      "wapi-history-tlv-1min-closed",
      `history?symbol=TLV&from=${now - DAY / 2}&to=${now}&rs=1&ajust=1&countback=400&currencyCode=RON`,
      {
        note: "1-minute bars asked for a window with no session (a Sunday): the feed answers with the last session's bars instead of no_data.",
      },
    ),
  "wapi-history-bet-1d": () =>
    wapi(
      "wapi-history-bet-1d",
      `history?symbol=BET&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=-`,
    ),
  "wapi-history-r2807a-1d": () =>
    wapi(
      "wapi-history-r2807a-1d",
      `history?symbol=R2807A&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-unknown": () =>
    wapi(
      "wapi-history-unknown",
      `history?symbol=ZZZZ&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
    ),
  "wapi-history-no-countback": () =>
    wapi(
      "wapi-history-no-countback",
      `history?symbol=TLV&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1`,
      {
        note: "Without countback the route does not match: 404.",
      },
    ),
  "wapi-history-no-key": () =>
    wapi(
      "wapi-history-no-key",
      `history?symbol=TLV&from=${now - 45 * DAY}&to=${now}&rs=1D&ajust=1&countback=30&currencyCode=RON`,
      {
        noKey: true,
        note: "No X-SK-API header, but Origin and Referer of bvb.ro: accepted (a bvb.ro Referer alone is enough).",
      },
    ),
  "wapi-symbols-no-auth": () =>
    wapi("wapi-symbols-no-auth", "symbols?symbol=TLV", {
      noKey: true,
      noReferer: true,
      note: "Neither X-SK-API nor a bvb.ro Referer: 401.",
    }),
  "wapi-search-transilvania": () =>
    wapi(
      "wapi-search-transilvania",
      "search?limit=30&query=TRANSILVANIA&type=&exchange=",
    ),
  "wapi-search-limit-31": () =>
    wapi(
      "wapi-search-limit-31",
      "search?limit=31&query=TRANSILVANIA&type=&exchange=",
      {
        note: "A limit above 30 is refused with a JSON string body and HTTP 200.",
      },
    ),

  "instruments-autocomplete-petrom": async () => {
    const url = `${SITE}/proxyshld.aspx/GetInstrumentsList`;
    const body = "{'searchtext':'petrom'}";
    const a = await call(
      "POST",
      url,
      { "Content-Type": "application/json" },
      body,
    );
    save(
      "instruments-autocomplete-petrom",
      "POST",
      url,
      a,
      parsed(a),
      "Site search box; no key or cookie needed; at most 10 matches.",
      body,
    );
  },
  "instruments-autocomplete-isin": async () => {
    const url = `${SITE}/proxyshld.aspx/GetInstrumentsList`;
    const body = "{'searchtext':'RO4Q0Z5RO1B6'}";
    const a = await call(
      "POST",
      url,
      { "Content-Type": "application/json" },
      body,
    );
    save(
      "instruments-autocomplete-isin",
      "POST",
      url,
      a,
      parsed(a),
      "Search by ISIN (Hidroelectrica).",
      body,
    );
  },

  "shares-list": async () => {
    const url = `${SITE}/FinancialInstruments/Markets/Shares`;
    const a = await call("GET", url);
    save(
      "shares-list",
      "GET",
      url,
      a,
      scrub(
        fragments({
          status: statusBlock(a.text),
          table: tableById(a.text, "gv"),
        }),
      ),
      `Regulated market (default). ${pageNote}`,
    );
    // The AeRO segment is a WebForms postback of the segment button.
    const form = (n: string) =>
      a.text.match(new RegExp(`name="${n}" id="${n}" value="([^"]*)"`))?.[1] ??
      "";
    const fields = new URLSearchParams({
      ctl00$ctl00$MasterScriptManager:
        "ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$updsgm|ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$ms3",
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      __VIEWSTATE: form("__VIEWSTATE"),
      __VIEWSTATEGENERATOR: form("__VIEWSTATEGENERATOR"),
      __EVENTVALIDATION: form("__EVENTVALIDATION"),
      ctl00$ctl00$body$rightColumnPlaceHolder$TCtrl$ddlTier: "",
      __ASYNCPOST: "true",
      ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$ms3: "AeRO",
    });
    const p = await call(
      "POST",
      url,
      {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-MicrosoftAjax": "Delta=true",
        "X-Requested-With": "XMLHttpRequest",
        Cookie: a.cookies.join("; "),
        Origin: SITE,
        Referer: url,
      },
      fields.toString(),
    );
    save(
      "shares-list-aero",
      "POST",
      url,
      p,
      scrub(
        fragments({
          status: statusBlock(p.text),
          table: tableById(p.text, "gv"),
        }),
      ),
      `AeRO segment via an ASP.NET AJAX partial postback (X-MicrosoftAjax: Delta=true, __ASYNCPOST=true, the script-manager field naming the update panel and button, the GET's hidden form fields and cookies); the answer is text/plain in the length|type|id|content delta format, with the table inside. ${pageNote}`,
      "ctl00$ctl00$MasterScriptManager=ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$updsgm|ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$ms3&__EVENTTARGET=&__EVENTARGUMENT=&__LASTFOCUS=&__VIEWSTATE=[stripped]&__VIEWSTATEGENERATOR=[from GET]&__EVENTVALIDATION=[stripped]&ctl00$ctl00$body$rightColumnPlaceHolder$TCtrl$ddlTier=&__ASYNCPOST=true&ctl00$ctl00$body$rightColumnPlaceHolder$MSCtrl$ms3=AeRO",
    );
  },
  "bonds-list": async () => {
    const url = `${SITE}/FinancialInstruments/Markets/Bonds`;
    const a = await call("GET", url);
    save(
      "bonds-list",
      "GET",
      url,
      a,
      scrub(
        fragments({
          status: statusBlock(a.text),
          table: tableById(a.text, "gv"),
        }),
      ),
      `Regulated market bonds, all currencies; price column is percent of par. ${pageNote}`,
    );
  },
  "markets-today": async () => {
    const url = `${SITE}/TradingAndStatistics/Trading/MarketsToday`;
    const a = await call("GET", url);
    save(
      "markets-today",
      "GET",
      url,
      a,
      scrub(
        fragments({
          status: statusBlock(a.text),
          summary: tableById(a.text, "gvH"),
          indices: tableById(a.text, "gvI"),
          stats: tableById(a.text, "gvES"),
        }),
      ),
      `Index table gvI is marked real time on the page; top-3 share tables are marked 15 min delayed. ${pageNote}`,
    );
  },
  "trading-schedule": async () => {
    const url = `${SITE}/TradingAndStatistics/TradingSessionSchedule`;
    const a = await call("GET", url);
    const body = between(a.text, "<h1", "<footer").replace(
      /<script[\s\S]*?<\/script>/g,
      "",
    );
    save(
      "trading-schedule",
      "GET",
      url,
      a,
      scrub(fragments({ status: statusBlock(a.text), content: body })),
      `Holidays and session phases. ${pageNote}`,
    );
  },
  "shares-list-en": async () => {
    const url = `${SITE}/FinancialInstruments/Markets/Shares`;
    const a = await call("GET", url, { Cookie: "BVBCulturePref=en-US" });
    save(
      "shares-list-en",
      "GET",
      url,
      a,
      scrub(fragments({ table: tableById(a.text, "gv") })),
      `Same page with the BVBCulturePref=en-US cookie: dot decimals and US 12-hour dates. ${pageNote}`,
    );
  },
};

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(cases);
// The wapi cases need a page key; the TLV details page provides it.
if (names.some((n) => n.startsWith("wapi-")) && !names.includes("detail-tlv"))
  names.unshift("detail-tlv");
for (const n of names) {
  const fn = cases[n];
  if (!fn) throw new Error(`unknown case ${n}`);
  await fn();
}
console.log(`${calls} requests`);
