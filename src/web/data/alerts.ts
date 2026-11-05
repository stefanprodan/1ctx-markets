// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Alerts page's calls and signals: the person's alerts with how close
// each is now, what triggered, and what the browser has shown.
// A change answers the refusal's sentence, or null once done.

import { batch, signal } from "@preact/signals";
import { type Later, paced, timer } from "../lib/slow.ts";
import { ApiError, type Call, codeOf, says } from "./api.ts";

export const ALERTS_PATH = "/api/v1/alerts";
export const HISTORY_PATH = "/api/v1/alerts/history";
export const SEEN_PATH = "/api/v1/alerts/seen";

export type Listing = {
  name: string | null;
  type: string;
  currency: string | null;
  unit: string;
};

export type Listings = Record<string, Listing>;

export type AlertState =
  | "watching"
  | "triggered"
  | "waiting_for_earnings"
  | "paused"
  | "split_paused"
  | "unknown";

// one comparison of when, in its order: symbol absent is the alert's own
export type Now = {
  field: string;
  symbol?: string;
  benchmark?: string;
  value: number | null;
  level: number | null;
  gap: number | null;
  gap_percent?: number | null;
  holds: boolean | null;
};

export type Alert = {
  id: number;
  symbol: string;
  when: string;
  note: string | null;
  after_earnings?: {
    symbol: string;
    fiscal_year: number;
    fiscal_quarter: number;
    date: string | null;
    status: string | null;
  };
  state: AlertState;
  reasons?: string[];
  last_triggered_at: string | null;
  gap_percent: number | null;
  now: Now[];
};

export type Trigger = {
  id: number;
  alert_id: number;
  truncated?: true;
  symbol: string;
  when: string;
  note: string | null;
  triggered_at: string;
  values: Record<string, number | null>;
  after_earnings?: {
    symbol: string;
    fiscal_year: number;
    fiscal_quarter: number;
  };
};

// a stored trigger the server could not read comes with its id only
const readable = (ts: readonly Trigger[]) => ts.filter((t) => !t.truncated);

type AlertsAnswer = {
  alerts: Alert[];
  instruments: Listings;
  next_page_token?: string;
};
type HistoryAnswer = {
  triggers: Trigger[];
  instruments: Listings;
  next_page_token?: string;
};
export type Seen = { seen: number; unseen: number };

// more than anyone keeps, so a page of alerts never loops on
const MAX_PAGES = 20;

const alertPath = (id: number) => `${ALERTS_PATH}/${id}`;

export type AlertsStore = ReturnType<typeof alertsStore>;

export function alertsStore(
  call: Call,
  session: () => number,
  later: Later = timer,
) {
  const alerts = signal<Alert[] | null>(null);
  const history = signal<Trigger[] | null>(null);
  // the newest trigger, readable or not, so an unreadable one can be seen
  const newest = signal(0);
  const listings = signal<Listings>({});
  const next = signal<string | null>(null);
  const more = signal(false);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);
  const failures = signal(0);
  const seen = signal<Seen | null>(null);
  // the last id seen before this visit to Fired: newer rows keep a dot
  const seenBefore = signal<number | null>(null);

  // every page of alerts, so the page holds them all
  async function allAlerts(): Promise<AlertsAnswer> {
    const first = await call<AlertsAnswer>(ALERTS_PATH);
    let token = first.next_page_token;
    const out = { alerts: [...first.alerts], instruments: first.instruments };
    for (let k = 1; token !== undefined && k < MAX_PAGES; k++) {
      const page = await call<AlertsAnswer>(
        `${ALERTS_PATH}?page_token=${encodeURIComponent(token)}`,
      );
      out.alerts.push(...page.alerts);
      out.instruments = { ...out.instruments, ...page.instruments };
      token = page.next_page_token;
    }
    return out;
  }

  let load = 0;
  async function loadAll(): Promise<void> {
    const mine = ++load;
    const at = session();
    const stale = () => mine !== load || at !== session();
    try {
      const [a, h] = await paced(
        Promise.all([allAlerts(), call<HistoryAnswer>(HISTORY_PATH)]),
        later,
      );
      if (stale()) return;
      batch(() => {
        alerts.value = a.alerts;
        // what More added stays under the fresh first page
        const last = h.triggers.at(-1)?.id ?? 0;
        const older = (history.value ?? []).filter((x) => x.id < last);
        history.value = [...readable(h.triggers), ...older];
        newest.value = h.triggers[0]?.id ?? 0;
        if (older.length === 0) next.value = h.next_page_token ?? null;
        listings.value = {
          ...listings.value,
          ...a.instruments,
          ...h.instruments,
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
    const token = next.value;
    if (token === null || more.value) return;
    more.value = true;
    // a refresh or a sign-out since makes this page another list's
    const mine = load;
    const at = session();
    const stale = () => mine !== load || at !== session();
    try {
      const h = await call<HistoryAnswer>(
        `${HISTORY_PATH}?page_token=${encodeURIComponent(token)}`,
      );
      if (stale()) return;
      batch(() => {
        history.value = [...(history.value ?? []), ...readable(h.triggers)];
        listings.value = { ...listings.value, ...h.instruments };
        next.value = h.next_page_token ?? null;
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
    const id = Math.max(newest.value, history.value?.[0]?.id ?? 0);
    if (id === 0) return;
    if (seenBefore.value === null) seenBefore.value = seen.value?.seen ?? 0;
    if ((seen.value?.seen ?? 0) >= id) return;
    const at = session();
    try {
      const s = await call<Seen>(SEEN_PATH, "PUT", { id });
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
    change(() => call(alertPath(id), "PATCH", { paused }));
  const remove = (id: number) => change(() => call(alertPath(id), "DELETE"));
  const add = (symbol: string, above: boolean, level: number, note: string) =>
    change(() =>
      call(ALERTS_PATH, "POST", {
        symbol,
        when: `price ${above ? ">=" : "<="} ${level}`,
        ...(note.trim() === "" ? {} : { note: note.trim() }),
      }),
    );

  const signedOut = () => {
    load++;
    newest.value = 0;
    batch(() => {
      alerts.value = null;
      history.value = null;
      listings.value = {};
      next.value = null;
      seen.value = null;
      seenBefore.value = null;
    });
  };

  return {
    alerts,
    history,
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
    newest,
    pause,
    remove,
    add,
    signedOut,
  };
}
