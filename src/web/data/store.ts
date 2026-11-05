// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { batch, computed, signal } from "@preact/signals";
import { path } from "../app/router.ts";
import { type Later, paced, slowFlag, timer } from "../lib/slow.ts";
import {
  fromOf,
  type History,
  type Interval,
  type Intraday,
  type IntradayRange,
} from "../views/Chart.model.ts";
import { adminStore } from "./admin.ts";
import { alertsStore } from "./alerts.ts";
import { analysisStore } from "./analysis.ts";
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
import { profileStore } from "./profile.ts";

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
  failing: {
    scope: string | null;
    error: string | null;
    at: string | null;
    // when a failed market check runs again, else null
    next_at: string | null;
  }[];
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
  tracked_by: ("rule" | "dashboard" | "read" | "world_markets")[];
  read_until: string | null;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  fetched_at: string | null;
};

// a stored row with the figures the Screener page screens on
export type Screened = Listed & {
  return_1m: number | null;
  return_1y: number | null;
  drawdown: number | null;
  rsi14: number | null;
  distance_sma200: number | null;
  cross: number | null;
  trend: "up" | "down" | "mixed" | null;
};

export const SCREENS = [
  "moves",
  "near_high",
  "off_high",
  "oversold",
  "overbought",
] as const;

export type ScreenKey = (typeof SCREENS)[number];

// what the page asks; a null sort is the screen's own
export type ScreenAsk = {
  types: readonly string[];
  screen: ScreenKey;
  sort: string | null;
  order: "asc" | "desc" | null;
};

export type Screener = {
  ask: ScreenAsk;
  sort: { field: string; order: "asc" | "desc" };
  counts: Record<ScreenKey, number>;
  kinds: { kind: string; count: number }[];
  rows: Screened[];
  next: string | null;
};

export type Session = {
  state: "open" | "closed";
  start: string | null;
  end: string | null;
};

export type View = "cards" | "table";

export type Gap = { distance_pct: number | null; crossed_today?: boolean };

// pre or post trading while the regular session is closed
export type Extended = {
  session: "pre" | "post";
  price: number | null;
  change: number | null;
  change_percent: number | null;
  time: string;
};

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
  // an index's futures, shown in its place while its market is closed
  futures?: Futures;
};

export type Futures = {
  label: string;
  instrument: Listed;
  session: Session;
  intraday: boolean;
};

