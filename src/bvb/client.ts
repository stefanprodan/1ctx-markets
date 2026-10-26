// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Bucharest Stock Exchange read directly: its site's pages (ASP.NET,
// in Romanian) and the chart feed its pages call. There is no documented
// API, so every page is read by its table ids and labels, and one that
// does not read is an error, never empty rows.

import type { Clock } from "../clock.ts";
import {
  type Backoff,
  type Fetch,
  type Limiter,
  limiter,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";
import { checkZone, dateOfWall } from "../zone.ts";
import {
  column,
  malformed,
  optionalRoNumber,
  optionalRoWallTime,
  roClock,
  roNumber,
  rowsOf,
  type Status,
  statusOf,
  tableById,
  textOf,
} from "./format.ts";

export const SOURCE = "bvb";
export const MARKET = "BVB";
export const SITE = "https://bvb.ro";
export const WAPI = "https://wapi.bvb.ro/api";
// the probes' pace, which the site never refused
export const SPACING_MS = 2000;
const TIMEOUT_MS = 30_000;
// the User-Agent the probes were answered with
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const DAY_S = 86_400;
const MAX_SEARCH = 64;

export type { Status };

// prices with wall times: the site writes local time with no offset
export type ListRow = {
  symbol: string;
  isin: string | null;
  name: string | null;
  // null for a listing that has not traded
  price: number | null;
  at: number | null;
};

export type SharesPage = {
  status: Status;
  // from the price column's header, Pret (RON)
  currency: string;
  rows: ListRow[];
  fetchedAt: number;
};

export type BondRow = ListRow & { currency: string | null };

export type BondsPage = { status: Status; rows: BondRow[]; fetchedAt: number };

// no trade time: the page gives none
export type IndexRow = { symbol: string; value: number; change: number };

export type IndicesPage = {
  status: Status;
  rows: IndexRow[];
  fetchedAt: number;
};

export type Detail = {
  status: Status;
  symbol: string;
  isin: string | null;
  name: string | null;
  // Tip: Actiuni, Obligatiuni, ...
  kind: string;
  tradable: boolean;
  price: number | null;
  at: number | null;
  // Pret referinta, the previous session's close
  reference: number | null;
  high: number | null;
  low: number | null;
  fetchedAt: number;
};

// the regular market's continuous start and close, ms after local midnight
export type Schedule = {
  status: Status;
  start: number;
  end: number;
  fetchedAt: number;
};

export type Meta = {
  symbol: string;
  name: string | null;
  // Shares, Bonds, index
  type: string;
  currency: string | null;
  zone: string;
  expired: boolean;
};

export type HistoryBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
};

export type History = { bars: HistoryBar[]; fetchedAt: number };

export type Listing = {
  symbol: string;
  isin: string | null;
  name: string | null;
  // T tradable, D delisted
  status: string;
};

export type Bvb = {
  shares(): Promise<SharesPage>;
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
  // the symbols, uppercased, on the list pages last read; null until all
  // three are read, as an unread kind may hold the symbol
  listed(): ReadonlySet<string> | null;
  // when the list page of a kind was last read, null if never
  listedAt(kind: ListKind): number | null;
  failFast(): Bvb;
  within(live: () => boolean): Bvb;
  due(): number | null;
  backoff(): Backoff | null;
  close(): void;
};

export const LISTS = ["shares", "bonds", "indices"] as const;
export type ListKind = (typeof LISTS)[number];

export type BvbOptions = { clock: Clock; fetch?: Fetch };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const symbolCell = (html: string): { symbol: string; isin: string | null } => {
  const b = /<b>([\s\S]*?)<\/b>/.exec(html);
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(html);
  const symbol = b === null ? "" : textOf(b[1]!);
  if (symbol === "") throw malformed("a row without a symbol");
  const isin = p === null ? "" : textOf(p[1]!);
  return { symbol, isin: isin === "" ? null : isin };
};

function listTable(html: string): { headers: string[]; rows: string[][] } {
  const table = tableById(html, "gv");
  if (table === null) throw malformed("no table gv");
  const all = rowsOf(table);
  const headers = (all[0] ?? []).map(textOf);
  const rows = all.slice(1);
  // a regulated market always lists something
  if (rows.length === 0) throw malformed("an empty table");
  return { headers, rows };
}

