// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { batch, signal } from "@preact/signals";
import { path } from "../app/router.ts";
import {
  fromOf,
  type History,
  type Interval,
  type Intraday,
  type IntradayRange,
} from "../views/Chart.model.ts";
import { ApiError, client, codeOf, type Fetch, failure, says } from "./api.ts";

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

export type Status = {
  version: string;
  sources: SourceStatus[];
  jobs: JobStatus[];
  instruments: number;
  tracked: number;
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

// a --track value; state is pending, tracked or its read's error code
export type WatchEntry = {
  value: string;
  id: string | null;
  state: string;
  instrument: Listed | null;
  session: Session | null;
  intraday: boolean;
};

type Watchlist = { attribution?: string; entries: WatchEntry[] };

export type Spark = Intraday | History;

export type Returns = {
  "1w": number | null;
  "1m": number | null;
  "3m": number | null;
  ytd: number | null;
  to: string;
  live: boolean;
};

export type Detail = {
  // FRED's notice, which its terms ask wherever its values show
  attribution?: string;
  // who the prices are from: the source's name and site
  credit: { name: string; url: string } | null;
  instrument: Listed;
  // null when the read failed; error says why
  error: { code: string; detail: string } | null;
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
    // the daily and weekly signals the quote tool gives; the page reads
    // the weekly 200 average
    signals?: {
      weekly?: { sma200?: number | null } | null;
    } | null;
    session: Session | null;
    // pre or post trading while the regular session is closed
    extended?: {
      session: "pre" | "post";
      price: number | null;
      change: number | null;
      change_percent: number | null;
      time: string;
    } | null;
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
  part: Part;
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

type ListedPage = {
  total: number;
  instruments: Listed[];
  // absent on the last page
  next_page_token?: string;
};

export const INSTRUMENTS_PATH = "/api/v1/instruments";
export const instrumentPath = (id: string) =>
  `${INSTRUMENTS_PATH}/${encodeURIComponent(id)}`;
export const STATUS_PATH = "/api/v1/status";
export const WATCHLIST_PATH = "/api/v1/watchlist";
export const SESSION_PATH = "/ui/session";

// here: the page shown, so an answer that arrives after leaving starts nothing
export function store(
  fetchFn: Fetch,
  now: () => number = Date.now,
  here: () => string = () => path.peek(),
) {
  // undefined until the first answer says whether the cookie holds
  const signedIn = signal<boolean | undefined>(undefined);
  const status = signal<Status | null>(null);
  // when the status on screen was answered, for the head's line
  const statusAt = signal<number | null>(null);
  const statusError = signal<string | null>(null);
  // its HTTP code, shown beside the words; null when no server answered
  const statusCode = signal<number | null>(null);
  const watchlist = signal<WatchEntry[] | null>(null);
  // FRED's terms ask for its notice wherever its values show
  const attribution = signal<string | null>(null);
  const sparks = signal<ReadonlyMap<string, Spark>>(new Map());
  const homeError = signal<string | null>(null);
  const homeCode = signal<number | null>(null);
  // each page's failed loads, so the same error again shows again and
  // another page's failure never does
  const statusFailures = signal(0);
  const homeFailures = signal(0);
  const instrumentsFailures = signal(0);
  const detailFailures = signal(0);
  const loading = signal(false);
  const instruments = signal<Listed[] | null>(null);
  const instrumentsError = signal<string | null>(null);
  const instrumentsCode = signal<number | null>(null);
  // the instrument page's, by the id asked last
  const detail = signal<Detail | null>(null);
  const detailId = signal<string | null>(null);
  const detailError = signal<string | null>(null);
  const detailCode = signal<number | null>(null);

  // a sign-in or sign-out starts a session anew: a call from before it
  // neither lands its answer nor signs the new one out
  let session = 0;
  // a later status load supersedes one in flight, and a superseded one
  // answers with the latest's outcome, so a sign-in never reads a stale
  // result
  let latest = 0;
  let current: Promise<boolean> = Promise.resolve(false);
  // Status and Home both read the watchlist: an older answer never lands
  // over a newer one, or a resolved card would turn back to Pending
  let watchAsked = 0;
  let watchShown = 0;
  const showWatchlist = (asked: number, w: Watchlist) => {
    if (asked < watchShown) return;
    watchShown = asked;
    watchlist.value = w.entries;
    attribution.value = w.attribution ?? null;
  };

  const signedOut = () => {
    session++;
    latest++;
    current = Promise.resolve(false);
    loading.value = false;
    batch(() => {
      signedIn.value = false;
      status.value = null;
      statusAt.value = null;
      statusError.value = null;
      statusCode.value = null;
      watchlist.value = null;
      attribution.value = null;
      sparks.value = new Map();
      homeError.value = null;
      homeCode.value = null;
      instruments.value = null;
      instrumentsError.value = null;
      instrumentsCode.value = null;
      detail.value = null;
      detailId.value = null;
      detailError.value = null;
      detailCode.value = null;
    });
  };
  const quiet = client(fetchFn, () => {});
  // a 401 signs out only the session the call was made in
  async function call<T>(
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<T> {
    const mine = session;
    try {
      return await quiet<T>(path, method, body);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 401 &&
        mine === session
      ) {
        signedOut();
      }
      throw error;
    }
  }

  function loadStatus(): Promise<boolean> {
    current = load(++latest);
    return current;
  }

  async function load(mine: number): Promise<boolean> {
    loading.value = true;
    const asked = ++watchAsked;
    try {
      // the status page shows both, so they land together; a 401 from
      // either signs out, whichever failed first
      const [s, w] = await Promise.allSettled([
        quiet<Status>(STATUS_PATH),
        quiet<Watchlist>(WATCHLIST_PATH),
      ]);
      if (s.status === "rejected" || w.status === "rejected") {
        const errors = [s, w].flatMap((r) =>
          r.status === "rejected" ? [r.reason as unknown] : [],
        );
        throw (
          errors.find((e) => e instanceof ApiError && e.status === 401) ??
          errors[0]
        );
      }
      if (mine !== latest) return current;
      batch(() => {
        signedIn.value = true;
        status.value = s.value;
        showWatchlist(asked, w.value);
        statusAt.value = now();
        statusError.value = null;
        statusCode.value = null;
      });
      return true;
    } catch (error) {
      if (mine !== latest) return current;
      if (error instanceof ApiError && error.status === 401) signedOut();
      else {
        statusError.value = says(error);
        statusCode.value = codeOf(error);
        statusFailures.value++;
      }
      return false;
    } finally {
      if (mine === latest) loading.value = false;
    }
  }

  // every stored instrument, a page at a time; a list is no read. A load
  // already going answers for a second ask, so a tick never stacks.
  let listing: Promise<void> | null = null;
  // a delete or a new session makes a list in flight stale: its answer
  // never lands, and the next ask starts a list of its own
  let listed = 0;
  function loadInstruments(): Promise<void> {
    listing ??= listAll().finally(() => {
      listing = null;
    });
    return listing;
  }
  async function listAll(): Promise<void> {
    const mine = ++listed;
    const at = session;
    const stale = () => mine !== listed || at !== session;
    try {
      const all: Listed[] = [];
      let token: string | undefined;
      do {
        const q = new URLSearchParams({ page_size: "200" });
        if (token !== undefined) q.set("page_token", token);
        const page = await call<ListedPage>(`${INSTRUMENTS_PATH}?${q}`);
        all.push(...page.instruments);
        token = page.next_page_token;
      } while (token !== undefined);
      if (stale()) return;
      batch(() => {
        instruments.value = all;
        instrumentsError.value = null;
        instrumentsCode.value = null;
      });
    } catch (error) {
      if (stale()) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        instrumentsError.value = says(error);
        instrumentsCode.value = codeOf(error);
        instrumentsFailures.value++;
      }
    }
  }

  // a later load supersedes one in flight, even of the same id, so a
  // refresh tick never lands over the reload after a refetch
  let instrumentLoad = 0;
  async function loadInstrument(id: string): Promise<void> {
    const mine = ++instrumentLoad;
    const at = session;
    if (detailId.value !== id) {
      batch(() => {
        detailId.value = id;
        detail.value = null;
        detailError.value = null;
        detailCode.value = null;
      });
    }
    try {
      const d = await call<Detail>(instrumentPath(id));
      if (mine !== instrumentLoad || at !== session) return;
      batch(() => {
        detail.value = d;
        detailError.value = null;
        detailCode.value = null;
      });
    } catch (error) {
      if (mine !== instrumentLoad || at !== session) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        // the API's hint names its search endpoint, which means nothing here
        detailError.value =
          error instanceof ApiError && error.code === "not_found"
            ? "Instrument not found."
            : says(error);
        detailCode.value = codeOf(error);
        detailFailures.value++;
      }
    }
  }

  async function refetch(
    id: string,
    parts: readonly Part[],
    sections: readonly Section[],
  ): Promise<Fetched[]> {
    let done: { parts: Fetched[] };
    try {
      done = await call(`${instrumentPath(id)}/refetch`, "POST", {
        parts,
        ...(parts.includes("research") ? { sections } : {}),
      });
    } catch (error) {
      // deleted meanwhile: the page says it is no longer stored
      if (error instanceof ApiError && error.code === "not_found") {
        return parts.map((part) => ({ part, status: "not found" }));
      }
      throw error;
    }
    // what changed shows at once, if its page is still the one open
    if (detailId.value === id) void loadInstrument(id);
    return done.parts;
  }

  async function remove(id: string): Promise<Removed> {
    try {
      await call(instrumentPath(id), "DELETE");
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "conflict" &&
        typeof error.body === "object" &&
        error.body !== null &&
        "rules" in error.body &&
        Array.isArray(error.body.rules)
      ) {
        return { ok: false, rules: error.body.rules as number[] };
      }
      return { ok: false, error: says(error) };
    }
    // a list still loading was read before the delete
    listed++;
    listing = null;
    batch(() => {
      instruments.value = instruments.value?.filter((r) => r.id !== id) ?? null;
      if (detailId.value === id) detail.value = null;
    });
    return { ok: true };
  }

  let homeLoad = 0;
  async function loadHome(): Promise<void> {
    // the minute refresh can fire after leaving, before Preact's cleanup
    if (here() !== "/") return;
    const mine = ++homeLoad;
    const at = session;
    const page = here();
    const stale = () => mine !== homeLoad || at !== session || here() !== page;
    const asked = ++watchAsked;
    let w: Watchlist;
    try {
      w = await call<Watchlist>(WATCHLIST_PATH);
    } catch (error) {
      if (stale()) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        homeError.value = says(error);
        homeCode.value = codeOf(error);
        homeFailures.value++;
      }
      return;
    }
    if (stale()) return;
    batch(() => {
      showWatchlist(asked, w);
      homeError.value = null;
      homeCode.value = null;
    });
    const ids = [
      ...new Set(
        w.entries.flatMap((e) =>
          e.id !== null && e.instrument !== null ? [e.id] : [],
        ),
      ),
    ];
    const day = new Set(
      w.entries.flatMap((e) => (e.intraday && e.id !== null ? [e.id] : [])),
    );
    const today = new Date(now()).toISOString().slice(0, 10);
    const lines = await Promise.allSettled(
      ids.map((id) =>
        day.has(id)
          ? call<Intraday>(
              `${instrumentPath(id)}/bars?${new URLSearchParams({ interval: "5m" })}`,
            )
          : history(id, fromOf("1M", today), "1d"),
      ),
    );
    if (stale()) return;
    // a line that failed keeps the one drawn before
    const was = sparks.value;
    const next = new Map<string, Spark>();
    ids.forEach((id, i) => {
      const r = lines[i]!;
      const line = r.status === "fulfilled" ? r.value : was.get(id);
      if (line !== undefined) next.set(id, line);
    });
    sparks.value = next;
  }

  // a chart's bars with their candles and volume; a read, as the page is
  function history(id: string, from: string, interval: Interval) {
    const q = new URLSearchParams({ from, interval });
    return call<History>(`${instrumentPath(id)}/bars?${q}`);
  }

  // 5D asks from before any session kept; 1D takes the server's default
  function intraday(id: string, range: IntradayRange, from: string) {
    const q = new URLSearchParams({ interval: "5m" });
    if (range === "5D") q.set("from", from);
    // the pre and post trading around the day, as a chart site draws it
    else q.set("extended", "true");
    return call<Intraday>(`${instrumentPath(id)}/bars?${q}`);
  }

  return {
    attribution,
    sparks,
    homeError,
    homeCode,
    homeFailures,
    loadHome,
    history,
    intraday,
    detail,
    detailId,
    detailError,
    detailCode,
    detailFailures,
    loadInstrument,
    refetch,
    remove,
    instruments,
    instrumentsError,
    instrumentsCode,
    instrumentsFailures,
    loadInstruments,
    signedIn,
    status,
    statusAt,
    statusError,
    statusCode,
    statusFailures,
    watchlist,
    loading,
    loadStatus,
    // the status load answers whether the cookie holds, so one load does both
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
      // a new session: an old call's late 401 never signs it out
      session++;
      // the cookie set but the status refused, so the form says why; a
      // 401 here is a cookie the browser dropped, never a session ended
      if (!(await loadStatus())) {
        throw new ApiError(0, statusError.value ?? "not signed in");
      }
    },
    async signOut(): Promise<void> {
      await call(SESSION_PATH, "DELETE");
      // supersedes any load in flight, so none signs back in
      signedOut();
    },
  };
}

export type Store = ReturnType<typeof store>;

export const markets: Store = store((input, init) => fetch(input, init));
