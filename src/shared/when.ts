// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// An alert's condition as text: comparisons joined by and/or, never a
// formula language. The server parses and renders it; the web UI reads it.

export const WHEN_OPS = ["<", "<=", ">", ">="] as const;
export type WhenOp = (typeof WHEN_OPS)[number];

// quote's and screen's names, each with the stored condition's key
export const WHEN_FIELDS: Readonly<Record<string, string>> = {
  price: "price",
  previous_close: "previousClose",
  change_percent: "changePct",
  day_high: "dayHigh",
  day_low: "dayLow",
  sma50: "sma50",
  sma200: "sma200",
  ema20: "ema20",
  cross: "cross",
  cross_edge: "crossEdge",
  rsi14: "rsi14",
  macd: "macd",
  macd_signal: "macdSignal",
  macd_histogram: "macdHistogram",
  macd_turn: "macdTurn",
  atr14: "atr14",
  move_atr: "moveAtr",
  volatility20: "volatility20",
  bollinger_lower: "bollingerLower",
  high52w: "high52w",
  low52w: "low52w",
  drawdown: "drawdown",
  from_low: "fromLow",
  days_since_high: "daysSinceHigh",
  volume_ratio: "volumeRatio",
  weekly_sma50: "weeklySma50",
  weekly_sma200: "weeklySma200",
  weekly_cross: "weeklyCross",
  weekly_cross_edge: "weeklyCrossEdge",
  relative_return_1m: "relativeReturn1m",
  relative_return_3m: "relativeReturn3m",
};

export const WHEN_FIELD_NAMES = Object.keys(WHEN_FIELDS);

const RELATIVE = new Set(["relative_return_1m", "relative_return_3m"]);
export const isRelative = (field: string) => RELATIVE.has(field);

export const MAX_COMPARISONS = 8;
export const MAX_DEPTH = 3;
export const MAX_WHEN = 1000;
export const MAX_SYMBOL = 100;
// past this a level is a typo, not a price
export const MAX_LITERAL = 1e15;

// symbol null: the alert's own
export type WhenOperand = {
  field: string;
  symbol: string | null;
  benchmark?: string;
};
export type WhenComparison = {
  left: WhenOperand;
  op: WhenOp;
  right: number | WhenOperand;
};
export type WhenNode =
  | WhenComparison
  | { all: WhenNode[] }
  | { any: WhenNode[] };

export class WhenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhenError";
  }
}

export const isWhenComparison = (n: WhenNode): n is WhenComparison => "op" in n;

// depth first, left to right: the order of an answer's now
export function whenComparisons(n: WhenNode): WhenComparison[] {
  if (isWhenComparison(n)) return [n];
  return ("all" in n ? n.all : n.any).flatMap(whenComparisons);
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = was;
    }
  }
  return row[b.length]!;
}

// the field meant: a stored key, a name without its underscores, a prefix,
// or one a typo or two away
export function nearestField(word: string): string | null {
  const w = word.toLowerCase();
  const bare = (s: string) => s.replace(/_/g, "");
  for (const [name, key] of Object.entries(WHEN_FIELDS)) {
    if (key.toLowerCase() === w || bare(name) === bare(w)) return name;
  }
  const prefixed = WHEN_FIELD_NAMES.filter(
    (n) => w.length >= 2 && n.startsWith(w),
  );
  if (prefixed.length > 0) {
    return prefixed.reduce((a, b) => (b.length < a.length ? b : a));
  }
  let best: string | null = null;
  let least = Math.max(2, Math.floor(w.length / 3)) + 1;
  for (const name of WHEN_FIELD_NAMES) {
    const d = distance(w, name);
    if (d < least) {
      least = d;
      best = name;
    }
  }
  return best;
}

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/;

const shown = (s: string) => (s.length > 24 ? `${s.slice(0, 24)}…` : s);

class Parser {
  private at = 0;
  private count = 0;
  // where each group and comparison starts, for a refusal's position
  readonly starts = new Map<WhenNode, number>();

  constructor(private readonly text: string) {}

