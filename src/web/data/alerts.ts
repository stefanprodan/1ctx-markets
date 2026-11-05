// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Alerts page's calls and signals: the person's rules with their
// evaluation now, the alerts they fired, and what the browser has shown.
// A change answers the refusal's sentence, or null once done.

import { batch, signal } from "@preact/signals";
import { type Later, paced, timer } from "../lib/slow.ts";
import { ApiError, type Call, codeOf, says } from "./api.ts";

export const RULES_PATH = "/api/v1/rules";
export const RECENT_PATH = "/api/v1/alerts/recent";
export const SEEN_PATH = "/api/v1/alerts/seen";

export type Op = "<" | "<=" | ">" | ">=";

export type Operand = { field: string; symbol: string; benchmark?: string };

export type Node =
  | { left: Operand; op: Op; right: number | Operand }
  | { all: Node[] }
  | { any: Node[] };

export type Condition = Node & { afterEarnings?: string };

export type OperandValue = Operand & {
  value: number | null;
  trade_time: string | null;
};

export type ComparisonValue = {
  left: OperandValue;
  op: Op;
  right: number | OperandValue;
  holds: boolean | null;
};

export type Listing = {
  name: string | null;
  type: string;
  currency: string | null;
  unit: string;
};

export type Listings = Record<string, Listing>;

export type Rule = {
  id: number;
  symbol: string;
  condition: Condition;
  note: string | null;
  paused: "manual" | "split" | null;
  armed: boolean;
  created_at: string;
  last_result: "true" | "false" | "unknown" | null;
  last_evaluated_at: string | null;
  after_earnings?: {
    symbol: string;
    fiscal_year: number;
    fiscal_quarter: number;
    status: string | null;
  };
  now: {
    result: "true" | "false" | "unknown";
    values: ComparisonValue[];
    reasons: string[];
  };
};

export type Alert = {
  id: number;
  rule_id: number;
  fired_at: string;
  symbol: string;
  note: string | null;
  condition: Condition;
  after_earnings?: {
    symbol: string;
    fiscal_year: number;
    fiscal_quarter: number;
  };
  values: ComparisonValue[];
};

type RulesAnswer = { rules: Rule[]; instruments: Listings };
type RecentAnswer = {
  alerts: Alert[];
  instruments: Listings;
  next: number | null;
};
export type Seen = { seen: number; unseen: number };

const rulePath = (id: number) => `${RULES_PATH}/${id}`;

export type AlertsStore = ReturnType<typeof alertsStore>;

export function alertsStore(
  call: Call,
  session: () => number,
  later: Later = timer,
) {
  const rules = signal<Rule[] | null>(null);
  const alerts = signal<Alert[] | null>(null);
  const listings = signal<Listings>({});
  const next = signal<number | null>(null);
  const more = signal(false);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);
  const failures = signal(0);
  const seen = signal<Seen | null>(null);
  // the last id seen before this visit to Fired: newer rows keep a dot
  const seenBefore = signal<number | null>(null);

  let load = 0;
  async function loadAll(): Promise<void> {
    const mine = ++load;
    const at = session();
    const stale = () => mine !== load || at !== session();
    try {
      const [r, a] = await paced(
        Promise.all([
          call<RulesAnswer>(RULES_PATH),
          call<RecentAnswer>(RECENT_PATH),
        ]),
        later,
      );
      if (stale()) return;
      batch(() => {
        rules.value = r.rules;
        // what More added stays under the fresh first page
        const last = a.alerts.at(-1)?.id ?? 0;
        const older = (alerts.value ?? []).filter((x) => x.id < last);
        alerts.value = [...a.alerts, ...older];
        if (older.length === 0) next.value = a.next;
        listings.value = {
          ...listings.value,
          ...r.instruments,
          ...a.instruments,
        };
        error.value = null;
        code.value = null;
      });
    } catch (e) {
      if (stale()) return;
      if (!(e instanceof ApiError && e.status === 401)) {
        error.value = says(e);
        code.value = codeOf(e);
        failures.value++;
      }
    }
  }

  async function loadMore(): Promise<void> {
    const before = next.value;
    if (before === null || more.value) return;
    more.value = true;
    // a refresh or a sign-out since makes this page another list's
    const mine = load;
    const at = session();
    const stale = () => mine !== load || at !== session();
    try {
      const a = await call<RecentAnswer>(`${RECENT_PATH}?before=${before}`);
      if (stale()) return;
      batch(() => {
        alerts.value = [...(alerts.value ?? []), ...a.alerts];
        listings.value = { ...listings.value, ...a.instruments };
        next.value = a.next;
      });
    } catch (e) {
      if (stale()) return;
      error.value = says(e);
      failures.value++;
    } finally {
      more.value = false;
    }
  }

  async function loadSeen(): Promise<void> {
    const at = session();
    try {
      const s = await call<Seen>(SEEN_PATH);
      // a read that started before a mark answered never moves it back
      if (at === session() && s.seen >= (seen.value?.seen ?? 0)) {
        seen.value = s;
      }
    } catch {
      // the mark waits for the next refresh
    }
  }

  // Fired was opened: the newest is seen, the ones before keep their dot
  async function markSeen(): Promise<void> {
    const newest = alerts.value?.[0]?.id;
    if (newest === undefined) return;
    if (seenBefore.value === null) seenBefore.value = seen.value?.seen ?? 0;
    if ((seen.value?.seen ?? 0) >= newest) return;
    const at = session();
    try {
      const s = await call<Seen>(SEEN_PATH, "PUT", { id: newest });
      if (at === session()) seen.value = s;
    } catch {
      // seen again on the next visit
    }
  }

  const leftFired = () => {
    seenBefore.value = null;
  };

  async function change(run: () => Promise<unknown>): Promise<string | null> {
    try {
      await run();
      await loadAll();
      return null;
    } catch (e) {
      return says(e);
    }
  }

  const pause = (id: number, paused: boolean) =>
    change(() => call(rulePath(id), "PATCH", { paused }));
  const remove = (id: number) => change(() => call(rulePath(id), "DELETE"));
  const add = (symbol: string, above: boolean, level: number, note: string) =>
    change(() =>
      call(RULES_PATH, "POST", {
        symbol,
        condition: { left: "price", op: above ? ">=" : "<=", right: level },
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      }),
    );

  const signedOut = () => {
    load++;
    batch(() => {
      rules.value = null;
      alerts.value = null;
      listings.value = {};
      next.value = null;
      seen.value = null;
      seenBefore.value = null;
    });
  };

  return {
    rules,
    alerts,
    listings,
    next,
    more,
    error,
    code,
    failures,
    seen,
    seenBefore,
    loadAll,
    loadMore,
    loadSeen,
    markSeen,
    leftFired,
    pause,
    remove,
    add,
    signedOut,
  };
}
