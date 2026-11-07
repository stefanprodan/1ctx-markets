// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's trade plans as the tools and REST read and write them: the
// owner's own only, never shared. Names and text are in no log line: logs
// carry the id, revision and bytes.

import type { Edit } from "../document/edit.ts";
import { authorOf, KEPT_REVISIONS, type Kind } from "../document/store.ts";
import { iso } from "../market/format.ts";
import { readInstrument } from "../market/instruments.ts";
import { localDate } from "../market/zone.ts";
import { fundKey, isFundKey } from "../portfolios/funds.ts";
import { timeZone } from "../portfolios/store.ts";
import { FUND_MARKET } from "../sources/ids.ts";
import { planRead } from "../trade-plans/read.ts";
import { namesOf, sectionsFor } from "../trade-plans/sections.ts";
import {
  createPlan,
  LIST_STATUSES,
  type ListAt,
  type Listed,
  type ListStatus,
  liveRevision,
  MAX_PLAN_NAME,
  MAX_PLAN_SYMBOLS,
  PLAN_STATUSES,
  type Plan,
  type PlanChange,
  type PlanRevision,
  type PlanSaved,
  type PlanStatus,
  planList,
  plansFor,
  planVersion,
  planVersions,
  readPlan,
  removePlan,
  restorePlan,
  savePlan,
  type VersionRow,
} from "../trade-plans/store.ts";
import {
  cursor,
  errorResult,
  type Failure,
  fitPage,
  fits,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import {
  ArgError,
  date,
  fields,
  oneOf,
  optionalText,
  quoted,
  text,
  textValues,
} from "./args.ts";
import { actionOf, parseSave, revisionOf } from "./document.ts";
import { noFund, seenFund } from "./funds.ts";
import type { Markets } from "./markets.ts";
import { resolveTargets, restStored, storedInstrument } from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const TRADE_PLANS_READS = [
  "list",
  "read",
  "versions",
  "version",
] as const;
export const TRADE_PLANS_WRITES = [
  "create",
  "edit",
  "replace",
  "set",
  "delete",
  "restore",
] as const;

export type TradePlansRead =
  | {
      action: "list";
      status: ListStatus;
      symbol: string | null;
      next: string | null;
    }
  | { action: "read"; id: number; symbol: string | null }
  | { action: "versions"; id: number }
  | { action: "version"; id: number; revision: number };

export type PlanFields = {
  name?: string;
  symbols?: string[];
  status?: PlanStatus;
  reviewBy?: string | null;
};

export type TradePlansWrite =
  | {
      action: "create";
      name: string;
      text: string;
      symbols: string[];
      reviewBy: string | null;
    }
  | { action: "edit"; id: number; revision: number; edits: Edit[] }
  | { action: "replace"; id: number; revision: number; text: string }
  | ({ action: "set"; id: number; revision: number } & PlanFields)
  | { action: "delete"; id: number; revision: number }
  | { action: "restore"; id: number };

const NO_READ = "this key has no trade plans access; its owner grants it";
const NO_WRITE = "this key reads trade plans only; its owner grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

// 15 digits stay under Number.MAX_SAFE_INTEGER, as every row id
export function planIdOf(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 999_999_999_999_999
  ) {
    throw new ArgError("id must be a trade plan id, a positive integer");
  }
  return value;
}

// trimmed and NFC, since a name is matched and shown, never edited in place
export function nameOf(value: unknown): string {
  if (typeof value !== "string") throw new ArgError("name must be a string");
  const name = value.trim().normalize("NFC");
  const length = [...name].length;
  if (length < 1 || length > MAX_PLAN_NAME) {
    throw new ArgError(`name must be 1 to ${MAX_PLAN_NAME} characters`);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refused here
  if (!name.isWellFormed() || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ArgError("name must be one line of well-formed text");
  }
  return name;
}

export function symbolsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PLAN_SYMBOLS) {
    throw new ArgError(
      `symbols must be a list of at most ${MAX_PLAN_SYMBOLS} symbols`,
    );
  }
  return value.map((v, k) => text(v, `symbols[${k}]`));
}

// null clears it
export function reviewByOf(value: unknown): string | null {
  return date(value, "review_by");
}

export const statusOf = (value: unknown): PlanStatus => {
  if (!(PLAN_STATUSES as readonly unknown[]).includes(value)) {
    throw new ArgError(`status must be one of ${PLAN_STATUSES.join(", ")}`);
  }
  return value as PlanStatus;
};

