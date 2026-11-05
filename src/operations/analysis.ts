// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The analysis's reads and writes the tools and REST share. Its text is in
// no log line: logs carry the symbol, revision and bytes.

import { analysisRead, noAnalysis, WRITE_ONE } from "../analysis/read.ts";
import {
  analysisList,
  analysisPointer,
  analysisVersion,
  analysisVersions,
  type ListAt,
  type Listed,
  type Note,
  readAnalysis,
  saveAnalysis,
} from "../analysis/store.ts";
import {
  KEPT_REVISIONS,
  type RevisionInfo,
  type Save,
  type Saved,
} from "../document/store.ts";
import { iso, price, round } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { readQuote } from "../market/quotes.ts";
import { addDays, localDate } from "../market/zone.ts";
import { isFundKey } from "../portfolios/funds.ts";
import { splitsOf } from "../portfolios/store.ts";
import { splitFactor } from "../portfolios/value.ts";
import {
  AWAITING_DAYS,
  eventStatus,
  readEvents,
} from "../sources/finnhub/read.ts";
import { FUND_MARKET } from "../sources/ids.ts";
import {
  cursor,
  errorResult,
  type Failure,
  fitPage,
  readCursor,
  type ToolResult,
  textResult,
} from "./answer.ts";
import { ArgError, fields, optionalText, text, textValues } from "./args.ts";
import { actionOf, parseWrite, revisionOf } from "./document.ts";
import { noFund, seenFund } from "./funds.ts";
import type { Markets } from "./markets.ts";
import { type ItemError, readTargets, resolveTargets } from "./targets.ts";
import { opens, type Who } from "./who.ts";

export const ANALYSIS_READS = ["read", "list", "versions", "version"] as const;
export const ANALYSIS_WRITES = ["replace", "edit"] as const;

export type AnalysisReadArgs =
  | { action: "read"; symbol: string }
  | { action: "list"; next: string | null }
  | { action: "versions"; symbol: string }
  | { action: "version"; symbol: string; revision: number };

export type AnalysisWrite = { symbol: string; save: Save };

const NO_READ = "this key has no analysis access; its owner grants it";
const NO_WRITE = "this key reads the analysis only; its owner grants write";

const forbidden = (write: boolean): Failure => ({
  error: "forbidden",
  message: write ? NO_WRITE : NO_READ,
});

export function parseAnalysisRead(input: unknown): AnalysisReadArgs {
  const f = textValues(
    fields(input, ["action", "symbol", "revision", "next"]),
    { ids: ["revision"] },
  );
  const action = actionOf(f.action, ANALYSIS_READS);
  const refuse = (name: string) => {
    if (f[name] !== undefined) {
      throw new ArgError(`${name} is not an argument of ${action}`);
    }
  };
  if (action === "list") {
    refuse("symbol");
    refuse("revision");
    return { action, next: optionalText(f.next, "next", 300) };
  }
  refuse("next");
  const symbol = text(f.symbol, "symbol");
  if (action !== "version") {
    refuse("revision");
    return { action, symbol };
  }
  return { action, symbol, revision: revisionOf(f.revision) };
}

export function parseAnalysisEdit(input: unknown): AnalysisWrite {
  const f = textValues(
    fields(input, ["action", "symbol", "revision", "edits", "text"]),
    { ids: ["revision"] },
  );
  const save = parseWrite(f, ANALYSIS_WRITES, "symbol, ");
  return { symbol: text(f.symbol, "symbol"), save };
}

// a fund resolves only for one who holds or priced it, as its prices do;
// a write fetches what is new but never marks the symbol read
export async function analysisTarget(
  m: Markets,
  who: Who,
  input: string,
  read: boolean,
): Promise<Instrument | ({ input: string } & ItemError)> {
  if (isFundKey(input)) {
    return seenFund(m.db, who, input) ?? { input, ...noFund };
  }
  const [t] = await (read ? readTargets : resolveTargets)(m, [input]);
  return "error" in t! ? { input, ...t.error } : t!.instrument;
}

// measured, never judged: the price then and now and the earnings between
export function sinceWritten(m: Markets, i: Instrument, note: Note) {
  if (note.price === null) return null;
  const now = m.clock.now();
  const q = readQuote(m.db, i.id);
  const today = localDate(i.zone, now);
  const saved = localDate(i.zone, note.createdAt);
  // a split since puts the price then and now on two share counts
  const pricedOn = localDate(i.zone, note.pricedAt ?? note.createdAt);
  const splits = splitsOf(m.db, i.id).filter((s) => s.date > pricedOn);
  const then = note.price / splitFactor(splits, pricedOn);
  // a currency changed since makes the two prices no move
  const change =
    q !== null && note.currency === i.currency && then !== 0
      ? round((q.price / then - 1) * 100)
      : null;
  return {
    price: price(note.price),
    currency: note.currency,
    priced_at: iso(note.pricedAt),
    price_now: price(q?.price ?? null),
    fetched_at: iso(q?.fetchedAt ?? null),
    change_percent: change,
    splits: splits.map((s) => ({ date: s.date, ratio: s.ratio })),
    // a report seen late can be dated in the days before the save
    earnings: readEvents(m.db, addDays(saved, -AWAITING_DAYS), today, [i.id])
      // a report seen before the save is one the note could read
      .filter((e) =>
        e.reportedSeenAt === null
          ? e.date > saved
          : e.reportedSeenAt > note.createdAt,
      )
      .map((e) => ({
        date: e.date,
        hour: e.hour,
        status: eventStatus(e, today),
      })),
  };
}

