// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// There is no documented API, so every page is read by its table ids and
// labels, and one that does not read is an error, never empty rows.

import { checkZone, dateOfWall } from "../../market/zone.ts";
import { SourceError } from "../source.ts";
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

export const DAY_S = 86_400;
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
  // Shares, Bonds, Units, index
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

// symbols uppercased to the feed's type: Shares, Units, Structured, ...
export function parseTypes(body: unknown): Map<string, string> {
  if (!Array.isArray(body)) throw malformed("no search list");
  const out = new Map<string, string>();
  for (const d of body) {
    if (!isObj(d)) continue;
    const symbol = typeof d.symbol === "string" ? d.symbol.trim() : "";
    const type = typeof d.type === "string" ? d.type.trim() : "";
    if (symbol !== "" && type !== "") out.set(symbol.toUpperCase(), type);
  }
  return out;
}
