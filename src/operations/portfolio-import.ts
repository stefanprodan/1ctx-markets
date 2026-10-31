// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A file is read, checked and shown before anything is saved; saving reads
// it again, so the preview and the save never disagree on a row.

import { type Instrument, readInstrument } from "../market/instruments.ts";
import { localDate } from "../market/zone.ts";
import {
  formatCsv,
  parseCsv,
  parseDay,
  parseNumber,
} from "../portfolios/csv.ts";
import { rates } from "../portfolios/fx.ts";
import {
  type Broker,
  insertPosition,
  insertTrade,
  listBrokers,
  MAX_NOTE,
  MAX_POSITION_NAME,
  type NewPosition,
  type NewTrade,
  type Portfolio,
  type Position,
  type PositionKind,
  readBroker,
  readTrades,
  type Split,
  samePosition,
  setPositionRemoved,
  splitsOf,
  type Trade,
} from "../portfolios/store.ts";
import { sellStep, splitFactor, statedOf } from "../portfolios/value.ts";
import { isCurrencyCode } from "../shared/currencies.ts";
import { FRED, YAHOO } from "../sources/ids.ts";
import type { Db } from "../storage/db/index.ts";
import type { Failure } from "./answer.ts";
import { ArgError, fields, text } from "./args.ts";
import type { Markets } from "./markets.ts";
import {
  findBroker,
  findPortfolio,
  latestDay,
  MAX_AMOUNT,
  ownerToday,
  ref,
} from "./portfolio.ts";
import { readTargets } from "./targets.ts";
import type { Who } from "./who.ts";

export const IMPORT_KINDS = ["trades", "cash", "funds", "bonds"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

// a Yahoo export of a few thousand trades
export const MAX_CSV_BYTES = 448 * 1024;
// the JSON body that carries it: quotes and line ends escape to two
// bytes each, so a file at the cap may double; under Bun's 1 MiB
export const MAX_IMPORT_BODY = 2 * MAX_CSV_BYTES + 16 * 1024;
export const MAX_ROWS = 5000;

// Yahoo's portfolio export, in its order
export const YAHOO_HEADER = [
  "Symbol",
  "Current Price",
  "Date",
  "Time",
  "Change",
  "Open",
  "High",
  "Low",
  "Volume",
  "Trade Date",
  "Purchase Price",
  "Quantity",
  "Commission",
  "High Limit",
  "Low Limit",
  "Comment",
  "Transaction Type",
] as const;

// Yahoo has no column for a broker, the currency paid or the day an
// export restated its lots, so they ride in Comment as leading tags,
// [broker North][paid EUR 9.5][as of 2026-04-17], the note after them as
// written; the paid tag's price is the price paid when Purchase Price
// holds the listing's; a note starting with [ or a backslash gets a
// backslash first, so any note reads back as it was
const TAG = /^\[(broker|paid|as of) ((?:[^\]\\]|\\.)*)\]/;
const unmark = (v: string) => v.replace(/\\(.)/g, "$1");
const mark = (v: string) => v.replace(/[\]\\]/g, "\\$&");