export type Board = {
  attribution?: string;
  revision: number;
  created: boolean;
  track?: { value: string; state: "ready" | "pending" }[];
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
  "1y": number | null;
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

// message or error alone when the fund lists none
export type TopHoldings = {
  source: string;
  error?: string;
  message?: string;
  fetched_at?: string | null;
  // a fund the owner prices: the days its holdings and sectors are as of
  as_of?: string | null;
  sectors_as_of?: string | null;
  stale?: string[];
  top?: {
    rank: number;
    symbol: string | null;
    id: string | null;
    name: string;
    weight_percent: number;
  }[];
  top_weight_percent?: number | null;
  sectors?: { sector: string; weight_percent: number }[];
  bond_ratings?: { rating: string; weight_percent: number }[];
  government_bonds_percent?: number | null;
};

export type Detail = {
  // FRED's notice, which its terms ask wherever its values show
  attribution?: string;
  // who the prices are from: the source's name and site
  credit: { name: string; url: string } | null;
  instrument: Listed;
  // whether its source gives 5-minute closes, for 1D and 5D
  intraday: boolean;
  // null when the read failed; error says why
  error: { code: string; detail: string } | null;
  // an ETF's or mutual fund's only
  top_holdings?: TopHoldings;
  quote: null | {
    id: string;
    // a fund the owner prices: its latest price and the day it is for
    kind?: "hand_price";
    as_of?: string;
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
    extended?: Extended | null;
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
  "top_holdings",
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

// counts only: status names which
export type Retried = {
  asked: number;
  fetched: number;
  failed: number;
  left_out: number;
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
  // whose key it is; an admin's list holds everyone's
  owner?: { id: string; name: string };
  created_at: string;
  last_used_at: string | null;
  // null never expires
  expires_at: string | null;
  // what it may do with portfolios, with rules and their alerts, with the
  // owner's profile and with the shared analysis
  portfolio?: KeyAccess;
  rules?: KeyAccess;
  profile?: KeyAccess;
  analysis?: KeyAccess;
};

export type KeyAccess = "none" | "read" | "write";

export type KeyAccesses = {
  portfolio: KeyAccess;
  rules: KeyAccess;
  profile: KeyAccess;
  analysis: KeyAccess;
};

type KeysPage = { keys: AgentKey[]; limit: number };

// the token is answered once; the view that made it holds it, never the store
export type MadeKey = { key: AgentKey; token: string };

type ScreenerPage = Omit<Screener, "ask" | "rows" | "next"> & {
  instruments: Screened[];
  // absent on the last page
  next_page_token?: string;
};

export const INSTRUMENTS_PATH = "/api/v1/instruments";
export const SCREENER_PATH = "/api/v1/screener";
// rows a page asks at once, and Show more adds
export const SCREEN_PAGE = 50;

export function screenerPath(ask: ScreenAsk, token?: string): string {
  const q = new URLSearchParams({ screen: ask.screen });
  if (ask.types.length > 0) q.set("type", ask.types.join(","));
  if (ask.sort !== null) q.set("sort", ask.sort);
  if (ask.sort !== null && ask.order !== null) q.set("order", ask.order);
  q.set("page_size", String(SCREEN_PAGE));
  if (token !== undefined) q.set("page_token", token);
  return `${SCREENER_PATH}?${q}`;
}

const MOVES: ScreenAsk = {
  types: [],
  screen: "moves",
  sort: null,
  order: null,
};
export const instrumentPath = (id: string) =>
  `${INSTRUMENTS_PATH}/${encodeURIComponent(id)}`;
export const STATUS_PATH = "/api/v1/status";
export const RETRY_PATH = "/api/v1/status/retry";

// the quotes route's limit on symbols
export const EXTENDED_BATCH = 100;

export const extendedPath = (ids: readonly string[]) =>
  `/api/v1/quotes?${new URLSearchParams({ symbols: ids.join(","), extended: "true" })}`;
export const SESSION_PATH = "/ui/session";
export const ME_PATH = "/ui/me";
export const LINK_PATH = "/ui/link";
export const CODE_PATH = "/ui/code";
export const SHARING_PATH = "/api/v1/sharing";

// everyone else, with whether the reader lets them see their portfolios,
// and the people who let the reader see theirs
export type Sharing = {
  people: { id: string; name: string; shared: boolean }[];
  sharers: { id: string; name: string }[];
};

// who is signed in, as GET /ui/me answers
export type Me = {
  id: string;
  name: string;
  role: "admin" | "member";
  email: string | null;
  // the person the admin key signs in as
  operator: boolean;
};

type MeAnswer = { user: Me | null; email_on: boolean };

const isMe = (u: unknown): u is Me =>
  typeof u === "object" &&
  u !== null &&
  typeof (u as Me).id === "string" &&
  typeof (u as Me).name === "string";
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

// by the problem's code: its detail is written for agents
const UNREAD: Record<string, string> = {
  not_found: "Instrument not found.",
  timeout: "The source did not answer in time.",
  rate_limited: "Too many requests to the source.",
  source_error: "The source failed.",
};

export const unread = (error: unknown): string =>
  (error instanceof ApiError && error.code !== null
    ? UNREAD[error.code]
    : undefined) ?? says(error);

// here: the page shown, so an answer that arrives after leaving starts nothing
export function store(
  fetchFn: Fetch,
  now: () => number = Date.now,
  here: () => string = () => path.peek(),
  reloadPage: () => void = () => location.reload(),
  later: Later = timer,
) {
  // undefined until the first answer says whether the cookie holds
  const signedIn = signal<boolean | undefined>(undefined);
  const me = signal<Me | null>(null);
  const isAdmin = computed(() => me.value?.role === "admin");
  // whether a person can ask for a link; known signed out too
  const emailOn = signal(false);
  const status = signal<Status | null>(null);
  const statusError = signal<string | null>(null);
  // its HTTP code, shown beside the words; null when no server answered
  const statusCode = signal<number | null>(null);
  // the rail's own read of the status, apart from the page's
  const pulse = signal<Status | null>(null);
  // FRED's terms ask for its notice wherever its values show
  const attribution = signal<string | null>(null);
  const sparks = signal<ReadonlyMap<string, Spark>>(new Map());
  const lining = signal<ReadonlySet<string>>(new Set());
  const extended = signal<ReadonlyMap<string, Extended>>(new Map());
  const homeWait = slowFlag(later);
  const linesWait = slowFlag(later);
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
  const screenerFailures = signal(0);
  const detailFailures = signal(0);
  const loading = signal(false);
  // the page's ask lives here, so a refresh, or a page left and opened
  // again, keeps the tab, the screen and the sort
  const screenAsk = signal<ScreenAsk>(MOVES);
  const screener = signal<Screener | null>(null);
  const screenerError = signal<string | null>(null);
  const screenerCode = signal<number | null>(null);
  // Show more's page while it reads
  const screenerMore = signal(false);
  // the instrument page's; detailId is the id the detail and its error
  // are for, kept until the next id's answer lands so the page left
  // stays on screen while it reads
  const detail = signal<Detail | null>(null);
  const detailId = signal<string | null>(null);
  const detailError = signal<string | null>(null);
  const detailCode = signal<number | null>(null);
  const detailWait = slowFlag(later);
  const firstFetch = signal<string | null>(null);
  // the id asked last, whose page is open or on its way; detailId stays
  // on the page left until this one's answer lands
  let askedId: string | null = null;
  // deleted while its page showed: kept on screen as the page leaves,
  // dropped if it is opened again
  let removedId: string | null = null;
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
    // a read of who is signed in from before it never signs back in
    meLoad++;
    meCurrent = Promise.resolve(false);
    loading.value = false;
    alerts.signedOut();
    batch(() => {
      signedIn.value = false;
      me.value = null;
      // the server's version and state are an admin's, never the next
      // person's on this browser
      pulse.value = null;
      status.value = null;
      statusError.value = null;
      statusCode.value = null;
      attribution.value = null;
      sparks.value = new Map();
      lining.value = new Set();
      extended.value = new Map();
      layout.value = null;
      items.value = new Map();
      earnings.value = [];
      earningsOff.value = false;
      seeding.value = null;
      saveError.value = null;
      homeError.value = null;
      homeCode.value = null;
      screenAsk.value = MOVES;
      screener.value = null;
      screenerError.value = null;
      screenerCode.value = null;
      screenerMore.value = false;
      detail.value = null;
      detailId.value = null;
      askedId = null;
      removedId = null;
      detailError.value = null;
      detailCode.value = null;
      firstFetch.value = null;
      keys.value = null;
      keysLimit.value = null;
      keysError.value = null;
      keysCode.value = null;
    });
    sharingLoad++;
    sharing.value = null;
    portfolios.clear();
    shared.clear();
    profile.clear();
    admin.clear();
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

  const portfolios = portfolioStore(call, () => session, later);
  // who sees whose portfolios: the settings' switches and the rail's rows
  const sharing = signal<Sharing | null>(null);
  const sharers = computed(() => sharing.value?.sharers ?? []);
  let sharingLoad = 0;
  // a failed read keeps the last answer: the rail never blinks
  async function loadSharing(): Promise<void> {
    const mine = ++sharingLoad;
    const at = session;
    try {
      const a = await call<Sharing>(SHARING_PATH);
      if (mine === sharingLoad && at === session) sharing.value = a;
    } catch {}
  }
  // the refusal's words, or null once the server answered; only the
  // newest answer lands, so switches flipped quickly never show an old one
  async function share(id: string, on: boolean): Promise<string | null> {
    const mine = ++sharingLoad;
    const at = session;
    try {
      const a = await call<Sharing>(
        `${SHARING_PATH}/${encodeURIComponent(id)}`,
        on ? "PUT" : "DELETE",
      );
      if (mine === sharingLoad && at === session) sharing.value = a;
      return null;
    } catch (error) {
      if (at === session) void loadSharing();
      return says(error);
    }
  }
  const shared = portfolioStore(call, () => session, later, {
    gone: () => void loadSharing(),
  });
  const profile = profileStore(call, () => session);
  // one per symbol page, read and written by every sign-in
  const analysis = (id: string) => analysisStore(call, () => session, id);
  const admin = adminStore(
    call,
    () => session,
    (on) => {
      emailOn.value = on;
    },
    later,
  );
  const alerts = alertsStore(call, () => session, later);

  // who is signed in: the web UI starts from it, never from the status,
  // which is an admin's. A later read supersedes one in flight
  let meLoad = 0;
  let meCurrent: Promise<boolean> = Promise.resolve(false);
  function loadMe(): Promise<boolean> {
    meCurrent = readMe(++meLoad);
    return meCurrent;
  }
  async function readMe(mine: number): Promise<boolean> {
    try {
      const a = await quiet<MeAnswer>(ME_PATH);
      if (mine !== meLoad) return meCurrent;
      emailOn.value = a?.email_on === true;
      if (!isMe(a?.user)) {
        if (signedIn.peek() !== false) signedOut();
        // an answer naming nobody is no failure, signed out already or not
        batch(() => {
          statusError.value = null;
          statusCode.value = null;
        });
        return false;
      }
      batch(() => {
        me.value = a.user as Me;
        signedIn.value = true;
        statusError.value = null;
        statusCode.value = null;
      });
      void loadSharing();
      void alerts.loadSeen();
      return true;
    } catch (error) {
      if (mine !== meLoad) return meCurrent;
      batch(() => {
        statusError.value = says(error);
        statusCode.value = codeOf(error);
        statusFailures.value++;
      });
      return false;
    }
  }

  // a sign-in's post: a wrong key or code is no session ending, so it
  // skips the 401 hook; the answer's own words otherwise
  async function post(
    to: string,
    body: unknown,
    wrong: string,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFn(to, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw failure(0, null);
    }
    if (res.status === 401) throw new ApiError(401, wrong);
    if (!res.ok) throw failure(res.status, await res.json().catch(() => null));
    return res;
  }

  // a new session: an old call's late 401 never signs it out; the cookie
  // set but /ui/me naming nobody is a cookie the browser dropped
  async function opened(): Promise<void> {
    session++;
    if (!(await loadMe())) {
      throw new ApiError(0, statusError.value ?? "not signed in");
    }
  }

  // a quiet read: a failure leaves the last answer, never a sign-out
  async function checkPulse(): Promise<void> {
    const at = session;
    try {
      const read = await quiet<Status>(STATUS_PATH);
      if (at === session) pulse.value = read;
    } catch {}
  }

  function loadStatus(): Promise<boolean> {
    current = load(++latest);
    return current;
  }

  async function load(mine: number): Promise<boolean> {
    loading.value = true;
    // a sign-in since makes it stale: its 401 never signs the new one out
    const at = session;
    try {
      const s = await quiet<Status>(STATUS_PATH);
      if (mine !== latest) return current;
      if (at !== session) return false;
      batch(() => {
        signedIn.value = true;
        status.value = s;
        pulse.value = s;
        statusError.value = null;
        statusCode.value = null;
      });
      return true;
    } catch (error) {
      if (mine !== latest) return current;
      if (at !== session) return false;
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

  // A refresh reads again as many rows as are shown. A load of the same
  // ask already going answers for a second, so a tick never stacks; a
  // new ask, a delete or a new session makes one in flight stale.
  let screening: { ask: ScreenAsk; read: Promise<void> } | null = null;
  let screened = 0;
  function loadScreener(next?: ScreenAsk): Promise<void> {
    const ask = next ?? screenAsk.peek();
    if (screening !== null && sameAsk(screening.ask, ask)) {
      return screening.read;
    }
    screenAsk.value = ask;
    const held = screener.peek();
    const shown =
      held !== null && sameAsk(held.ask, ask)
        ? Math.max(held.rows.length, SCREEN_PAGE)
        : SCREEN_PAGE;
    const read = screen(ask, shown).finally(() => {
      if (screening?.read === read) screening = null;
    });
    screening = { ask, read };
    return read;
  }
  async function screen(ask: ScreenAsk, shown: number): Promise<void> {
    const mine = ++screened;
    const at = session;
    const stale = () => mine !== screened || at !== session;
    try {
      const got = await paced(
        (async () => {
          let page = await call<ScreenerPage>(screenerPath(ask));
          let rows = page.instruments;
          while (rows.length < shown && page.next_page_token !== undefined) {
            page = await call<ScreenerPage>(
              screenerPath(ask, page.next_page_token),
            );
            rows = appended(rows, page.instruments);
          }
          return { page, rows };
        })(),
        later,
      );
      if (stale()) return;
      batch(() => {
        screener.value = screenerOf(ask, got.page, got.rows);
        screenerError.value = null;
        screenerCode.value = null;
      });
    } catch (error) {
      if (stale()) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        screenerError.value = says(error);
        screenerCode.value = codeOf(error);
        screenerFailures.value++;
      }
    }
  }
  // The next page of what is shown. A read already going would land
  // fewer rows over it, so it goes stale; a later refresh or ask makes
  // this one stale.
  async function moreScreener(): Promise<void> {
    const held = screener.peek();
    if (held === null || held.next === null || screenerMore.peek()) return;
    const mine = ++screened;
    screening = null;
    const at = session;
    screenerMore.value = true;
    try {
      const page = await call<ScreenerPage>(screenerPath(held.ask, held.next));
      if (mine !== screened || at !== session) return;
      screener.value = screenerOf(
        held.ask,
        page,
        appended(held.rows, page.instruments),
      );
    } catch (error) {
      if (mine !== screened || at !== session) return;
      if (!(error instanceof ApiError && error.status === 401)) {
        screenerError.value = says(error);
        screenerCode.value = codeOf(error);
        screenerFailures.value++;
      }
    } finally {
      if (at === session) screenerMore.value = false;
    }
  }

  // a later load supersedes one in flight, even of the same id, so a
  // refresh tick never lands over the reload after a refetch
  let instrumentLoad = 0;
  async function loadInstrument(id: string, again = false): Promise<void> {
    // Try again on a page left while the next one reads: the next wins
    if (again && askedId !== null && askedId !== id) return;
    const mine = ++instrumentLoad;
    const at = session;
    askedId = id;
    if (removedId === id) {
      removedId = null;
      if (detailId.value === id) detail.value = null;
    }
    const fresh = detailId.value !== id || detail.value === null;
    // another id's error stays with the page left while it is held
    if (again && detailId.value === id) {
      batch(() => {
        detailError.value = null;
        detailCode.value = null;
      });
    }
    let out = true;
    const read = call<Detail>(instrumentPath(id));
    // beside the read, never before it, so a stored symbol waits on nothing
    if (fresh) {
      void call<{ stored: boolean }>(`${instrumentPath(id)}/stored`).then(
        (s) => {
          if (out && !s.stored && mine === instrumentLoad) {
            firstFetch.value = id;
          }
        },
        () => {},
      );
    }
    try {
      const d = await detailWait.track(read);
      if (mine !== instrumentLoad || at !== session) return;
      batch(() => {
        detail.value = d;
        detailId.value = id;
        detailError.value = null;
        detailCode.value = null;
        firstFetch.value = null;
      });
    } catch (error) {
      if (mine !== instrumentLoad || at !== session) return;
      firstFetch.value = null;
      if (!(error instanceof ApiError && error.status === 401)) {
        batch(() => {
          // a failed refresh keeps its detail; another id's never stands in
          if (detailId.value !== id) detail.value = null;
          detailId.value = id;
          detailError.value = unread(error);
          detailCode.value = codeOf(error);
          detailFailures.value++;
        });
      }
    } finally {
      out = false;
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
    if (askedId === id) void loadInstrument(id);
    return done.parts;
  }

  async function retry(): Promise<Retried> {
    const done = await call<Retried>(RETRY_PATH, "POST");
    void loadStatus();
    return done;
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
    // a screen still loading was read before the delete
    screened++;
    screening = null;
    batch(() => {
      const held = screener.value;
      if (held !== null) {
        screener.value = {
          ...held,
          rows: held.rows.filter((r) => r.id !== id),
        };
      }
      if (detailId.value === id) removedId = id;
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
      const page = await paced(call<KeysPage>(KEYS_PATH), later);
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
    access: KeyAccesses = {
      portfolio: "none",
      rules: "none",
      profile: "none",
      analysis: "none",
    },
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
    // the page's refresh can fire after leaving, before Preact's cleanup
    if (here() !== "/") return;
    const mine = ++homeLoad;
    const at = session;
    const page = here();
    const asked = edits;
    const ask = ++asks;
    const stale = () => mine !== homeLoad || at !== session || here() !== page;
    let b: Board;
    try {
      b = await homeWait.track(call<Board>(DASHBOARD_PATH));
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
    await Promise.all([
      loadLines(shown(), stale),
      loadEarnings(stale),
      loadExtended(shown(), stale),
    ]);
  }

  // after the page's answer, beside the lines: each listing is a live read
  async function loadExtended(ids: readonly string[], stale: () => boolean) {
    const closed = ids.filter((id) => {
      const session = items.value.get(id)?.session;
      return session != null && session.state !== "open";
    });
    const next = new Map<string, Extended>();
    for (let i = 0; i < closed.length; i += EXTENDED_BATCH) {
      try {
        const r = await call<{
          quotes: { id?: string; extended?: Extended | null }[];
        }>(extendedPath(closed.slice(i, i + EXTENDED_BATCH)));
        for (const x of r.quotes) {
          if (x.id && x.extended && x.extended.price !== null) {
            next.set(x.id, x.extended);
          }
        }
      } catch {
        return;
      }
    }
    if (!stale()) extended.value = next;
  }

  // a failed one keeps the line drawn before; a flipped index draws its
  // futures' line, under the futures' id
  async function loadLines(shownIds: readonly string[], stale: () => boolean) {
    const at = session;
    const today = new Date(now()).toISOString().slice(0, 10);
    const lines = new Map<string, boolean>();
    for (const id of shownIds) {
      const item = items.value.get(id);
      if (item?.futures !== undefined) {
        lines.set(item.futures.instrument.id, item.futures.intraday);
      } else lines.set(id, item?.intraday ?? false);
    }
    const ids = [...lines.keys()];
    const fresh = ids.filter((id) => !sparks.value.has(id));
    if (fresh.length > 0) lining.value = new Set([...lining.value, ...fresh]);
    const landed = (id: string) => {
      if (at !== session || !lining.value.has(id)) return;
      const next = new Set(lining.value);
      next.delete(id);
      lining.value = next;
    };
    await linesWait.track(
      Promise.allSettled(
        ids.map(async (id) => {
          try {
            const line = await (lines.get(id)
              ? call<Intraday>(
                  `${instrumentPath(id)}/bars?${new URLSearchParams({ interval: "5m" })}`,
                )
              : history(id, fromOf("1M", today), "1d"));
            if (!stale()) sparks.value = new Map(sparks.value).set(id, line);
          } finally {
            landed(id);
          }
        }),
      ),
    );
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
    later,
    portfolios,
    shared,
    sharing,
    sharers,
    loadSharing,
    share,
    profile,
    analysis,
    alerts,
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
    lining,
    extended,
    homeSlow: homeWait.slow,
    linesSlow: linesWait.slow,
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
    detailSlow: detailWait.slow,
    firstFetch,
    loadInstrument,
    refetch,
    remove,
    screenAsk,
    screener,
    screenerError,
    screenerCode,
    screenerFailures,
    screenerMore,
    loadScreener,
    moreScreener,
    signedIn,
    status,
    pulse,
    checkPulse,
    statusError,
    statusCode,
    statusFailures,
    loading,
    loadStatus,
    retry,
    me,
    isAdmin,
    emailOn,
    admin,
    // the reader's own name; the refusal's sentence, or null once saved
    async setMyName(name: string): Promise<string | null> {
      try {
        const a = await call<MeAnswer>(ME_PATH, "PATCH", { name });
        if (isMe(a?.user)) {
          me.value = a.user;
          admin.renamed(a.user.id, a.user.name);
        }
        return null;
      } catch (error) {
        return says(error);
      }
    },
    // the operator's email: a link goes there, and the address is set
    // only once it is used
    async setMyEmail(
      email: string,
    ): Promise<
      { sent: true } | { sent: false; reason: string } | { error: string }
    > {
      try {
        const a = await call<{ link: string; reason?: string }>(
          ME_PATH,
          "PATCH",
          { email },
        );
        return a.link === "sent"
          ? { sent: true }
          : { sent: false, reason: a.reason ?? "other" };
      } catch (error) {
        return { error: says(error) };
      }
    },
    // /ui/me answers whether the cookie holds and who it is
    check: loadMe,
    // the same read, saying whether it named nobody or failed
    async whoIs(): Promise<"in" | "nobody" | "failed"> {
      if (await loadMe()) return "in";
      return statusError.peek() === null ? "nobody" : "failed";
    },
    async signIn(key: string): Promise<void> {
      await post(SESSION_PATH, { key: key.trim() }, "wrong admin key");
      await opened();
    },
    // answered the same for any address; the code goes to an invited one
    async askLink(email: string): Promise<void> {
      await post(LINK_PATH, { email: email.trim() }, "signed out");
    },
    // go: the landing the code opens, taken before the pages load
    async signInByCode(
      email: string,
      code: string,
      go: (landing: string) => void,
    ): Promise<void> {
      const res = await post(
        CODE_PATH,
        { email: email.trim(), code },
        "wrong or expired code",
      );
      const a = (await res.json().catch(() => null)) as {
        landing?: unknown;
      } | null;
      if (typeof a?.landing === "string" && a.landing.startsWith("/")) {
        go(a.landing);
      }
      await opened();
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

// the token is an offset and prices reorder rows between pages, so a
// row the page before held is not shown twice
function appended(rows: Screened[], more: Screened[]): Screened[] {
  const shown = new Set(rows.map((r) => r.id));
  return [...rows, ...more.filter((r) => !shown.has(r.id))];
}

const sameAsk = (a: ScreenAsk, b: ScreenAsk): boolean =>
  a.screen === b.screen &&
  a.sort === b.sort &&
  a.order === b.order &&
  a.types.join(",") === b.types.join(",");

function screenerOf(
  ask: ScreenAsk,
  page: ScreenerPage,
  rows: Screened[],
): Screener {
  return {
    ask,
    sort: page.sort,
    counts: page.counts,
    kinds: page.kinds,
    rows,
    next: page.next_page_token ?? null,
  };
}