export const listStatusOf = (value: unknown): ListStatus =>
  oneOf(value, "status", LIST_STATUSES, "active");

const refuse = (
  f: Record<string, unknown>,
  action: string,
  names: string[],
) => {
  for (const name of names) {
    if (f[name] !== undefined) {
      throw new ArgError(`${name} is not an argument of ${action}`);
    }
  }
};

export function parseTradePlansRead(input: unknown): TradePlansRead {
  const f = textValues(
    fields(input, ["action", "id", "status", "symbol", "revision", "next"]),
    { ids: ["id", "revision"] },
  );
  const action = actionOf(f.action, TRADE_PLANS_READS);
  if (action === "list") {
    refuse(f, action, ["id", "revision"]);
    return {
      action,
      status: listStatusOf(f.status),
      symbol: optionalText(f.symbol, "symbol"),
      next: optionalText(f.next, "next", 300),
    };
  }
  refuse(f, action, ["status", "next"]);
  const id = planIdOf(f.id);
  if (action === "read") {
    refuse(f, action, ["revision"]);
    return { action, id, symbol: optionalText(f.symbol, "symbol") };
  }
  refuse(f, action, ["symbol"]);
  if (action === "versions") {
    refuse(f, action, ["revision"]);
    return { action, id };
  }
  return { action, id, revision: revisionOf(f.revision) };
}

// the fields set may change; one at least
export function planFieldsOf(f: Record<string, unknown>): PlanFields {
  const out: PlanFields = {};
  if (f.name !== undefined) out.name = nameOf(f.name);
  if (f.symbols !== undefined) out.symbols = symbolsOf(f.symbols);
  if (f.status !== undefined) out.status = statusOf(f.status);
  if (f.review_by !== undefined) out.reviewBy = reviewByOf(f.review_by);
  return out;
}

const SET_FIELDS = ["name", "symbols", "status", "review_by"];

export function parseTradePlansEdit(input: unknown): TradePlansWrite {
  const f = textValues(
    fields(input, [
      "action",
      "id",
      "revision",
      "name",
      "text",
      "edits",
      "symbols",
      "status",
      "review_by",
    ]),
    { ids: ["id", "revision"] },
  );
  const action = actionOf(f.action, TRADE_PLANS_WRITES);
  if (action === "create") {
    refuse(f, action, ["id", "revision", "edits", "status"]);
    if (typeof f.text !== "string") throw new ArgError("text must be a string");
    return {
      action,
      name: nameOf(f.name),
      text: f.text,
      symbols: f.symbols === undefined ? [] : symbolsOf(f.symbols),
      reviewBy: reviewByOf(f.review_by),
    };
  }
  const id = planIdOf(f.id);
  if (action === "restore") {
    refuse(f, action, ["revision", "text", "edits", ...SET_FIELDS]);
    return { action, id };
  }
  if (f.revision === undefined) {
    throw new ArgError(`${action} needs the revision it read`);
  }
  const revision = revisionOf(f.revision);
  if (action === "delete") {
    refuse(f, action, ["text", "edits", ...SET_FIELDS]);
    return { action, id, revision };
  }
  if (action === "set") {
    refuse(f, action, ["text", "edits"]);
    const change = planFieldsOf(f);
    if (Object.keys(change).length === 0) {
      throw new ArgError(`set takes one or more of ${SET_FIELDS.join(", ")}`);
    }
    return { action, id, revision, ...change };
  }
  refuse(f, action, SET_FIELDS);
  if (action === "edit" && f.edits === undefined) {
    throw new ArgError("edit takes id, revision and edits");
  }
  if (action === "replace" && f.text === undefined) {
    throw new ArgError("replace takes id, revision and text");
  }
  const save = parseSave({ revision, text: f.text, edits: f.edits });
  if (save.action !== action) {
    throw new ArgError(
      `${action === "edit" ? "text" : "edits"} is not an argument of ${action}`,
    );
  }
  return save.action === "edit"
    ? { action: "edit", id, revision, edits: save.edits }
    : { action: "replace", id, revision, text: save.text };
}

