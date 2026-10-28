// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { batch, signal } from "@preact/signals";
import type { History, Interval } from "../views/Chart.model.ts";
import { ApiError, client, type Fetch, failure, says } from "./api.ts";

export type SourceStatus = {
  name: string;
  label: string;
  short: string;
  mark: string;
  // how to turn it on, for a source that needs a key
  key: { file: string; adds: string; signup: string } | null;
  state: "on" | "off";
  why: string;
  backing_off: { until: string | null; after: string } | null;
};

export type JobStatus = {
  source: string;
  job: string;
  label: string;
  about: string | null;
  last: {
    scope: string | null;
    started_at: string | null;
    ended_at: string | null;
    status: "running" | "ok" | "failed";
    rows: number;
    error: string | null;
  };
  instruments: number;
  markets: number;
  failing_instruments: number;
  failing_markets: number;
  failing_scopes: number;
  failing: { scope: string | null; error: string | null; at: string | null }[];
};

export type TrackStatus = { value: string; id: string | null; state: string };

export type Status = {
  version: string;
  sources: SourceStatus[];
  jobs: JobStatus[];
  instruments: number;
  tracked: number;
  track: TrackStatus[];
  database_bytes: number;
};

export type Listed = {
  id: string;
  name: string | null;
  market: string;
  currency: string | null;
  kind: string;
  unit: string;
  source: string;
  tracked: boolean;
  tracked_by: ("rule" | "read" | "track")[];
  read_until: string | null;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  fetched_at: string | null;
};

export type Session = {
  state: "open" | "closed";
  start: string | null;
  end: string | null;
};

export type Returns = {
  "1w": number | null;
  "1m": number | null;
  "3m": number | null;
  ytd: number | null;
  to: string;
  live: boolean;
};

export type Detail = {
  instrument: Listed;
  // null when the read failed; error says why
  error: { error: string; message: string } | null;
  quote: null | {
    id: string;
    price: number | null;
    observation?: { date: string; value: number } | null;
    change: number | null;
    change_percent: number | null;
    unit: string;
    currency: string | null;
    fetched_at: string | null;
    stale: string[];
    returns: Returns | null;
    session: Session | null;
  };
};

export const PARTS = [
  "quotes",
  "bars",
  "research",
  "calendar",
  "news",
] as const;
export type Part = (typeof PARTS)[number];
export const SECTIONS = ["metric", "analysts", "earnings", "insider"] as const;
export type Section = (typeof SECTIONS)[number];

export type Fetched = {
  symbol: string;
  part?: Part;
  section?: Section;
  status: "fetched" | "not covered" | "source off" | "failed" | "not found";
  rows?: number;
  error?: string;
};

// a delete a rule holds names the rules; any other refusal is its sentence
export type Removed =
  | { ok: true }
  | { ok: false; rules: number[] }
  | { ok: false; error: string };

type ListedPage = { total: number; more: boolean; instruments: Listed[] };

export const INSTRUMENTS_PATH = "/api/v1/admin/instruments";
export const REFETCH_PATH = "/api/v1/admin/refetch";
export const HISTORY_PATH = "/api/v1/history";
const one = (id: string) => `${INSTRUMENTS_PATH}/${encodeURIComponent(id)}`;
export const STATUS_PATH = "/api/v1/admin/status";
export const SESSION_PATH = "/ui/session";

