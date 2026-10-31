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
import {
  ApiError,
  buildWatch,
  client,
  codeOf,
  type Fetch,
  failure,
  says,
} from "./api.ts";
import { portfolioStore } from "./portfolios.ts";

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
  // false while the server runs with --no-sync
  sync: boolean;
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
  tracked_by: ("rule" | "dashboard" | "read" | "track")[];
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

export type View = "cards" | "table";

export type Gap = { distance_pct: number | null; crossed_today?: boolean };

export type BoardItem = {
  id: string;
  instrument: Listed;
  session: Session | null;
  intraday: boolean;
  averages: {
    daily_sma50: Gap | null;
    daily_sma200: Gap | null;
    weekly_sma200: Gap | null;
  };
};

export type Board = {
  attribution?: string;
  revision: number;
  created: boolean;
  track?: { value: string; state: "ready" | "pending" | "failed" }[];
  sections: { name: string; view: View; items: BoardItem[] }[];
};

export type BoardSection = { name: string; view: View; ids: string[] };

export const layoutOf = (b: Board): BoardSection[] =>
  b.sections.map((s) => ({
    name: s.name,
    view: s.view,
    ids: s.items.map((i) => i.id),
  }));

export const payloadOf = (
  revision: number,
  layout: readonly BoardSection[],
) => ({
  revision,
  sections: layout.map((s) => ({
    name: s.name,
    view: s.view,
    symbols: s.ids,
  })),
});

export type Candidate = {
  id: string;
  name: string | null;
  type: string | null;
  exchange: string;
  // the exchange in words, when the source's search gives them
  exchange_name?: string;
  // a stored listing's
  currency?: string | null;
  stored: boolean;
};

export const SYMBOLS_PATH = "/api/v1/symbols";

export type Earning = {
  id: string;
  name: string | null;
  date: string;
  hour: string | null;
  eps_estimate: number | null;
  revenue_estimate: number | null;
  currency: string | null;
};

export type Spark = Intraday | History;

export type Returns = {
  "1w": number | null;
  "1m": number | null;
  "3m": number | null;
  ytd: number | null;
  to: string;
  live: boolean;
};

// the quote's daily signal row, the fields the page reads
export type Daily = {
  sma50: number | null;
  sma200: number | null;
  cross: number | null;
  cross_edge: number | null;
  rsi14: number | null;
  macd_histogram: number | null;
  macd_turn: number | null;
  atr14: number | null;
  volatility20: number | null;
  high52w: number | null;
  low52w: number | null;
  drawdown: number | null;
  from_low: number | null;
  days_since_high: number | null;
  volume_ratio: number | null;
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
    trade_time?: string | null;
    day_high?: number | null;
    day_low?: number | null;
    volume?: number | null;
    stale: string[];
    returns: Returns | null;
    // the daily and weekly signals the quote tool gives; the page reads
    // the weekly 200 average
    signals?: {
      daily?: Daily | null;
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

export function saveFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 422) {
    const body = error.body as { errors?: { input?: unknown }[] } | null;
    const names = (body?.errors ?? []).flatMap((e) =>
      typeof e.input === "string" ? [e.input] : [],
    );
    if (names.length > 0) return `Could not add ${names.join(", ")}.`;
  }
  return `Not saved. ${says(error)}`;
}

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

// an agent's key as listed: never its token
export type AgentKey = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  // null never expires
  expires_at: string | null;
  // what it may do with portfolios, and with rules and their alerts
  portfolio?: KeyAccess;
  rules?: KeyAccess;
};

export type KeyAccess = "none" | "read" | "write";

export type KeyAccesses = { portfolio: KeyAccess; rules: KeyAccess };

type KeysPage = { keys: AgentKey[]; limit: number };

// the token is answered once; the view that made it holds it, never the store
export type MadeKey = { key: AgentKey; token: string };

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
export const KEYS_PATH = "/api/v1/keys";
export const DASHBOARD_PATH = "/api/v1/dashboard";
export const EARNINGS_PATH = "/api/v1/earnings";
// the route refuses more in one call
export const EARNINGS_SYMBOLS = 100;

// the viewer's own calendar day, as the page reads "Today"
const dayOf = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// the route counts both ends, so six days on is the seventh day
const AHEAD_MS = 6 * 86_400_000;

type EarningsAnswer = {
  earnings: Earning[];
  message?: string;
  unavailable?: { input: string; id?: string }[];
};