export function commentOf(t: {
  broker: string | null;
  paid: string | null;
  paidPrice?: string | null;
  note: string | null;
  statedOn?: string | null;
}): string {
  const tags = `${t.broker === null ? "" : `[broker ${mark(t.broker)}]`}${
    t.paid === null
      ? ""
      : `[paid ${mark(t.paid)}${t.paidPrice ? ` ${mark(t.paidPrice)}` : ""}]`
  }${t.statedOn ? `[as of ${t.statedOn}]` : ""}`;
  const note = t.note ?? "";
  const lead = tags !== "" && note !== "" ? " " : "";
  const marked = /^[[\\]/.test(note) ? `\\${note}` : note;
  return `${tags}${lead}${marked}`;
}

export function readComment(raw: string): {
  broker: string | null;
  paid: string | null;
  paidPrice: string | null;
  note: string | null;
  statedOn: string | null;
} {
  let rest = raw;
  let broker: string | null = null;
  let paid: string | null = null;
  let paidPrice: string | null = null;
  let statedOn: string | null = null;
  let tagged = false;
  for (;;) {
    const m = TAG.exec(rest);
    if (m === null) break;
    tagged = true;
    if (m[1] === "broker") broker = unmark(m[2]!);
    else if (m[1] === "paid") {
      // a code has no space: what follows one is the price paid
      const v = unmark(m[2]!);
      const at = v.indexOf(" ");
      paid = at < 0 ? v : v.slice(0, at);
      paidPrice = at < 0 ? null : v.slice(at + 1);
    } else statedOn = unmark(m[2]!);
    rest = rest.slice(m[0].length);
  }
  if (tagged && rest.startsWith(" ")) rest = rest.slice(1);
  // the mark export puts before a note starting with [ or a backslash;
  // any other backslash is the note's own
  if (/^\\[[\\]/.test(rest)) rest = rest.slice(1);
  // only spaces is no note
  return {
    broker,
    paid,
    paidPrice,
    note: rest.trim() === "" ? null : rest,
    statedOn,
  };
}

type Status = "ok" | "bad" | "skipped" | "saved";

export type ImportRow = {
  // the line in the file, the header being 1
  line: number;
  status: Status;
  reason?: string;
  warning?: string;
  replaces?: number;
  item?: Record<string, unknown>;
};

export type ImportArgs = {
  portfolio: number | string;
  csv: string;
  broker: string | null;
  // the cash file's currency when its header names none
  currency: string | null;
  confirm: boolean;
  // the cash rows, by line, the owner marked as dry powder
  dryPowder: number[];
};

export function parseImport(body: unknown): ImportArgs {
  const f = fields(body, [
    "portfolio",
    "csv",
    "broker",
    "currency",
    "confirm",
    "dry_powder",
  ]);
  const portfolio = ref(f.portfolio);
  if (portfolio === null) throw new ArgError("portfolio is a name or an id");
  if (typeof f.csv !== "string" || f.csv.trim() === "") {
    throw new ArgError("csv is the file's text");
  }
  if (Buffer.byteLength(f.csv) > MAX_CSV_BYTES) {
    throw new ArgError(`csv is at most ${MAX_CSV_BYTES / 1024} KiB`);
  }
  if (f.confirm !== undefined && typeof f.confirm !== "boolean") {
    throw new ArgError("confirm must be true or false");
  }
  const dry = f.dry_powder ?? [];
  if (
    !Array.isArray(dry) ||
    dry.some((n) => typeof n !== "number" || !Number.isSafeInteger(n))
  ) {
    throw new ArgError("dry_powder is a list of the cash file's lines");
  }
  const currency = f.currency ?? null;
  if (
    currency !== null &&
    (typeof currency !== "string" || !isCurrencyCode(currency))
  ) {
    throw new ArgError(
      "currency must be an ISO 4217 currency code in circulation, such as EUR",
    );
  }
  return {
    portfolio,
    csv: f.csv,
    broker:
      f.broker === undefined || f.broker === null
        ? null
        : text(f.broker, "broker"),
    currency: currency as string | null,
    confirm: f.confirm === true,
    dryPowder: dry as number[],
  };
}

const norm = (h: string) => h.trim().toLowerCase();

export function kindOf(header: readonly string[]): ImportKind | null {
  const h = new Set(header.map(norm));
  const has = (...names: string[]) => names.every((n) => h.has(n));
  if (has("symbol", "trade date", "purchase price", "quantity"))
    return "trades";
  if (has("fund", "currency", "units", "value")) return "funds";
  if (has("item", "symbol", "currency", "amount", "rate (%)")) return "bonds";
  if (
    has("item", "as of") &&
    [...h].some((x) => /^amount( \(.+\))?$/.test(x))
  ) {
    return "cash";
  }
  return null;
}

// raw: the cell as written, for a note whose spaces are its own
type Cells = (name: string, raw?: boolean) => string;

const cellsOf = (header: readonly string[], row: readonly string[]): Cells => {
  const at = new Map(header.map((h, k) => [norm(h), k]));
  return (name, raw = false) => {
    const cell = row[at.get(name) ?? -1] ?? "";
    return raw ? cell : cell.trim();
  };
};

class Bad extends Error {}

const num = (
  raw: string,
  name: string,
  opts: { required?: boolean; positive?: boolean } = {},
): number | null => {
  const n = parseNumber(raw);
  if (n === "bad") throw new Bad(`${name} is not a number`);
  if (n === null) {
    if (opts.required) throw new Bad(`no ${name}`);
    return null;
  }
  if (n < 0 || n > MAX_AMOUNT) throw new Bad(`${name} is out of range`);
  if (opts.positive && n === 0) throw new Bad(`${name} is zero`);
  return n;
};

const day = (
  raw: string,
  name: string,
  required = false,
  month = false,
): string | null => {
  const d = parseDay(raw, month);
  if (d === "bad") throw new Bad(`${name} is not a date`);
  if (d === null && required) throw new Bad(`no ${name}`);
  return d;
};

// a month reads as its last day, never past today, so the current month
// is today; a day or month after today anywhere is refused, as typed
const asOf = (
  raw: string,
  name: string,
  today: string,
  latest: string,
  month = true,
): string => {
  const d = day(raw, name, false, month);
  if (d === null) return today;
  const ym = month && /^\d{4}-\d{2}$/.test(raw.trim());
  const first = ym ? `${raw.trim()}-01` : d;
  if (first > latest) throw new Bad(`${name} is in the future`);
  if (!ym) return d;
  return d < today ? d : today < first ? first : today;
};

const noteOf = (raw: string): string | null =>
  raw === "" ? null : raw.slice(0, MAX_NOTE);

// a trade's row: what its comment says, the symbol not resolved yet
type Draft = {
  symbol: string;
  side: "buy" | "sell";
  date: string;
  quantity: number;
  price: number;
  fees: number;
  currency: string | null;
  broker: Broker | null;
  note: string | null;
  // the day our own export restated it as of, from its tag
  statedOn: string | null;
};

function yahooRow(
  get: Cells,
  fileBroker: Broker | null,
  brokers: readonly Broker[],
): Draft | { skip: string } {
  const symbol = get("symbol");
  const kind = get("transaction type");
  if (symbol.startsWith("$$")) return { skip: "a cash row" };
  if (kind === "" && get("trade date") === "" && get("quantity") === "") {
    return { skip: "no trade, a watched symbol" };
  }
  if (symbol === "") throw new Bad("no symbol");
  const side = kind.toLowerCase();
  if (side !== "buy" && side !== "sell") {
    throw new Bad("transaction type is not Buy or Sell");
  }
  const said = readComment(get("comment", true));
  if (said.statedOn !== null) {
    const d = parseDay(said.statedOn);
    if (d === null || d === "bad" || d !== said.statedOn) {
      throw new Bad("the as of tag is not a date");
    }
  }
  let broker = fileBroker;
  if (broker === null && said.broker !== null) {
    broker =
      brokers.find(
        (b) => b.name.toLowerCase() === said.broker!.toLowerCase(),
      ) ?? null;
    if (broker === null) throw new Bad(`no broker ${said.broker}`);
  }
  // a hundredth's code (GBp) is kept as written: GBP would be 100 times it
  const currency = said.paid;
  if (currency !== null && !isCurrencyCode(currency)) {
    throw new Bad("the currency paid is not a currency in circulation");
  }
  const date = day(get("trade date"), "trade date", true)!;
  // figures are restated after the trade, never before it
  if (said.statedOn !== null && said.statedOn < date) {
    throw new Bad("the as of tag is before the trade date");
  }
  return {
    symbol,
    side,
    date,
    quantity: num(get("quantity"), "quantity", {
      required: true,
      positive: true,
    })!,
    price: (() => {
      const listed = num(get("purchase price"), "purchase price", {
        required: true,
      })!;
      if (said.paidPrice === null) return listed;
      if (currency === null) throw new Bad("the paid tag's price has no code");
      return num(said.paidPrice, "the paid tag's price", { required: true })!;
    })(),
    fees: num(get("commission"), "commission") ?? 0,
    currency,
    broker,
    note: said.note === null ? null : noteOf(said.note),
    statedOn: said.statedOn,
  };
}

const PRICED = new Set(["per_share", "per_unit", "percent_of_par"]);

async function resolveAll(
  m: Markets,
  symbols: readonly string[],
): Promise<Map<string, Instrument | string>> {
  const out = new Map<string, Instrument | string>();
  const unique = [...new Set(symbols)];
  const targets = unique.length === 0 ? [] : await readTargets(m, unique);
  for (const t of targets) {
    if ("error" in t) out.set(t.input, t.error.message);
    else if (t.instrument.source === FRED || !PRICED.has(t.instrument.unit)) {
      out.set(t.input, "no price a holding can be valued at");
    } else out.set(t.input, t.instrument);
  }
  return out;
}

type Planned =
  | {
      kind: "trade";
      row: ImportRow;
      trade: NewTrade;
      // skipped or refused by judge(), so a second judge() starts afresh
      judged?: boolean;
    }
  | {
      kind: "position";
      row: ImportRow;
      position: NewPosition;
      // a bond with no purchase date matches a kept one of any date
      undated?: boolean;
      // the kept bond this line matched, so no other line matches it
      matched?: number;
    };

// a bond already kept, each kept row matching one line of a file: skipped,
// or relisted when the file resolves a listing the kept row lacks
function keptBond(
  db: Db,
  position: NewPosition,
  undated: boolean,
  taken: Set<number>,
): { old: Position; relist: boolean } | null {
  const old = samePosition(db, position, { undated, skip: [...taken] });
  if (old === null) return null;
  taken.add(old.id);
  const relist = old.instrument === null && position.instrument !== null;
  // the kept purchase date stands when the file gives none
  if (relist && undated) position.asOf = old.asOf;
  return { old, relist };
}

export type ImportAnswer = {
  kind: ImportKind;
  portfolio: string;
  broker: string | null;
  saved: boolean;
  counts: Record<Status, number>;
  rows: ImportRow[];
};

export async function importCsv(
  m: Markets,
  who: Who,
  args: ImportArgs,
): Promise<ImportAnswer | Failure> {
  const p = findPortfolio(m.db, args.portfolio);
  if (p === null || "error" in p)
    return p ?? { error: "not_found", message: "no portfolio" };
  const fileBroker = findBroker(m.db, args.broker);
  if (fileBroker !== null && "error" in fileBroker) return fileBroker;
  const table = parseCsv(args.csv);
  if (table.length < 1) throw new ArgError("csv has no header");
  if (table.length - 1 > MAX_ROWS) {
    throw new ArgError(`csv has more than ${MAX_ROWS} rows`);
  }
  const header = table[0]!;
  const kind = kindOf(header);
  if (kind === null) {
    throw new ArgError(
      "csv's header is not a Yahoo portfolio export, nor a cash, funds or bonds list",
    );
  }
  const brokers = listBrokers(m.db);
  const plan = await planRows(m, who, p, kind, header, table.slice(1), {
    broker: fileBroker,
    brokers,
    currency: args.currency,
    dryPowder: new Set(args.dryPowder),
  });
  let saved = false;
  if (args.confirm) {
    const now = m.clock.now();
    await m.writer.write((db) => {
      judge(db, plan);
      // rows of one file never replace each other
      const added = new Set<number>();
      const taken = new Set<number>();
      for (const x of plan) {
        if (x.kind === "position" && x.row.status === "skipped") {
          if (x.matched !== undefined) taken.add(x.matched);
        }
      }
      for (const x of plan) {
        if (x.row.status !== "ok") continue;
        if (x.kind === "trade") {
          if (readInstrument(db, x.trade.instrument) === null) {
            x.row.status = "bad";
            x.row.reason = "its instrument was deleted";
            continue;
          }
          insertTrade(db, x.trade, now);
        } else {
          let old: Position | null = null;
          if (x.position.kind === "bond") {
            const kept = keptBond(db, x.position, x.undated === true, taken);
            if (kept !== null && !kept.relist) {
              x.row.status = "skipped";
              x.row.reason = "already saved";
              continue;
            }
            old = kept?.old ?? null;
          } else {
            const found = samePosition(db, x.position);
            old = found !== null && !added.has(found.id) ? found : null;
          }
          if (old !== null) setPositionRemoved(db, old.id, who.name, now);
          const id = insertPosition(
            db,
            { ...x.position, replaces: old?.id ?? null },
            now,
          );
          added.add(id);
          // a bond line saved here is its own purchase: no later line of
          // this file matches it, as none did in the preview
          if (x.position.kind === "bond") taken.add(id);
        }
        x.row.status = "saved";
      }
    });
    saved = true;
  }
  const rows = plan.map((x) => x.row);
  const counts: Record<Status, number> = {
    ok: 0,
    bad: 0,
    skipped: 0,
    saved: 0,
  };
  for (const r of rows) counts[r.status]++;
  return {
    kind,
    portfolio: p.name,
    broker: fileBroker?.name ?? null,
    saved,
    counts,
    rows,
  };
}

type Ctx = {
  broker: Broker | null;
  brokers: readonly Broker[];
  currency: string | null;
  dryPowder: Set<number>;
};

async function planRows(
  m: Markets,
  who: Who,
  p: Portfolio,
  kind: ImportKind,
  header: readonly string[],
  body: readonly string[][],
  ctx: Ctx,
): Promise<Planned[]> {
  if (kind === "trades") return planTrades(m, who, p, header, body, ctx);
  return planPositions(m, who, p, kind, header, body, ctx);
}

async function planTrades(
  m: Markets,
  who: Who,
  p: Portfolio,
  header: readonly string[],
  body: readonly string[][],
  ctx: Ctx,
): Promise<Planned[]> {
  type Read =
    | { line: number; bad: string }
    | { line: number; d: Draft | { skip: string } };
  const drafts = body.map((cells, k): Read => {
    const line = k + 2;
    try {
      return {
        line,
        d: yahooRow(cellsOf(header, cells), ctx.broker, ctx.brokers),
      };
    } catch (error) {
      if (error instanceof Bad) return { line, bad: error.message };
      throw error;
    }
  });
  const found = await resolveAll(
    m,
    drafts.flatMap((x) => ("d" in x && !("skip" in x.d) ? [x.d.symbol] : [])),
  );
  const out: Planned[] = [];
  for (const x of drafts) {
    if ("bad" in x) {
      out.push({
        kind: "trade",
        row: { line: x.line, status: "bad", reason: x.bad },
        trade: null as never,
      });
      continue;
    }
    if ("skip" in x.d) {
      out.push({
        kind: "trade",
        row: { line: x.line, status: "skipped", reason: x.d.skip },
        trade: null as never,
      });
      continue;
    }
    const d = x.d;
    const i = found.get(d.symbol);
    if (i === undefined || typeof i === "string") {
      out.push({
        kind: "trade",
        row: {
          line: x.line,
          status: "bad",
          reason: `${d.symbol}: ${i ?? "not resolved"}`,
        },
        trade: null as never,
      });
      continue;
    }
    const currency = d.currency ?? i.currency;
    let reason: string | null = null;
    if (currency === null) reason = "no currency for this listing";
    else if (d.date > latestDay(m.clock.now())) {
      reason = "trade date is in the future";
    } else if (d.statedOn !== null && d.statedOn > latestDay(m.clock.now())) {
      reason = "the as of tag is in the future";
    }
    const trade: NewTrade = {
      portfolio: p.id,
      instrument: i.id,
      side: d.side,
      date: d.date,
      // an export restates old lots in the shares of its day: only a split
      // after that day applies, the import's day when the file says none
      statedOn: d.statedOn ?? localDate(i.zone, m.clock.now()),
      quantity: d.quantity,
      price: d.price,
      fees: d.fees,
      currency: currency ?? "",
      broker: d.broker?.id ?? null,
      note: d.note,
      enteredBy: who.name,
    };
    const item = {
      symbol: i.id,
      input: d.symbol,
      side: d.side,
      date: d.date,
      quantity: d.quantity,
      price: d.price,
      fees: d.fees,
      currency,
      broker: d.broker?.name ?? null,
      note: d.note,
    };
    if (reason !== null) {
      out.push({
        kind: "trade",
        row: { line: x.line, status: "bad", reason, item },
        trade,
      });
    } else {
      out.push({
        kind: "trade",
        row: { line: x.line, status: "ok", item },
        trade,
      });
    }
  }
  judge(m.db, out);
  return out;
}

// in today's shares, so a trade typed in before a split and its export
// read back after it are one trade
const close = (x: number, y: number) =>
  Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
const sameTrade = (a: NewTrade, t: NewTrade, splits: readonly Split[]) => {
  const fa = splitFactor(splits, statedOf(a));
  const ft = splitFactor(splits, statedOf(t));
  return (
    t.instrument === a.instrument &&
    t.side === a.side &&
    t.date === a.date &&
    close(t.quantity * ft, a.quantity * fa) &&
    close(t.price / ft, a.price / fa) &&
    t.fees === a.fees &&
    t.currency === a.currency &&
    t.broker === a.broker
  );
};

// against the rows stored when it runs: in the preview, and again inside
// the save's write, so two saves of one file never insert it twice. A
// trade already kept is skipped; a sell past what its broker holds at
// any date, with the file's trades merged into each part's history, is
// refused. One read of the portfolio, and each file sell replays only what
// follows it, so a large file holds the writer briefly.
function judge(db: Db, plan: Planned[]): void {
  type Row = Extract<Planned, { kind: "trade" }>;
  for (const x of plan) {
    if (x.kind === "trade" && x.judged) {
      x.row.status = "ok";
      delete x.row.reason;
      x.judged = false;
    }
  }
  const ready = plan.filter(
    (x): x is Row => x.kind === "trade" && x.row.status === "ok",
  );
  if (ready.length === 0) return;
  const splitsCache = new Map<string, Split[]>();
  const splitsFor = (id: string) => {
    let s = splitsCache.get(id);
    if (s === undefined) {
      s = splitsOf(db, id);
      splitsCache.set(id, s);
    }
    return s;
  };
  const stored = new Map<number, Trade[]>();
  const keyOf = (t: NewTrade) =>
    `${t.instrument}|${t.side}|${t.date}|${t.broker ?? ""}|${t.currency}|${t.fees}`;
  const kept = new Map<string, Trade[]>();
  const used = new Set<number>();
  for (const x of ready) {
    const p = x.trade.portfolio;
    if (!stored.has(p)) {
      const all = readTrades(db, { portfolio: p });
      stored.set(p, all);
      for (const t of all) {
        const k = `${p}#${keyOf(t)}`;
        const list = kept.get(k);
        if (list) list.push(t);
        else kept.set(k, [t]);
      }
    }
    const same = kept.get(`${p}#${keyOf(x.trade)}`) ?? [];
    const splits = splitsFor(x.trade.instrument);
    // each kept trade is one fill: two kept, a third in the file is new
    const hit = same.find(
      (t) => !used.has(t.id) && sameTrade(x.trade, t, splits),
    );
    if (hit !== undefined) {
      used.add(hit.id);
      x.row.status = "skipped";
      x.row.reason = "already saved";
      x.judged = true;
    }
  }
  type Entry = { t: NewTrade; date: string; order: number; file?: Row };
  const parts = new Map<string, Entry[]>();
  const partKey = (t: NewTrade) =>
    `${t.portfolio}/${t.instrument}/${t.broker ?? ""}`;
  const push = (e: Entry) => {
    const k = partKey(e.t);
    const list = parts.get(k);
    if (list) list.push(e);
    else parts.set(k, [e]);
  };
  const touched = new Set(
    ready.filter((x) => x.row.status === "ok").map((x) => partKey(x.trade)),
  );
  for (const all of stored.values()) {
    for (const t of all) {
      if (touched.has(partKey(t))) push({ t, date: t.date, order: t.id });
    }
  }
  ready.forEach((x, k) => {
    if (x.row.status !== "ok") return;
    // after every stored trade of its day, in the file's order
    push({
      t: x.trade,
      date: x.trade.date,
      order: Number.MAX_SAFE_INTEGER - ready.length + k,
      file: x,
    });
  });
  for (const list of parts.values()) {
    const splits = splitsFor(list[0]!.t.instrument);
    list.sort((a, b) =>
      a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1,
    );
    const shares = list.map(
      (e) => e.t.quantity * splitFactor(splits, statedOf(e.t)),
    );
    // a file sell is judged with every stored trade and every file buy, the
    // file sells before it as judged: bad when it adds an oversell anywhere
    // after it, its own or a later stored sell's, as a typed sell is
    const kept = list.map((e) => e.file === undefined || e.t.side === "buy");
    let held = 0;
    list.forEach((e, k) => {
      if (e.file !== undefined && e.t.side === "sell") {
        if (
          replay(list, shares, kept, k, held, true) >
          replay(list, shares, kept, k, held, false)
        ) {
          e.file.row.status = "bad";
          e.file.row.reason = "sells more than that broker holds then";
          e.file.judged = true;
          return;
        }
        kept[k] = true;
      }
      if (kept[k]) held = sellStep(held, e.t.side, shares[k]!).held;
    });
  }
}

// the oversells from entry k on, with or without it, from what was held
function replay(
  list: readonly { t: NewTrade }[],
  shares: readonly number[],
  kept: readonly boolean[],
  k: number,
  from: number,
  withIt: boolean,
): number {
  let held = from;
  let n = 0;
  for (let j = k; j < list.length; j++) {
    if (j === k ? !withIt : !kept[j]) continue;
    const s = sellStep(held, list[j]!.t.side, shares[j]!);
    held = s.held;
    if (s.over) n++;
  }
  return n;
}

async function planPositions(
  m: Markets,
  who: Who,
  p: Portfolio,
  kind: Exclude<ImportKind, "trades">,
  header: readonly string[],
  body: readonly string[][],
  ctx: Ctx,
): Promise<Planned[]> {
  const fromHeader = header
    .map((h) => /^amount \((.+)\)$/i.exec(h.trim())?.[1]?.trim())
    .find((c) => c !== undefined);
  const amountColumn =
    header.map(norm).find((h) => /^amount( \(.+\))?$/.test(h)) ?? "amount";
  const today = ownerToday(m.db, m.clock.now());
  const latest = latestDay(m.clock.now());
  const rows = body.map((cells, k) => ({
    line: k + 2,
    get: cellsOf(header, cells),
  }));
  const symbols =
    kind === "bonds"
      ? rows.map((r) => r.get("symbol")).filter((s) => s !== "")
      : [];
  const found = await resolveAll(m, symbols);
  const posKind: PositionKind =
    kind === "cash" ? "cash" : kind === "funds" ? "fund" : "bond";
  const out: Planned[] = [];
  const taken = new Set<number>();
  for (const { line, get } of rows) {
    try {
      const name = get(kind === "funds" ? "fund" : "item");
      if (name === "") throw new Bad("no name");
      if (name.length > MAX_POSITION_NAME) throw new Bad("name is too long");
      let currency =
        kind === "cash" ? (fromHeader ?? ctx.currency) : get("currency");
      if (!currency) throw new Bad("no currency");
      if (!isCurrencyCode(currency)) currency = currency.toUpperCase();
      if (!isCurrencyCode(currency)) {
        throw new Bad("currency is not a currency in circulation");
      }
      let warning: string | undefined;
      let undated = false;
      const position: NewPosition = {
        portfolio: p.id,
        kind: posKind,
        name,
        currency,
        instrument: null,
        market: null,
        amount: null,
        units: null,
        price: null,
        cost: null,
        coupon: null,
        maturity: null,
        asOf: today,
        broker: ctx.broker?.id ?? null,
        note: noteOf(get("note")),
        dryPowder: false,
        replaces: null,
        enteredBy: who.name,
      };
      if (kind === "cash") {
        position.amount = num(get(amountColumn), "amount", { required: true });
        position.asOf = asOf(get("as of"), "as of", today, latest);
        position.dryPowder = ctx.dryPowder.has(line);
      } else if (kind === "funds") {
        const value = num(get("value"), "value", { required: true })!;
        const units = num(get("units"), "units", { positive: true }) ?? 1;
        position.units = units;
        position.price = value / units;
        position.cost = num(get("cost basis"), "cost basis");
        position.asOf = asOf(get("as of"), "as of", today, latest);
      } else {
        position.amount = num(get("amount"), "amount", {
          required: true,
          positive: true,
        });
        const rate = parseNumber(get("rate (%)"));
        if (rate === "bad") throw new Bad("rate is not a number");
        position.coupon = rate;
        position.maturity = day(get("maturity"), "maturity");
        undated = get("purchase date") === "";
        position.asOf = undated
          ? today
          : asOf(get("purchase date"), "purchase date", today, latest, false);
        const symbol = get("symbol");
        if (symbol !== "") {
          const i = found.get(symbol);
          if (i === undefined || typeof i === "string") {
            warning = `${symbol}: ${i ?? "not resolved"}; valued at face`;
          } else if (i.currency !== currency) {
            throw new Bad(`listed in ${i.currency ?? "no currency"}`);
          } else position.instrument = i.id;
        }
      }
      // a bond bought once is one row: the same file read again adds
      // nothing, but sets a listing found since
      let old: Position | null;
      if (posKind === "bond") {
        const kept = keptBond(m.db, position, undated, taken);
        if (kept !== null && !kept.relist) {
          out.push({
            kind: "position",
            row: { line, status: "skipped", reason: "already saved" },
            position,
            matched: kept.old.id,
          });
          continue;
        }
        old = kept?.old ?? null;
      } else old = samePosition(m.db, position);
      const item = {
        kind: posKind,
        name,
        currency,
        symbol: position.instrument,
        amount: position.amount,
        units: position.units,
        price: position.price,
        cost: position.cost,
        coupon: position.coupon,
        maturity: position.maturity,
        as_of: position.asOf,
        ...(kind === "cash" ? { dry_powder: position.dryPowder } : {}),
        broker: ctx.broker?.name ?? null,
        note: position.note,
      };
      out.push({
        kind: "position",
        row: {
          line,
          status: "ok",
          item,
          ...(warning ? { warning } : {}),
          ...(old ? { replaces: old.id } : {}),
        },
        position,
        undated,
        ...(old !== null && posKind === "bond" ? { matched: old.id } : {}),
      });
    } catch (error) {
      if (!(error instanceof Bad)) throw error;
      out.push({
        kind: "position",
        row: { line, status: "bad", reason: error.message },
        position: null as never,
      });
    }
  }
  return out;
}

// a decimal its reader takes: 1e-7 is written 0.0000001
export function plain(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/\.?0+$/, "");
}

// Yahoo's columns, oldest trade first; its market columns are left empty
export function exportCsv(m: Markets, portfolio: Portfolio): string {
  const trades = readTrades(m.db, { portfolio: portfolio.id }).reverse();
  const rows: string[][] = [[...YAHOO_HEADER]];
  const fx = rates(m.db, m.clock.now(), m.quoteEveryMs);
  for (const t of trades) {
    const i = readInstrument(m.db, t.instrument);
    const symbol = i?.source === YAHOO ? i.sourceSymbol : t.instrument;
    const broker = t.broker === null ? null : readBroker(m.db, t.broker);
    // stated as of today, as the export restates every lot, and tagged so,
    // so a split between export and import applies once
    const f = splitFactor(splitsOf(m.db, t.instrument), statedOf(t));
    const paid = t.price / f;
    const other = i !== null && t.currency !== i.currency;
    // a Yahoo reader takes Purchase Price as the listing's: a lot paid in
    // another currency is written at the close its cost converts at, the
    // price paid kept in its tag; with no close, as paid, as before
    const rate =
      other && i.currency !== null
        ? fx.rate(t.currency, i.currency, t.date).rate
        : null;
    const comment = commentOf({
      broker: broker?.name ?? null,
      paid: other ? t.currency : null,
      paidPrice: rate === null ? null : plain(paid),
      note: t.note,
      // a trade dated ahead of the listing's today is stated on its date
      statedOn: [localDate(i?.zone ?? "UTC", m.clock.now()), t.date].sort()[1],
    });
    const cells: Record<string, string> = {
      Symbol: symbol,
      "Trade Date": t.date.replace(/-/g, ""),
      // as stored, so export then import gives the same trade back
      "Purchase Price": plain(rate === null ? paid : paid * rate),
      Quantity: plain(t.quantity * f),
      Commission: plain(t.fees),
      Comment: comment,
      "Transaction Type": t.side === "buy" ? "Buy" : "Sell",
    };
    rows.push(YAHOO_HEADER.map((h) => cells[h] ?? ""));
  }
  return formatCsv(rows);
}