// stored first, so a stored but untracked id tags with no fetch; the rest
// resolve as a write does, fetching what is new but marking no read
export async function resolvePlanSymbols(
  m: Markets,
  who: Who,
  inputs: readonly string[],
): Promise<string[] | Failure> {
  const ids = new Map<string, string>();
  const rest: string[] = [];
  const bvb = m.bvb !== null;
  for (const input of new Set(inputs)) {
    if (isFundKey(input)) {
      // a fund resolves only for one who holds or priced it
      const fund = seenFund(m.db, who, input);
      if (fund === null) {
        return {
          ...noFund,
          message: `symbol ${quoted(input)}: ${noFund.message}`,
        };
      }
      ids.set(input, fund.id);
      continue;
    }
    const stored = m.yahooFirst
      ? restStored(m.db, input, bvb, false)
      : storedInstrument(m.db, input, bvb);
    if (stored !== null) ids.set(input, stored.id);
    else rest.push(input);
  }
  const targets = rest.length === 0 ? [] : await resolveTargets(m, rest);
  for (const t of targets) {
    if ("error" in t) {
      const { candidates, ...error } = t.error;
      return {
        ...error,
        message: `symbol ${quoted(t.input)}: ${error.message}`,
        ...(candidates === undefined ? {} : { candidates }),
      };
    }
    ids.set(t.input, t.instrument.id);
  }
  // VVSM.DE and XETRA:VVSM are one id
  return [...new Set(inputs.map((input) => ids.get(input)!))];
}

// a filter reads stored listings only; a deleted listing's tag keeps its id
export function storedSymbol(m: Markets, symbol: string | null): string | null {
  if (symbol === null) return null;
  if (isFundKey(symbol)) {
    return fundKey(
      symbol
        .trim()
        .slice(FUND_MARKET.length + 1)
        .toUpperCase(),
    );
  }
  const bvb = m.bvb !== null;
  const i = m.yahooFirst
    ? restStored(m.db, symbol, bvb, false)
    : storedInstrument(m.db, symbol, bvb);
  if (i !== null) return i.id;
  const given = symbol.trim().toUpperCase();
  // no listing: a symbol no plan can name
  return given.includes(":") ? given : `?${given}`;
}

// past the review date once the owner's own day is
export function reviewDue(
  m: Markets,
  owner: string,
  reviewBy: string | null,
): boolean {
  if (reviewBy === null) return false;
  const today = localDate(timeZone(m.db, owner) ?? "UTC", m.clock.now());
  return today > reviewBy;
}

const statusShown = (p: Listed) =>
  p.removedAt === null ? p.status : "removed";

export const planItem = (m: Markets, owner: string, p: Listed) => ({
  id: p.id,
  name: p.name,
  status: statusShown(p),
  symbols: p.symbols,
  review_by: p.reviewBy,
  review_due: reviewDue(m, owner, p.reviewBy),
  revision: p.revision,
  updated_at: iso(p.updatedAt),
  author: p.author,
  bytes: p.bytes,
});

// one revision's state, as a version answers it
export const revisionFields = (r: Omit<PlanRevision, "text">) => ({
  name: r.name,
  status: r.status,
  symbols: r.symbols,
  review_by: r.reviewBy,
  revision: r.revision,
  updated_at: iso(r.createdAt),
  author: r.author,
  bytes: r.bytes,
});

// the headings answered for a symbol are capped, so a read stays a page
export const MAX_SECTIONS = 20;
const HEADING_CHARS = 120;
export const SECTIONS_RESERVE = 4096;

export function sectionsOf(text: string, symbol: string, name: string | null) {
  const market = symbol.slice(0, symbol.indexOf(":"));
  return sectionsFor(text, namesOf({ id: symbol, market, name }))
    .slice(0, MAX_SECTIONS)
    .map((h) => ({
      heading: [...h.text].slice(0, HEADING_CHARS).join(""),
      level: h.level,
      line: h.line,
    }));
}

const KIND =
  (id: number): ((next: PlanRevision) => Kind) =>
  (next) => ({
    noun: "trade plan",
    notHere:
      "a plan holds one intent's levels, sizes and dates; split a long one into two plans",
    // the symbols are in the measured read; the reserve is a symbol's headings
    read: () => planRead({ id, fields: revisionFields(next) }, next),
    reserve: SECTIONS_RESERVE,
  });

const logSaved = (m: Markets, done: PlanSaved) => {
  if (done.unchanged) return;
  m.log.info("trade plan saved", {
    plan: done.plan.id,
    revision: done.plan.revision,
    bytes: done.plan.bytes,
  });
};