// how a save ended: a failed one leaves the edit to try again
export type Saved = "saved" | "conflict" | "failed";

// here: the page shown, so an answer that arrives after leaving starts nothing
export function store(
  fetchFn: Fetch,
  now: () => number = Date.now,
  here: () => string = () => path.peek(),
  reloadPage: () => void = () => location.reload(),
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
  // the rail's own read of the status, apart from the page's
  const pulse = signal<Status | null>(null);
  // FRED's terms ask for its notice wherever its values show
  const attribution = signal<string | null>(null);
  const sparks = signal<ReadonlyMap<string, Spark>>(new Map());
  // a save in flight shows at once
  const layout = signal<BoardSection[] | null>(null);
  const items = signal<ReadonlyMap<string, BoardItem>>(new Map());
  const earnings = signal<Earning[]>([]);
  // none could be had, which is not the same as none reporting
  const earningsOff = signal(false);
  const seeding = signal<Board["track"] | null>(null);
  const homeError = signal<string | null>(null);
  const homeCode = signal<number | null>(null);
  const saveError = signal<string | null>(null);
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
  const keys = signal<AgentKey[] | null>(null);
  const keysLimit = signal<number | null>(null);
  const keysError = signal<string | null>(null);
  const keysCode = signal<number | null>(null);
  const keysFailures = signal(0);

  // a sign-in or sign-out starts a session anew: a call from before it
  // neither lands its answer nor signs the new one out
  let session = 0;
  // a later status load supersedes one in flight, and a superseded one
  // answers with the latest's outcome, so a sign-in never reads a stale
  // result
  let latest = 0;
  let current: Promise<boolean> = Promise.resolve(false);

  const signedOut = () => {
    session++;
    revision = 0;
    saved = [];
    dirty = false;
    base = null;
    ours.clear();
    // a save of the old session never carries an edit of the new one
    flight = null;
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
      layout.value = null;
      items.value = new Map();
      earnings.value = [];
      earningsOff.value = false;
      seeding.value = null;
      saveError.value = null;
      homeError.value = null;
      homeCode.value = null;
      instruments.value = null;
      instrumentsError.value = null;
      instrumentsCode.value = null;
      detail.value = null;
      detailId.value = null;
      detailError.value = null;
      detailCode.value = null;
      keys.value = null;
      keysLimit.value = null;
      keysError.value = null;
      keysCode.value = null;
    });
    portfolios.clear();
  };
  const quiet = client(fetchFn, () => {}, buildWatch(reloadPage));
  // a 401 signs out only the session the call was made in
  async function call<T>(
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const mine = session;
    try {
      return await quiet<T>(path, method, body, signal);
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

  const portfolios = portfolioStore(call, () => session);

  // a quiet read: a failure leaves the last answer, never a sign-out
  async function checkPulse(): Promise<void> {
    try {
      pulse.value = await quiet<Status>(STATUS_PATH);
    } catch {}
  }

  function loadStatus(): Promise<boolean> {
    current = load(++latest);
    return current;
  }

  async function load(mine: number): Promise<boolean> {
    loading.value = true;
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
        pulse.value = s.value;
        watchlist.value = w.value.entries;
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

  // a create or revoke makes a list in flight stale, as a delete does
  let keysLoad = 0;
  async function loadKeys(): Promise<void> {
    const mine = ++keysLoad;
    const at = session;
    const stale = () => mine !== keysLoad || at !== session;
    try {
      const page = await call<KeysPage>(KEYS_PATH);
      if (stale()) return;
      batch(() => {
        keys.value = page.keys;
        keysLimit.value = page.limit;
        keysError.value = null;
        keysCode.value = null;
      });
    } catch (error) {
      if (stale()) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        keysError.value = says(error);
        keysCode.value = codeOf(error);
        keysFailures.value++;
      }
    }
  }

  // throws the refusal, its words a sentence, for the form to show
  async function createKey(
    name: string,
    expiresInDays: number | null,
    access: KeyAccesses = { portfolio: "none", rules: "none" },
  ): Promise<MadeKey> {
    let made: MadeKey;
    try {
      made = await call<MadeKey>(KEYS_PATH, "POST", {
        name,
        expiresInDays,
        ...access,
      });
    } catch (error) {
      throw new Error(says(error));
    }
    keysLoad++;
    keys.value = [...(keys.value ?? []), made.key];
    return made;
  }

  // throws the refusal, its words a sentence, for the form to show
  async function setKeyAccess(id: string, access: KeyAccesses): Promise<void> {
    let changed: { key: AgentKey };
    try {
      changed = await call<{ key: AgentKey }>(
        `${KEYS_PATH}/${encodeURIComponent(id)}`,
        "PATCH",
        access,
      );
    } catch (error) {
      throw new Error(says(error));
    }
    keysLoad++;
    keys.value =
      keys.value?.map((k) => (k.id === id ? changed.key : k)) ?? null;
  }

  // the refusal's sentence, or null once it is gone; one already gone is
  // gone all the same
  async function revokeKey(id: string): Promise<string | null> {
    try {
      await call(`${KEYS_PATH}/${encodeURIComponent(id)}`, "DELETE");
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "not_found")) {
        return says(error);
      }
    }
    keysLoad++;
    keys.value = keys.value?.filter((k) => k.id !== id) ?? null;
    return null;
  }

  let revision = 0;
  let saved: BoardSection[] = [];
  // each edit counts, so a load asked before one never lands its layout
  let edits = 0;
  let dirty = false;
  // the revision an edit was made on, sent so another tab's save since
  // is refused rather than overwritten
  let base: number | null = null;
  // what this tab's own saves moved each revision to, so an edit begun
  // during one is not taken for another tab's
  const ours = new Map<number, number>();
  const since = (r: number) => {
    while (ours.has(r)) r = ours.get(r)!;
    return r;
  };
  let flight: Promise<Saved> | null = null;
  // by when each call was sent, so an older answer never draws over a newer
  let asks = 0;
  let landed = 0;

  // an older answer only fills a card no newer one has drawn
  const merge = (b: Board, ask: number) => {
    const older = ask < landed;
    landed = Math.max(landed, ask);
    const next = new Map(items.value);
    for (const s of b.sections) {
      for (const i of s.items) if (!older || !next.has(i.id)) next.set(i.id, i);
    }
    items.value = next;
  };
  const adopt = (b: Board, ask: number) => {
    merge(b, ask);
    revision = b.revision;
    saved = layoutOf(b);
    layout.value = saved;
    attribution.value = b.attribution ?? null;
    seeding.value = b.track ?? null;
  };
  const shown = () => [...new Set((layout.value ?? []).flatMap((s) => s.ids))];

  let homeLoad = 0;
  async function loadDashboard(): Promise<void> {
    // the minute refresh can fire after leaving, before Preact's cleanup
    if (here() !== "/") return;
    const mine = ++homeLoad;
    const at = session;
    const page = here();
    const asked = edits;
    const ask = ++asks;
    const stale = () => mine !== homeLoad || at !== session || here() !== page;
    let b: Board;
    try {
      b = await call<Board>(DASHBOARD_PATH);
    } catch (error) {
      if (stale()) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        homeError.value = says(error);
        homeCode.value = codeOf(error);
        homeFailures.value++;
      }
      return;
    }
    // from before a save landed, so older than all that shows
    if (stale() || b.revision < revision) return;
    batch(() => {
      if (asked === edits && flight === null) adopt(b, ask);
      else merge(b, ask);
      homeError.value = null;
      homeCode.value = null;
    });
    await Promise.all([loadLines(shown(), stale), loadEarnings(stale)]);
  }

  // a failed one keeps the line drawn before
  async function loadLines(ids: readonly string[], stale: () => boolean) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const lines = await Promise.allSettled(
      ids.map((id) =>
        items.value.get(id)?.intraday
          ? call<Intraday>(
              `${instrumentPath(id)}/bars?${new URLSearchParams({ interval: "5m" })}`,
            )
          : history(id, fromOf("1M", today), "1d"),
      ),
    );
    if (stale()) return;
    const next = new Map(sparks.value);
    ids.forEach((id, i) => {
      const r = lines[i]!;
      if (r.status === "fulfilled") next.set(id, r.value);
    });
    sparks.value = next;
  }

  let earningsAsk = 0;
  async function loadEarnings(stale: () => boolean) {
    const mine = ++earningsAsk;
    const shares = shown().filter(
      (id) => items.value.get(id)?.instrument.kind === "EQUITY",
    );
    if (shares.length === 0) {
      batch(() => {
        earnings.value = [];
        earningsOff.value = false;
      });
      return;
    }
    const batches: string[][] = [];
    for (let k = 0; k < shares.length; k += EARNINGS_SYMBOLS) {
      batches.push(shares.slice(k, k + EARNINGS_SYMBOLS));
    }
    const asked = await Promise.allSettled(
      batches.map((b) => {
        const q = new URLSearchParams({
          from: dayOf(now()),
          to: dayOf(now() + AHEAD_MS),
          symbols: b.join(","),
        });
        return call<EarningsAnswer>(`${EARNINGS_PATH}?${q}`);
      }),
    );
    // a part that failed keeps the list shown before, never a shorter one
    if (mine !== earningsAsk || stale()) return;
    if (asked.some((r) => r.status === "rejected")) return;
    const answers = asked.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    // a save since the ask may have removed a share
    const kept = new Set(shown());
    batch(() => {
      earnings.value = answers
        .flatMap((a) => a.earnings)
        .filter((e) => kept.has(e.id))
        .sort((a, b) => a.date.localeCompare(b.date));
      // the route notes every share it has no calendar for, so only none
      // answered at all reads as not available
      const missing = new Set(
        answers.flatMap((a) =>
          (a.unavailable ?? []).map((u) => u.id ?? u.input),
        ),
      );
      earningsOff.value =
        answers.some((a) => a.message !== undefined) ||
        shares.every((id) => missing.has(id));
    });
  }

  // edits during a save go in the next, so none is sent on an old revision
  function saveLayout(next: BoardSection[], on?: number): Promise<Saved> {
    edits++;
    if (on !== undefined) base = on;
    batch(() => {
      layout.value = next;
      saveError.value = null;
    });
    dirty = true;
    if (flight === null) {
      // an old session's save ending never clears a newer one's
      const f: Promise<Saved> = flush().finally(() => {
        if (flight === f) flight = null;
      });
      flight = f;
    }
    return flight;
  }

  async function flush(): Promise<Saved> {
    const at = session;
    const before = new Set(saved.flatMap((s) => s.ids));
    while (dirty) {
      dirty = false;
      let b: Board;
      const ask = ++asks;
      const on = base === null ? revision : since(base);
      base = null;
      try {
        b = await call<Board>(
          DASHBOARD_PATH,
          "PUT",
          payloadOf(on, layout.value ?? []),
        );
      } catch (error) {
        if (at !== session) return "failed";
        dirty = false;
        base = null;
        if (error instanceof ApiError && error.status === 401) return "failed";
        const body = error instanceof ApiError ? error.body : null;
        let outcome: Saved = "failed";
        batch(() => {
          // another tab saved first: its layout is the one kept
          if (
            error instanceof ApiError &&
            error.status === 409 &&
            typeof body === "object" &&
            body !== null &&
            "dashboard" in body
          ) {
            adopt(body.dashboard as Board, ask);
            saveError.value = "Changed in another tab. Reloaded.";
            outcome = "conflict";
          } else {
            layout.value = saved;
            saveError.value = saveFailure(error);
          }
        });
        return outcome;
      }
      if (at !== session) return "failed";
      ours.set(on, b.revision);
      batch(() => {
        if (dirty) {
          merge(b, ask);
          revision = b.revision;
          saved = layoutOf(b);
          // the saved cards' notice, even if a later save is refused
          attribution.value = b.attribution ?? null;
        } else adopt(b, ask);
      });
    }
    const kept = new Set(shown());
    earnings.value = earnings.value.filter((e) => kept.has(e.id));
    // a save that lands after leaving Home starts nothing
    const added = [...kept].filter((id) => !before.has(id));
    const off = () => at !== session || here() !== "/";
    if (added.length > 0 && !off()) {
      void Promise.all([loadLines(added, off), loadEarnings(off)]);
    }
    return "saved";
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
    portfolios,
    keys,
    keysLimit,
    keysError,
    keysCode,
    keysFailures,
    loadKeys,
    createKey,
    setKeyAccess,
    revokeKey,
    attribution,
    sparks,
    homeError,
    homeCode,
    homeFailures,
    layout,
    items,
    earnings,
    earningsOff,
    seeding,
    saveError,
    loadDashboard,
    saveLayout,
    // the revision the layout shown was read or saved on, for an edit to start from
    revision: () => revision,
    // a search is no read; upstream false asks the server's database only
    search: (query: string, upstream = true, signal?: AbortSignal) =>
      call<{ candidates: Candidate[] }>(
        `${SYMBOLS_PATH}?${new URLSearchParams(
          upstream ? { query } : { query, upstream: "false" },
        )}`,
        "GET",
        undefined,
        signal,
      ).then((r) => r.candidates),
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
    pulse,
    checkPulse,
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