export function parseShares(html: string, fetchedAt: number): SharesPage {
  const status = statusOf(html);
  const { headers, rows } = listTable(html);
  const symbol = column(headers, "Simbol");
  const name = column(headers, "Societate");
  const price = column(headers, "Pret (");
  const at = column(headers, "Data");
  const currency = /^Pret \(([A-Z]{3})\)$/.exec(headers[price]!)?.[1];
  if (currency === undefined) throw malformed("no price currency");
  return {
    status,
    currency,
    rows: rows.map((cells) => {
      if (cells.length !== headers.length) throw malformed("a short row");
      const s = symbolCell(cells[symbol]!);
      return {
        ...s,
        name: textOf(cells[name]!) || null,
        price: optionalRoNumber(textOf(cells[price]!), "price"),
        at: optionalRoWallTime(textOf(cells[at]!), "trade time"),
      };
    }),
    fetchedAt,
  };
}

export function parseBonds(html: string, fetchedAt: number): BondsPage {
  const status = statusOf(html);
  const { headers, rows } = listTable(html);
  const symbol = column(headers, "Simbol");
  const name = column(headers, "Societate");
  // percent of par
  const price = column(headers, "Pret (%)");
  const at = column(headers, "Data");
  const currency = column(headers, "Moneda");
  return {
    status,
    rows: rows.map((cells) => {
      if (cells.length !== headers.length) throw malformed("a short row");
      const s = symbolCell(cells[symbol]!);
      const c = textOf(cells[currency]!);
      return {
        ...s,
        name: textOf(cells[name]!) || null,
        price: optionalRoNumber(textOf(cells[price]!), "price"),
        at: optionalRoWallTime(textOf(cells[at]!), "trade time"),
        currency: /^[A-Z]{3}$/.test(c) ? c : null,
      };
    }),
    fetchedAt,
  };
}

// its header cells are blank, so columns are read by position and class
export function parseIndices(html: string, fetchedAt: number): IndicesPage {
  const status = statusOf(html);
  const table = tableById(html, "gvI");
  if (table === null) throw malformed("no table gvI");
  const rows = rowsOf(table).slice(1);
  if (rows.length === 0) throw malformed("an empty table");
  return {
    status,
    rows: rows.map((cells) => {
      const link = /IndicesProfiles\.aspx\?i=([^"&]+)"/.exec(cells[1] ?? "");
      if (link === null || cells.length !== 5) {
        throw malformed("an index row not of five cells");
      }
      return {
        symbol: decodeURIComponent(link[1]!),
        value: roNumber(textOf(cells[2]!), "index value"),
        change: roNumber(textOf(cells[3]!), "index change"),
      };
    }),
    fetchedAt,
  };
}

// a two-cell row's value by its label, in the table with this id
function labelled(html: string, id: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const table = tableById(html, id);
  if (table === null) return out;
  for (const cells of rowsOf(table)) {
    if (cells.length < 2) continue;
    const label = textOf(cells[0]!).replace(/:$/, "").trim();
    const list = out.get(label) ?? [];
    list.push(textOf(cells[1]!));
    out.set(label, list);
  }
  return out;
}

const KEY = /sk = '([^']+)'/;

// the chart feed's key, new on every load of an instrument's page
export function pageKey(html: string): string | null {
  return KEY.exec(html)?.[1] ?? null;
}

export function parseDetail(html: string, fetchedAt: number): Detail {
  const status = statusOf(html);
  const header = /<table class="date w100">([\s\S]*?)<\/table>/.exec(html);
  // an unknown symbol answers the page without its header
  if (header === null) throw new SourceError("not found");
  const fields = new Map<string, string>();
  for (const cells of rowsOf(`<table>${header[1]}`)) {
    if (cells.length === 2) {
      fields.set(textOf(cells[0]!).replace(/:$/, "").trim(), textOf(cells[1]!));
    }
  }
  const symbol = fields.get("Simbol") ?? "";
  const kind = fields.get("Tip") ?? "";
  if (symbol === "" || kind === "") throw malformed("no symbol or type");
  const name = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(html);
  const value =
    /<b class="value">([^<]*)<\/b>\s*<br \/>\s*<span class="date small">([^<]*)<\/span>/.exec(
      html,
    );
  const prices = labelled(html, "ctl00_body_ctl02_PricesControl_dvCPrices");
  if (prices.size === 0) throw malformed("no price table");
  const one = (label: string) => prices.get(label)?.[0] ?? "";
  return {
    status,
    symbol,
    isin: fields.get("ISIN") || null,
    name: name === null ? null : textOf(name[1]!) || null,
    kind,
    tradable: fields.get("Stare") === "Tranzactionabila",
    price: value === null ? null : optionalRoNumber(textOf(value[1]!), "price"),
    at:
      value === null
        ? null
        : optionalRoWallTime(textOf(value[2]!), "trade time"),
    reference: optionalRoNumber(one("Pret referinta"), "reference price"),
    high: optionalRoNumber(one("Pret maxim"), "high"),
    low: optionalRoNumber(one("Pret minim"), "low"),
    fetchedAt,
  };
}