// an evicted revision says why it is gone, so an agent stops looking
export function missingPlanRevision(
  m: Markets,
  owner: string,
  id: number,
  revision: number,
): Failure {
  const live = liveRevision(m.db, owner, id);
  if (live === null)
    return { error: "not_found", message: `no trade plan ${id}` };
  return {
    error: "not_found",
    message:
      revision < live
        ? `revision ${revision} is no longer kept; the last ${KEPT_REVISIONS} are`
        : `no revision ${revision}`,
  };
}

// every write the tool and the routes share; its answer is the plan's item
export async function writePlan(
  m: Markets,
  who: Who,
  args: TradePlansWrite,
): Promise<
  | { item: ReturnType<typeof planItem>; unchanged: boolean; made: boolean }
  | Failure
> {
  const owner = who.user;
  const now = m.clock.now();
  const author = authorOf(m.db, who);
  const item = (p: Listed) => planItem(m, owner, p);
  switch (args.action) {
    case "create": {
      const symbols = await resolvePlanSymbols(m, who, args.symbols);
      if (!Array.isArray(symbols)) return symbols;
      const done = await createPlan(
        m.writer,
        owner,
        {
          name: args.name,
          text: args.text,
          symbols,
          status: "active",
          reviewBy: args.reviewBy,
        },
        KIND(0),
        author,
        now,
      );
      if ("error" in done) return done;
      logSaved(m, done);
      return { item: item(done.plan), unchanged: false, made: true };
    }
    case "delete": {
      const done = await removePlan(
        m.writer,
        owner,
        args.id,
        args.revision,
        author,
        now,
      );
      if ("error" in done) return done;
      m.log.info("trade plan deleted", { plan: done.id });
      return { item: item(done), unchanged: false, made: false };
    }
    case "restore": {
      const done = await restorePlan(m.writer, owner, args.id);
      if ("error" in done) return done;
      m.log.info("trade plan restored", { plan: done.id });
      return { item: item(done), unchanged: false, made: false };
    }
    default: {
      let change: PlanChange;
      if (args.action === "set") {
        const { action, id: _, revision: __, ...set } = args;
        change = { action, ...set };
        if (set.symbols !== undefined) {
          const symbols = await resolvePlanSymbols(m, who, set.symbols);
          if (!Array.isArray(symbols)) return symbols;
          change.symbols = symbols;
        }
      } else {
        change =
          args.action === "edit"
            ? { action: "edit", edits: args.edits }
            : { action: "replace", text: args.text };
      }
      const done = await savePlan(
        m.writer,
        owner,
        args.id,
        args.revision,
        change,
        KIND(args.id),
        author,
        now,
      );
      if ("error" in done) return done;
      logSaved(m, done);
      return { item: item(done.plan), unchanged: done.unchanged, made: false };
    }
  }
}

export const LIST_ROWS = 100;

export const listPosition = (p: Listed): string => `${p.updatedAt}.${p.id}`;

export function readListPosition(position: string): ListAt | null {
  const at = /^(\d{1,15})\.(\d{1,15})$/.exec(position);
  return at === null ? null : { updatedAt: Number(at[1]), id: Number(at[2]) };
}

export function planPage(
  m: Markets,
  owner: string,
  filter: { status: ListStatus; symbol: string | null },
  at: ListAt | null,
  size: number,
): { shown: Listed[]; last: Listed | null } {
  const raw = planList(
    m.db,
    owner,
    { status: filter.status, symbol: storedSymbol(m, filter.symbol) },
    at,
    size + 1,
  );
  const shown = raw.slice(0, size);
  return { shown, last: raw.length > size ? shown.at(-1)! : null };
}

function listAnswer(
  m: Markets,
  who: Who,
  args: Extract<TradePlansRead, { action: "list" }>,
): string {
  const filter = { status: args.status, symbol: args.symbol };
  let at: ListAt | null = null;
  if (args.next !== null) {
    const position = readCursor(args.next, filter);
    at = position === null ? null : readListPosition(position);
    if (at === null) throw new ArgError("next does not continue this list");
  }
  const { shown, last } = planPage(m, who.user, filter, at, LIST_ROWS);
  return fitPage(
    shown.map((p) => planItem(m, who.user, p)),
    (count) => ({
      next:
        count > 0 && count < shown.length
          ? cursor(listPosition(shown[count - 1]!), filter)
          : last === null
            ? null
            : cursor(listPosition(last), filter),
    }),
    "plans",
  ).text;
}