  // 1-based, as a person counts
  private pos(at = this.at): number {
    return at + 1;
  }

  private space(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) {
      this.at++;
    }
  }

  private rest(): string {
    this.space();
    return this.text.slice(this.at);
  }

  private found(): string {
    const r = this.rest();
    if (r === "") return "the end";
    const m = WORD.exec(r) ?? NUMBER.exec(r);
    return shown(m === null ? r[0]! : m[0]);
  }

  private keyword(): "and" | "or" | null {
    const m = WORD.exec(this.rest());
    if (m === null) return null;
    const k = m[0].toLowerCase();
    return k === "and" || k === "or" ? k : null;
  }

  parse(): WhenNode {
    if (this.rest() === "") throw new WhenError("when is empty");
    const n = this.or();
    if (this.rest() !== "") {
      throw new WhenError(
        `expected and, or or the end at ${this.pos()}, found ${this.found()}`,
      );
    }
    return n;
  }

  // and binds tighter than or, as in SQL and most languages
  private or(): WhenNode {
    this.space();
    const start = this.at;
    const items = [this.and()];
    while (this.keyword() === "or") {
      this.at += 2;
      items.push(this.and());
    }
    if (items.length === 1) return items[0]!;
    const n = { any: items };
    this.starts.set(n, start);
    return n;
  }

  private and(): WhenNode {
    this.space();
    const start = this.at;
    const items = [this.atom()];
    while (this.keyword() === "and") {
      this.at += 3;
      items.push(this.atom());
    }
    if (items.length === 1) return items[0]!;
    const n = { all: items };
    this.starts.set(n, start);
    return n;
  }

  private atom(): WhenNode {
    if (this.rest().startsWith("(")) {
      const open = this.at;
      this.at++;
      const n = this.or();
      if (!this.rest().startsWith(")")) {
        throw new WhenError(
          `( at ${this.pos(open)} is not closed: expected ) at ${this.pos()}, found ${this.found()}`,
        );
      }
      this.at++;
      if (!isWhenComparison(n)) this.starts.set(n, open);
      return n;
    }
    return this.comparison();
  }

  private side(): { value: number | WhenOperand; at: number } {
    const r = this.rest();
    const at = this.at;
    const num = NUMBER.exec(r);
    if (num !== null && !/^[A-Za-z_]/.test(r.slice(num[0].length))) {
      const v = Number(num[0]);
      if (!Number.isFinite(v) || Math.abs(v) > MAX_LITERAL) {
        throw new WhenError(
          `number ${shown(num[0])} at ${this.pos()} is out of range`,
        );
      }
      this.at += num[0].length;
      return { value: v, at };
    }
    const word = WORD.exec(r);
    if (word === null || this.keyword() !== null) {
      throw new WhenError(
        `expected a field or a number at ${this.pos()}, found ${this.found()}`,
      );
    }
    const field = word[0].toLowerCase();
    if (!Object.hasOwn(WHEN_FIELDS, field)) {
      const near = nearestField(word[0]);
      throw new WhenError(
        `unknown field ${shown(word[0])} at ${this.pos()}${near === null ? "" : `; did you mean ${near}?`}`,
      );
    }
    this.at += word[0].length;
    const args = this.rest().startsWith("(") ? this.args() : [];
    if (isRelative(field)) {
      if (args.length === 0) {
        throw new WhenError(
          `${field} at ${this.pos(at)} needs a benchmark: ${field}(QQQ)`,
        );
      }
      if (args.length > 2) {
        throw new WhenError(
          `${field} at ${this.pos(at)} takes a benchmark, or a symbol and a benchmark`,
        );
      }
      return {
        value:
          args.length === 1
            ? { field, symbol: null, benchmark: args[0]! }
            : { field, symbol: args[0]!, benchmark: args[1]! },
        at,
      };
    }
    if (args.length > 1) {
      throw new WhenError(`${field} at ${this.pos(at)} takes one symbol`);
    }
    return { value: { field, symbol: args[0] ?? null }, at };
  }

  // a symbol is read as written up to , or ), so VWCE.DE, XETRA:VVSM, ^VIX
  // and EURUSD=X need no quotes
  private args(): string[] {
    const open = this.at;
    const close = this.text.indexOf(")", open);
    if (close < 0) {
      throw new WhenError(`( at ${this.pos(open)} is not closed`);
    }
    const parts = this.text.slice(open + 1, close).split(",");
    let from = open + 1;
    const out: string[] = [];
    for (const p of parts) {
      const s = p.trim();
      if (s === "") {
        throw new WhenError(`expected a symbol at ${this.pos(from)}`);
      }
      if (s.length > MAX_SYMBOL) {
        throw new WhenError(
          `symbol at ${this.pos(from)} is longer than ${MAX_SYMBOL} characters`,
        );
      }
      out.push(s);
      from += p.length + 1;
    }
    this.at = close + 1;
    return out;
  }

  private comparison(): WhenNode {
    this.space();
    const start = this.at;
    this.count++;
    if (this.count > MAX_COMPARISONS) {
      throw new WhenError(
        `at most ${MAX_COMPARISONS} comparisons; one more starts at ${this.pos()}`,
      );
    }
    const left = this.side();
    const r = this.rest();
    const op = (WHEN_OPS as readonly string[]).find(
      (o) => r.startsWith(o) && !(o.length === 1 && r[1] === "="),
    ) as WhenOp | undefined;
    if (op === undefined) {
      const bad = /^[=!<>]+/.exec(r);
      throw new WhenError(
        bad === null
          ? `expected < <= > or >= at ${this.pos()}, found ${this.found()}`
          : `unknown operator ${shown(bad[0])} at ${this.pos()}; use < <= > or >=`,
      );
    }
    this.at += op.length;
    const right = this.side();
    let n: WhenComparison;
    if (typeof left.value === "number") {
      if (typeof right.value === "number") {
        throw new WhenError(
          `the comparison at ${this.pos(start)} compares two numbers; one side must be a field`,
        );
      }
      // 180 > price reads as price < 180
      n = { left: right.value, op: FLIPPED[op], right: left.value };
    } else {
      n = { left: left.value, op, right: right.value };
    }
    this.starts.set(n, start);
    return n;
  }
}