// the regular market (REGS): continuous trading's start, and the close
// after the auction and trading at the last price
export function parseSchedule(html: string, fetchedAt: number): Schedule {
  const status = statusOf(html);
  const table = tableById(html, "gv");
  if (table === null) throw malformed("no table gv");
  const all = rowsOf(table);
  const headers = (all[0] ?? []).map(textOf);
  const continuous = column(headers, "Tranzactionare Continua");
  const closed = column(headers, "Inchisa");
  const regular = all
    .slice(1)
    .find((r) => textOf(r[0] ?? "").includes("(REGS)"));
  if (regular === undefined) throw malformed("no regular market row");
  const span = /^(\d{2}:\d{2}) - (\d{2}:\d{2})$/.exec(
    textOf(regular[continuous] ?? ""),
  );
  if (span === null) throw malformed("no continuous trading span");
  const start = roClock(span[1]!, "session start");
  const end = roClock(textOf(regular[closed] ?? ""), "session end");
  if (end <= start) throw malformed("a session ending before it starts");
  return { status, start, end, fetchedAt };
}

export function parseMeta(body: unknown): Meta {
  if (!isObj(body)) throw malformed("no symbol answer");
  // the feed's own form for a symbol it does not know
  if (body.s === "error" || body.s === "no_data") {
    throw new SourceError("not found");
  }
  const symbol = body.name;
  const type = body.type;
  if (typeof symbol !== "string" || symbol === "") throw malformed("no symbol");
  if (typeof type !== "string" || type === "") throw malformed("no type");
  let zone: string;
  try {
    zone = checkZone(body.timezone);
  } catch {
    throw malformed("no exchange zone");
  }
  const currency = body.currency_code;
  const name = body.description;
  return {
    symbol,
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
    type,
    // an index is priced in points: "-"
    currency:
      typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
        ? currency
        : null,
    zone,
    expired: body.expired === true,
  };
}

function columnOf(
  body: Obj,
  name: string,
  n: number,
  nullable: boolean,
): (number | null)[] {
  const v = body[name];
  if (!Array.isArray(v) || v.length !== n) {
    throw malformed(`${name} does not match the timestamps`);
  }
  return v.map((x) => {
    if (x === null && nullable) return null;
    if (typeof x !== "number" || !Number.isFinite(x)) {
      throw malformed(`${name} value`);
    }
    return x;
  });
}

// a window without trading still answers the last session's bars, and
// countback wins over from, so bars outside from and to are dropped
export function parseHistory(
  body: unknown,
  from: number,
  to: number,
  fetchedAt: number,
): History {
  if (!isObj(body)) throw malformed("no history answer");
  if (body.s === "no_data") throw new SourceError("not found");
  if (body.s !== "ok" || !Array.isArray(body.t)) {
    throw malformed("no history");
  }
  const n = body.t.length;
  const t = columnOf(body, "t", n, false) as number[];
  const o = columnOf(body, "o", n, true);
  const h = columnOf(body, "h", n, true);
  const l = columnOf(body, "l", n, true);
  const c = columnOf(body, "c", n, true);
  const v = columnOf(body, "v", n, true);
  const bars: HistoryBar[] = [];
  let last = "";
  for (let i = 0; i < n; i++) {
    // daily bars are stamped 00:00 UTC of the trading date
    if (!Number.isSafeInteger(t[i]) || t[i]! % DAY_S !== 0) {
      throw malformed("a bar off midnight UTC");
    }
    const date = dateOfWall(t[i]! * 1000);
    if (date <= last) throw malformed("bars out of order");
    last = date;
    if (t[i]! * 1000 < from || t[i]! * 1000 > to || c[i] === null) continue;
    bars.push({
      date,
      open: o[i]!,
      high: h[i]!,
      low: l[i]!,
      close: c[i]!,
      volume: v[i] === null ? null : Math.round(v[i]!),
    });
  }
  return { bars, fetchedAt };
}

export function parseSearch(body: unknown): Listing[] {
  if (!isObj(body) || !Array.isArray(body.d)) throw malformed("no search list");
  const out: Listing[] = [];
  for (const d of body.d) {
    if (!isObj(d)) continue;
    const symbol = typeof d.Symbol === "string" ? d.Symbol.trim() : "";
    const status = typeof d.Status === "string" ? d.Status.trim() : "";
    if (symbol === "" || status === "") continue;
    const isin = typeof d.Isin === "string" ? d.Isin.trim() : "";
    const name = typeof d.Name === "string" ? d.Name.trim() : "";
    out.push({
      symbol,
      isin: isin === "" ? null : isin,
      name: name === "" ? null : name,
      status,
    });
  }
  return out;
}

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