export function store(fetchFn: Fetch, now: () => number = Date.now) {
  // undefined until the first answer says whether the cookie holds
  const signedIn = signal<boolean | undefined>(undefined);
  const status = signal<Status | null>(null);
  // when the status on screen was answered, for the head's line
  const statusAt = signal<number | null>(null);
  const statusError = signal<string | null>(null);
  const loading = signal(false);
  const instruments = signal<Listed[] | null>(null);
  const instrumentsError = signal<string | null>(null);
  // the instrument page's, by the id asked last
  const detail = signal<Detail | null>(null);
  const detailId = signal<string | null>(null);
  const detailError = signal<string | null>(null);

  const signedOut = () =>
    batch(() => {
      signedIn.value = false;
      status.value = null;
      statusAt.value = null;
      statusError.value = null;
      instruments.value = null;
      instrumentsError.value = null;
      detail.value = null;
      detailId.value = null;
      detailError.value = null;
    });
  const call = client(fetchFn, signedOut);
  // a superseded load's 401 must not sign out a newer sign-in, so the
  // status load signs out itself, only while it is the latest
  const quiet = client(fetchFn, () => {});
  // a later load supersedes one in flight, and a superseded one answers
  // with the latest's outcome, so a sign-in never reads a stale result
  let latest = 0;
  let current: Promise<boolean> = Promise.resolve(false);

  function loadStatus(): Promise<boolean> {
    current = load(++latest);
    return current;
  }

  async function load(mine: number): Promise<boolean> {
    loading.value = true;
    try {
      const s = await quiet<Status>(STATUS_PATH);
      if (mine !== latest) return current;
      batch(() => {
        signedIn.value = true;
        status.value = s;
        statusAt.value = now();
        statusError.value = null;
      });
      return true;
    } catch (error) {
      if (mine !== latest) return current;
      if (error instanceof ApiError && error.status === 401) signedOut();
      else statusError.value = says(error);
      return false;
    } finally {
      if (mine === latest) loading.value = false;
    }
  }

  // every stored instrument, a page at a time; a list is no read. A load
  // already going answers for a second ask, so a tick never stacks.
  let listing: Promise<void> | null = null;
  function loadInstruments(): Promise<void> {
    listing ??= listAll().finally(() => {
      listing = null;
    });
    return listing;
  }
  async function listAll(): Promise<void> {
    try {
      const all: Listed[] = [];
      let after = "";
      for (;;) {
        const page = await call<ListedPage>(
          `${INSTRUMENTS_PATH}?limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        );
        all.push(...page.instruments);
        if (!page.more || page.instruments.length === 0) break;
        after = page.instruments.at(-1)!.id;
      }
      batch(() => {
        instruments.value = all;
        instrumentsError.value = null;
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        instrumentsError.value = says(error);
      }
    }
  }

  // a later id supersedes one in flight; the same id reloads in place
  // a later load supersedes one in flight, even of the same id, so a
  // refresh tick never lands over the reload after a refetch
  let instrumentLoad = 0;
  async function loadInstrument(id: string): Promise<void> {
    const mine = ++instrumentLoad;
    if (detailId.value !== id) {
      batch(() => {
        detailId.value = id;
        detail.value = null;
        detailError.value = null;
      });
    }
    try {
      const d = await call<Detail>(one(id));
      if (mine !== instrumentLoad) return;
      batch(() => {
        detail.value = d;
        detailError.value = null;
      });
    } catch (error) {
      if (mine !== instrumentLoad) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        detailError.value = says(error);
      }
    }
  }

  async function refetch(
    id: string,
    parts: readonly Part[],
    sections: readonly Section[],
  ): Promise<Fetched[]> {
    const done = await call<{ results: Fetched[] }>(REFETCH_PATH, "POST", {
      symbols: [id],
      fetch: parts,
      ...(parts.includes("research") ? { sections } : {}),
    });
    // what changed shows at once
    void loadInstrument(id);
    return done.results;
  }

  async function remove(id: string): Promise<Removed> {
    try {
      await call(one(id), "DELETE");
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        typeof error.body === "object" &&
        error.body !== null &&
        "rules" in error.body &&
        Array.isArray(error.body.rules)
      ) {
        return { ok: false, rules: error.body.rules as number[] };
      }
      return { ok: false, error: says(error) };
    }
    batch(() => {
      instruments.value = instruments.value?.filter((r) => r.id !== id) ?? null;
      if (detailId.value === id) detail.value = null;
    });
    return { ok: true };
  }

  // a chart's bars with their candles and volume; a read, as the page is
  function history(id: string, from: string, interval: Interval) {
    const q = new URLSearchParams({ symbol: id, from, interval, ohlc: "true" });
    return call<History>(`${HISTORY_PATH}?${q}`);
  }

  return {
    history,
    detail,
    detailId,
    detailError,
    loadInstrument,
    refetch,
    remove,
    instruments,
    instrumentsError,
    loadInstruments,
    signedIn,
    status,
    statusAt,
    statusError,
    loading,
    loadStatus,
    // the status answers whether the cookie holds, so one call does both
    check: loadStatus,
    // a wrong key is no session ending, so it skips the 401 hook
    async signIn(key: string): Promise<void> {
      let res: Response;
      try {
        res = await fetchFn(SESSION_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: key.trim() }),
        });
      } catch {
        throw failure(0, null);
      }
      if (res.status === 401) {
        throw new ApiError(401, "wrong admin key");
      }
      if (!res.ok) {
        throw failure(res.status, await res.json().catch(() => null));
      }
      // the cookie set but the status refused, so the form says why; a
      // 401 here is a cookie the browser dropped, never a session ended
      if (!(await loadStatus())) {
        throw new ApiError(0, statusError.value ?? "not signed in");
      }
    },
    async signOut(): Promise<void> {
      await call(SESSION_PATH, "DELETE");
      // a status load still in flight must not sign back in
      latest++;
      current = Promise.resolve(false);
      loading.value = false;
      signedOut();
    },
  };
}

export type Store = ReturnType<typeof store>;

export const markets: Store = store((input, init) => fetch(input, init));