const FLIPPED: Record<WhenOp, WhenOp> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
};

// every refusal names what it found and where, so one retry fixes it
export function parseWhen(text: string): WhenNode {
  if (text.length > MAX_WHEN) {
    throw new WhenError(`when is longer than ${MAX_WHEN} characters`);
  }
  const p = new Parser(text);
  const root = p.parse();
  const walk = (n: WhenNode, level: number) => {
    if (level > MAX_DEPTH) {
      throw new WhenError(
        `conditions nest at most ${MAX_DEPTH} levels; the one at ${(p.starts.get(n) ?? 0) + 1} is deeper`,
      );
    }
    if (!isWhenComparison(n)) {
      for (const k of "all" in n ? n.all : n.any) walk(k, level + 1);
    }
  };
  walk(root, 1);
  return root;
}

// as written in when, and as a trigger's values key it
export function operandText(o: WhenOperand): string {
  const args =
    o.benchmark === undefined
      ? o.symbol === null
        ? []
        : [o.symbol]
      : o.symbol === null
        ? [o.benchmark]
        : [o.symbol, o.benchmark];
  return args.length === 0 ? o.field : `${o.field}(${args.join(", ")})`;
}

// one canonical form: single spaces, every nested group in parentheses
export function renderWhen(n: WhenNode): string {
  if (isWhenComparison(n)) {
    const right =
      typeof n.right === "number" ? String(n.right) : operandText(n.right);
    return `${operandText(n.left)} ${n.op} ${right}`;
  }
  const kids = "all" in n ? n.all : n.any;
  return kids
    .map((k) => (isWhenComparison(k) ? renderWhen(k) : `(${renderWhen(k)})`))
    .join("all" in n ? " and " : " or ");
}