export const analysisItem = (r: RevisionInfo) => ({
  revision: r.revision,
  author: r.author,
  bytes: r.bytes,
  written_at: iso(r.createdAt),
});

export const savedAnalysis = (s: Saved) => ({
  ...analysisItem(s.saved),
  ...(s.unchanged ? { unchanged: true } : {}),
});

// beside the research overview, for a key that opens the analysis only
export function analysisField(m: Markets, who: Who, id: string) {
  if (who.analysis === "none") return {};
  const p = analysisPointer(m.db, id);
  return {
    analysis:
      p === null
        ? null
        : {
            revision: p.revision,
            written_at: iso(p.createdAt),
            // the answer names its tool: an agent may never read a description
            read_with: "analysis",
          },
  };
}

// an evicted revision says why it is gone, so an agent stops looking
export function missingAnalysis(
  m: Markets,
  symbol: string,
  revision: number,
): Failure {
  const live = analysisPointer(m.db, symbol)?.revision ?? null;
  return {
    error: "not_found",
    message:
      live !== null && revision < live
        ? `revision ${revision} is no longer kept; the last ${KEPT_REVISIONS} are`
        : `no revision ${revision}`,
  };
}

export async function saveAnalysisAnswer(
  m: Markets,
  who: Who,
  symbol: string,
  save: Save,
): Promise<Saved | Failure> {
  const done = await saveAnalysis(m.writer, symbol, save, who, m.clock.now());
  if ("error" in done) return done;
  if (!done.unchanged) {
    m.log.info("analysis saved", {
      // a fund's ISIN would tell the operator what someone holds
      symbol: isFundKey(symbol) ? FUND_MARKET : symbol,
      revision: done.saved.revision,
      bytes: done.saved.bytes,
    });
  }
  return done;
}

export const LIST_ROWS = 100;

export const listPosition = (r: Listed): string => `${r.createdAt}.${r.symbol}`;

export function readListPosition(position: string): ListAt | null {
  const at = /^(\d{1,15})\.(.+)$/.exec(position);
  return at === null ? null : { createdAt: Number(at[1]), symbol: at[2]! };
}

// a fund's note only to one who sees it, as seenFund() rules
export function listedPage(
  m: Markets,
  who: Who,
  at: ListAt | null,
  size: number,
): { shown: Listed[]; last: Listed | null } {
  const viewer = { user: who.user, funds: opens(who.portfolio, false) };
  const raw = analysisList(m.db, viewer, at, size + 1);
  const shown = raw.slice(0, size);
  return { shown, last: raw.length > size ? shown.at(-1)! : null };
}

export const listedItem = (r: Listed) => ({
  id: r.symbol,
  ...analysisItem(r),
});

function listAnswer(m: Markets, who: Who, next: string | null): string {
  let at: ListAt | null = null;
  if (next !== null) {
    const position = readCursor(next, {});
    at = position === null ? null : readListPosition(position);
    if (at === null) throw new ArgError("next does not continue this list");
  }
  const { shown, last } = listedPage(m, who, at, LIST_ROWS);
  return fitPage(
    shown.map(listedItem),
    (count) => ({
      next:
        count > 0 && count < shown.length
          ? cursor(listPosition(shown[count - 1]!), {})
          : last === null
            ? null
            : cursor(listPosition(last), {}),
    }),
    "analyses",
  ).text;
}

export async function analysisAnswer(
  m: Markets,
  who: Who,
  args: AnalysisReadArgs | AnalysisWrite,
): Promise<ToolResult> {
  const writes = "save" in args;
  if (!opens(who.analysis, writes)) return errorResult(forbidden(writes));
  if (!writes && args.action === "list") {
    return textResult(listAnswer(m, who, args.next));
  }
  const i = await analysisTarget(m, who, args.symbol, !writes);
  if ("input" in i) return errorResult(i);
  if (writes) {
    const done = await saveAnalysisAnswer(m, who, i.id, args.save);
    if ("error" in done) return errorResult(done);
    return textResult(JSON.stringify({ id: i.id, ...savedAnalysis(done) }));
  }
  switch (args.action) {
    case "read": {
      const note = readAnalysis(m.db, i.id);
      if (note === null) {
        return textResult(
          `${noAnalysis(i.id)}${who.analysis === "write" ? WRITE_ONE : ""}`,
        );
      }
      return textResult(analysisRead(i.id, note, sinceWritten(m, i, note)));
    }
    case "versions":
      return textResult(
        JSON.stringify({
          id: i.id,
          revisions: analysisVersions(m.db, i.id).map(analysisItem),
        }),
      );
    case "version": {
      const note = analysisVersion(m.db, i.id, args.revision);
      if (note === null) {
        return errorResult(missingAnalysis(m, i.id, args.revision));
      }
      return textResult(analysisRead(i.id, note));
    }
  }
}