// the fields a read heads its text with; with a symbol, its sections
export function readFields(
  m: Markets,
  owner: string,
  p: Plan,
  symbol: string | null,
) {
  const id = storedSymbol(m, symbol);
  return {
    ...planItem(m, owner, p),
    created_at: iso(p.madeAt),
    ...(id === null
      ? {}
      : id.startsWith("?")
        ? // no listing: a symbol no heading is matched for
          { symbol: symbol!.trim(), sections: [] }
        : {
            symbol: id,
            sections: sectionsOf(
              p.text,
              id,
              readInstrument(m.db, id)?.name ?? null,
            ),
          }),
  };
}

// the save checked the text with room for headings, but quotes in them
// grow twice when escaped: the last sections go until the read is a page
export function fittedRead(
  p: Plan,
  fields: ReturnType<typeof readFields>,
): string {
  const sections: unknown[] = ("sections" in fields && fields.sections) || [];
  for (let kept = sections.length; ; kept--) {
    const shown =
      kept === sections.length
        ? fields
        : {
            ...fields,
            sections: sections.slice(0, kept),
            sections_left_out: sections.length - kept,
          };
    const text = planRead({ id: p.id, fields: shown }, p);
    if (kept === 0 || fits(text)) return text;
  }
}

// which parts each kept revision changed from the one before it, null
// when none before it is kept
export function versionItems(revisions: readonly VersionRow[]) {
  return revisions.map((r, k) => {
    const before = revisions[k + 1];
    const changed =
      before === undefined ||
      before.revision !== r.revision - 1 ||
      r.textChanged === null
        ? null
        : [
            ...(r.textChanged ? ["text"] : []),
            ...(r.name === before.name ? [] : ["name"]),
            ...(JSON.stringify(r.symbols) === JSON.stringify(before.symbols)
              ? []
              : ["symbols"]),
            ...(r.status === before.status ? [] : ["status"]),
            ...(r.reviewBy === before.reviewBy ? [] : ["review_by"]),
          ];
    return {
      revision: r.revision,
      author: r.author,
      updated_at: iso(r.createdAt),
      bytes: r.bytes,
      changed,
    };
  });
}

const notFound = (id: number): Failure => ({
  error: "not_found",
  message: `no trade plan ${id}`,
});

export async function tradePlansAnswer(
  m: Markets,
  who: Who,
  args: TradePlansRead | TradePlansWrite,
): Promise<ToolResult> {
  const writes = (TRADE_PLANS_WRITES as readonly string[]).includes(
    args.action,
  );
  if (!opens(who.tradePlans, writes)) return errorResult(forbidden(writes));
  if (writes) {
    const done = await writePlan(m, who, args as TradePlansWrite);
    if ("error" in done) return errorResult(done);
    return textResult(
      JSON.stringify({
        ...done.item,
        ...(done.unchanged ? { unchanged: true } : {}),
      }),
    );
  }
  const read = args as TradePlansRead;
  if (read.action === "list") return textResult(listAnswer(m, who, read));
  const owner = who.user;
  switch (read.action) {
    case "read": {
      const p = readPlan(m.db, owner, read.id);
      if (p === null) return errorResult(notFound(read.id));
      return textResult(fittedRead(p, readFields(m, owner, p, read.symbol)));
    }
    case "versions": {
      if (liveRevision(m.db, owner, read.id) === null) {
        return errorResult(notFound(read.id));
      }
      return textResult(
        JSON.stringify({
          id: read.id,
          revisions: versionItems(planVersions(m.db, owner, read.id)),
        }),
      );
    }
    case "version": {
      const r = planVersion(m.db, owner, read.id, read.revision);
      if (r === null) {
        return errorResult(
          missingPlanRevision(m, owner, read.id, read.revision),
        );
      }
      return textResult(
        planRead({ id: read.id, fields: revisionFields(r) }, r),
      );
    }
  }
}

// a quote item is never split across pages, so its pointer stays short
export const QUOTE_PLANS = 10;

// beside a quote item, for a key that opens trade plans: its owner's active
// plans tagged with it, the newest first, never their text
export function tradePlansField(m: Markets, who: Who, id: string) {
  if (who.tradePlans === "none") return {};
  const plans = plansFor(m.db, who.user, id);
  if (plans.length === 0) return {};
  return {
    trade_plans: plans.slice(0, QUOTE_PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      updated_at: iso(p.updatedAt),
      // the answer names its tool: an agent may never read a description
      read_with: "trade_plans",
    })),
    // the list action with symbol gives them all
    ...(plans.length > QUOTE_PLANS
      ? { trade_plans_more: plans.length - QUOTE_PLANS }
      : {}),
  };
}
