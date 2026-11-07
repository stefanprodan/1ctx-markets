// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { spec } from "../src/api/openapi.ts";
import { UI_PATHS } from "../src/server/http.ts";
import { App, Shell } from "../src/web/app/App.tsx";
import {
  Bar,
  barLit,
  isTextField,
  MORE,
  More,
  moreOpen,
  typingIn,
  watchMore,
  watchTyping,
} from "../src/web/app/Bar.tsx";
import { iconClass, Rail, Recent } from "../src/web/app/Rail.tsx";
import {
  putRecent,
  RECENT_MAX,
  RECENT_PHONE,
  readRecent,
  recent,
} from "../src/web/app/recent.ts";
import {
  backFrom,
  goBack,
  inApp,
  path,
  stepOf,
  visits,
} from "../src/web/app/router.ts";
import {
  HOME,
  lit,
  match,
  RAIL,
  ROUTES,
  railFor,
} from "../src/web/app/routes.ts";
import { Strip } from "../src/web/app/Strip.tsx";
import { onPhone } from "../src/web/app/shell.ts";
import { resolveTheme } from "../src/web/app/theme.ts";
import { tabTitle } from "../src/web/app/title.ts";
import { UserItems } from "../src/web/app/UserMenu.tsx";
import { SEEN_PATH } from "../src/web/data/alerts.ts";
import {
  ApiError,
  buildWatch,
  client,
  type Fetch,
  failure,
  says,
} from "../src/web/data/api.ts";
import type { AgentKey, Detail } from "../src/web/data/store.ts";
import {
  type Board,
  type BoardItem,
  type BoardSection,
  DASHBOARD_PATH,
  EARNINGS_PATH,
  EARNINGS_SYMBOLS,
  EXTENDED_BATCH,
  type Extended,
  extendedPath,
  INSTRUMENTS_PATH,
  instrumentPath,
  KEYS_PATH,
  type Listed,
  layoutOf,
  ME_PATH,
  type Me,
  markets,
  payloadOf,
  RETRY_PATH,
  type ScreenAsk,
  type Screened,
  type Screener,
  SESSION_PATH,
  SHARING_PATH,
  STATUS_PATH,
  type Status,
  screenerPath,
  store,
} from "../src/web/data/store.ts";
import {
  ago,
  change,
  plain,
  price,
  priceParts,
  signedChange,
} from "../src/web/lib/format.ts";
import { about, marketOf, symbolOf } from "../src/web/lib/names.ts";
import { reloading } from "../src/web/lib/refresh.ts";
import { Drawer } from "../src/web/ui/Drawer.tsx";
import { MenuItems } from "../src/web/ui/Menu.tsx";
import { didNotLoad, Page } from "../src/web/ui/Page.tsx";
import { Segmented } from "../src/web/ui/Segmented.tsx";
import {
  OPENER,
  openSearch,
  SymbolSearch,
  searchShown,
} from "../src/web/ui/SymbolSearch.tsx";
import {
  axisPrice,
  candles,
  clearOfTags,
  DEFAULT_SETTINGS,
  DESK,
  drawnRange,
  extendedLines,
  fromOf,
  type History,
  hasCandles,
  hasVolume,
  type Intraday,
  intervalOf,
  isIntraday,
  legendOf,
  levelsOf,
  localTime,
  lookOf,
  PHONE,
  PHONE_RANGES,
  phoneRange,
  pointLegendOf,
  pointLine,
  RANGES,
  readSettings,
  sessionSlots,
  tick,
  timeLabel,
  volumes,
} from "../src/web/views/Chart.model.ts";
import { Chart, LegendLine, paintOptions } from "../src/web/views/Chart.tsx";
import {
  AGENTS,
  accessWords,
  capLine,
  expiryWords,
  KEY_ENV,
  SHOWN_ONCE,
  setupLine,
  shapeName,
  usedWords,
} from "../src/web/views/Connect.model.ts";
import {
  ConnectBody,
  dropNewKey,
  KeyDetails,
  Keys,
  NewKey,
  Setup,
  ShownKey,
} from "../src/web/views/Connect.tsx";
import {
  addRefusal,
  addSection,
  addTo,
  afterSave,
  bySort,
  type CardEntry,
  cardOf,
  crossedToday,
  DEFAULT_SORT,
  draftOf,
  dropSection,
  earningRows,
  editOf,
  entryOf,
  extMove,
  gapText,
  isSort,
  money,
  moveOf,
  moversOf,
  moveTo,
  nameError,
  removeFrom,
  rename,
  renameOf,
  type Sort,
  savedDraft,
  saveOf,
  shortName,
  sparkOf,
  swap,
  tileColumns,
  trendsOf,
  waiting,
  withView,
} from "../src/web/views/Dashboard.model.ts";
import {
  Earnings,
  Glance,
  LoadingPanel,
  SectionView,
  sectionTools,
  Tile,
} from "../src/web/views/Dashboard.tsx";
import {
  afterHours,
  choices,
  headline,
  labelOf,
  moveLabel,
  priceState,
  summary,
} from "../src/web/views/Instrument.model.ts";
import { signalsOf } from "../src/web/views/InstrumentCards.model.ts";
import { InstrumentCards } from "../src/web/views/InstrumentCards.tsx";
import { Head } from "../src/web/views/InstrumentHead.tsx";
import { InstrumentMenu } from "../src/web/views/InstrumentMenu.tsx";
import {
  fromHigh,
  returnOf,
  typeTabs,
} from "../src/web/views/Screener.model.ts";
import { ScreenerList } from "../src/web/views/Screener.tsx";
import { SignIn } from "../src/web/views/SignIn.tsx";
import {
  allOk,
  bytes,
  groups,
  jobLine,
  jobTone,
  jobWhen,
  retried,
  retryable,
  runTime,
  switchFailure,
  troubled,
} from "../src/web/views/Status.model.ts";
import {
  JobDetails,
  StatusBody,
  StatusMenu,
  statusItems,
} from "../src/web/views/Status.tsx";
import { validate } from "./helpers/schema.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");

const source = (
  name: string,
  more: Partial<Status["sources"][number]> = {},
): Status["sources"][number] => ({
  name,
  label: `Casey ${name}`,
  short: name.toUpperCase(),
  mark: name.slice(0, 2).toUpperCase(),
  state: "on",
  why: "always",
  backing_off: null,
  key: null,
  ...more,
});

const job = (
  src: string,
  name: string,
  more: Partial<Status["jobs"][number]> = {},
): Status["jobs"][number] => ({
  source: src,
  job: name,
  label: name,
  about: `What ${name} does.`,
  last: {
    scope: "US",
    started_at: "2026-10-28T11:57:00Z",
    ended_at: "2026-10-28T11:57:02Z",
    status: "ok",
    rows: 1,
    error: null,
  },
  instruments: 0,
  markets: 1,
  failing_instruments: 0,
  failing_markets: 0,
  failing_scopes: 0,
  failing: [],
  ...more,
});

const STATUS: Status = {
  version: "v1.2.3",
  sync: true,
  sources: [
    source("prices"),
    source("feed"),
    source("research", {
      why: "key file",
      backing_off: { until: "2026-10-28T12:05:00Z", after: "rate limited" },
    }),
    source("news", {
      state: "off",
      why: "no key",
      key: {
        file: "secrets/source-news.key",
        adds: "News for shares.",
        signup: "https://example.com/keys",
      },
    }),
  ],
  jobs: [
    job("prices", "Live prices", { markets: 19 }),
    job("feed", "Daily prices", {
      last: {
        scope: "FEED:TLV",
        started_at: "2026-10-28T09:00:00Z",
        ended_at: "2026-10-28T09:00:01Z",
        status: "failed",
        rows: 0,
        error: "no bars",
      },
      instruments: 14,
      markets: 0,
      failing_instruments: 7,
      failing_scopes: 7,
      failing: [
        {
          scope: "FEED:TLV",
          error: "no bars",
          at: "2026-10-28T09:00:01Z",
          next_at: null,
        },
        {
          scope: "FEED:SNP",
          error: "timeout",
          at: "2026-10-28T08:00:01Z",
          next_at: null,
        },
      ],
    }),
    job("research", "Key figures", {
      last: {
        scope: "US:A",
        started_at: "2026-10-27T23:00:00Z",
        ended_at: "2026-10-27T23:00:05Z",
        status: "ok",
        rows: 4,
        error: null,
      },
      instruments: 19,
      markets: 0,
    }),
    job("news", "News", { instruments: 24, markets: 0 }),
    job("sources", "switch"),
  ],
  instruments: 78,
  tracked: 61,
  database_bytes: 65_515_520,
};

// answers by method and path, recording what was asked
function fake(answers: Record<string, () => Response>): {
  fetch: Fetch;
  asked: { path: string; init?: RequestInit }[];
} {
  const asked: { path: string; init?: RequestInit }[] = [];
  return {
    asked,
    fetch: async (path, init) => {
      asked.push({ path, init });
      const answer = answers[`${init?.method ?? "GET"} ${path}`];
      if (answer === undefined) throw new Error(`no answer for ${path}`);
      return answer();
    },
  };
}

const ok = (body: unknown) => () => Response.json(body);
const status =
  (code: number, body: unknown = null) =>
  () =>
    body === null
      ? new Response(null, { status: code })
      : Response.json(body, { status: code });
// /api/v1's errors, as the server writes them
const problem = (
  code: number,
  body: { code: string; detail: string } & Record<string, unknown>,
) =>
  status(code, {
    title: code === 404 ? "Not Found" : "Conflict",
    status: code,
    ...body,
  });

const ADMIN_ME: Me = {
  id: "operator",
  name: "Casey",
  role: "admin",
  email: null,
  operator: true,
};
const signedAs = (user: Me | null, email_on = true) => ok({ user, email_on });

// the shell as an admin sees it: Server admin in the menus
function asAdmin<T>(run: () => T): T {
  markets.me.value = ADMIN_ME;
  try {
    return run();
  } finally {
    markets.me.value = null;
  }
}

describe("the routes", () => {
  test("are the paths the server answers with the page", () => {
    const paths = ROUTES.map((r) => r.path);
    expect(paths.sort()).toEqual([...UI_PATHS].sort());
    // the home page lands on /, and Server admin's Status is /admin
    expect(HOME).toBe("/");
    expect(match("/")?.route.label).toBe("Home");
    expect(match("/admin")?.route.label).toBe("Server admin");
    expect(match("/status")).toBeNull();
    expect(match("/admin/smtp")).toBeNull();
    expect(match("/screener")?.route.label).toBe("Screener");
    // the old addresses are no pages
    expect(match("/instruments")).toBeNull();
    expect(match("/instruments/US%3ANVDA")).toBeNull();
    expect(match("/connect")?.route.label).toBe("Connect agents");
    expect(match("/profile")?.route.label).toBe("Profile");
    // Alerts' two tabs keep their tab in the address, lit under /alerts
    expect(match("/alerts")?.route.label).toBe("Alerts");
    expect(match("/alerts/history")?.route).toMatchObject({
      label: "Alerts",
      parent: "/alerts",
    });
    expect(match("/nothing")).toBeNull();
    // an instrument's page takes its id from the path, decoded
    expect(match("/symbol/US%3ANVDA")).toMatchObject({
      route: { label: "Instrument" },
      params: { id: "US:NVDA" },
    });
    expect(match("/symbol/%E0%A4%A")).toBeNull();
    expect(match("/symbol/a/b")).toBeNull();
    // the rail names the pages without a parameter and lights the parent
    expect(RAIL.map((r) => r.label)).toEqual([
      "Home",
      "Screener",
      "Portfolios",
      "Alerts",
      "Trade plans",
      "Profile",
      "Connect agents",
      "Server admin",
    ]);
    // a member never sees an admin's pages
    expect(railFor(false).map((r) => r.label)).toEqual([
      "Home",
      "Screener",
      "Portfolios",
      "Alerts",
      "Trade plans",
      "Profile",
      "Connect agents",
    ]);
    expect(railFor(true)).toEqual(RAIL);
    // Server admin keeps its tab in the address, lit under /admin
    expect(match("/admin")?.route).toMatchObject({
      label: "Server admin",
      icon: "shield",
      admin: true,
    });
    for (const tab of ["/admin/settings", "/admin/users"]) {
      expect(match(tab)?.route).toMatchObject({
        label: "Server admin",
        admin: true,
        parent: "/admin",
      });
      expect(lit(tab, "/admin")).toBe(true);
    }
    expect(lit("/admin", "/")).toBe(false);
    // a symbol's page is not under /screener, so it names its parent
    expect(lit("/symbol/US%3ANVDA", "/screener")).toBe(true);
    expect(lit("/symbol/US%3ANVDA", "/portfolios")).toBe(false);
    expect(lit("/portfolios/5", "/portfolios")).toBe(true);
    expect(lit("/screenerx", "/screener")).toBe(false);
  });

  test("a link opens in place unless it leaves the UI", () => {
    const at = "http://markets.test";
    const link = {
      origin: at,
      pathname: "/admin",
      download: false,
      blank: false,
    };
    expect(inApp(link, at)).toBe(true);
    for (const other of [
      { ...link, origin: "http://other.test" },
      { ...link, download: true },
      { ...link, blank: true },
      { ...link, pathname: "/api/v1/docs" },
    ]) {
      expect(inApp(other, at)).toBe(false);
    }
    // an installed app has no tabs, so its own pages open in place
    expect(inApp({ ...link, blank: true }, at, true)).toBe(true);
    for (const other of [
      { ...link, origin: "http://other.test", blank: true },
      { ...link, download: true },
      { ...link, pathname: "/api/v1/docs", blank: true },
    ]) {
      expect(inApp(other, at, true)).toBe(false);
    }
  });

  test("the tab names the page before the brand", () => {
    expect(tabTitle("/", true)).toBe("1ctx Markets");
    expect(tabTitle("/admin", true)).toBe("Server admin · 1ctx Markets");
    expect(tabTitle("/admin/users", true)).toBe("Server admin · 1ctx Markets");
    expect(tabTitle("/screener", undefined)).toBe("Screener · 1ctx Markets");
    expect(tabTitle("/symbol/US%3ABRK-B", true)).toBe("BRK-B · 1ctx Markets");
    expect(tabTitle("/symbol/FRED:DGS10", true)).toBe("DGS10 · 1ctx Markets");
    expect(tabTitle("/portfolios/5", true)).toBe("Portfolios · 1ctx Markets");
    expect(tabTitle("/admin", false)).toBe("Sign in · 1ctx Markets");
    expect(tabTitle("/nothing", true)).toBe("1ctx Markets");
  });

  test("the theme follows the system until a choice is kept", () => {
    expect(resolveTheme(null, true)).toBe("light");
    expect(resolveTheme(null, false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("other", true)).toBe("light");
  });
});

describe("the data layer", () => {
  test("any 401 signs out and throws the session's end", async () => {
    let out = 0;
    const f = fake({ "GET /x": status(401, { error: "unauthorized" }) });
    const call = client(f.fetch, () => out++);
    const err = await call("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(out).toBe(1);
  });

  test("a tab reloads once when the server answers from another build", async () => {
    let reloads = 0;
    const watch = buildWatch(() => reloads++);
    watch("v1");
    watch("v1");
    expect(reloads).toBe(0);
    watch("v2");
    watch("v3");
    expect(reloads).toBe(1);
    let build = "v1";
    const seen: string[] = [];
    const call = client(
      async () => Response.json({}, { headers: { "x-markets-build": build } }),
      () => {},
      (v) => seen.push(v),
    );
    await call("/x");
    build = "v2";
    await call("/x");
    expect(seen).toEqual(["v1", "v2"]);
  });

  test("a failure reads as a short sentence", () => {
    const conflict = failure(409, {
      title: "Conflict",
      status: 409,
      detail: "rules read it",
      code: "conflict",
    });
    expect(says(conflict)).toBe("Rules read it.");
    expect(conflict.code).toBe("conflict");
    expect(says(failure(0, null))).toBe("The server did not answer.");
    expect(says("odd")).toBe("The server did not answer.");
  });

  test("a refusal shows the server's message; a fault or no answer, plain words", async () => {
    // the sign-in's own refusals keep {error, message}
    expect(
      failure(409, { error: "conflict", message: "rules read it" }).message,
    ).toBe("rules read it");
    expect(
      failure(500, { status: 500, code: "internal", detail: "internal error" })
        .message,
    ).toBe("the server failed");
    const call = client(
      async () => {
        throw new TypeError("offline");
      },
      () => {},
    );
    const err = (await call("/x").catch((e: unknown) => e)) as ApiError;
    expect([err.status, err.message]).toEqual([0, "the server did not answer"]);
  });

  test("/ui/me says whether the cookie holds and whose it is", async () => {
    const f = fake({ [`GET ${ME_PATH}`]: signedAs(ADMIN_ME) });
    const signed = store(f.fetch, () => NOW);
    await signed.check();
    expect(signed.signedIn.value).toBe(true);
    expect(signed.me.value).toEqual(ADMIN_ME);
    expect(signed.isAdmin.value).toBe(true);
    expect(signed.emailOn.value).toBe(true);
    // never the status, which is an admin's; who shares with them and the
    // alerts not seen yet, for the rail
    expect(f.asked.map((a) => a.path)).toEqual([
      ME_PATH,
      SHARING_PATH,
      SEEN_PATH,
    ]);
    const out = store(fake({ [`GET ${ME_PATH}`]: signedAs(null) }).fetch);
    await out.check();
    expect(out.signedIn.value).toBe(false);
    expect(out.me.value).toBeNull();
    expect(out.statusError.value).toBeNull();
    const down = store(fake({ [`GET ${ME_PATH}`]: status(502) }).fetch);
    await down.check();
    expect(down.signedIn.value).toBeUndefined();
    expect(down.statusError.value).toBe("The server failed.");
  });

  test("a 401 after signing in drops what was shown", async () => {
    let answer = ok(STATUS);
    const s = store(fake({ [`GET ${STATUS_PATH}`]: () => answer() }).fetch);
    await s.loadStatus();
    expect(s.signedIn.value).toBe(true);
    answer = status(401, {});
    await s.loadStatus();
    expect(s.signedIn.value).toBe(false);
    expect(s.status.value).toBeNull();
  });

  test("1D asks for the newest session with its extended trading, 5D for every one kept", async () => {
    const base = "/api/v1/instruments/US%3AA/bars?interval=5m";
    const one = `${base}&extended=true`;
    const five = `${base}&from=2016-10-28`;
    const daily = "/api/v1/instruments/US%3AA/bars?from=2026-01-01&interval=1d";
    const facts = {
      id: "US:A",
      name: "A Inc.",
      exchange: "NMS",
      type: "EQUITY",
      currency: "USD",
      unit: "per_share",
      source: "yahoo",
    };
    const common = {
      input: "US:A",
      stale: [],
      from: "2026-10-28",
      to: "2026-10-28",
      session: {
        state: "closed",
        start: "2026-10-28T13:30:00Z",
        end: "2026-10-28T20:00:00Z",
      },
    };
    const answer = {
      ...common,
      instrument: facts,
      interval: "5m",
      sessions: [{ session: "2026-10-28", fetched_at: "2026-10-28T20:05:00Z" }],
      previous_close: 100,
      points: [
        {
          at: "2026-10-28T19:55:00Z",
          session: "2026-10-28",
          close: 101,
          final: true,
        },
      ],
      extended_points: [
        { at: "2026-10-28T21:00:00Z", session: "post", close: 102 },
      ],
    };
    const bars = {
      ...common,
      instrument: {
        ...facts,
        basis: "split-adjusted prices; dividends and FX conversion excluded",
      },
      interval: "1d",
      bars: [hbar("2026-10-28", 101)],
    };
    // the fakes hold to the spec, so the chart reads what the server sends
    const schemas = spec.components.schemas as Record<string, any>;
    expect(validate(answer, schemas.Intraday, spec)).toEqual([]);
    expect(validate(bars, schemas.Bars, spec)).toEqual([]);
    const f = fake({
      [`GET ${one}`]: ok(answer),
      [`GET ${five}`]: ok(answer),
      [`GET ${daily}`]: ok(bars),
    });
    const s = store(f.fetch);
    expect(await s.intraday("US:A", "1D", "2016-10-28")).toEqual(answer as any);
    await s.intraday("US:A", "5D", "2016-10-28");
    expect(await s.history("US:A", "2026-01-01", "1d")).toEqual(bars as any);
    expect(f.asked.map((a) => a.path)).toEqual([one, five, daily]);
  });

  test("sign-in posts the key alone; a wrong one keeps the form", async () => {
    let key = "";
    const f = fake({
      [`POST ${SESSION_PATH}`]: () => status(key === "right" ? 204 : 401)(),
      [`GET ${ME_PATH}`]: signedAs(ADMIN_ME),
      [`DELETE ${SESSION_PATH}`]: status(204),
    });
    const s = store(f.fetch);
    key = "wrong";
    const err = await s.signIn(" wrong ").catch((e: unknown) => e);
    // what the form shows under the field
    expect(says(err)).toBe("Wrong admin key.");
    expect(s.signedIn.value).toBeUndefined();
    expect(f.asked).toHaveLength(1);
    const post = f.asked.find((a) => a.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ key: "wrong" });
    key = "right";
    await s.signIn("right");
    expect(s.me.value).toEqual(ADMIN_ME);
    await s.signOut();
    expect(s.signedIn.value).toBe(false);
    expect(s.me.value).toBeNull();
    expect(f.asked.at(-1)).toMatchObject({
      path: SESSION_PATH,
      init: { method: "DELETE" },
    });
  });

  test("a sign-in /ui/me then names nobody for says why", async () => {
    for (const [answer, words] of [
      // the browser dropped the cookie: no session ever held
      [signedAs(null), "Not signed in."],
      [status(502), "The server failed."],
    ] as const) {
      const s = store(
        fake({
          [`POST ${SESSION_PATH}`]: status(204),
          [`GET ${ME_PATH}`]: answer,
        }).fetch,
      );
      const err = await s.signIn("right").catch((e: unknown) => e);
      expect([words, says(err)]).toEqual([words, words]);
      expect(s.signedIn.value).not.toBe(true);
    }
  });

  test("a sign-in waits for the latest read of who is signed in", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const s = store(async (_path, init) => {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      const mine = ++n;
      await new Promise<void>((r) => releases.push(r));
      // the read before the sign-in names nobody, the later ones a person
      return Response.json({
        user: mine === 1 ? null : { ...ADMIN_ME, name: `v${mine}` },
        email_on: true,
      });
    });
    const before = s.check();
    const signing = s.signIn("right");
    while (releases.length < 2) await Bun.sleep(0);
    // a later read supersedes the sign-in's own
    const after = s.check();
    // the sign-in's read answers first and the later one last
    releases[1]!();
    await Bun.sleep(0);
    releases[0]!();
    await Bun.sleep(0);
    releases[2]!();
    await Promise.all([before, after]);
    await signing;
    expect(s.signedIn.value).toBe(true);
    expect(s.me.value?.name).toBe("v3");
  });

  test("an old 401 after a sign-in never signs out", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const s = store(async (path, init) => {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      if (path === ME_PATH) return Response.json({ user: ADMIN_ME });
      const mine = ++n;
      await new Promise<void>((r) => releases.push(r));
      return mine === 1
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : Response.json(STATUS);
    });
    // a status read from before the sign-in
    const before = s.loadStatus();
    while (releases.length < 1) await Bun.sleep(0);
    await s.signIn("right");
    expect(s.signedIn.value).toBe(true);
    releases[0]!();
    await before;
    expect(s.signedIn.value).toBe(true);
    expect(s.status.value).toBeNull();
  });

  test("a status load in flight at sign-out never signs back in", async () => {
    const releases: (() => void)[] = [];
    const s = store(async (_path, init) => {
      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      await new Promise<void>((r) => releases.push(r));
      return Response.json(STATUS);
    });
    const inFlight = s.loadStatus();
    await s.signOut();
    releases[0]!();
    await inFlight;
    expect(s.signedIn.value).toBe(false);
    expect(s.status.value).toBeNull();
    expect(s.loading.value).toBe(false);
  });

  test("an older status answer never lands over a newer one", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const s = store(async () => {
      const mine = ++n;
      await new Promise<void>((r) => releases.push(r));
      return Response.json({ ...STATUS, version: `v${mine}` });
    });
    const first = s.loadStatus();
    const second = s.loadStatus();
    releases[1]!();
    await second;
    releases[0]!();
    await first;
    expect(s.status.value?.version).toBe("v2");
    expect(s.loading.value).toBe(false);
  });
});

describe("the status model", () => {
  test("sizes, distances and times read as an operator says them", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(65_515_520)).toBe("62 MB");
    expect(bytes(1_500_000)).toBe("1.4 MB");
    expect(ago(null, NOW)).toBe("never");
    expect(ago("2026-10-28T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-28T11:57:00Z", NOW)).toBe("3 min ago");
    expect(ago("2026-10-28T09:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-10-26T12:00:00Z", NOW)).toBe("2 d ago");
    expect(runTime(null)).toBe("Never");
    expect(runTime("2026-10-28T13:05:00Z")).not.toMatch(/AM|PM/i);
  });

  test("a source and its jobs read as counts, never a single run", () => {
    // the server's phrases read as plain words
    expect(plain("rate limited")).toBe("too many requests");
    expect(plain("timed out")).toBe("no answer in time");
    expect(plain(null)).toBe("failed");
    expect(plain("something new")).toBe("something new");
    expect(plain("source error: AMD")).toBe("AMD: the source failed");
    expect(plain("source error: AMD, EL +2 more")).toBe(
      "AMD, EL +2 more: the source failed",
    );
    const [live, daily, figures] = STATUS.jobs;
    expect(jobLine(live!)).toBe("19 markets");
    expect(jobLine(daily!)).toBe("14 instruments · 7 failing");
    expect(jobLine({ ...live!, markets: 1 })).toBe("1 market");
    expect(jobLine({ ...live!, markets: 0 })).toBe("");
    expect(allOk(figures!)).toBe("All 19 instruments ok.");
    expect(allOk({ ...live!, markets: 1 })).toBe("1 market ok.");
    // a bars job runs per market and per instrument: it reads as instruments
    expect(jobLine({ ...live!, instruments: 50, markets: 19 })).toBe(
      "50 instruments",
    );
    // its market run failing reads apart, so a count never exceeds the one shown
    expect(
      jobLine({
        ...live!,
        instruments: 3,
        markets: 2,
        failing_instruments: 3,
        failing_markets: 1,
        failing_scopes: 4,
      }),
    ).toBe("3 instruments · 3 failing · 1 market failing");
    expect(
      jobLine({
        ...live!,
        instruments: 50,
        markets: 19,
        failing_markets: 2,
        failing_scopes: 2,
      }),
    ).toBe("50 instruments · 2 markets failing");
    expect(jobWhen(live!, NOW)).toBe("2 min ago");
    // the time never says how the run went
    expect(jobWhen(daily!, NOW)).toBe("2 h ago");
    expect(jobTone(live!)).toBe("done");
    expect(jobTone(daily!)).toBe("failed");
    // a good last run still reads failing while another scope failed
    expect(jobTone({ ...live!, failing_scopes: 1 })).toBe("failed");
    const running = {
      ...live!,
      last: { ...live!.last, status: "running" as const },
    };
    expect(jobTone(running)).toBe("running");
    // a failing scope outranks a run in progress
    expect(jobTone({ ...running, failing_scopes: 1 })).toBe("failed");
  });

  test("the rail turns red when a job fails or a source backs off", () => {
    const ok = { sources: [source("prices")], jobs: [job("prices", "quotes")] };
    expect(troubled(ok)).toBe(false);
    expect(
      troubled({
        ...ok,
        jobs: [job("prices", "quotes", { failing_scopes: 1 })],
      }),
    ).toBe(true);
    expect(
      troubled({
        ...ok,
        sources: [
          source("prices", {
            backing_off: {
              until: "2026-10-28T12:05:00Z",
              after: "rate limited",
            },
          }),
        ],
      }),
    ).toBe(true);
    // a source that is off shows nothing on the page, so it is no alarm
    expect(
      troubled({
        sources: [source("prices", { state: "off" })],
        jobs: [job("prices", "quotes", { failing_scopes: 1 })],
      }),
    ).toBe(false);
  });

  test("only sources that are on get a card, failing jobs first", () => {
    const g = groups(STATUS.sources, STATUS.jobs);
    expect(g.map((x) => x.source.name)).toEqual(["prices", "feed", "research"]);
    const [live] = STATUS.jobs;
    const failing = job("prices", "Daily prices", { failing_scopes: 1 });
    const [prices] = groups(STATUS.sources, [live!, failing]);
    expect(prices!.jobs.map((j) => j.label)).toEqual([
      "Daily prices",
      "Live prices",
    ]);
    // a job that only marks work for another never shows
    const [shown] = groups(STATUS.sources, [live!, job("prices", "owed")]);
    expect(shown!.jobs.map((j) => j.job)).toEqual(["Live prices"]);
  });

  test("a source change shows only when it failed", () => {
    expect(switchFailure(STATUS.jobs)).toBeNull();
    const failed = STATUS.jobs.map((j) =>
      j.source === "sources"
        ? {
            ...j,
            failing_scopes: 1,
            failing: [
              { scope: "BVB", error: "timeout", at: null, next_at: null },
            ],
          }
        : j,
    );
    expect(switchFailure(failed)).toBe(
      "Source change for market BVB failed: no answer in time. Its prices stay stale until a retry succeeds.",
    );
  });
});

describe("the views", () => {
  test("status draws the on sources' cards and the keyed ones to add, never a tracked list", () => {
    const html = render(<StatusBody status={STATUS} now={NOW} />);
    expect(html).not.toContain("Always tracked");
    expect(html).not.toContain("srv-track");
    for (const words of [
      "78",
      "61 tracked",
      "1 paused",
      "1 failing",
      "62 MB",
      "v1.2.3",
      "Casey prices",
      "19 markets",
      "14 instruments · 7 failing",
      "Add a source",
      "News for shares.",
      "secrets/source-news.key",
      "https://example.com/keys",
      "Get a key",
    ]) {
      expect([words, html.includes(words)]).toEqual([words, true]);
    }
    // a job row that is well says nothing more: the dot does
    expect(html).not.toContain(" ok<");
    // an off source has no card, only its row to add
    // one Jobs card, a folding label per source that is on, one head row
    expect(html).toContain(
      '<h2 class="card-title">Jobs<span class="card-count num" aria-live="polite">3</span>',
    );
    expect(html.match(/class="group-label group-fold"/g)).toHaveLength(3);
    expect(html).toMatch(/Casey feed<span class="group-count num">1<\/span>/);
    expect(html.match(/table-head/g)).toHaveLength(2);
    expect(html).toMatch(/<\/svg>Casey feed</);
    expect(html).not.toMatch(/<\/svg>Casey news</);
    expect(html).not.toContain(">switch<");
    expect(html).toContain('class="srv-dot status-failed"');
    // each job row opens its drawer; none is open yet
    expect(html).toContain('<span class="table-hidden">Daily prices</span>');
    expect(html).not.toContain('role="dialog"');
    // the jobs figure counts the jobs shown, not the off source's
    expect(html).toMatch(/<dt>Jobs<\/dt><dd class="num">3</);
    // a stat row, no tiles
    expect(html).toContain('<dl class="stats"');
  });

  test("an opened job says what it does, then its failures or that all are ok", () => {
    const [live, daily] = STATUS.jobs;
    const ok = render(<JobDetails job={live!} />);
    expect(ok).toContain("What Live prices does.");
    expect(ok).toContain("All 19 markets ok.");
    expect(ok).not.toContain("<table");
    const bad = render(<JobDetails job={daily!} source="Casey feed" />);
    expect(bad).toContain("Casey feed");
    expect(bad).toContain("Last run");
    expect(bad).toContain("FEED:TLV");
    expect(bad).toContain("no bars");
    expect(bad).toContain("5 more failing");
    expect(bad).not.toContain("ok.");
    // a last run that failed but a later read settled reads from the counts
    const settled = {
      ...daily!,
      failing: [],
      failing_scopes: 0,
      failing_instruments: 0,
    };
    expect(jobTone(settled)).toBe("done");
    const done = render(<JobDetails job={settled} />);
    expect(done).toContain("All 14 instruments ok.");
    expect(done).not.toContain("no bars");
    // a failed market check says when it runs again; a ticker's has no column
    expect(bad).not.toContain("Runs again");
    const check = render(
      <JobDetails
        job={{
          ...daily!,
          failing: [
            {
              scope: "FX",
              error: "malformed answer: CHF=X",
              at: "2026-11-05T00:00:20Z",
              next_at: "2026-11-06T00:00:00Z",
            },
          ],
        }}
      />,
    );
    expect(check).toContain("Runs again");
  });

  test("status leaves out what is empty", () => {
    const html = render(
      <StatusBody
        status={{
          ...STATUS,
          sources: STATUS.sources.map((x) => ({ ...x, state: "on" as const })),
          jobs: [],
        }}
        now={NOW}
      />,
    );
    expect(html).toContain("No runs yet.");
    expect(html).not.toContain("Add a source");
    expect(html).not.toContain("notice-failed");
    expect(html).not.toContain("Sync is off.");
  });

  test("status says when sync is off", () => {
    const html = render(
      <StatusBody status={{ ...STATUS, sync: false }} now={NOW} />,
    );
    expect(html).toContain('<p class="notice">Sync is off.</p>');
  });

  test("the status menu holds Refresh and the retry, off with nothing failing", () => {
    const items = (failing: boolean) =>
      render(
        <MenuItems
          close={() => {}}
          items={statusItems({
            failing,
            loading: false,
            onRefresh: () => {},
            onRetry: () => {},
          })}
        />,
      );
    const on = items(true);
    expect(on.match(/role="menuitem"/g)).toHaveLength(2);
    expect(on).toMatch(/role="menuitem"[^>]*>.*Refresh<\/button>/);
    expect(on).toMatch(/role="menuitem"[^>]*>.*Retry failed jobs<\/button>/);
    expect(on).not.toContain("disabled");
    expect(items(false)).toMatch(
      /role="menuitem" disabled[^>]*>.*Retry failed jobs<\/button>/,
    );
    const menu = (busy: boolean, done: boolean) =>
      render(
        <StatusMenu
          busy={busy}
          done={done}
          failing
          loading={false}
          onRefresh={() => {}}
          onRetry={() => {}}
        />,
      );
    const idle = menu(false, false);
    expect(idle).toContain('aria-label="More"');
    expect(idle).not.toContain("disabled");
    const busy = menu(true, false);
    expect(busy).toContain("disabled");
    expect(busy).toContain("spinner");
    expect(menu(false, true)).toContain("status-done");
  });

  test("only a failing instrument makes the retry worth asking, and the check needs a fetch", () => {
    const market = job("prices", "quotes", {
      failing_markets: 1,
      failing_scopes: 1,
    });
    const share = job("research", "metric", {
      failing_instruments: 1,
      failing_scopes: 1,
    });
    expect(retryable([job("prices", "bars")])).toBe(false);
    expect(retryable([market])).toBe(false);
    expect(retryable([market, share])).toBe(true);
    const counts = { asked: 1, fetched: 1, failed: 0, left_out: 0 };
    expect(retried(counts)).toBe(true);
    expect(retried({ ...counts, fetched: 0, asked: 0, left_out: 2 })).toBe(
      false,
    );
    expect(retried({ ...counts, asked: 2, failed: 1 })).toBe(false);
  });

  test("a retry posts to its route, then reloads status", async () => {
    const counts = { asked: 2, fetched: 1, failed: 1, left_out: 3 };
    const f = fake({
      [`POST ${RETRY_PATH}`]: ok(counts),
      [`GET ${STATUS_PATH}`]: ok(STATUS),
    });
    const s = store(f.fetch);
    expect(await s.retry()).toEqual(counts);
    const post = f.asked.findIndex((a) => a.path === RETRY_PATH);
    expect(f.asked[post]!.init?.method).toBe("POST");
    expect(f.asked[post]!.init?.body).toBeUndefined();
    expect(f.asked.slice(post + 1).some((a) => a.path === STATUS_PATH)).toBe(
      true,
    );
    // refused, it throws for the page's notice and reloads nothing
    const refused = fake({
      [`POST ${RETRY_PATH}`]: status(403, {
        title: "Forbidden",
        status: 403,
        code: "forbidden",
        detail: "this route takes the admin key",
      }),
    });
    await expect(store(refused.fetch).retry()).rejects.toThrow();
    expect(refused.asked.map((a) => a.path)).toEqual([RETRY_PATH]);
  });

  test("sign-in asks for the admin key alone", () => {
    const html = render(<SignIn store={store(fake({}).fetch)} />);
    expect(html).toContain("Admin key");
    expect(html).toContain('type="password"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain("Markets");
    expect(html).not.toContain("ssearch");
  });

  test("a server that cannot be reached shows its failure without the symbol search", () => {
    const s = store(fake({}).fetch);
    s.statusError.value = "The server did not answer.";
    const html = render(<App store={s} />);
    expect(html).toContain("This page did not load");
    expect(html).toContain("The server did not answer.");
    expect(html).not.toContain("ssearch");
  });

  test("the rail is the logo, Markets, the pages lit where they are, and the menu", () => {
    const html = asAdmin(() =>
      render(<Rail here="/symbol/US%3AAAPL" onHide={() => {}} />),
    );
    expect(html).toContain('aria-label="1ctx"');
    expect(html).toContain('<span class="rail-word">Markets</span>');
    expect(html.indexOf("rail-word")).toBeLessThan(html.indexOf("rail-nav"));
    const lit = [
      ...html.matchAll(/class="rail-item rail-item-on"[^>]*>.*?<span>([^<]+)/g),
    ].map((m) => m[1]);
    expect(lit).toEqual(["Screener"]);
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain('href="/status"');
    expect(html).toContain("Hide the menu");
    expect(html).toContain("rail-user-row");
    // the menu's row names the person signed in
    expect(html).toContain('<span class="rail-user-name cut">Casey</span>');
    // a member's rail leaves out Server admin
    markets.me.value = { ...ADMIN_ME, id: "ana", name: "Ana", role: "member" };
    try {
      const member = render(<Rail here="/" onHide={() => {}} />);
      expect(member).not.toContain('href="/admin"');
      expect(member).toContain('href="/connect"');
      const strip = render(<Strip here="/" />);
      expect(strip).not.toContain('href="/admin"');
    } finally {
      markets.me.value = null;
    }
  });

  test("a page re-reading marks its title, never the menu's icons", () => {
    const views = () => [
      render(<Rail here="/screener" onHide={() => {}} />),
      render(<Strip here="/screener" />),
    ];
    expect(render(<Page title="Screener" />)).not.toContain("page-title-busy");
    reloading.value = 1;
    try {
      expect(render(<Page title="Screener" />)).toContain(
        'class="page-title page-title-busy"',
      );
      for (const html of views()) expect(html).not.toContain("rail-icon-");
    } finally {
      reloading.value = 0;
    }
    expect(iconClass(true)).toBe("rail-icon-failed");
    expect(iconClass(false)).toBeUndefined();
  });

  test("the rail lists the recent instruments, the one on screen lit", () => {
    expect(render(<Rail here="/" onHide={() => {}} />)).not.toContain("Recent");
    recent.value = [
      { id: "US:AMD", name: "Advanced Micro Devices, Inc." },
      { id: "US:AAPL", name: null },
    ];
    try {
      const html = render(<Rail here="/symbol/US%3AAAPL" onHide={() => {}} />);
      expect(html).toContain('<span class="rail-label">Recent</span>');
      expect(html).toContain('href="/symbol/US%3AAMD"');
      expect(html).toContain(
        '<span class="sym sym-compact"><span class="sym-ticker">AMD</span><span class="sym-name">Advanced Micro Devices, Inc.</span></span>',
      );
      expect(html).toMatch(
        /class="rail-recent rail-item-on"[^>]*><span class="sym sym-compact"><span class="sym-ticker">AAPL<\/span><\/span><\/a>/,
      );
    } finally {
      recent.value = [];
    }
  });

  test("the rail lists every recent instrument, More on a phone the first few", () => {
    recent.value = Array.from({ length: RECENT_MAX }, (_, i) => ({
      id: `US:S${i}`,
      name: null,
    }));
    try {
      const count = (html: string) =>
        html.split('class="rail-recent').length - 1;
      expect(count(render(<Rail here="/" onHide={() => {}} />))).toBe(
        RECENT_MAX,
      );
      expect(count(render(<Recent here="/" max={RECENT_PHONE} />))).toBe(
        RECENT_PHONE,
      );
    } finally {
      recent.value = [];
    }
  });

  test("a recent coin is named without its quote currency", () => {
    recent.value = [{ id: "CRYPTO:BTC-USD", name: "Bitcoin USD" }];
    try {
      const html = render(<Rail here="/" onHide={() => {}} />);
      expect(html).toContain(
        '<span class="sym-ticker">BTC</span><span class="sym-name">Bitcoin</span>',
      );
      expect(html).toContain('title="BTC · Bitcoin"');
    } finally {
      recent.value = [];
    }
  });

  test("a recent instrument opened goes first, one opened from Recent keeps its place", () => {
    const a = { id: "US:A", name: "A" };
    const b = { id: "US:B", name: "B" };
    const c = { id: "US:C", name: "C" };
    expect(putRecent([a, b], c, false)).toEqual([c, a, b]);
    expect(putRecent([a, b, c], c, false)).toEqual([c, a, b]);
    const renamed = { id: "US:C", name: "C2" };
    expect(putRecent([a, b, c], renamed, true)).toEqual([a, b, renamed]);
    expect(putRecent([a, b], c, true)).toEqual([c, a, b]);
    const many = Array.from({ length: RECENT_MAX }, (_, i) => ({
      id: `US:${i}`,
      name: null,
    }));
    expect(putRecent(many, c, false)).toHaveLength(RECENT_MAX);
    expect(putRecent(many, c, false)[0]).toEqual(c);
  });

  test("a stored Recent list that is not one reads as empty", () => {
    expect(readRecent(null)).toEqual([]);
    expect(readRecent("{")).toEqual([]);
    expect(readRecent('{"id":"x"}')).toEqual([]);
    expect(readRecent('[{"id":"US:A","name":null},{"id":3},null]')).toEqual([
      { id: "US:A", name: null },
    ]);
  });

  test("the folded rail keeps the pages as icons", () => {
    const html = asAdmin(() => render(<Strip here="/admin/settings" />));
    expect(html).toContain('aria-label="Show the menu"');
    for (const r of RAIL) expect(html).toContain(`aria-label="${r.label}"`);
    expect(html).toContain('class="strip-item strip-item-on"');
  });

  test("the shell puts the rail beside the page", () => {
    const html = render(
      <Shell here="/admin">
        <p>page</p>
      </Shell>,
    );
    expect(html).toContain('<aside class="rail">');
    expect(html).toContain('<main class="shell-main"><p>page</p></main>');
  });
});

const listed = (id: string, more: Partial<Listed> = {}): Listed => ({
  id,
  name: `${id} name`,
  market: id.split(":")[0]!,
  currency: "USD",
  kind: "EQUITY",
  unit: "per_share",
  source: "yahoo",
  tracked: true,
  tracked_by: ["read"],
  read_until: "2026-11-27T12:00:00Z",
  price: 100,
  change: 1,
  change_percent: 1,
  fetched_at: "2026-10-28T11:59:00Z",
  ...more,
});

const screened = (id: string, more: Partial<Screened> = {}): Screened => ({
  ...listed(id),
  return_1m: 2,
  return_1y: 20,
  drawdown: -4,
  rsi14: 55,
  distance_sma200: 5,
  cross: 1,
  trend: "up",
  ...more,
});

const MOVES: ScreenAsk = {
  types: [],
  screen: "moves",
  sort: null,
  order: null,
};

const screenPage = (
  rows: Screened[],
  more: { next?: string; screen?: string; sort?: [string, string] } = {},
) => ({
  screen: more.screen ?? "moves",
  type: [],
  sort: {
    field: more.sort?.[0] ?? "move",
    order: more.sort?.[1] ?? "desc",
  },
  counts: { moves: 9, near_high: 3, off_high: 2, oversold: 1, overbought: 0 },
  kinds: [
    { kind: "EQUITY", count: 7 },
    { kind: "ETF", count: 2 },
  ],
  instruments: rows,
  ...(more.next === undefined ? {} : { next_page_token: more.next }),
});

const heldScreen = (
  rows: Screened[],
  ask: ScreenAsk = MOVES,
  next: string | null = null,
): Screener => {
  const p = screenPage(rows, { screen: ask.screen });
  return {
    ask,
    sort: p.sort as Screener["sort"],
    counts: p.counts,
    kinds: p.kinds,
    rows,
    next,
  };
};

describe("the instruments model", () => {
  test("a row names the kind and market in plain words, and a stop only", () => {
    expect(symbolOf("US:NVDA")).toBe("NVDA");
    expect(about(listed("US:NVDA"))).toBe("Stock · US");
    expect(about(listed("XETRA:VWCE", { kind: "ETF" }))).toBe("ETF · XETRA");
    // a market that repeats the kind is said once
    expect(about(listed("CRYPTO:BTC-USD", { kind: "CRYPTOCURRENCY" }))).toBe(
      "Crypto",
    );
    expect(
      about(
        listed("BVB:R2809A", { kind: "BOND", tracked: false, tracked_by: [] }),
      ),
    ).toBe("Bond · BVB · No longer updated");
  });

  test("a price carries its currency or unit, a change its sign", () => {
    expect(price(listed("US:A", { price: 1661.62 }))).toBe("1,661.62 USD");
    expect(price(listed("BVB:SNP", { price: 1.359, currency: "RON" }))).toBe(
      "1.359 RON",
    );
    expect(
      price(
        listed("FRED:DGS10", { price: 5, unit: "percent", currency: null }),
      ),
    ).toBe("5.00%");
    expect(price(listed("US:A", { price: null }))).toBe("—");
    expect(change(listed("US:A", { change_percent: 1.264 }))).toEqual({
      text: "+1.26%",
      dir: 1,
    });
    expect(change(listed("US:A", { change_percent: -0.52 }))).toEqual({
      text: "−0.52%",
      dir: -1,
    });
    // a move that rounds to nothing is flat, never "−0.00%"
    expect(change(listed("US:A", { change_percent: -0.001 }))).toEqual({
      text: "0.00%",
      dir: 0,
    });
    expect(change(listed("FRED:DGS10", { change_percent: null })).text).toBe(
      "",
    );
  });

  test("a screen's own figure, the type tabs and a yield's return read plainly", () => {
    expect(fromHigh(-3.14)).toBe("3.1% below");
    expect(fromHigh(-0.04)).toBe("At its high");
    expect(fromHigh(0)).toBe("At its high");
    expect(
      typeTabs([
        { kind: "SERIES", count: 1 },
        { kind: "ALTSYMBOL", count: 1 },
        { kind: "EQUITY", count: 3 },
        { kind: "FUTURE", count: 2 },
        { kind: "CURRENCY", count: 1 },
        { kind: "WARRANT", count: 1 },
      ]).map((t) => [t.label, t.types]),
    ).toEqual([
      ["All", []],
      ["Stocks", ["EQUITY"]],
      ["Currencies", ["CURRENCY"]],
      // two kinds said alike are one tab
      ["Futures", ["ALTSYMBOL", "FUTURE"]],
      ["Series", ["SERIES"]],
      ["Warrant", ["WARRANT"]],
    ]);
    expect(returnOf(screened("US:A"), 12.345).text).toBe("+12.35%");
    expect(
      returnOf(screened("FRED:DGS10", { unit: "percent" }), -0.2).text,
    ).toBe("−0.20 pts");
  });

  test("the price and its currency come apart; a market that repeats the kind is blank", () => {
    expect(priceParts(listed("US:A", { price: 1661.62 }))).toEqual({
      value: "1,661.62",
      currency: "USD",
    });
    expect(
      priceParts(
        listed("FRED:X", { price: 5, unit: "percent", currency: null }),
      ),
    ).toEqual({ value: "5.00%", currency: null });
    expect(
      marketOf(
        listed("CRYPTO:BTC-USD", { kind: "CRYPTOCURRENCY", market: "CRYPTO" }),
      ),
    ).toBe("");
    expect(marketOf(listed("US:A"))).toBe("US");
  });
});

describe("the instruments screener", () => {
  const list = (held: Screener | null, ask: ScreenAsk = MOVES) =>
    render(
      <ScreenerList
        held={held}
        ask={ask}
        more={false}
        onAsk={() => {}}
        onMore={() => {}}
      />,
    );

  test("draws the type tabs, the tiles' counts and the screen's rows", () => {
    const html = list(
      heldScreen(
        [
          screened("US:NVDA", {
            name: "NVIDIA",
            price: 216.885,
            change_percent: -0.48,
            return_1y: 30.5,
          }),
          screened("BVB:H2O", { currency: "RON", trend: "down" }),
        ],
        MOVES,
        "50~abc",
      ),
    );
    expect(html).toContain(">All<");
    expect(html).toContain(">Stocks<");
    expect(html).toContain(">ETFs<");
    for (const name of [
      "Biggest moves",
      "Near the high",
      "Well off the high",
      "Oversold",
      "Overbought",
    ]) {
      expect(html).toContain(`<span class="scr-name">${name}</span>`);
    }
    expect(html).toContain('<span class="scr-n num">9</span>');
    expect(html).toContain("Largest moves today, up or down.");
    // the title is the screen's name, no count
    expect(html).not.toContain("card-count");
    expect(html.indexOf("NVDA")).toBeLessThan(html.indexOf("H2O"));
    expect(html).toContain('href="/symbol/US%3ANVDA"');
    expect(html).toContain('216.89<span class="num-ccy"> USD</span>');
    expect(html).toContain("−0.48%");
    expect(html).toContain("+30.50%");
    expect(html).toContain(">Uptrend<");
    expect(html).toContain(">Downtrend<");
    for (const head of ["Day", "1M", "1Y", "Trend"]) {
      expect(html).toContain(`>${head}<`);
    }
    // moves has no figure of its own
    expect(html).not.toContain("From high");
    expect(html).toContain("Show more");
  });

  test("a screen with a figure of its own shows it beside the price", () => {
    const ask: ScreenAsk = { ...MOVES, screen: "off_high" };
    const html = list(
      heldScreen([screened("US:A", { drawdown: -31.26 })], ask),
      ask,
    );
    expect(html).toContain(">From high<");
    expect(html).toContain("31.3% below");
    expect(html).toContain("20% or more below the year's high.");
    const rsi: ScreenAsk = { ...MOVES, screen: "oversold" };
    const low = list(heldScreen([screened("US:A", { rsi14: 27.6 })], rsi), rsi);
    expect(low).toContain(">RSI<");
    expect(low).toContain(">28<");
    expect(low).not.toContain("Show more");
  });

  test("a tab, a tile and a column head each ask the server", () => {
    const asked: ScreenAsk[] = [];
    const ask: ScreenAsk = {
      types: [],
      screen: "off_high",
      sort: "return_1y",
      order: "asc",
    };
    const tree = ScreenerList({
      held: heldScreen([screened("US:A")], ask),
      ask,
      more: false,
      onAsk: (a) => asked.push(a),
      onMore: () => {},
    });
    const nodes: any[] = [];
    const walk = (n: any) => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      nodes.push(n);
      walk(n.props?.children);
    };
    walk(tree);
    nodes.find((n) => n.props?.label === "Types").props.onPick("Stock");
    expect(asked.at(-1)).toEqual({ ...ask, types: ["EQUITY"] });
    const tiles = nodes.filter((n) =>
      /^scr-tile( |$)/.test(String(n.props?.class ?? "")),
    );
    // the picked tile asks nothing
    tiles.find((n) => n.props["aria-pressed"]).props.onClick();
    expect(asked).toHaveLength(1);
    tiles.find((n) => !n.props["aria-pressed"]).props.onClick();
    expect(asked.at(-1)).toEqual({
      types: [],
      screen: "moves",
      sort: null,
      order: null,
    });
    nodes
      .find((n) => n.props?.label === "Instruments" && n.props.onSort)
      .props.onSort("change", "desc");
    expect(asked.at(-1)).toEqual({ ...ask, sort: "change", order: "desc" });
    const html = list(heldScreen([], ask), ask);
    expect(html).toContain(
      '<button type="button" class="scr-tile scr-tile-on" aria-pressed="true">',
    );
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  test("says why a screen is empty, and waits before its first answer", () => {
    const ask: ScreenAsk = { ...MOVES, screen: "oversold" };
    expect(list(heldScreen([], ask), ask)).toContain(
      "Nothing is oversold today.",
    );
    expect(list(heldScreen([]))).toContain(
      "No instrument is kept up to date yet.",
    );
    const waiting = list(null);
    expect(waiting).not.toContain("Nothing is");
    expect(waiting).not.toContain("No instrument is kept up to date yet.");
    expect(waiting).toContain('<span class="scr-n num">–</span>');
  });

  test("asks the screen, its type and sort; a second ask joins the one in flight", async () => {
    const first = Promise.withResolvers<Response>();
    const asked: string[] = [];
    const s = store(async (path) => {
      asked.push(path);
      if (path === screenerPath(MOVES)) return first.promise;
      return Response.json(
        screenPage([screened("US:B")], { screen: "near_high" }),
      );
    });
    const a = s.loadScreener();
    const b = s.loadScreener();
    first.resolve(Response.json(screenPage([screened("US:A")])));
    await Promise.all([a, b]);
    expect(asked).toEqual(["/api/v1/screener?screen=moves&page_size=50"]);
    expect(s.screener.value?.rows.map((r) => r.id)).toEqual(["US:A"]);
    const near: ScreenAsk = {
      types: ["FUTURE", "ALTSYMBOL"],
      screen: "near_high",
      sort: "return_1y",
      order: "asc",
    };
    await s.loadScreener(near);
    expect(asked.at(-1)).toBe(
      "/api/v1/screener?screen=near_high&type=FUTURE%2CALTSYMBOL&sort=return_1y&order=asc&page_size=50",
    );
    expect(s.screenAsk.value).toEqual(near);
    // a refresh asks what the page asked last
    await s.loadScreener();
    expect(asked.at(-1)).toBe(asked.at(-2));
  });

  test("Show more adds the next page, and a refresh reads as many again", async () => {
    const asked: string[] = [];
    const rows = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => screened(`US:R${from + k}`));
    const s = store(async (path) => {
      asked.push(path);
      if (path.endsWith("page_token=p2")) {
        return Response.json(screenPage(rows(50, 50), { next: "p3" }));
      }
      if (path.endsWith("page_token=p3")) {
        return Response.json(screenPage(rows(100, 10)));
      }
      return Response.json(screenPage(rows(0, 50), { next: "p2" }));
    });
    await s.loadScreener();
    expect(s.screener.value?.rows).toHaveLength(50);
    await s.moreScreener();
    expect(s.screener.value?.rows).toHaveLength(100);
    expect(s.screener.value?.next).toBe("p3");
    asked.length = 0;
    await s.loadScreener();
    expect(asked).toEqual([screenerPath(MOVES), screenerPath(MOVES, "p2")]);
    expect(s.screener.value?.rows).toHaveLength(100);
    await s.moreScreener();
    expect(s.screener.value?.rows).toHaveLength(110);
    expect(s.screener.value?.next).toBeNull();
  });

  test("a row a reordered page repeats is shown once", async () => {
    // the quote pass moved US:B up between the two reads
    const s = store(async (path) =>
      Response.json(
        path.endsWith("page_token=p2")
          ? screenPage([screened("US:B"), screened("US:C")])
          : screenPage([screened("US:A"), screened("US:B")], { next: "p2" }),
      ),
    );
    await s.loadScreener();
    await s.moreScreener();
    expect(s.screener.value?.rows.map((r) => r.id)).toEqual([
      "US:A",
      "US:B",
      "US:C",
    ]);
  });

  test("a refresh read before Show more never cuts the rows back", async () => {
    const first = Promise.withResolvers<Response>();
    const more = Promise.withResolvers<Response>();
    const asked: string[] = [];
    const rows = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => screened(`US:R${from + k}`));
    let refreshes = 0;
    const s = store(async (path) => {
      asked.push(path);
      if (path.endsWith("page_token=p2")) return more.promise;
      if (refreshes++ === 1) return first.promise;
      return Response.json(screenPage(rows(0, 50), { next: "p2" }));
    });
    await s.loadScreener();
    const refreshing = s.loadScreener();
    const adding = s.moreScreener();
    more.resolve(Response.json(screenPage(rows(50, 50), { next: "p3" })));
    await adding;
    first.resolve(Response.json(screenPage(rows(0, 50), { next: "p2" })));
    await refreshing;
    expect(s.screener.value?.rows).toHaveLength(100);
    asked.length = 0;
    await s.loadScreener();
    // the next refresh reads the hundred again, a page past the first
    expect(asked).toEqual([screenerPath(MOVES), screenerPath(MOVES, "p2")]);
  });

  test("a failed refresh keeps the rows and says why", async () => {
    let fail = false;
    const s = store(async () =>
      fail
        ? Response.json(
            { status: 500, code: "internal", detail: "x" },
            { status: 500 },
          )
        : Response.json(screenPage([screened("US:A")])),
    );
    await s.loadScreener();
    fail = true;
    await s.loadScreener();
    expect(s.screener.value?.rows.map((r) => r.id)).toEqual(["US:A"]);
    expect(s.screenerError.value).toBe("The server failed.");
  });
});

const detail = (
  more: Partial<Detail["quote"]> = {},
  row: Partial<Listed> = {},
): Detail => ({
  instrument: listed("US:NVDA", { name: "NVIDIA", ...row }),
  credit: { name: "Casey", url: "https://example.com/" },
  intraday: true,
  error: null,
  quote: {
    id: "US:NVDA",
    price: 217.24,
    change: -0.7,
    change_percent: -0.32,
    unit: "per_share",
    currency: "USD",
    fetched_at: "2026-10-28T11:59:30Z",
    stale: [],
    returns: {
      "1w": -2.13,
      "1m": -5.08,
      "3m": 10.27,
      ytd: 16.48,
      "1y": 30.12,
      to: "2026-10-28",
      live: true,
    },
    session: {
      state: "open",
      start: "2026-10-28T08:00:00Z",
      end: "2026-10-28T16:30:00Z",
    },
    ...more,
  },
});

const DAILY = {
  sma50: 221.97,
  sma200: 204.27,
  cross: 1,
  cross_edge: 0,
  rsi14: 41.3,
  macd_histogram: -1.1,
  macd_turn: 0,
  atr14: 5.72,
  volatility20: 1.91,
  high52w: 243.37,
  low52w: 164.27,
  drawdown: -12.66,
  from_low: 29.4,
  days_since_high: 17,
  volume_ratio: 0.46,
};

describe("the instrument model", () => {
  test("the cards under the chart say the signals in plain words", () => {
    const s = signalsOf(
      detail({
        signals: { daily: DAILY },
        day_low: 212.08,
        day_high: 215.32,
        volume: 46_360_000,
      }),
    );
    const year = s.range;
    const today = s.session;
    expect(today?.today).toBe(true);
    expect(year!.span).toEqual({
      low: "164.27 USD",
      high: "243.37 USD",
      at: (217.24 - 164.27) / (243.37 - 164.27),
    });
    expect(year!.facts).toEqual([
      {
        label: "From the high",
        value: "12.66% below",
        note: "17 trading days ago",
        tone: "down",
      },
      { label: "From the low", value: "29.40% above", tone: "up" },
    ]);
    // the price past the day's high pins the dot at the end
    expect(today!.span?.at).toBe(1);
    expect(today!.facts.map((r) => [r.label, r.value, r.note])).toEqual([
      ["Volume so far", "46.36M", "0.46× the 20-day average"],
      ["Typical daily move", "1.91%", "over 20 days"],
      ["Average daily range", "5.72 USD", "over 14 days"],
    ]);
    expect(s.trend.map((r) => [r.label, r.value, r.note])).toEqual([
      ["50-day average", "2.13% below", "221.97 USD"],
      ["200-day average", "6.35% above", "204.27 USD"],
      ["50-day vs 200-day", "above", undefined],
      ["RSI 14", "41.3", "neutral"],
      ["Momentum", "downward", undefined],
    ]);
  });

  test("Trend carries the 200-week average in the daily ones' form", () => {
    const d = detail({ signals: { daily: DAILY, weekly: { sma200: 180 } } });
    expect(
      signalsOf(d).trend.map((r) => [r.label, r.value, r.note, r.tone]),
    ).toContainEqual(["200-week average", "20.69% above", "180.00 USD", "up"]);
    expect(render(<Head detail={d} now={NOW} />)).not.toContain(
      "200-week average",
    );
    // a yield is apart from its average by points
    const y = detail(
      {
        price: null,
        observation: { date: "2026-10-23", value: 5 },
        signals: { daily: DAILY, weekly: { sma200: 4.2 } },
      },
      { id: "FRED:DGS10", unit: "percent", currency: null },
    );
    expect(
      signalsOf(y).trend.find((r) => r.label === "200-week average")?.value,
    ).toBe("0.80 pts above");
    // too young for one: no row
    expect(
      signalsOf(
        detail({ signals: { daily: DAILY, weekly: { sma200: null } } }),
      ).trend.map((r) => r.label),
    ).not.toContain("200-week average");
  });

  test("a turn, a cross and an extreme read as the day's news", () => {
    const trend = (more: Partial<typeof DAILY>) =>
      signalsOf(
        detail({ signals: { daily: { ...DAILY, ...more } } }),
      ).trend.map(
        (r) => `${r.label}: ${r.value}${r.note ? ` (${r.note})` : ""}`,
      );
    expect(
      trend({ macd_turn: 1, rsi14: 72, cross: -1, cross_edge: -1 }),
    ).toEqual([
      "50-day average: 2.13% below (221.97 USD)",
      "200-day average: 6.35% above (204.27 USD)",
      "50-day vs 200-day: below (death cross today)",
      "RSI 14: 72.0 (overbought)",
      // a turn up while still below the signal: the side stays downward
      "Momentum: downward (turning up today)",
    ]);
    expect(trend({ macd_histogram: 0.4, macd_turn: -1 })).toContain(
      "Momentum: upward (turning down today)",
    );
    expect(trend({ macd_histogram: 0 })).toContain("Momentum: flat");
    expect(trend({ rsi14: 25 })).toContain("RSI 14: 25.0 (oversold)");
    expect(trend({ cross_edge: 1 })).toContain(
      "50-day vs 200-day: above (golden cross today)",
    );
  });

  test("a yield's distances and range read in points", () => {
    const yieldRow = signalsOf(
      detail(
        {
          price: 4.2,
          unit: "percent",
          currency: null,
          signals: {
            daily: { ...DAILY, sma50: 4.0, sma200: 4.5, atr14: 0.07 },
          },
        },
        { id: "FRED:DGS10", unit: "percent", currency: null },
      ),
    );
    const rows = [
      ...yieldRow.range!.facts,
      ...yieldRow.session!.facts,
      ...yieldRow.trend,
    ];
    const value = (label: string) => rows.find((r) => r.label === label)?.value;
    expect(value("50-day average")).toBe("0.20 pts above");
    expect(value("200-day average")).toBe("0.30 pts below");
    expect(value("Average daily range")).toBe("0.07 pts");
  });

  test("a card or row without its signals is left out", () => {
    // no returns, signals or day range: nothing under the chart
    const bare = detail({ returns: null });
    expect(signalsOf(bare)).toEqual({
      returns: null,
      range: null,
      session: null,
      trend: [],
    });
    expect(render(<InstrumentCards detail={bare} held={null} />)).toBe(
      '<div class="ins-cards"></div>',
    );
    // a young listing: no year, no 200-day average, no cross
    const young = detail({
      returns: null,
      signals: {
        daily: {
          ...DAILY,
          sma200: null,
          cross: null,
          high52w: null,
          low52w: null,
          drawdown: null,
          from_low: null,
          days_since_high: null,
        },
      },
      session: null,
    });
    const s = signalsOf(young);
    expect(s.range).toBeNull();
    expect(s.session?.today).toBe(false);
    expect(s.trend.map((r) => r.label)).toEqual([
      "50-day average",
      "RSI 14",
      "Momentum",
    ]);
    // a closed market's card is the last session, its volume the day's
    const closed = signalsOf(
      detail({
        volume: 1_000,
        session: { state: "closed", start: null, end: null },
      }),
    ).session!;
    expect(closed.today).toBe(false);
    expect(closed.facts[0]!.label).toBe("Volume");
    // open, but the price is still yesterday's until the first pass
    const opening = signalsOf(
      detail({ volume: 1_000, trade_time: "2026-10-27T20:00:00Z" }),
    ).session!;
    expect(opening.today).toBe(false);
    expect(opening.facts[0]!.label).toBe("Volume");
    // at the high and the low, and a high made today
    const edges = signalsOf(
      detail({
        signals: {
          daily: {
            ...DAILY,
            drawdown: -0.001,
            from_low: 0,
            days_since_high: 0,
          },
        },
      }),
    ).range!.facts.map((r) => [r.value, r.note ?? null, r.tone ?? null]);
    expect(edges).toEqual([
      ["at the high", "today", null],
      ["at the low", null, null],
    ]);
    const html = render(<InstrumentCards detail={young} held={null} />);
    expect(html).toContain("Momentum");
    expect(html).toContain('<h2 class="card-title">Trend');
    expect(html).toContain('<h2 class="card-title">Last session');
    expect(html).not.toContain("Performance");
    expect(html).not.toContain("range-bar");
  });

  test("the head says open or closed, and when it was fetched", () => {
    expect(headline(detail()).price).toBe("217.24 USD");
    expect(priceState(detail(), NOW)).toBe("Open · just now");
    expect(
      priceState(
        detail({ session: { state: "closed", start: null, end: null } }),
        NOW,
      ),
    ).toBe("Closed");
    // the open before the first pass: the price is still the last close
    expect(
      priceState(
        detail({
          fetched_at: "2026-10-27T16:35:00Z",
          trade_time: "2026-10-27T16:29:58Z",
        }),
        NOW,
      ),
    ).toBe("Opening · last close");
    // read since the open, but nothing has traded yet
    expect(
      priceState(
        detail({
          fetched_at: "2026-10-28T09:00:00Z",
          trade_time: "2026-10-27T16:29:58Z",
        }),
        NOW,
      ),
    ).toBe("Open · no trade yet · 3 h ago");
    const series = detail(
      {
        price: null,
        observation: { date: "2026-10-26", value: 5 },
        session: null,
        unit: "percent",
        currency: null,
      },
      { id: "FRED:DGS10", unit: "percent", currency: null },
    );
    expect(headline(series).price).toBe("5.00%");
    expect(priceState(series, NOW)).toBe("Latest value, 26 Oct · just now");
    expect(signedChange(10.27)).toEqual({ text: "+10.27%", dir: 1 });
    expect(signedChange(null, { empty: "—" })).toEqual({ text: "—", dir: 0 });
  });

  test("a closed head says when the market opens", () => {
    const closed = { state: "closed" as const, start: null, end: null };
    const state = (opens: string | null | undefined) =>
      priceState(detail({ session: closed, opens }), NOW);
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(state(at(2 * 3_600_000 + 3 * 60_000))).toBe(
      "Closed · opens in 2h 3m",
    );
    expect(state(at(2 * 3_600_000))).toBe("Closed · opens in 2h");
    expect(state(at(45 * 60_000))).toBe("Closed · opens in 45m");
    // rounded up, so the last minute still counts down
    expect(state(at(1_000))).toBe("Closed · opens in 1m");
    expect(state(at(59 * 60_000 + 1_000))).toBe("Closed · opens in 1h");
    expect(state(at(12 * 3_600_000 - 1))).toBe("Closed · opens in 12h");
    // from 12 hours out, the viewer's clock time
    const far = at(12 * 3_600_000);
    const clock = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(far));
    expect(state(far)).toBe(`Closed · opens ${clock}`);
    for (const past of [at(0), at(-60_000), null, undefined]) {
      expect(state(past)).toBe("Closed");
    }
  });

  test("after hours stands beside the close, said with its time", () => {
    expect(afterHours(detail())).toBeNull();
    const after = afterHours(
      detail({
        extended: {
          session: "post",
          price: 290.14,
          change: -34.75,
          change_percent: -10.7,
          time: "2026-10-28T22:05:00Z",
        },
      }),
    )!;
    expect(after.value).toBe("290.14");
    expect(after.change).toEqual({ text: "−10.70%", dir: -1 });
    expect(after.word).toBe("After hours");
    expect(after.at).toMatch(/^\d\d:\d\d$/);
    const pre = afterHours(
      detail({
        extended: {
          session: "pre",
          price: 220,
          change: 2.76,
          change_percent: 1.27,
          time: "2026-10-29T12:00:00Z",
        },
      }),
    )!;
    expect(pre.word).toBe("Pre-market");
    expect(afterHours(detail({ extended: null }))).toBeNull();
  });

  test("the refetch menu lists what a source holds for it, everything first", () => {
    expect(
      choices(listed("BVB:H2O", { market: "BVB" })).map((c) => c.label),
    ).toEqual(["Everything", "Price", "Daily history"]);
    const share = choices(listed("US:NVDA"));
    expect(share.map((c) => c.label)).toEqual([
      "Everything",
      "Price",
      "Daily history",
      "Key figures",
      "Analyst ratings",
      "Earnings",
      "Insider trades",
      "Next earnings",
      "News",
    ]);
    expect(share[0]).toEqual({
      label: "Everything",
      parts: ["quotes", "bars", "research", "calendar", "news"],
      sections: ["metric", "analysts", "earnings", "insider"],
    });
    expect(
      choices(listed("US:QQQ", { kind: "ETF" })).map((c) => c.label),
    ).toEqual(["Everything", "Price", "Daily history", "News", "Top holdings"]);
    expect(
      choices(listed("XETRA:AAA", { market: "XETRA", kind: "MUTUALFUND" })).map(
        (c) => c.label,
      ),
    ).toEqual(["Everything", "Price", "Daily history", "Top holdings"]);
  });

  test("a refetch reads as one short word, a failure in words", () => {
    const all = choices(listed("US:NVDA"));
    const ok = (part: any, section?: any) => ({
      part,
      section,
      status: "fetched" as const,
      rows: 1,
    });
    expect(summary([ok("quotes")], all, "NVDA")).toEqual({
      text: "Updated",
      bad: false,
    });
    // a part no source holds is no failure
    expect(
      summary(
        [ok("quotes"), { part: "news", status: "not covered" }],
        all,
        "NVDA",
      ),
    ).toEqual({ text: "Updated", bad: false });
    expect(
      summary([{ part: "news", status: "not covered" }], all, "NVDA"),
    ).toEqual({ text: "Not available", bad: false });
    const failed = {
      part: "research" as const,
      section: "insider" as const,
      status: "failed" as const,
      error: "rate limited",
    };
    expect(labelOf(failed, all)).toBe("Insider trades");
    expect(summary([ok("quotes"), failed], all, "NVDA")).toEqual({
      text: "Insider trades failed: too many requests.",
      bad: true,
    });
    expect(
      summary([{ part: "quotes", status: "source off" }], all, "NVDA"),
    ).toEqual({ text: "Its source is off.", bad: true });
    expect(
      summary([{ part: "quotes", status: "not found" }], all, "NVDA").bad,
    ).toBe(true);
  });
});

describe("the instrument page", () => {
  test("the head draws the price and its state, no returns", () => {
    const html = render(<Head detail={detail()} now={NOW} />);
    expect(html).toContain("Stock · US");
    expect(html).toContain('217.24<span class="hero-ccy">USD</span>');
    expect(html).toContain("−0.70");
    expect(html).toContain("−0.32%");
    expect(html).toContain("today");
    expect(html).toContain("Open · just now");
    expect(html).not.toContain("updated");
    for (const gone of ["1 week", "1W", "Year to date", "+16.48%"]) {
      expect(html).not.toContain(gone);
    }
    // one large figure, ever
    expect(html.match(/hero-value/g)?.length).toBe(1);
    expect(html).not.toContain("hero-line");
    const closed = render(
      <Head
        detail={detail({
          session: { state: "closed", start: null, end: null },
        })}
        now={NOW}
      />,
    );
    expect(closed).toContain("· Closed</span>");
    expect(closed).toContain("at close");
  });

  test("after hours is a line under the price, not a second figure", () => {
    const html = render(
      <Head
        detail={detail({
          session: { state: "closed", start: null, end: null },
          extended: {
            session: "post",
            price: 290.14,
            change: -34.75,
            change_percent: -10.7,
            time: "2026-10-28T22:05:00Z",
          },
        })}
        now={NOW}
      />,
    );
    expect(html.match(/hero-value/g)?.length).toBe(1);
    expect(html).toContain('<div class="hero-line">');
    expect(html).toContain("After hours");
    expect(html).toContain("290.14");
    expect(html).toContain("−10.70%");
    expect(html).toContain("at close");
    // open, but no trade since the open: the move is still the last close's
    expect(
      moveLabel(
        detail({
          fetched_at: "2026-10-28T09:00:00Z",
          trade_time: "2026-10-27T16:29:58Z",
        }),
      ),
    ).toBe("at close");
    expect(moveLabel(detail())).toBe("today");
    // a yield moves in percent alone, with no money move
    const y = headline(
      detail(
        { price: 4.2, change: 0.047, unit: "percent", currency: null },
        { id: "FRED:DGS10", unit: "percent", currency: null },
      ),
    );
    expect([y.value, y.currency, y.move.text]).toEqual(["4.20%", null, ""]);
  });

  test("the actions button checks a refetch that fetched and waits while busy", () => {
    const menu = (busy: boolean, done: boolean) =>
      render(
        <InstrumentMenu
          symbol="NVDA"
          admin
          busy={busy}
          done={done}
          removing={false}
          onRefetch={() => {}}
          onDelete={() => {}}
        />,
      );
    const idle = menu(false, false);
    expect(idle).toContain('aria-label="More"');
    expect(idle).not.toContain("disabled");
    expect(idle).not.toContain("status-done");
    const busy = menu(true, false);
    expect(busy).toContain("disabled");
    expect(busy).toContain('aria-label="Fetching"');
    expect(menu(false, true)).toContain("status-done");
  });

  test("an instrument loads by id; an older answer never lands over a newer id", async () => {
    const slow = Promise.withResolvers<Response>();
    const s = store(async (path) =>
      path.endsWith("US%3AOLD") ? slow.promise : Response.json(detail()),
    );
    const old = s.loadInstrument("US:OLD");
    await s.loadInstrument("US:NVDA");
    slow.resolve(Response.json(detail({ id: "US:OLD" })));
    await old;
    expect(s.detailId.value).toBe("US:NVDA");
    expect(s.detail.value?.quote?.id).toBe("US:NVDA");
  });

  test("a reload of the same instrument supersedes a refresh in flight", async () => {
    const tick = Promise.withResolvers<Response>();
    let n = 0;
    const s = store(async () =>
      ++n === 1 ? tick.promise : Response.json(detail({ price: 220 })),
    );
    const refresh = s.loadInstrument("US:NVDA");
    await s.loadInstrument("US:NVDA");
    tick.resolve(Response.json(detail({ price: 210 })));
    await refresh;
    expect(s.detail.value?.quote?.price).toBe(220);
  });

  test("a failed read shows the stored price and says so", () => {
    const unread: Detail = {
      ...detail(),
      instrument: listed("US:NVDA", {
        price: 216.5,
        change_percent: 0.4,
        fetched_at: "2026-10-28T09:00:00Z",
      }),
      quote: null,
      error: {
        code: "source_error",
        detail: "network error; retry this symbol later",
      },
    };
    expect(headline(unread).price).toBe("216.50 USD");
    expect(priceState(unread, NOW)).toBe("Stored price · 3 h ago");
    const html = render(<Head detail={unread} now={NOW} />);
    expect(html).toContain('216.50<span class="hero-ccy">USD</span>');
    expect(html).not.toContain("1 week");
  });

  test("refetch posts the parts, sections only with research", async () => {
    const fetched = { part: "quotes", status: "fetched", rows: 1 };
    const f = fake({
      "POST /api/v1/instruments/US%3ANVDA/refetch": ok({
        input: "US:NVDA",
        id: "US:NVDA",
        parts: [fetched],
      }),
      "GET /api/v1/instruments/US%3ANVDA": ok(detail()),
    });
    const s = store(f.fetch);
    expect(await s.refetch("US:NVDA", ["quotes"], [])).toEqual([
      fetched as any,
    ]);
    await s.refetch("US:NVDA", ["research"], ["insider"]);
    const bodies = f.asked
      .filter((a) => a.init?.method === "POST")
      .map((a) => JSON.parse(String(a.init!.body)));
    expect(bodies).toEqual([
      { parts: ["quotes"] },
      { parts: ["research"], sections: ["insider"] },
    ]);
    // deleted meanwhile, it reads as no longer stored
    const gone = store(
      fake({
        "POST /api/v1/instruments/US%3ANVDA/refetch": problem(404, {
          code: "not_found",
          detail: "no such instrument",
        }),
      }).fetch,
    );
    const results = await gone.refetch("US:NVDA", ["quotes"], []);
    expect(summary(results, choices(listed("US:NVDA")), "NVDA")).toEqual({
      text: "NVDA is no longer stored.",
      bad: true,
    });
  });

  test("a delete a rule holds names the rules; one that goes leaves the list", async () => {
    const held = store(
      fake({
        "DELETE /api/v1/instruments/US%3ANVDA": problem(409, {
          code: "conflict",
          detail: "alerts read this instrument; delete them first",
          input: "US:NVDA",
          rules: [3],
        }),
      }).fetch,
    );
    expect(await held.remove("US:NVDA")).toEqual({ ok: false, rules: [3] });
    const s = store(
      fake({
        [`GET ${screenerPath(MOVES)}`]: ok(
          screenPage([screened("US:NVDA"), screened("US:AMD")]),
        ),
        "DELETE /api/v1/instruments/US%3ANVDA": status(204),
      }).fetch,
    );
    await s.loadScreener();
    expect(await s.remove("US:NVDA")).toEqual({ ok: true });
    expect(s.screener.value?.rows.map((r) => r.id)).toEqual(["US:AMD"]);
  });
});

const agentKey = (name: string, more: Partial<AgentKey> = {}): AgentKey => ({
  id: `${name}-id`,
  name,
  created_at: "2026-10-01T10:00:00Z",
  last_used_at: null,
  expires_at: null,
  ...more,
});

// made up, never a real key
const TOKEN = "1ctx-markets-made-up-token-0123456789abcdefABCDEF012345";

describe("connect agents", () => {
  test("keys load, a made one joins the list without its token, a revoked one leaves", async () => {
    const f = fake({
      [`GET ${KEYS_PATH}`]: ok({ keys: [agentKey("codex")], limit: 5 }),
      [`POST ${KEYS_PATH}`]: () =>
        Response.json(
          { key: agentKey("claude-code"), token: TOKEN },
          { status: 201 },
        ),
      [`DELETE ${KEYS_PATH}/codex-id`]: status(204),
      [`DELETE ${KEYS_PATH}/claude-code-id`]: problem(404, {
        code: "not_found",
        detail: "no such key",
      }),
    });
    const s = store(f.fetch);
    await s.loadKeys();
    expect(s.keys.value?.map((k) => k.name)).toEqual(["codex"]);
    expect(s.keysLimit.value).toBe(5);
    const made = await s.createKey("claude-code", 90);
    expect(made.token).toBe(TOKEN);
    expect(JSON.parse(f.asked.at(-1)!.init!.body as string)).toEqual({
      name: "claude-code",
      expiresInDays: 90,
      portfolio: "none",
      alerts: "none",
      profile: "none",
      analysis: "none",
      trade_plans: "none",
    });
    expect(s.keys.value?.map((k) => k.name)).toEqual(["codex", "claude-code"]);
    expect(JSON.stringify(s.keys.value)).not.toContain(TOKEN);
    expect(await s.revokeKey("codex-id")).toBeNull();
    // one already gone is gone all the same
    expect(await s.revokeKey("claude-code-id")).toBeNull();
    expect(s.keys.value).toEqual([]);
  });

  test("a refused key says why in a few words", async () => {
    const s = store(
      fake({
        [`POST ${KEYS_PATH}`]: problem(409, {
          code: "conflict",
          detail: "name taken",
        }),
        [`DELETE ${KEYS_PATH}/x`]: status(500),
      }).fetch,
    );
    await expect(s.createKey("codex", null)).rejects.toThrow("Name taken.");
    expect(await s.revokeKey("x")).toBe("The server failed.");
  });

  test("a kept key's access changes in place, its refusal said in a few words", async () => {
    const f = fake({
      [`GET ${KEYS_PATH}`]: ok({
        keys: [agentKey("codex"), agentKey("opencode")],
        limit: 5,
      }),
      [`PATCH ${KEYS_PATH}/codex-id`]: ok({
        key: agentKey("codex", { portfolio: "read", alerts: "write" }),
      }),
      [`PATCH ${KEYS_PATH}/gone-id`]: problem(404, {
        code: "not_found",
        detail: "no such key",
      }),
    });
    const s = store(f.fetch);
    await s.loadKeys();
    await s.setKeyAccess("codex-id", {
      portfolio: "read",
      alerts: "write",
      profile: "read",
      analysis: "write",
      trade_plans: "read",
    });
    expect(JSON.parse(f.asked.at(-1)!.init!.body as string)).toEqual({
      portfolio: "read",
      alerts: "write",
      profile: "read",
      analysis: "write",
      trade_plans: "read",
    });
    expect(s.keys.value?.map((k) => [k.name, k.portfolio, k.alerts])).toEqual([
      ["codex", "read", "write"],
      ["opencode", undefined, undefined],
    ]);
    await expect(
      s.setKeyAccess("gone-id", {
        portfolio: "none",
        alerts: "read",
        profile: "none",
        analysis: "none",
        trade_plans: "none",
      }),
    ).rejects.toThrow();
  });

  test("a key says what it opens beyond market data", () => {
    expect(accessWords(agentKey("a"))).toBeNull();
    expect(
      accessWords(agentKey("a", { portfolio: "none", alerts: "none" })),
    ).toBeNull();
    expect(accessWords(agentKey("a", { alerts: "read" }))).toBe("Reads alerts");
    expect(
      accessWords(agentKey("a", { portfolio: "write", alerts: "write" })),
    ).toBe("Writes portfolios · Writes alerts");
    expect(accessWords(agentKey("a", { portfolio: "read" }))).toBe(
      "Reads portfolios",
    );
    expect(
      accessWords(agentKey("a", { alerts: "read", profile: "write" })),
    ).toBe("Reads alerts · Writes the profile");
    expect(accessWords(agentKey("a", { analysis: "read" }))).toBe(
      "Reads analyses",
    );
    expect(
      accessWords(agentKey("a", { analysis: "read", trade_plans: "write" })),
    ).toBe("Reads analyses · Writes trade plans");
  });

  test("New key and a key's details pick each access with the app's own buttons", () => {
    const s = store(fake({}).fetch);
    const made = render(
      <NewKey store={s} shown={signal(null)} onClose={() => {}} />,
    );
    const changed = render(
      <KeyDetails
        store={s}
        row={agentKey("codex", { portfolio: "read", alerts: "write" })}
        now={Date.parse("2026-10-28T12:00:00Z")}
        onDone={() => {}}
      />,
    );
    for (const html of [made, changed]) {
      expect(html).toContain('role="dialog"');
      expect(html).toContain(">Portfolios<");
      expect(html).toContain(">Alerts<");
      expect(html).toContain(">Profile<");
      expect(html).toContain(">Analysis<");
      expect(html).toContain(">Trade plans<");
      expect(html.match(/>Read and write</g)).toHaveLength(5);
      expect(html).not.toContain("<select");
    }
    // the new key never expires unless picked, and reaches neither
    expect(made).toMatch(/aria-pressed="true"[^>]*>Never</);
    expect(made.match(/aria-pressed="true"[^>]*>No access</g)).toHaveLength(5);
    expect(made).toContain(" disabled>Create key<");
    // the kept key's picks start at what it has, Save waiting on a change
    expect(changed.match(/aria-pressed="true"/g)).toHaveLength(5);
    expect(changed).toMatch(/aria-pressed="true"[^>]*>Read</);
    expect(changed).toMatch(/aria-pressed="true"[^>]*>Read and write</);
    expect(changed).toContain(" disabled>Save<");
    // Revoke leads the foot, asking nothing until pressed
    expect(changed).toContain('aria-label="Revoke codex"');
    expect(changed).toMatch(/drawer-foot-start"><button[^>]*>Revoke</);
    expect(changed.indexOf(">Revoke<")).toBeLessThan(changed.indexOf(">Save<"));
    expect(changed).not.toContain("lose access");
    // Save submits the drawer's form from its foot
    const form = changed.match(/<form id="([^"]+)"/)?.[1];
    expect(form).toBeDefined();
    expect(changed).toContain(`type="submit" form="${form}"`);
    // the details say when it was used and when it ends
    expect(changed).toContain("Last used");
    expect(changed).toContain("<dt>Last used</dt><dd>Never</dd>");
    expect(changed).toContain("<dt>Expires</dt><dd><span>Never</span></dd>");
    // the new key's picks are held while it is made
    expect(
      render(
        <Segmented
          label="Expires"
          options={[{ value: "never", text: "Never" }]}
          value="never"
          onPick={() => {}}
          disabled
        />,
      ),
    ).toContain('aria-pressed="true" disabled>Never<');
  });

  test("a name is shaped as typed into what the server takes", () => {
    expect(shapeName("Claude Code")).toBe("claude-code");
    expect(shapeName("-my_agent!")).toBe("my_agent");
    expect(shapeName("x".repeat(90))).toHaveLength(80);
  });

  test("a key reads its last use and expiry in plain words", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    expect(usedWords(agentKey("a"), now)).toBe("Never");
    expect(
      usedWords(agentKey("a", { last_used_at: "2026-10-28T11:55:00Z" }), now),
    ).toBe("5 min ago");
    expect(expiryWords(agentKey("a"), now)).toBe("Never");
    expect(
      expiryWords(agentKey("a", { expires_at: "2026-11-27T12:00:00Z" }), now),
    ).toBe("27 Nov");
    expect(
      expiryWords(agentKey("a", { expires_at: "2027-10-28T12:00:00Z" }), now),
    ).toBe("28 Oct 2027");
    expect(
      expiryWords(agentKey("a", { expires_at: "2026-10-20T12:00:00Z" }), now),
    ).toBe("Expired 20 Oct");
  });

  test("the keys card is a table of keys that open their drawer, its count and New key", async () => {
    const s = store(
      fake({
        [`GET ${KEYS_PATH}`]: ok({
          keys: [
            agentKey("codex", { expires_at: "2020-01-01T00:00:00Z" }),
            agentKey("opencode"),
          ],
          limit: 5,
        }),
      }).fetch,
    );
    await s.loadKeys();
    const html = render(<Keys store={s} shown={signal(null)} />);
    expect(html).toContain(">Keys<");
    expect(html).toContain("2 of 5");
    expect(html).toContain("New key");
    expect(html).toContain("codex");
    expect(html).toContain("opencode");
    expect(html).toContain('<table class="table" aria-label="Keys"');
    // each row opens its key's drawer; none is open yet
    expect(
      html.match(/<button type="button" class="table-open">/g),
    ).toHaveLength(2);
    expect(html).toContain('<span class="table-hidden">codex</span>');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain(">Revoke<");
    expect(html).toContain('<span class="error">Expired 1 Jan 2020</span>');
    expect(html).toContain(">Last used<");
    // no key reaches more than market data, so no Access column
    expect(html).not.toContain(">Access<");
    expect(html).not.toContain("No keys yet.");
    const page = render(<ConnectBody store={s} />);
    expect(page).toContain("Connect agents");
    expect(page).toContain("Setup");
  });

  test("an empty list says so, and a full one names the cap without New key", async () => {
    const empty = store(
      fake({ [`GET ${KEYS_PATH}`]: ok({ keys: [], limit: 5 }) }).fetch,
    );
    await empty.loadKeys();
    expect(render(<Keys store={empty} shown={signal(null)} />)).toContain(
      "No keys yet.",
    );
    const full = store(
      fake({
        [`GET ${KEYS_PATH}`]: ok({
          keys: ["a1", "a2", "a3", "a4", "a5"].map((n) => agentKey(n)),
          limit: 5,
        }),
      }).fetch,
    );
    await full.loadKeys();
    const html = render(<Keys store={full} shown={signal(null)} />);
    expect(html).toContain(capLine(5));
    expect(html).not.toContain("New key");
  });

  test("a made key shows once with its copy and the line that exports it", async () => {
    const s = store(
      fake({ [`GET ${KEYS_PATH}`]: ok({ keys: [], limit: 5 }) }).fetch,
    );
    await s.loadKeys();
    const html = render(<Keys store={s} shown={signal(TOKEN)} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain(SHOWN_ONCE);
    expect(html).toContain(`export ${KEY_ENV}=&quot;${TOKEN}&quot;`);
    expect(html).toContain('aria-label="Copy Key"');
    expect(html).toContain(">Done<");
    expect(html).not.toContain("Create key");
    // beside the card, so the card keeps its padding while it is open
    expect(html.indexOf("</section>")).toBeLessThan(
      html.indexOf("drawer-wrap"),
    );
    expect(render(<ShownKey token={TOKEN} />)).toContain(TOKEN);
    // closing the drawer drops the token with it
    const adding = signal(true);
    const shown = signal<string | null>(TOKEN);
    dropNewKey(adding, shown);
    expect(adding.value).toBe(false);
    expect(shown.value).toBeNull();
    expect(render(<Keys store={s} shown={shown} />)).not.toContain(TOKEN);
    // the page's own draw never holds one
    expect(render(<ConnectBody store={s} />)).not.toContain(TOKEN);
  });

  test("a key row shows its use, expiry and access; a phone keeps name and expiry", async () => {
    const s = store(
      fake({
        [`GET ${KEYS_PATH}`]: ok({
          keys: [
            agentKey("codex", {
              last_used_at: new Date(Date.now() - 3_600_000).toISOString(),
              portfolio: "read",
            }),
          ],
          limit: 5,
        }),
      }).fetch,
    );
    await s.loadKeys();
    const html = render(<Keys store={s} shown={signal(null)} />);
    expect(html).toContain('<span class="faint">1 h ago</span>');
    expect(html).toContain('<span class="faint">Never</span>');
    expect(html).toContain(">Access<");
    expect(html).toContain("Reads portfolios");
    expect(html.match(/table-hide-phone/g)?.length).toBe(4);
    expect(html).not.toContain(">Save<");
  });

  test("each agent's setup adds this server and reads the key from the environment", () => {
    const origin = "https://markets.example";
    for (const { agent } of AGENTS) {
      const line = setupLine(origin, agent);
      expect([agent, line.text]).toEqual([
        agent,
        expect.stringContaining(`${origin}/mcp`),
      ]);
      expect([agent, line.text]).toEqual([
        agent,
        expect.stringContaining(KEY_ENV),
      ]);
      expect(line.text).not.toContain("1ctx-markets-");
    }
    expect(setupLine(origin, "claude").text).toContain(
      `--header 'Authorization: Bearer \${${KEY_ENV}}'`,
    );
    expect(setupLine(origin, "codex").text).toContain(
      `bearer_token_env_var = "${KEY_ENV}"`,
    );
    expect(setupLine(origin, "opencode").text).toContain('"oauth": false');
    const html = render(<Setup origin={origin} />);
    for (const { label } of AGENTS) expect(html).toContain(`>${label}<`);
    expect(html).toContain("claude mcp add");
    expect(html).toContain('<h2 class="card-title">Setup</h2>');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Claude Code</);
    expect(html).not.toContain("<select");
  });
});

const hbar = (
  date: string,
  close: number | null,
  more: Record<string, unknown> = {},
) => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  final: true,
  sma50: null,
  sma200: null,
  ...more,
});

describe("page failures", () => {
  test("a page that did not load names the code, the words and a retry", () => {
    const html = render(
      <Page
        title="Status"
        failed={{ words: "Not found.", status: 404, retry: () => {} }}
      >
        <p>body</p>
      </Page>,
    );
    expect(html).toContain("This page did not load");
    expect(html).toContain("HTTP 404");
    expect(html).toContain("Not found.");
    expect(html).toContain("Try again");
    expect(html).not.toContain("<p>body</p>");
  });

  test("no server answering leaves the code out", () => {
    const html = render(
      <Page
        title="Status"
        failed={{
          words: "The server did not answer.",
          status: null,
          retry: () => {},
        }}
      />,
    );
    expect(html).toContain("The server did not answer.");
    expect(html).not.toContain("HTTP");
  });

  test("only a page with nothing on screen says it did not load", () => {
    const retry = () => {};
    expect(didNotLoad(true, "x", 500, retry)).toBeUndefined();
    expect(didNotLoad(false, null, null, retry)).toBeUndefined();
    expect(didNotLoad(false, "x", 500, retry)).toEqual({
      words: "x",
      status: 500,
      retry,
    });
  });

  test("a failed refresh shows over the body as one line", () => {
    const html = render(
      <Page title="Status" stale="The server failed.">
        <p>body</p>
      </Page>,
    );
    expect(html).toContain("The server failed.");
    expect(html).toContain("<p>body</p>");
    expect(html).not.toContain("This page did not load");
  });

  test("a load keeps its HTTP code until it works, and counts each failure", async () => {
    let fail = true;
    const s = store(async () =>
      fail
        ? Response.json(
            { status: 503, code: "unavailable", detail: "x" },
            { status: 503 },
          )
        : Response.json(screenPage([screened("US:A")])),
    );
    await s.loadScreener();
    expect(s.screenerCode.value).toBe(503);
    expect(s.screenerFailures.value).toBe(1);
    await s.loadScreener();
    expect(s.screenerFailures.value).toBe(2);
    expect(s.detailFailures.value).toBe(0);
    fail = false;
    await s.loadScreener();
    expect(s.screenerError.value).toBeNull();
    expect(s.screenerCode.value).toBeNull();
  });

  test("no answer has no code", async () => {
    const s = store(async () => {
      throw new Error("offline");
    });
    await s.loadScreener();
    expect(s.screenerError.value).toBe("The server did not answer.");
    expect(s.screenerCode.value).toBeNull();
  });

  test("an instrument the server does not hold reads as not found", async () => {
    const s = store(async () =>
      Response.json(
        {
          status: 404,
          code: "not_found",
          detail: "no listing found; try GET /api/v1/symbols",
        },
        { status: 404 },
      ),
    );
    await s.loadInstrument("US:NONE");
    expect(s.detailError.value).toBe("Instrument not found.");
    expect(s.detailCode.value).toBe(404);
  });

  test("a 404 for another reason keeps the server's words", async () => {
    const s = store(async () =>
      Response.json(
        { status: 404, code: "no_data", detail: "source is off" },
        { status: 404 },
      ),
    );
    await s.loadInstrument("US:OFF");
    expect(s.detailError.value).toBe("Source is off.");
  });
});

// every vnode a render makes, so a test can press what it drew
function drawn(view: () => preact.VNode): { html: string; nodes: any[] } {
  const nodes: any[] = [];
  const before = options.vnode;
  options.vnode = (v) => {
    nodes.push(v);
    before?.(v);
  };
  try {
    return { html: render(view()), nodes };
  } finally {
    options.vnode = before;
  }
}

const slotOn = (html: string): string[] =>
  [
    ...html.matchAll(
      /class="bar-slot bar-slot-on"[^>]*>.*?bar-label">([^<]+)/g,
    ),
  ].map((m) => m[1]!);

describe("the phone's bar", () => {
  test("lights the slot of the page on screen", () => {
    expect(barLit("/")).toBe("home");
    expect(barLit("/screener")).toBe("screener");
    expect(barLit("/symbol/US%3AAAPL")).toBe("screener");
    expect(barLit("/portfolios")).toBe("portfolios");
    expect(barLit("/portfolios/5")).toBe("portfolios");
    for (const here of [
      "/profile",
      "/trade-plans",
      "/trade-plans/3",
      "/connect",
      "/admin",
      "/admin/users",
    ]) {
      expect(barLit(here)).toBe("more");
    }
    expect(barLit("/instruments")).toBeNull();
    expect(MORE.map((r) => r.label)).toEqual([
      "Alerts",
      "Trade plans",
      "Profile",
      "Connect agents",
      "Server admin",
    ]);
    for (const [here, label] of [
      ["/", "Home"],
      ["/screener", "Screener"],
      ["/symbol/US%3AAAPL", "Screener"],
      ["/portfolios/5", "Portfolios"],
      ["/admin", "More"],
    ] as const) {
      expect([here, slotOn(render(<Bar here={here} />))]).toEqual([
        here,
        [label],
      ]);
    }
    const home = render(<Bar here="/" />);
    expect(home).toContain(
      'href="/" class="bar-slot bar-slot-on" aria-current="page"',
    );
    expect(home).toContain('href="/screener"');
    expect(home).toContain('href="/portfolios"');
    // a page under its slot is lit but is not that page
    expect(render(<Bar here="/symbol/US%3AAAPL" />)).toContain(
      'href="/screener" class="bar-slot bar-slot-on" aria-current="true"',
    );
  });

  test("Search opens the page's own search, off while the page leaves it out", () => {
    searchShown.value = 0;
    const off = drawn(() => <Bar here="/profile" />);
    const search = (nodes: any[]) =>
      nodes.find((n) => n.type === "button" && n.props[OPENER] !== undefined);
    expect(search(off.nodes).props.disabled).toBe(true);
    searchShown.value = 1;
    try {
      const on = drawn(() => <Bar here="/" />);
      expect(search(on.nodes).props.disabled).toBe(false);
      expect(search(on.nodes).props.onClick).toBe(openSearch);
    } finally {
      searchShown.value = 0;
    }
    // the sheet is the page's search: Home's carries its adds, a page
    // mid-edit has none
    const adds = { sections: [], onAdd: async () => {}, refuse: () => null };
    const home = drawn(() => <Page title="Home" search={adds} />);
    expect(home.nodes.find((n) => n.type === SymbolSearch).props.adds).toBe(
      adds,
    );
    const plain = drawn(() => <Page title="Screener" />);
    expect(
      plain.nodes.find((n) => n.type === SymbolSearch).props.adds,
    ).toBeUndefined();
    const editing = drawn(() => <Page title="Profile" search={false} />);
    expect(editing.nodes.some((n) => n.type === SymbolSearch)).toBe(false);
    // the tap asks the page's search to open, inside the tap
    const was = (globalThis as any).window;
    const target = new EventTarget();
    let asked = 0;
    target.addEventListener("symbol-search-open", () => asked++);
    (globalThis as any).window = target;
    try {
      openSearch();
    } finally {
      (globalThis as any).window = was;
    }
    expect(asked).toBe(1);
  });

  test("the rail and the strip mark Server admin red while something fails", () => {
    markets.signedIn.value = true;
    markets.me.value = ADMIN_ME;
    markets.pulse.value = STATUS;
    try {
      const rail = render(<Rail here="/" onHide={() => {}} />);
      expect(rail).toContain('aria-label="Server admin: something is failing"');
      expect(rail.match(/rail-icon-failed/g)).toHaveLength(1);
      const strip = render(<Strip here="/" />);
      expect(strip).toContain(
        'aria-label="Server admin: something is failing"',
      );
    } finally {
      markets.signedIn.value = undefined;
      markets.me.value = null;
      markets.pulse.value = null;
    }
  });

  test("More carries Server admin's red mark while something fails", () => {
    expect(render(<Bar here="/" />)).not.toContain("rail-icon-failed");
    markets.signedIn.value = true;
    markets.me.value = ADMIN_ME;
    markets.pulse.value = STATUS;
    try {
      const html = render(<Bar here="/" />);
      expect(html).toContain('aria-label="More: something is failing"');
      expect(html).toContain('class="rail-icon-failed"');
    } finally {
      markets.signedIn.value = undefined;
      markets.me.value = null;
      markets.pulse.value = null;
    }
    // a member reads no status, so nothing is red for them
    markets.signedIn.value = true;
    markets.pulse.value = STATUS;
    try {
      expect(render(<Bar here="/" />)).not.toContain("rail-icon-failed");
    } finally {
      markets.signedIn.value = undefined;
      markets.pulse.value = null;
    }
  });

  test("hides for a text field, never for a button or a switch", () => {
    const el = (tagName: string, type?: string, editable = false) => ({
      tagName,
      isContentEditable: editable,
      getAttribute: (n: string) => (n === "type" ? (type ?? null) : null),
    });
    for (const f of [
      el("INPUT"),
      el("INPUT", "text"),
      el("INPUT", "search"),
      el("INPUT", "NUMBER"),
      el("INPUT", "date"),
      el("TEXTAREA"),
      el("DIV", undefined, true),
    ]) {
      expect(isTextField(f as any)).toBe(true);
    }
    for (const f of [
      el("INPUT", "checkbox"),
      el("INPUT", "radio"),
      el("INPUT", "file"),
      el("BUTTON"),
      el("A"),
      null,
    ]) {
      expect(isTextField(f as any)).toBe(false);
    }
  });

  test("comes back once the focused field leaves the page, with no focusout", async () => {
    const field = {
      tagName: "INPUT",
      isContentEditable: false,
      isConnected: true,
      getAttribute: () => "search",
    };
    const body = {
      tagName: "BODY",
      isConnected: true,
      getAttribute: () => null,
    };
    const doc = Object.assign(new EventTarget(), {
      activeElement: body as any,
      body: {} as Node,
    });
    const view = new EventTarget();
    let changed: (() => void) | null = null;
    let watching = 0;
    class Tree {
      constructor(fn: () => void) {
        changed = fn;
      }
      observe() {
        watching++;
      }
      disconnect() {
        watching--;
      }
    }
    const seen: boolean[] = [];
    const inBar = { ...field };
    const bar = { contains: (n: unknown) => n === inBar } as any;
    const w = watchTyping(
      { doc: doc as any, view: view as any, Observer: Tree as any },
      () => bar,
      (t) => seen.push(t),
    );
    doc.activeElement = field;
    doc.dispatchEvent(new Event("focusin"));
    expect(seen).toEqual([true]);
    expect(watching).toBe(1);
    // the drawer or the sheet holding it closes: WebKit says nothing
    field.isConnected = false;
    changed!();
    expect(seen).toEqual([true, false]);
    expect(watching).toBe(0);
    // a field the keyboard leaves, seen once the focus has moved
    field.isConnected = true;
    doc.dispatchEvent(new Event("focusin"));
    doc.activeElement = body;
    doc.dispatchEvent(new Event("focusout"));
    expect(seen).toEqual([true, false, true]);
    await Promise.resolve();
    expect(seen).toEqual([true, false, true, false]);
    // the keyboard going resizes the visual viewport
    doc.activeElement = field;
    w.check();
    field.isConnected = false;
    view.dispatchEvent(new Event("resize"));
    expect(seen).toEqual([true, false, true, false, true, false]);
    // a field inside the bar never sends it away
    expect(typingIn(inBar as any, bar)).toBe(false);
    expect(typingIn({ ...field, isConnected: true } as any, bar)).toBe(true);
    w.stop();
  });

  test("More closes on any step to another address, Back included", () => {
    const stop = watchMore();
    const was = path.value;
    try {
      moreOpen.value = true;
      path.value = "/admin";
      expect(moreOpen.value).toBe(false);
      moreOpen.value = true;
      visits.value++;
      expect(moreOpen.value).toBe(false);
    } finally {
      stop();
      path.value = was;
    }
  });

  test("the phone check, not the width, makes the search a sheet", () => {
    expect(render(<SymbolSearch />)).not.toContain("ssearch-phone");
    onPhone.value = true;
    try {
      expect(render(<SymbolSearch />)).toContain(
        'class="ssearch ssearch-phone"',
      );
    } finally {
      onPhone.value = false;
    }
  });

  test("a phone's shell is the view and the bar, no rail, strip or menu button", () => {
    onPhone.value = true;
    try {
      const html = render(
        <Shell here="/">
          <p>view</p>
        </Shell>,
      );
      expect(html).toContain('class="shell-main shell-main-bar"');
      expect(html).toContain('class="bar"');
      expect(html).not.toContain("rail");
      expect(html).not.toContain("strip");
      expect(html).not.toContain("Show the menu");
    } finally {
      onPhone.value = false;
    }
    const wide = render(
      <Shell here="/">
        <p>view</p>
      </Shell>,
    );
    expect(wide).toContain('class="rail"');
    expect(wide).not.toContain('class="bar');
  });
});

describe("More's drawer", () => {
  test("lists the pages, Recent, the person, the theme and Sign out; a tap closes it", () => {
    recent.value = [{ id: "US:AMD", name: "Advanced Micro Devices, Inc." }];
    markets.me.value = ADMIN_ME;
    try {
      const { nodes } = drawn(() => (
        <More here="/connect" failing={false} onClose={() => {}} />
      ));
      const drawer = nodes.find((n) => n.type === Drawer);
      expect(drawer.props.title).toBe("More");
      let closed = 0;
      const close = () => closed++;
      const body = drawn(() => drawer.props.children(close));
      const words = [
        ...body.html.matchAll(
          /<span>([^<]+)<\/span>|class="rail-label">([^<]+)|sym-ticker">([^<]+)|menu-head"><span class="cut">([^<]+)/g,
        ),
      ].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
      expect(words).toEqual([
        "Alerts",
        "Trade plans",
        "Profile",
        "Connect agents",
        "Server admin",
        "Recent",
        "AMD",
        "Casey",
        "Dark theme",
        "Hide amounts",
        "Sign out",
      ]);
      expect(body.html).toContain(
        'href="/connect" class="rail-item rail-item-on" aria-current="page"',
      );
      expect(body.html).toContain('href="/symbol/US%3AAMD"');
      const links = body.nodes.filter((n) => n.type === "a");
      expect(links).toHaveLength(6);
      for (const a of links) a.props.onClick();
      expect(closed).toBe(6);
      // the user menu's own items, closing once signed out
      expect(
        body.nodes.find((n) => n.type === UserItems).props.onSignedOut,
      ).toBe(close);
    } finally {
      recent.value = [];
      markets.me.value = null;
    }
  });

  test("lists each person sharing with the reader above Recent, none without", () => {
    recent.value = [{ id: "US:AMD", name: "Advanced Micro Devices, Inc." }];
    markets.me.value = ADMIN_ME;
    const more = (here: string) => {
      const { nodes } = drawn(() => (
        <More here={here} failing={false} onClose={() => {}} />
      ));
      const drawer = nodes.find((n) => n.type === Drawer);
      return render(drawer.props.children(() => {}));
    };
    const rail = (here: string) =>
      render(<Rail here={here} onHide={() => {}} />);
    try {
      for (const html of [more("/"), rail("/")]) {
        expect(html).not.toContain("Shared with me");
        expect(html).not.toContain("/portfolios/shared/");
      }
      markets.sharing.value = {
        people: [],
        sharers: [
          { id: "ana", name: "Ana" },
          { id: "bea", name: "Bea" },
        ],
      };
      for (const draw of [more, rail]) {
        const html = draw("/portfolios/shared/ana/2");
        expect(html.indexOf("Shared with me")).toBeLessThan(
          html.indexOf("Recent"),
        );
        expect(html).toContain("Ana's portfolios");
        expect(html).toContain("Bea's portfolios");
        expect(html).toContain(
          'href="/portfolios/shared/ana" class="rail-item rail-item-on"',
        );
        expect(html).toContain(
          'href="/portfolios/shared/bea" class="rail-item"',
        );
      }
      // another's page lights no page of the reader's own
      expect(rail("/portfolios/shared/ana")).toContain(
        'href="/portfolios" class="rail-item"',
      );
    } finally {
      recent.value = [];
      markets.me.value = null;
      markets.sharing.value = null;
    }
  });

  test("a member's More leaves out Server admin", () => {
    markets.me.value = { ...ADMIN_ME, id: "ana", name: "Ana", role: "member" };
    try {
      const { nodes } = drawn(() => (
        <More here="/" failing={false} onClose={() => {}} />
      ));
      const drawer = nodes.find((n) => n.type === Drawer);
      const html = render(drawer.props.children(() => {}));
      expect(html).toContain('href="/connect"');
      expect(html).not.toContain('href="/admin"');
      expect(html).toContain("Ana");
    } finally {
      markets.me.value = null;
    }
  });

  test("Server admin is red while something fails", () => {
    const { nodes } = drawn(() => <More here="/" failing onClose={() => {}} />);
    const drawer = nodes.find((n) => n.type === Drawer);
    const html = asAdmin(() => render(drawer.props.children(() => {})));
    expect(html).toContain('aria-label="Server admin: something is failing"');
    expect(html.match(/rail-icon-failed/g)).toHaveLength(1);
  });
});

describe("Back", () => {
  test("steps back inside the app, else goes to the page's address", () => {
    expect(stepOf(null)).toBe(0);
    expect(stepOf({ step: 3 })).toBe(3);
    expect(stepOf({ other: 1 })).toBe(0);
    // reached by a step inside the app
    expect(backFrom({ step: 2 }, 1)).toBe("history");
    // the tab's first page, a reload or a pasted address
    expect(backFrom(null, 0)).toBe("address");
    expect(backFrom({ step: 3 }, 3)).toBe("address");
    // back past a reload, to an entry from before it
    expect(backFrom({ step: 1 }, 3)).toBe("address");

    const g = globalThis as any;
    const was = { history: g.history, location: g.location, path: path.value };
    const backs: number[] = [];
    const pushed: [unknown, string][] = [];
    const tab = (state: unknown) => {
      g.location = {
        origin: "http://markets.test",
        pathname: "/symbol/US%3AAAPL",
        search: "",
      };
      g.history = {
        state,
        back: () => backs.push(1),
        pushState: (s: unknown, _: string, to: string) => pushed.push([s, to]),
        replaceState: () => {},
      };
    };
    try {
      tab({ step: 1 });
      goBack("/screener");
      expect(backs).toHaveLength(1);
      expect(pushed).toEqual([]);
      tab(null);
      goBack("/screener");
      expect(backs).toHaveLength(1);
      expect(pushed).toEqual([[{ step: 1 }, "/screener"]]);
      expect(path.value).toBe("/screener");
    } finally {
      g.history = was.history;
      g.location = was.location;
      path.value = was.path;
    }
  });

  test("shows on a phone's page that asks for it, before the title", () => {
    expect(render(<Page title="AAPL" back="/screener" />)).not.toContain(
      "page-back",
    );
    onPhone.value = true;
    try {
      const html = render(<Page title="AAPL" back="/screener" />);
      expect(html).toMatch(
        /<div class="page-head"><button type="button" class="btn-icon page-back" aria-label="Back">[\s\S]*<h1[^>]*>AAPL<\/h1>/,
      );
      expect(render(<Page title="Portfolios" />)).not.toContain("page-back");
    } finally {
      onPhone.value = false;
    }
  });
});

describe("the chart model", () => {
  test("a phone has no toolbar and draws edge to edge; a wider window keeps Log", () => {
    // no storage in tests, so the chart opens on its default, 1D
    try {
      onPhone.value = true;
      const phone = render(<Chart id="US:AAPL" intraday />);
      expect(phone).not.toContain("chart-tools");
      expect(phone).toContain("chart-phone");
      onPhone.value = false;
      const desk = render(<Chart id="US:AAPL" intraday />);
      expect(desk).toContain(">Log</button>");
      expect(desk).not.toContain("chart-phone");
    } finally {
      onPhone.value = false;
    }
  });

  test("a range asks from its first day, weekly past two years", () => {
    expect(fromOf("1M", "2026-10-28")).toBe("2026-09-28");
    expect(fromOf("YTD", "2026-10-28")).toBe("2026-01-01");
    expect(fromOf("Max", "2026-10-28")).toBe("2016-10-28");
    // a shorter month takes its last day, never rolls into the next
    expect(fromOf("1M", "2026-03-31")).toBe("2026-02-28");
    expect(fromOf("3M", "2026-05-31")).toBe("2026-02-28");
    expect(fromOf("1Y", "2028-02-29")).toBe("2027-02-28");
    expect(fromOf("1M", "2026-01-15")).toBe("2025-12-15");
    expect(intervalOf("1Y")).toBe("1d");
    expect(intervalOf("3Y")).toBe("1wk");
    expect(intervalOf("Max")).toBe("1wk");
  });

  test("a bar with no open borrows the last close; a series is a line", () => {
    const bars = [
      hbar("2026-10-27", 100),
      hbar("2026-10-28", 103, {
        open: null,
        high: null,
        low: null,
        final: false,
      }),
    ];
    expect(candles(bars).at(-1)).toEqual({
      time: "2026-10-28",
      open: 100,
      high: 103,
      low: 100,
      close: 103,
    });
    const series = [
      hbar("2026-10-26", 5, {
        open: null,
        high: null,
        low: null,
        volume: null,
      }),
    ];
    expect(hasCandles(series)).toBe(false);
    expect(hasVolume(series)).toBe(false);
    expect(
      volumes([hbar("2026-10-27", 100), hbar("2026-10-28", 99)]).map(
        (v) => v.up,
      ),
    ).toEqual([true, false]);
  });

  test("the legend reads the bar under the crosshair, else the latest", () => {
    const h: History = {
      instrument: { id: "US:NVDA", unit: "per_share" },
      interval: "1d",
      session: { state: "open" },
      bars: [
        hbar("2026-10-27", 100, { sma50: 90, sma200: 80 }),
        hbar("2026-10-28", 110, { final: false, sma50: null, sma200: null }),
      ],
    };
    const latest = legendOf(h, null)!;
    expect(latest).toMatchObject({
      date: "2026-10-28",
      live: true,
      close: 110,
      change: 10,
    });
    // a bar with no average yet keeps the last at rest
    expect(latest.sma50).toBe(90);
    const hovered = legendOf(h, "2026-10-27")!;
    expect(hovered).toMatchObject({ live: false, change: 0, sma50: 90 });
    expect(legendOf({ ...h, session: { state: "closed" } }, null)!.live).toBe(
      false,
    );
    // a yield moves in points
    const y = legendOf(
      { ...h, instrument: { ...h.instrument, unit: "percent" } },
      null,
    )!;
    expect(signedChange(y.change, { points: y.points }).text).toBe(
      "+10.00 pts",
    );
    expect(signedChange(-0.001).text).toBe("0.00%");
  });

  test("a price on the axis has separators, and no cents past five figures", () => {
    expect(axisPrice(120000)).toBe("120,000");
    expect(axisPrice(80684.99)).toBe("80,685");
    expect(axisPrice(1661.62)).toBe("1,661.62");
    expect(axisPrice(5)).toBe("5.00");
  });

  test("a scale number under a price tag is left blank", () => {
    // 30 px per unit, the top at 100
    const y = (p: number) => (100 - p) * 30;
    expect(clearOfTags([99, 98, 97, 96], [97.9], y)).toEqual([
      "99.00",
      "",
      "97.00",
      "96.00",
    ]);
    expect(clearOfTags([99, 98], [], y)).toEqual(["99.00", "98.00"]);
    expect(clearOfTags([99], [99], () => null)).toEqual(["99.00"]);
  });

  test("the axis says a month or a day with its month, never a bare day", () => {
    expect(tick("2026-09-01", "month")).toBe("Sep");
    expect(tick("2026-10-05", "day")).toBe("5 Oct");
    expect(tick("2026-01-02", "year")).toBe("2026");
  });

  test("1D and 5D draw the 5-minute closes in order, labelled on the viewer's clock", () => {
    expect(RANGES.slice(0, 3)).toEqual(["1D", "5D", "1M"]);
    expect(isIntraday("5D")).toBe(true);
    expect(isIntraday("1M")).toBe(false);
    // Bucharest falls back at 01:00 UTC on 25 October: 03:00 to 04:00 twice
    const zone = "Europe/Bucharest";
    const from = Date.parse("2026-10-25T00:00:00Z");
    const points = Array.from({ length: 31 }, (_, k) => ({
      at: new Date(from + k * 300_000).toISOString().replace(".000", ""),
      session: "2026-10-25",
      close: k === 15 ? 90 : 100 + k,
      final: k < 30,
    }));
    const h: Intraday = {
      instrument: { id: "CRYPTO:BTC-USD", unit: "per_unit" },
      interval: "5m",
      session: { state: "open" },
      previous_close: null,
      points,
    };
    const line = pointLine(h.points);
    expect(line).toHaveLength(31);
    expect(line.every((p, k) => k === 0 || p.time > line[k - 1]!.time)).toBe(
      true,
    );
    expect(line[15]).toEqual({ time: from / 1000 + 15 * 300, value: 90 });
    const labels = line.map((p) => localTime(p.time, zone).time);
    expect(labels.slice(0, 2)).toEqual(["03:00", "03:05"]);
    expect(labels.filter((t) => t === "03:00")).toHaveLength(2);
    expect(labels.at(-1)).toBe("04:30");
    expect(localTime(line[0]!.time, zone).date).toBe("2026-10-25");
    const latest = pointLegendOf(h, null, zone)!;
    expect(latest).toMatchObject({
      date: "2026-10-25",
      time: "04:30",
      live: true,
      close: 130,
      change: 30,
      open: null,
      sma50: null,
    });
    // a day's move is from the previous close, as the quote's change is
    expect(
      pointLegendOf({ ...h, previous_close: 125 }, null, zone)!.change,
    ).toBeCloseTo(4);
    // a session's empty slots ahead hold no price: the newest stands
    expect(pointLegendOf(h, line.at(-1)!.time + 600, zone)).toMatchObject({
      time: "04:30",
      close: 130,
    });
    // the crosshair's time is the point's own
    const low = pointLegendOf(h, line[15]!.time, zone)!;
    expect(low).toMatchObject({ time: "03:15", close: 90, live: false });
    expect(timeLabel(line[0]!.time, zone)).toBe("25 Oct 2026 03:00");
    // a day reads as the library writes it
    expect(timeLabel("2026-10-05", undefined, "en-US")).toBe("05 Oct '26");
    expect(
      timeLabel({ year: 2026, month: 1, day: 9 }, undefined, "en-US"),
    ).toBe("09 Jan '26");
  });

  test("a day spans its whole session in 5-minute slots", () => {
    const open = {
      state: "open" as const,
      start: "2026-10-29T13:30:00Z",
      end: "2026-10-29T20:00:00Z",
    };
    const at = (hhmm: string) => Date.parse(`2026-10-29T${hhmm}:00Z`) / 1000;
    const slots = sessionSlots([at("13:30"), at("13:35")], open);
    expect(slots[0]).toBe(at("13:40"));
    expect(slots.at(-1)).toBe(at("20:00"));
    expect(slots).toHaveLength(77);
    // a last point between slots starts them at the next one
    expect(sessionSlots([at("13:30"), at("13:37")], open)[0]).toBe(at("13:40"));
    // no points, a closed day ending on its close, or a session that is
    // not the points' own: no slots
    expect(sessionSlots([], open)).toEqual([]);
    expect(sessionSlots([at("13:30"), at("20:00")], open)).toEqual([]);
    expect(
      sessionSlots([at("13:30")], {
        state: "closed",
        start: "2026-10-30T13:30:00Z",
        end: "2026-10-30T20:00:00Z",
      }),
    ).toEqual([]);
    expect(sessionSlots([at("13:30")], null)).toEqual([]);
  });

  test("kept settings fall back field by field", () => {
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(
      readSettings(JSON.stringify({ range: "6M", line: true, log: "yes" })),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      range: "6M",
      line: true,
    });
    // a fresh browser opens on 1D as a line; 1D and 5D are kept like any range
    // a first chart is a plain line, the averages off
    expect(DEFAULT_SETTINGS).toMatchObject({
      range: "1D",
      line: true,
      sma50: false,
      sma200: false,
    });
    expect(readSettings(JSON.stringify({ range: "5D" })).range).toBe("5D");
    expect(readSettings(JSON.stringify({ range: "2D" })).range).toBe("1D");
  });

  test("pre and post trading join the session at its ends, never at the same time", () => {
    const session = [
      { time: 100, value: 10 },
      { time: 200, value: 11 },
    ];
    const outside = [
      { time: 50, value: 9, session: "pre" as const },
      { time: 100, value: 9.5, session: "pre" as const },
      // the closing trade and the first post bar share a minute
      { time: 200, value: 12, session: "post" as const },
      { time: 300, value: 8, session: "post" as const },
    ];
    expect(extendedLines(session, outside)).toEqual({
      pre: [
        { time: 50, value: 9 },
        { time: 100, value: 10 },
      ],
      post: [
        { time: 200, value: 11 },
        { time: 300, value: 8 },
      ],
    });
    expect(extendedLines(session, [])).toEqual({ pre: [], post: [] });
    expect(extendedLines([], outside)).toEqual({ pre: [], post: [] });
  });

  test("the legend under the crosshair reads an extended point too", () => {
    const h: Intraday = {
      instrument: { id: "US:A", unit: "per_share" },
      interval: "5m",
      session: { state: "closed" },
      previous_close: 100,
      points: [
        {
          at: "2026-10-28T19:55:00Z",
          session: "2026-10-28",
          close: 102,
          final: true,
        },
      ],
      extended_points: [
        { at: "2026-10-28T21:00:00Z", session: "post", close: 90 },
      ],
    };
    const t = Date.parse("2026-10-28T21:00:00Z") / 1000;
    expect(pointLegendOf(h, t, "UTC")).toMatchObject({
      close: 90,
      live: false,
      change: -10,
      session: "post",
    });
    // at rest the newest price is the after-hours one
    expect(pointLegendOf(h, null, "UTC")).toMatchObject({
      time: "21:00",
      close: 90,
      session: "post",
    });
    const at = Date.parse("2026-10-28T19:55:00Z") / 1000;
    expect(pointLegendOf(h, at, "UTC")?.session).toBeUndefined();
    const regular = { ...h, extended_points: [] };
    expect(pointLegendOf(regular, null, "UTC")).toMatchObject({ close: 102 });
    expect(pointLegendOf(regular, null, "UTC")?.session).toBeUndefined();
    const label = (legend: ReturnType<typeof pointLegendOf>) =>
      render(
        <LegendLine
          legend={legend!}
          interval="5m"
          range="1D"
          show={{ sma50: false, sma200: false }}
        />,
      );
    expect(label(pointLegendOf(h, null, "UTC"))).toContain("<i>Post</i>");
    expect(label(pointLegendOf(h, null, "UTC"))).not.toContain("<i>C</i>");
    expect(label(pointLegendOf(regular, null, "UTC"))).toContain("<i>C</i>");
    const early = {
      ...h,
      extended_points: [
        { at: "2026-10-28T12:00:00Z", session: "pre" as const, close: 99 },
      ],
    };
    const pre = Date.parse("2026-10-28T12:00:00Z") / 1000;
    expect(label(pointLegendOf(early, pre, "UTC"))).toContain("<i>Pre</i>");
  });

  test("the legend names each average beside its stroke", () => {
    const h: History = {
      instrument: { id: "US:NVDA", unit: "per_share" },
      interval: "1wk",
      session: null,
      bars: [hbar("2026-10-26", 110, { sma50: 90, sma200: 80 })],
    };
    const html = render(
      <LegendLine
        legend={legendOf(h, null)!}
        interval="1wk"
        range="5Y"
        show={{ sma50: true, sma200: false }}
      />,
    );
    expect(html).toContain("50-week average");
    expect(html).not.toContain("200-week average");
    expect(html).toContain("5Y");
  });

  test("a phone's legend is the date, the close and the range's change", () => {
    const h: History = {
      instrument: { id: "US:NVDA", unit: "per_share" },
      interval: "1d",
      session: null,
      bars: [
        hbar("2026-10-26", 100),
        hbar("2026-10-27", 110, { sma50: 90, sma200: 80 }),
      ],
    };
    const html = render(
      <LegendLine
        legend={legendOf(h, null)!}
        interval="1d"
        range="1M"
        show={{ sma50: false, sma200: false, ohlc: false }}
      />,
    );
    expect(html).toContain("<i>C</i>");
    expect(html).toContain("1M");
    for (const gone of ["<i>O</i>", "<i>H</i>", "<i>L</i>", "<i>Vol</i>"])
      expect(html).not.toContain(gone);
    expect(html.match(/chart-legend-row/g)?.length).toBe(1);
  });

  test("a yield's returns are points; a page footer only where one is asked", () => {
    expect(signedChange(-0.15, { points: true }).text).toBe("−0.15 pts");
    expect(render(<Page title="Status" />)).not.toContain("page-foot");
    const foot = render(<Page title="NVDA" foot="Charts by TradingView" />);
    expect(foot).toContain("github.com/stefanprodan/1ctx-markets");
    expect(foot).toContain("Charts by TradingView");
  });

  test("the page's colours are set with no bars, so the chart never paints white first", async () => {
    const l = await import("lightweight-charts");
    const k = {
      card: "#1e1f20",
      page: "#131314",
      fg: "#eeeeee",
      faint: "#8b8b91",
      line: "#2a2b2d",
      up: "#4ade80",
      down: "#f87171",
      sma50: "#aaaaaa",
      sma200: "#bbbbbb",
      buy: "#cccccc",
      font: "mono",
    };
    const o = paintOptions(l, k, false);
    expect(o.layout.background).toEqual({
      type: l.ColorType.Solid,
      color: "#1e1f20",
    });
    expect(o.layout.textColor).toBe("#8b8b91");
    expect(o.layout.fontFamily).toBe("mono");
    expect(o.layout.attributionLogo).toBe(false);
    expect(o.grid.horzLines.color).toBe("rgba(42, 43, 45, 0.7)");
    expect(o.crosshair.vertLine.color).toBe("#8b8b91");
    expect(o.rightPriceScale.mode).toBe(l.PriceScaleMode.Normal);
    expect(paintOptions(l, k, true).rightPriceScale.mode).toBe(
      l.PriceScaleMode.Logarithmic,
    );
    expect(o.rightPriceScale.visible).toBe(true);
    const phone = paintOptions(l, k, false, PHONE);
    expect(phone.layout.background.color).toBe("#131314");
    expect(phone.rightPriceScale.visible).toBe(false);
    expect(phone.grid.horzLines.visible).toBe(false);
  });

  test("a phone's plot names where the range starts, its high and its low", () => {
    expect(levelsOf(100, [100, 104, 98, 101])).toEqual({
      ref: 100,
      high: 104,
      low: 98,
    });
    expect(levelsOf(10, [12, 15], [9, 11])).toEqual({
      ref: 10,
      high: 15,
      low: 9,
    });
    expect(levelsOf(null, [])).toBeNull();
  });

  test("a phone offers one row of ranges, and a wider window's range moves to its neighbour", () => {
    expect(PHONE_RANGES).toEqual([
      "1D",
      "5D",
      "1M",
      "6M",
      "YTD",
      "1Y",
      "5Y",
      "Max",
    ]);
    expect(phoneRange("3M")).toBe("6M");
    expect(phoneRange("3Y")).toBe("5Y");
    expect(phoneRange("1M")).toBe("1M");
    // drawn as its neighbour on a phone, kept as chosen
    expect(drawnRange(PHONE, "3M")).toBe("6M");
    expect(drawnRange(DESK, "3M")).toBe("3M");
    expect(drawnRange(PHONE, "1Y")).toBe("1Y");
    for (const r of PHONE_RANGES) expect(RANGES).toContain(r);
  });

  test("a phone draws the price alone, a wider window everything", () => {
    expect(lookOf(false)).toBe(DESK);
    expect(lookOf(true)).toBe(PHONE);
    expect(PHONE).toEqual({
      phone: true,
      ranges: PHONE_RANGES,
      candles: false,
      averages: false,
      volume: false,
      log: false,
      axis: false,
      ohlc: false,
    });
    expect(DESK.ranges).toBe(RANGES);
    expect([
      DESK.candles,
      DESK.averages,
      DESK.volume,
      DESK.log,
      DESK.axis,
    ]).toEqual([true, true, true, true, true]);
  });
});

describe("the store across sessions and pages", () => {
  // answers held until released, by path
  function held() {
    const waits = new Map<string, ((r: Response) => void)[]>();
    const fetch: Fetch = (path, init) =>
      new Promise<Response>((resolve) => {
        const key = `${init?.method ?? "GET"} ${path}`;
        waits.set(key, [...(waits.get(key) ?? []), resolve]);
      });
    const answer = async (key: string, res: Response) => {
      while (!(waits.get(key)?.length ?? 0)) await Bun.sleep(0);
      waits.get(key)!.shift()!(res);
      await Bun.sleep(0);
    };
    return { fetch, answer };
  }

  test("a status answer from before a sign-out never signs back in", async () => {
    const h = held();
    const s = store(h.fetch);
    const one = `GET ${INSTRUMENTS_PATH}/US%3AA`;
    const status = s.loadStatus();
    const detail = s.loadInstrument("US:A");
    await h.answer(
      one,
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    await detail;
    expect(s.signedIn.value).toBe(false);
    await h.answer(`GET ${STATUS_PATH}`, Response.json(STATUS));
    await status;
    expect(s.signedIn.value).toBe(false);
    expect(s.status.value).toBeNull();
  });

  test("an old call's 401 never signs out a newer sign-in", async () => {
    const h = held();
    const s = store(h.fetch);
    const one = `GET ${INSTRUMENTS_PATH}/US%3AA`;
    const detail = s.loadInstrument("US:A");
    const signing = s.signIn("right");
    await h.answer(`POST ${SESSION_PATH}`, new Response(null, { status: 204 }));
    await h.answer(`GET ${ME_PATH}`, Response.json({ user: ADMIN_ME }));
    await signing;
    await h.answer(
      one,
      Response.json({ error: "unauthorized" }, { status: 401 }),
    );
    await detail;
    expect(s.signedIn.value).toBe(true);
  });

  test("a list read before a delete never brings the row back", async () => {
    const h = held();
    const s = store(h.fetch);
    const list = `GET ${screenerPath(MOVES)}`;
    const both = screenPage([screened("US:A"), screened("US:B")]);
    const first = s.loadScreener();
    await h.answer(list, Response.json(both));
    await first;
    const refreshing = s.loadScreener();
    const removing = s.remove("US:A");
    await h.answer(
      `DELETE ${instrumentPath("US:A")}`,
      new Response(null, { status: 204 }),
    );
    expect(await removing).toEqual({ ok: true });
    // the refresh asked before the delete answers with the row
    await h.answer(list, Response.json(both));
    await refreshing;
    expect(s.screener.value?.rows.map((r) => r.id)).toEqual(["US:B"]);
  });

  test("a refetch that ends on another page never takes that page over", async () => {
    const h = held();
    const s = store(h.fetch);
    const fetching = s.refetch("US:A", ["quotes"], []);
    const b = s.loadInstrument("US:B");
    await h.answer(
      `GET ${INSTRUMENTS_PATH}/US%3AB`,
      Response.json(detail({ id: "US:B" })),
    );
    await b;
    await h.answer(
      `POST ${instrumentPath("US:A")}/refetch`,
      Response.json({ input: "US:A", id: "US:A", parts: [] }),
    );
    await fetching;
    expect(s.detailId.value).toBe("US:B");
    expect(s.detail.value?.quote?.id).toBe("US:B");
  });
});

// the home page's answers, built to the spec's schemas
const homeRow = (id: string, more: Partial<Listed> = {}) => ({
  id,
  name: `${id} name`,
  market: id.split(":")[0]!,
  exchange: id.split(":")[0]!,
  currency: "USD",
  kind: "INDEX",
  unit: "index_points",
  source: "yahoo",
  tracked: true,
  tracked_by: ["world_markets"],
  read_at: null,
  read_until: null,
  price: 100,
  change: 1,
  change_percent: 1,
  fetched_at: "2026-10-28T11:59:00Z",
  ...more,
});
const SESSION = {
  state: "open",
  start: "2026-10-28T13:30:00Z",
  end: "2026-10-28T20:00:00Z",
} as const;
const tracked = (
  value: string,
  id: string,
  more: Partial<Listed> = {},
  intraday = true,
) => ({
  value,
  id,
  state: "tracked",
  instrument: homeRow(id, more),
  session: intraday ? SESSION : null,
  intraday,
});
const SERIES = {
  kind: "SERIES",
  unit: "percent",
  currency: null,
  source: "fred",
  price: 4.1,
  // a series has no day change
  change: null,
  change_percent: null,
} as const;
const HOME_CARDS = {
  attribution: "Source: a series' owner.",
  entries: [
    tracked("^GSPC", "SNP:^GSPC"),
    tracked("GC=F", "CMX:GC=F", { kind: "FUTURE" }),
    tracked("FRED:DGS10", "FRED:DGS10", SERIES, false),
    {
      value: "LATER",
      id: null,
      state: "pending",
      instrument: null,
      session: null,
      intraday: false,
    },
    tracked("^NDX", "NAS:^NDX"),
    {
      value: "TYPO",
      id: null,
      state: "not_found",
      instrument: null,
      session: null,
      intraday: false,
    },
    tracked("BVB:BET", "BVB:BET", { source: "bvb", currency: "RON" }, false),
  ],
};
const at5 = (i: number) =>
  new Date(Date.parse(SESSION.start) + i * 300_000)
    .toISOString()
    .replace(".000Z", "Z");
const dayAnswer = (id: string, closes: number[], previous: number) => ({
  input: id,
  stale: [],
  from: "2026-10-28",
  to: "2026-10-28",
  session: SESSION,
  instrument: {
    id,
    name: `${id} name`,
    exchange: "SNP",
    type: "INDEX",
    currency: "USD",
    unit: "index_points",
    source: "yahoo",
  },
  interval: "5m",
  sessions: [{ session: "2026-10-28", fetched_at: "2026-10-28T14:05:00Z" }],
  previous_close: previous,
  points: closes.map((close, i) => ({
    at: at5(i),
    session: "2026-10-28",
    close,
    final: true,
  })),
});
const monthAnswer = (id: string, closes: number[]) => ({
  input: id,
  stale: [],
  from: "2026-09-28",
  to: "2026-10-28",
  session: null,
  instrument: {
    id,
    name: `${id} name`,
    exchange: "FRED",
    type: "SERIES",
    currency: null,
    unit: "percent",
    source: "fred",
    basis: "observations as published",
  },
  interval: "1d",
  bars: closes.map((c, i) =>
    hbar(`2026-10-${String(i + 1).padStart(2, "0")}`, c, {
      open: null,
      high: null,
      low: null,
      volume: null,
    }),
  ),
});
const barsOf = (id: string, q: string) =>
  `/api/v1/instruments/${encodeURIComponent(id)}/bars?${q}`;
const DAY = "interval=5m";
const MONTH = "from=2026-09-28&interval=1d";

describe("the home page's cards", () => {
  test("the fakes hold to the spec", () => {
    const schemas = spec.components.schemas as Record<string, any>;
    const items = HOME_CARDS.entries.flatMap((e) =>
      e.instrument === null
        ? []
        : [{ ...e, value: undefined, state: undefined, averages: NO_AVERAGES }],
    );
    const cards = { revision: 0, created: false, sections: [] as unknown[] };
    cards.sections.push({ name: "Cards", view: "cards", items });
    expect(
      validate(JSON.parse(JSON.stringify(cards)), schemas.Dashboard, spec),
    ).toEqual([]);
    expect(
      validate(dayAnswer("SNP:^GSPC", [101], 100), schemas.Intraday, spec),
    ).toEqual([]);
    expect(
      validate(monthAnswer("FRED:DGS10", [4, 4.1]), schemas.Bars, spec),
    ).toEqual([]);
    expect(validate(BOARD, schemas.Dashboard, spec)).toEqual([]);
  });

  test("a card has its price, the day's move in its unit and in percent, and its state", () => {
    const [gspc, , dgs10, later, , typo] = HOME_CARDS.entries as CardEntry[];
    expect(cardOf(gspc!)).toMatchObject({
      type: "ready",
      href: "/symbol/SNP%3A%5EGSPC",
      symbol: "^GSPC",
      price: "100.00",
      currency: "USD",
      move: "+1.00 USD",
      percent: "+1.00%",
      dir: 1,
      state: "Open",
    });
    // a yield moves in points
    expect(cardOf(dgs10!)).toMatchObject({
      price: "4.10%",
      currency: null,
      move: "",
      percent: "",
      state: "",
    });
    // a yield's day change, where one is given, is in points
    expect(
      moveOf(homeRow("X:Y", { unit: "percent", change: 0.05 }) as Listed).text,
    ).toBe("+0.05 pts");
    expect(moveOf(homeRow("X:Y", { change: -0.0000001 }) as Listed).dir).toBe(
      0,
    );
    expect(cardOf(later!)).toEqual({ type: "pending", value: "LATER" });
    expect(cardOf(typo!)).toEqual({
      type: "failed",
      value: "TYPO",
      text: "Not found",
    });
  });

  test("a pending value with a stored row shows its stored price; Pending only without one", () => {
    const restarted = {
      ...tracked("^GSPC", "SNP:^GSPC"),
      state: "pending",
    } as CardEntry;
    expect(cardOf(restarted)).toMatchObject({
      type: "ready",
      price: "100.00",
      currency: "USD",
    });
    expect(cardOf(HOME_CARDS.entries[3] as CardEntry)).toEqual({
      type: "pending",
      value: "LATER",
    });
  });

  test("a failed value says so, beside its stored price where it has one", () => {
    const stored = {
      ...tracked("^NDX", "NAS:^NDX"),
      state: "source_error",
    } as CardEntry;
    expect(cardOf(stored)).toEqual({
      type: "failed",
      value: "^NDX",
      text: "Not available",
      href: "/symbol/NAS%3A%5ENDX",
      price: "100.00 USD",
    });
    expect(cardOf({ ...stored, state: "candidates" })).toMatchObject({
      text: "Not found",
    });
    const html = render(<Tile entry={stored} spark={undefined} />);
    expect(html).toContain("Not available");
    expect(html).toContain('href="/symbol/NAS%3A%5ENDX"');
  });

  test("a card leads with the ticker over its name; a coin drops its quote currency", () => {
    const html = render(
      <Tile
        entry={tracked("^NDX", "NAS:^NDX") as CardEntry}
        spark={undefined}
      />,
    );
    expect(html).toMatch(/sym-ticker">\^NDX<\/span><span class="sym-name">/);
    const coin = {
      ...tracked("BTC-USD", "CRYPTO:BTC-USD"),
    } as CardEntry;
    coin.instrument = {
      ...coin.instrument!,
      name: "Bitcoin USD",
      kind: "CRYPTOCURRENCY",
    };
    expect(cardOf(coin)).toMatchObject({ symbol: "BTC", name: "Bitcoin" });
  });

  test("a day line splits at the previous close across its session; a month line starts from its first close", () => {
    // two closes of a session of 78 five-minute steps sit at its start
    const up = sparkOf(dayAnswer("SNP:^GSPC", [101, 103], 100) as Intraday)!;
    expect(up).toEqual({ closes: [101, 103], base: 100, slots: 79 });
    const html = render(
      <Tile
        entry={HOME_CARDS.entries[0] as CardEntry}
        spark={dayAnswer("SNP:^GSPC", [101, 103], 100) as Intraday}
      />,
    );
    expect(html).toMatch(/points="0\.0,[\d.]+ 1\.5,2\.0"/);
    // a session not bracketing the closes spans what it has
    const late = dayAnswer("SNP:^GSPC", [101, 103], 100) as Intraday;
    expect(
      sparkOf({ ...late, session: { ...SESSION, start: at5(1) } }),
    ).toEqual({ closes: [101, 103], base: 100 });
    expect(sparkOf(dayAnswer("SNP:^GSPC", [], 100) as Intraday)).toBeNull();
    expect(
      sparkOf(monthAnswer("FRED:DGS10", [4, 3.9]) as History),
    ).toMatchObject({ base: "start" });
    expect(sparkOf(undefined)).toBeNull();
  });

  test("a card shows the day's percent, not its move; the minute refresh redraws its line", () => {
    const e = HOME_CARDS.entries[0] as CardEntry;
    const draw = (shift: number) =>
      render(
        <Tile
          entry={e}
          spark={dayAnswer("SNP:^GSPC", [101 + shift, 99], 100) as Intraday}
        />,
      );
    const first = draw(0);
    expect(first).not.toContain("+1.00 USD");
    expect(first).toContain("+1.00%");
    expect(first.match(/<polyline/g)).toHaveLength(2);
    expect(draw(1)).not.toEqual(first);
  });

  test("tiles fill a row, one fewer or more when that would leave one alone", () => {
    expect([1, 2, 4, 6, 8].map((n) => tileColumns(n, 4))).toEqual([
      4, 4, 4, 4, 4,
    ]);
    expect(tileColumns(5, 4)).toBe(3);
    expect(tileColumns(9, 4)).toBe(3);
    expect(tileColumns(13, 4)).toBe(5);
    expect(tileColumns(7, 3)).toBe(4);
    // a phone's two to a row, or one when an odd count would strand one
    expect([1, 2, 3, 4, 5].map((n) => tileColumns(n, 2))).toEqual([
      2, 2, 1, 2, 1,
    ]);
  });
});

// the dashboard's answers, built to the spec's schema
const NO_AVERAGES = {
  daily_sma50: null,
  daily_sma200: null,
  weekly_sma200: null,
};
const boardItem = (
  id: string,
  more: Partial<Listed> = {},
  averages: BoardItem["averages"] = NO_AVERAGES,
  intraday = true,
) => ({
  id,
  instrument: homeRow(id, more) as Listed,
  session: intraday ? SESSION : null,
  intraday,
  averages,
});
const BOARD: Board = {
  revision: 3,
  created: true,
  sections: [
    {
      name: "Indices",
      view: "cards",
      items: [
        boardItem("SNP:^GSPC"),
        boardItem(
          "BVB:BET",
          { source: "bvb", currency: "RON" },
          NO_AVERAGES,
          false,
        ),
      ],
    },
    {
      name: "Shares",
      view: "table",
      items: [
        boardItem(
          "US:AAA",
          { kind: "EQUITY", change_percent: 2.5 },
          {
            daily_sma50: { distance_pct: 4.2, crossed_today: true },
            daily_sma200: { distance_pct: -1.5, crossed_today: false },
            weekly_sma200: { distance_pct: 30 },
          },
        ),
      ],
    },
  ],
};
// the S&P while its market is closed and its futures trade
const flipped = (state: "open" | "closed" = "open"): BoardItem => ({
  ...boardItem("SNP:^GSPC"),
  session: { ...SESSION, state: "closed" },
  futures: {
    label: "S&P Futures",
    instrument: homeRow("CME:ES=F", {
      kind: "FUTURE",
      price: 7617.5,
    }) as Listed,
    session: { state, start: null, end: null },
    intraday: true,
  },
});
const itemsOf = (b: Board) =>
  new Map(b.sections.flatMap((s) => s.items.map((i) => [i.id, i] as const)));
const local = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const earningsOf = (ids: string[]) =>
  `${EARNINGS_PATH}?${new URLSearchParams({
    from: local(NOW),
    to: local(NOW + 6 * 86_400_000),
    symbols: ids.join(","),
  })}`;
const EARNING = {
  id: "US:AAA",
  name: "AAA Inc.",
  date: "2026-10-28",
  hour: "amc",
  eps_estimate: 1.234,
  revenue_estimate: 206_300_000_000,
  currency: "USD",
};

describe("the dashboard's model", () => {
  test("movers are the four biggest each way, scaled to the biggest move", () => {
    const pct = [5, -3, 0.001, 2, 1, 0.5, -8, null];
    const items = new Map(
      pct.map((p, i) => [
        `US:S${i}`,
        boardItem(`US:S${i}`, { kind: "EQUITY", change_percent: p }),
      ]),
    );
    const m = moversOf([...items.keys(), "US:GONE"], items);
    expect(m.up.map((r) => r.change_percent)).toEqual([5, 2, 1, 0.5]);
    expect(m.down.map((r) => r.change_percent)).toEqual([-8, -3]);
    expect(m.top).toBe(8);
    expect(moversOf([], items)).toEqual({ up: [], down: [], top: 1 });
    expect(shortName(homeRow("US:A", { name: "Apple Inc." }) as Listed)).toBe(
      "Apple",
    );
    expect(
      shortName(
        homeRow("BVB:R2809A", { kind: "BOND", name: "Fidelis" }) as Listed,
      ),
    ).toBe("R2809A");
  });

  test("the trend lists what is bought, by its gaps, deepest below its 50SMA first", () => {
    const g = (sma50: number | null, crossed = false) => ({
      daily_sma50:
        sma50 === null ? null : { distance_pct: sma50, crossed_today: crossed },
      daily_sma200: { distance_pct: 1, crossed_today: false },
      weekly_sma200: { distance_pct: 2 },
    });
    const items = new Map([
      ["US:A", boardItem("US:A", { kind: "EQUITY" }, g(3))],
      ["US:B", boardItem("US:B", { kind: "ETF" }, g(-4, true))],
      ["US:C", boardItem("US:C", { kind: "CRYPTOCURRENCY" }, g(null))],
      ["X:IDX", boardItem("X:IDX", { kind: "INDEX" }, g(-9))],
      ["US:NONE", boardItem("US:NONE", { kind: "EQUITY" })],
      ["US:NOP", boardItem("US:NOP", { kind: "EQUITY", price: null }, g(1))],
    ]);
    const t = trendsOf([...items.keys()], items);
    expect(t.map((x) => x.id)).toEqual(["US:A", "US:B", "US:C"]);
    expect(t.filter(crossedToday).map((x) => x.id)).toEqual(["US:B"]);
    expect(t[0]!.wma200).toEqual({ gap: 2, crossed: false });
    const sorted = (s: Sort) => [...t].sort(bySort(s)).map((x) => x.id);
    expect(sorted(DEFAULT_SORT)).toEqual(["US:B", "US:A", "US:C"]);
    expect(sorted({ key: "sma50", dir: -1 })).toEqual(["US:A", "US:B", "US:C"]);
    expect(isSort({ key: "sma50", dir: -1 })).toBe(true);
    expect(isSort({ key: "rsi", dir: 1 })).toBe(false);
    expect([
      gapText(0.456),
      gapText(-0.4),
      gapText(12.34),
      gapText(-3),
    ]).toEqual(["+0.46%", "−0.40%", "+12.3%", "−3.0%"]);
  });

  test("earnings read as days, times and short money", () => {
    const rows = earningRows(
      [
        EARNING,
        { ...EARNING, date: "2026-10-29", hour: "bmo", eps_estimate: null },
        { ...EARNING, date: "2026-10-31", hour: "", revenue_estimate: null },
      ],
      "2026-10-28",
    );
    expect(rows.map((r) => [r.day, r.today, r.time, r.eps, r.revenue])).toEqual(
      [
        ["Today", true, "After close", "1.23", "206.3B"],
        ["Tomorrow", false, "Before open", "—", "206.3B"],
        ["Sat 31 Oct", false, "—", "1.23", "—"],
      ],
    );
    expect([money(1.5e12), money(870e6), money(1234)]).toEqual([
      "1.50T",
      "870M",
      "1,234",
    ]);
  });

  test("a layout edit is whole, and one that changes nothing is null", () => {
    const l = layoutOf(BOARD);
    expect(l).toEqual([
      { name: "Indices", view: "cards", ids: ["SNP:^GSPC", "BVB:BET"] },
      { name: "Shares", view: "table", ids: ["US:AAA"] },
    ]);
    expect(addTo([], 0, "US:A")).toEqual([
      { name: "Favourites", view: "cards", ids: ["US:A"] },
    ]);
    expect(addTo(l, 1, "US:B")![1]!.ids).toEqual(["US:AAA", "US:B"]);
    expect(addTo(l, 1, "BVB:BET")).toBeNull();
    const full = [
      {
        name: "A",
        view: "cards" as const,
        ids: Array.from({ length: 100 }, (_, i) => `X:${i}`),
      },
    ];
    expect(addTo(full, 0, "US:B")).toBeNull();
    expect(moveTo(l, 0, "BVB:BET", 0, "SNP:^GSPC")![0]!.ids).toEqual([
      "BVB:BET",
      "SNP:^GSPC",
    ]);
    const moved = moveTo(l, 0, "SNP:^GSPC", 1, null)!;
    expect(moved.map((s) => s.ids)).toEqual([
      ["BVB:BET"],
      ["US:AAA", "SNP:^GSPC"],
    ]);
    expect(moveTo(l, 0, "BVB:BET", 0, "BVB:BET")).toBeNull();
    expect(removeFrom(l, 0, "BVB:BET")[0]!.ids).toEqual(["SNP:^GSPC"]);
    expect(swap(l, 0, 1).map((s) => s.name)).toEqual(["Shares", "Indices"]);
    expect(withView(l, 0, "table")[0]!.view).toBe("table");
    expect(dropSection(l, 0).map((s) => s.name)).toEqual(["Shares"]);
    expect(l[0]!.ids).toEqual(["SNP:^GSPC", "BVB:BET"]);
    expect(addSection(l)!.at(-1)).toEqual({
      name: "Section 3",
      view: "cards",
      ids: [],
    });
    expect(
      addSection([...l, { name: "section 3", view: "cards", ids: [] }])!.at(-1)!
        .name,
    ).toBe("Section 4");
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      name: `S${i}`,
      view: "cards" as const,
      ids: [],
    }));
    expect(addSection(twenty)).toBeNull();
    expect(nameError(l, 0, " ")).toBe("Give it a name.");
    expect(nameError(l, 0, "x".repeat(41))).toBe("At most 40 characters.");
    expect(nameError(l, 0, "shares")).toBe("Another section has this name.");
    expect(nameError(l, 0, "indices")).toBeNull();
    expect(rename(l, 0, " Markets ")![0]!.name).toBe("Markets");
    expect(rename(l, 0, "Indices")).toBeNull();
    expect(rename(l, 0, "Shares")).toBeNull();
    expect(payloadOf(3, l)).toEqual({
      revision: 3,
      sections: [
        { name: "Indices", view: "cards", symbols: ["SNP:^GSPC", "BVB:BET"] },
        { name: "Shares", view: "table", symbols: ["US:AAA"] },
      ],
    });
  });

  test("a table row shows the day's change in percent and in its own unit", () => {
    const l = layoutOf(BOARD);
    const html = render(
      <SectionView
        index={1}
        layout={l}
        editing={false}
        locked={false}
        items={itemsOf(BOARD)}
        sparks={new Map()}
        drag={null}
        setDrag={() => {}}
        save={() => Promise.resolve()}
      />,
    );
    expect(html).toContain('href="/symbol/US%3AAAA"');
    expect(html).toMatch(
      />\+2\.50%<\/span><span class="num up small">\+1\.00 USD</,
    );
    expect(html).not.toContain('draggable="true"');
  });

  test("an edited section drags its rows whole, removes one, and moves only inward", () => {
    const l = layoutOf(BOARD);
    const props = {
      layout: l,
      editing: true,
      locked: false,
      items: itemsOf(BOARD),
      sparks: new Map(),
      drag: null,
      setDrag: () => {},
      save: () => Promise.resolve(),
    };
    const table = render(<SectionView index={1} {...props} />);
    expect(table).toMatch(/<tr draggable="true" class="table-row dash-item"/);
    expect(table).toContain('aria-label="Remove AAA"');
    expect(table).toContain('aria-label="Edit Shares"');
    expect(table).toContain('aria-label="Section name"');
    expect(table).not.toContain("table-open");
    const cards = render(<SectionView index={0} {...props} />);
    expect(cards.match(/draggable="true"/g)).toHaveLength(2);
    expect(cards).toContain('aria-label="Remove ^GSPC"');
    const saved: (BoardSection[] | null)[] = [];
    const save = (n: BoardSection[] | null) => {
      saved.push(n);
      return Promise.resolve();
    };
    const labels = (i: number) => sectionTools(l, i, save).map((t) => t.label);
    expect(labels(0)).toEqual(["Move down", "Delete section"]);
    expect(labels(1)).toEqual(["Move up", "Delete section"]);
    sectionTools(l, 1, save)[0]!.run!();
    expect(saved[0]!.map((x) => x.name)).toEqual(["Shares", "Indices"]);
  });

  test("a drop that changes nothing, or names what a refresh took away, is no edit", () => {
    const l = layoutOf(BOARD);
    expect(moveTo(l, 0, "BVB:BET", 0, null)).toBeNull();
    expect(moveTo(l, 0, "US:AAA", 1, null)).toBeNull();
    expect(moveTo(l, 5, "BVB:BET", 0, null)).toBeNull();
    expect(moveTo(l, 0, "BVB:BET", 5, null)).toBeNull();
  });

  test("an add the server would refuse says why", () => {
    const l = layoutOf(BOARD);
    expect(addRefusal(l, 0, "US:NEW")).toBeNull();
    expect(addRefusal([], 0, "US:NEW")).toBeNull();
    expect(addRefusal(l, 0, "US:AAA")).toBe("Already on your dashboard.");
    expect(addRefusal(l, 7, "US:NEW")).toBe("That section is gone.");
    const full = [
      {
        name: "A",
        view: "cards" as const,
        ids: Array.from({ length: 100 }, (_, i) => `X:${i}`),
      },
    ];
    expect(addRefusal(full, 0, "US:NEW")).toBe("This section is full.");
    const both = [
      ...full,
      { ...full[0]!, name: "B", ids: full[0]!.ids.map((i) => `Y${i}`) },
    ];
    expect(addRefusal(both, 0, "US:NEW")).toBe("Your dashboard is full.");
  });

  test("an edit is a draft apart from the layout; an unchanged one saves nothing", () => {
    const l = layoutOf(BOARD);
    const d = draftOf(l);
    expect(savedDraft(d, l)).toBeNull();
    d[0]!.ids.pop();
    expect(l[0]!.ids).toEqual(["SNP:^GSPC", "BVB:BET"]);
    expect(savedDraft(d, l)).toEqual(d);
  });

  test("Save compares the draft to the layout it was copied from, on its revision", () => {
    const l = layoutOf(BOARD);
    const e = editOf(l, 3);
    expect(saveOf(e)).toBeNull();
    e.draft[0]!.ids.pop();
    expect(e.base[0]!.ids).toEqual(["SNP:^GSPC", "BVB:BET"]);
    expect(saveOf(e)).toEqual({ next: e.draft, revision: 3 });
  });

  test("a save ends only the edit it saved, and keeps it when it failed", () => {
    const l = layoutOf(BOARD);
    const saved = editOf(l, 3);
    const later = editOf(l, 3);
    expect(afterSave(saved, saved, "saved")).toBeNull();
    expect(afterSave(saved, saved, "conflict")).toBeNull();
    expect(afterSave(saved, saved, "failed")).toBe(saved);
    expect(afterSave(later, saved, "saved")).toBe(later);
    expect(afterSave(null, saved, "saved")).toBeNull();
  });

  test("a name left in the field saves, says why it cannot, or does nothing", () => {
    const l = layoutOf(BOARD);
    expect(renameOf(l, 0, " Markets ")).toEqual({
      next: [{ ...l[0]!, name: "Markets" }, l[1]!],
    });
    expect(renameOf(l, 0, "Indices")).toBeNull();
    expect(renameOf(l, 0, "")).toEqual({ error: "Give it a name." });
    expect(renameOf(l, 0, "SHARES")).toEqual({
      error: "Another section has this name.",
    });
  });

  test("while a seed value is still fetched the page waits, with a chip per value", () => {
    const track = [
      { value: "^GSPC", state: "ready" as const },
      { value: "AAPL", state: "pending" as const },
    ];
    expect(waiting(track)).toBe(true);
    expect(waiting([track[0]!])).toBe(false);
    expect(waiting(null)).toBe(false);
    const html = render(<LoadingPanel track={track} />);
    expect(html).toContain("Getting prices");
    expect(html).toContain("1 of 2");
    for (const cls of ["status-done", "dash-seed-pending"]) {
      expect(html.match(new RegExp(`"tag ${cls}"`, "g"))).toHaveLength(1);
    }
    expect(html).toContain('class="spinner dash-seed-spin"');
  });

  test("a flipped index draws its futures under their label, with their line and state", () => {
    const item = flipped();
    const card = cardOf(entryOf("SNP:^GSPC", item));
    expect(card).toMatchObject({
      type: "ready",
      href: "/symbol/CME%3AES%3DF",
      name: "S&P Futures",
      symbol: "ES=F",
      state: "Open",
    });
    const shut = flipped("closed");
    expect(cardOf(entryOf("SNP:^GSPC", shut))).toMatchObject({
      name: "S&P Futures",
      state: "Closed",
    });
    const html = render(
      <SectionView
        index={0}
        layout={[{ name: "Americas", view: "cards", ids: ["SNP:^GSPC"] }]}
        editing={false}
        locked={false}
        items={new Map([["SNP:^GSPC", item]])}
        sparks={
          new Map([["CME:ES=F", dayAnswer("CME:ES=F", [1, 2], 1) as never]])
        }
        drag={null}
        setDrag={() => {}}
        save={async () => {}}
      />,
    );
    expect(html).toContain("S&amp;P Futures");
    expect(html).toContain("ES=F");
    expect(html).not.toContain("dash-tile-pending");
    expect(html).toContain("<polyline");
  });

  test("a card not answered yet draws as pending", () => {
    expect(entryOf("US:NEW", undefined)).toMatchObject({
      value: "NEW",
      state: "pending",
      instrument: null,
    });
    expect(cardOf(entryOf("US:NEW", undefined)).type).toBe("pending");
    const item = itemsOf(BOARD).get("SNP:^GSPC");
    expect(cardOf(entryOf("SNP:^GSPC", item))).toMatchObject({
      type: "ready",
      state: "Open",
    });
  });

  test("the tabs count today's crossings and the week's earnings, hidden at none", () => {
    const items = itemsOf(BOARD);
    const ids = [...items.keys()];
    const html = render(
      <Glance ids={ids} items={items} earnings={[EARNING]} />,
    );
    expect(html).toContain(">Wealth<");
    expect(html).toContain(">Movers<");
    expect(html).not.toContain('class="card');
    expect(html).toContain('role="tablist"');
    expect(html.match(/tab-count/g)).toHaveLength(2);
    const calm = new Map(items);
    calm.set("US:AAA", boardItem("US:AAA", { kind: "EQUITY" }));
    const none = render(<Glance ids={ids} items={calm} earnings={[]} />);
    expect(none.match(/tab-count/g)).toBeNull();
    const off = render(<Glance ids={ids} items={calm} earnings={[]} off />);
    expect(off.match(/tab-count/g)).toBeNull();
    expect(render(<Earnings earnings={[]} off />)).toContain(
      "Earnings are not available.",
    );
    expect(render(<Earnings earnings={[]} off={false} />)).toContain(
      "None of your stocks reports",
    );
    const week = render(<Earnings earnings={[EARNING]} off={false} />);
    expect(week).toContain('href="/symbol/US%3AAAA"');
    expect(week).toMatch(
      /sym-ticker">AAA<\/span><span class="sym-name">AAA Inc\./,
    );
    expect(week).toContain("After close");
  });
});

describe("the dashboard's store", () => {
  test("the store asks the database only with upstream false, and passes the signal", async () => {
    const f = fake({
      "GET /api/v1/symbols?query=aap&upstream=false": ok({ candidates: [] }),
      "GET /api/v1/symbols?query=aap": ok({ candidates: [] }),
    });
    const s = store(f.fetch);
    const abort = new AbortController();
    await s.search("aap", false, abort.signal);
    await s.search("aap");
    expect(f.asked.map((a) => a.path)).toEqual([
      "/api/v1/symbols?query=aap&upstream=false",
      "/api/v1/symbols?query=aap",
    ]);
    expect(f.asked[0]!.init?.signal).toBe(abort.signal);
  });

  // answers held until released, by method and path
  function held() {
    const waits = new Map<string, ((r: Response) => void)[]>();
    const asked: { key: string; body: any }[] = [];
    const fetch: Fetch = (path, init) =>
      new Promise<Response>((resolve) => {
        const key = `${init?.method ?? "GET"} ${path}`;
        asked.push({
          key,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        waits.set(key, [...(waits.get(key) ?? []), resolve]);
      });
    const answer = async (key: string, res: Response) => {
      while (!(waits.get(key)?.length ?? 0)) await Bun.sleep(0);
      waits.get(key)!.shift()!(res);
      await Bun.sleep(0);
    };
    const puts = () => asked.filter((a) => a.key === `PUT ${DASHBOARD_PATH}`);
    return { fetch, answer, asked, puts };
  }

  const PUT = `PUT ${DASHBOARD_PATH}`;
  const lines: Record<string, () => Response> = {
    [`GET ${barsOf("SNP:^GSPC", DAY)}`]: ok(dayAnswer("SNP:^GSPC", [101], 100)),
    [`GET ${barsOf("US:AAA", DAY)}`]: ok(dayAnswer("US:AAA", [101], 100)),
    [`GET ${barsOf("BVB:BET", MONTH)}`]: ok(monthAnswer("BVB:BET", [4, 4.1])),
    [`GET ${earningsOf(["US:AAA"])}`]: ok({ earnings: [EARNING] }),
  };

  test("loads the layout, each card's line and the favourite shares' earnings", async () => {
    const f = fake({ [`GET ${DASHBOARD_PATH}`]: ok(BOARD), ...lines });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/",
    );
    await s.loadDashboard();
    expect(f.asked.map((a) => a.path)).toEqual([
      DASHBOARD_PATH,
      barsOf("SNP:^GSPC", DAY),
      barsOf("BVB:BET", MONTH),
      barsOf("US:AAA", DAY),
      earningsOf(["US:AAA"]),
    ]);
    expect(s.layout.value).toEqual(layoutOf(BOARD));
    expect([...s.items.value.keys()]).toEqual([
      "SNP:^GSPC",
      "BVB:BET",
      "US:AAA",
    ]);
    expect(s.sparks.value.get("BVB:BET")?.interval).toBe("1d");
    expect(s.earnings.value).toEqual([EARNING]);
    // a flipped index asks its futures' line, never its own
    const swapped = {
      ...BOARD,
      sections: [{ ...BOARD.sections[0]!, items: [flipped()] }],
    };
    const g = fake({
      [`GET ${DASHBOARD_PATH}`]: ok(swapped),
      [`GET ${barsOf("CME:ES=F", DAY)}`]: ok(dayAnswer("CME:ES=F", [1], 1)),
    });
    const t = store(
      g.fetch,
      () => NOW,
      () => "/",
    );
    await t.loadDashboard();
    const asked = g.asked.map((a) => a.path);
    expect(asked).toContain(barsOf("CME:ES=F", DAY));
    expect(asked).not.toContain(barsOf("SNP:^GSPC", DAY));
    expect(t.sparks.value.has("CME:ES=F")).toBe(true);
    const off = fake({});
    await store(
      off.fetch,
      () => NOW,
      () => "/admin",
    ).loadDashboard();
    expect(off.asked).toEqual([]);
  });

  test("the World markets seed shows until the first save, which sends revision 0", async () => {
    const seed = { ...BOARD, revision: 0, created: false };
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    const load = s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(seed));
    expect(s.layout.value).toEqual(layoutOf(seed));
    const next = removeFrom(s.layout.value!, 0, "BVB:BET");
    const saving = s.saveLayout(next);
    expect(s.layout.value).toEqual(next);
    const saved = {
      ...seed,
      revision: 1,
      created: true,
      sections: [
        { ...seed.sections[0]!, items: [seed.sections[0]!.items[0]!] },
        seed.sections[1]!,
      ],
    };
    await h.answer(PUT, Response.json(saved));
    await saving;
    expect(h.puts()[0]!.body).toEqual(payloadOf(0, next));
    expect(s.layout.value).toEqual(layoutOf(saved));
    expect(s.saveError.value).toBeNull();
    const again = s.saveLayout(removeFrom(s.layout.value!, 1, "US:AAA"));
    await h.answer(PUT, Response.json({ ...saved, revision: 2 }));
    await again;
    expect(h.puts()[1]!.body.revision).toBe(1);
    void load;
  });

  test("a refused save puts the saved layout back and says why", async () => {
    const cases: [Response, string][] = [
      [
        Response.json(
          { status: 500, code: "internal", detail: "internal error" },
          { status: 500 },
        ),
        "Not saved. The server failed.",
      ],
      [
        Response.json(
          {
            status: 422,
            code: "unresolved",
            detail: "some symbols did not resolve; nothing was saved",
            errors: [
              { input: "ZZZ", error: { code: "not_found", detail: "x" } },
            ],
          },
          { status: 422 },
        ),
        "Could not add ZZZ.",
      ],
    ];
    for (const [res, words] of cases) {
      const h = held();
      const s = store(
        h.fetch,
        () => NOW,
        () => "/",
      );
      void s.loadDashboard();
      await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
      const next = addTo(s.layout.value!, 1, "ZZZ")!;
      const saving = s.saveLayout(next);
      expect(s.layout.value).toEqual(next);
      await h.answer(PUT, res);
      await saving;
      expect(s.layout.value).toEqual(layoutOf(BOARD));
      expect(s.saveError.value).toBe(words);
      const after = s.saveLayout(swap(s.layout.value!, 0, 1));
      expect(s.saveError.value).toBeNull();
      await h.answer(PUT, Response.json(BOARD));
      await after;
      expect(h.puts()[1]!.body.revision).toBe(3);
    }
  });

  test("a save another tab beat takes the stored dashboard and its revision", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const other: Board = {
      ...BOARD,
      revision: 7,
      sections: [BOARD.sections[1]!],
    };
    const saving = s.saveLayout(dropSection(s.layout.value!, 1));
    await h.answer(
      PUT,
      Response.json(
        {
          status: 409,
          code: "conflict",
          detail: "the dashboard changed since that revision",
          dashboard: other,
        },
        { status: 409 },
      ),
    );
    await saving;
    expect(s.layout.value).toEqual(layoutOf(other));
    expect(s.saveError.value).toBe("Changed in another tab. Reloaded.");
    const next = s.saveLayout(withView(s.layout.value!, 0, "cards"));
    await h.answer(PUT, Response.json({ ...other, revision: 8 }));
    await next;
    expect(h.puts()[1]!.body.revision).toBe(7);
  });

  test("edits while a save is in flight go in one more, on the revision it answered", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const l = s.layout.value!;
    const first = s.saveLayout(withView(l, 0, "table"));
    const a = withView(withView(l, 0, "table"), 1, "cards");
    void s.saveLayout(a);
    const b = swap(a, 0, 1);
    const last = s.saveLayout(b);
    expect(s.layout.value).toEqual(b);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    expect(s.layout.value).toEqual(b);
    const saved = {
      ...BOARD,
      revision: 5,
      sections: [
        { ...BOARD.sections[1]!, view: "cards" as const },
        { ...BOARD.sections[0]!, view: "table" as const },
      ],
    };
    await h.answer(PUT, Response.json(saved));
    await Promise.all([first, last]);
    expect(h.puts().map((p) => p.body.revision)).toEqual([3, 4]);
    expect(h.puts()[1]!.body).toEqual(payloadOf(4, b));
    expect(s.layout.value).toEqual(layoutOf(saved));
  });

  test("a load asked before an edit never lands its layout over it", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const tick = s.loadDashboard();
    const next = dropSection(s.layout.value!, 0);
    const saving = s.saveLayout(next);
    await h.answer(
      PUT,
      Response.json({ ...BOARD, revision: 4, sections: [BOARD.sections[1]!] }),
    );
    await saving;
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    void tick;
    await Bun.sleep(0);
    expect(s.layout.value).toEqual(next);
    const again = s.saveLayout(addSection(next)!);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 5 }));
    await again;
    expect(h.puts()[1]!.body.revision).toBe(4);
  });

  test("a load asked during a save but answered after it never lands the older layout", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const next = dropSection(s.layout.value!, 0);
    const saving = s.saveLayout(next);
    void s.loadDashboard();
    const saved = { ...BOARD, revision: 4, sections: [BOARD.sections[1]!] };
    await h.answer(PUT, Response.json(saved));
    await saving;
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    expect(s.layout.value).toEqual(layoutOf(saved));
    const again = s.saveLayout(addSection(s.layout.value!)!);
    await h.answer(PUT, Response.json({ ...saved, revision: 5 }));
    await again;
    expect(h.puts()[1]!.body.revision).toBe(4);
    expect(s.saveError.value).toBeNull();
  });

  test("the seed's values while it was never saved, gone once it is", async () => {
    const track = [
      { value: "^GSPC", state: "ready" as const },
      { value: "AAPL", state: "pending" as const },
    ];
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(
      `GET ${DASHBOARD_PATH}`,
      Response.json({ ...BOARD, revision: 0, created: false, track }),
    );
    expect(s.seeding.value).toEqual(track);
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    expect(s.seeding.value).toBeNull();
  });

  test("more favourite shares than one earnings call takes go in several, merged by date", async () => {
    const n = EARNINGS_SYMBOLS + 20;
    const shares = Array.from({ length: n }, (_, i) => `US:S${i}`);
    const board: Board = {
      revision: 1,
      created: true,
      sections: [
        {
          name: "Shares",
          view: "table",
          items: shares.map((id) => boardItem(id, { kind: "EQUITY" })),
        },
      ],
    };
    const late = { ...EARNING, id: "US:S0", date: "2026-11-02" };
    const soon = { ...EARNING, id: `US:S${n - 1}`, date: "2026-10-29" };
    const first = earningsOf(shares.slice(0, EARNINGS_SYMBOLS));
    const second = earningsOf(shares.slice(EARNINGS_SYMBOLS));
    const asked: string[] = [];
    const s = store(
      async (path) => {
        asked.push(path);
        if (path === DASHBOARD_PATH) return Response.json(board);
        if (path === first) return Response.json({ earnings: [late] });
        if (path === second) return Response.json({ earnings: [soon] });
        return Response.json(dayAnswer("US:S0", [101], 100));
      },
      () => NOW,
      () => "/",
    );
    await s.loadDashboard();
    expect(asked.filter((p) => p.startsWith(EARNINGS_PATH))).toEqual([
      first,
      second,
    ]);
    expect(s.earnings.value).toEqual([soon, late]);
  });

  test("an edit after signing out and back in is saved, whatever the old save did", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    void s.saveLayout(dropSection(s.layout.value!, 0));
    const out = s.signOut();
    await h.answer(
      `DELETE ${SESSION_PATH}`,
      new Response(null, { status: 204 }),
    );
    await out;
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const saving = s.saveLayout(swap(s.layout.value!, 0, 1));
    expect(h.puts()).toHaveLength(2);
    expect(h.puts()[1]!.body.revision).toBe(3);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 9 }));
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    await saving;
    const again = s.saveLayout(addSection(s.layout.value!)!);
    expect(h.puts()).toHaveLength(3);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 5 }));
    await again;
    expect(h.puts()[2]!.body.revision).toBe(4);
  });

  test("Save sends one write with every edit of the draft; Cancel sends nothing", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const l = s.layout.value!;
    let d = (renameOf(draftOf(l), 0, "Markets") as { next: BoardSection[] })
      .next;
    d = swap(d, 0, 1);
    d = withView(d, 0, "cards");
    d = removeFrom(d, 1, "BVB:BET");
    expect(h.puts()).toHaveLength(0);
    expect(s.layout.value).toEqual(l);
    expect(s.layout.value).toEqual(layoutOf(BOARD));
    const saving = s.saveLayout(savedDraft(d, l)!);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    await saving;
    expect(h.puts()).toHaveLength(1);
    expect(h.puts()[0]!.body).toEqual(payloadOf(3, d));
    expect(d.map((x) => x.name)).toEqual(["Shares", "Markets"]);
  });

  test("the earnings window is today and the six days after it", async () => {
    const f = fake({ [`GET ${DASHBOARD_PATH}`]: ok(BOARD), ...lines });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/",
    );
    await s.loadDashboard();
    const asked = new URL(
      f.asked.find((a) => a.path.startsWith(EARNINGS_PATH))!.path,
      "http://x",
    );
    expect(
      Date.parse(asked.searchParams.get("to")!) -
        Date.parse(asked.searchParams.get("from")!),
    ).toBe(6 * 86_400_000);
  });

  test("earnings none could be had are not available, never none reporting", async () => {
    for (const answer of [
      { earnings: [], message: "no earnings source" },
      {
        earnings: [],
        unavailable: [{ input: "US:AAA", id: "US:AAA", message: "x" }],
      },
    ]) {
      const f = fake({
        ...lines,
        [`GET ${DASHBOARD_PATH}`]: ok(BOARD),
        [`GET ${earningsOf(["US:AAA"])}`]: ok(answer),
      });
      const s = store(
        f.fetch,
        () => NOW,
        () => "/",
      );
      await s.loadDashboard();
      expect(s.earningsOff.value).toBe(true);
    }
    const good = store(
      fake({ [`GET ${DASHBOARD_PATH}`]: ok(BOARD), ...lines }).fetch,
      () => NOW,
      () => "/",
    );
    await good.loadDashboard();
    expect(good.earningsOff.value).toBe(false);
  });

  test("a share with no calendar among others answering is a note, not earnings off", async () => {
    const both: Board = {
      ...BOARD,
      sections: [
        BOARD.sections[0]!,
        {
          ...BOARD.sections[1]!,
          items: [
            ...BOARD.sections[1]!.items,
            boardItem(
              "BVB:TLV",
              { kind: "EQUITY", source: "bvb" },
              NO_AVERAGES,
              false,
            ),
          ],
        },
      ],
    };
    const f = fake({
      ...lines,
      [`GET ${DASHBOARD_PATH}`]: ok(both),
      [`GET ${barsOf("BVB:TLV", MONTH)}`]: ok(monthAnswer("BVB:TLV", [1, 2])),
      [`GET ${earningsOf(["US:AAA", "BVB:TLV"])}`]: ok({
        earnings: [],
        unavailable: [{ input: "BVB:TLV", id: "BVB:TLV", message: "x" }],
      }),
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/",
    );
    await s.loadDashboard();
    expect(s.earnings.value).toEqual([]);
    expect(s.earningsOff.value).toBe(false);
  });

  test("an older answer never draws its prices over a newer one", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const priced = (revision: number, price: number): Board => ({
      ...BOARD,
      revision,
      sections: BOARD.sections.map((x) => ({
        ...x,
        items: x.items.map((i) => ({
          ...i,
          instrument: { ...i.instrument, price },
        })),
      })),
    });
    void s.loadDashboard();
    const saving = s.saveLayout(swap(s.layout.value!, 0, 1));
    await h.answer(PUT, Response.json(priced(4, 200)));
    await saving;
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(priced(3, 50)));
    expect(s.items.value.get("US:AAA")!.instrument.price).toBe(200);
    const next = s.saveLayout(swap(s.layout.value!, 0, 1));
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(priced(5, 300)));
    await h.answer(PUT, Response.json(priced(5, 250)));
    await next;
    expect(s.items.value.get("US:AAA")!.instrument.price).toBe(300);
  });

  test("an older earnings answer never lands over a newer one; a removed share's go at once", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const bbb = boardItem("US:BBB", { kind: "EQUITY" });
    const withB: Board = {
      ...BOARD,
      revision: 4,
      sections: [
        BOARD.sections[0]!,
        { ...BOARD.sections[1]!, items: [...BOARD.sections[1]!.items, bbb] },
      ],
    };
    const saving = s.saveLayout(addTo(s.layout.value!, 1, "US:BBB")!);
    await h.answer(PUT, Response.json(withB));
    await saving;
    const newer = { ...EARNING, id: "US:BBB" };
    await h.answer(
      `GET ${earningsOf(["US:AAA", "US:BBB"])}`,
      Response.json({ earnings: [EARNING, newer] }),
    );
    await h.answer(
      `GET ${earningsOf(["US:AAA"])}`,
      Response.json({ earnings: [] }),
    );
    expect(s.earnings.value).toEqual([EARNING, newer]);
    const removing = s.saveLayout(removeFrom(s.layout.value!, 1, "US:BBB"));
    await h.answer(PUT, Response.json({ ...BOARD, revision: 5 }));
    await removing;
    expect(s.earnings.value).toEqual([EARNING]);
  });

  test("the notice follows each save that landed, even when a later one is refused", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    expect(s.attribution.value).toBeNull();
    const l = s.layout.value!;
    const first = s.saveLayout(swap(l, 0, 1));
    void s.saveLayout(withView(swap(l, 0, 1), 0, "cards"));
    await h.answer(
      PUT,
      Response.json({ ...BOARD, revision: 4, attribution: "A notice." }),
    );
    await h.answer(
      PUT,
      Response.json(
        { status: 500, code: "internal", detail: "x" },
        { status: 500 },
      ),
    );
    await first;
    expect(s.saveError.value).toBe("Not saved. The server failed.");
    expect(s.attribution.value).toBe("A notice.");
  });

  test("a save that lands after leaving Home asks for no lines", async () => {
    const h = held();
    let page = "/";
    const s = store(
      h.fetch,
      () => NOW,
      () => page,
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const saving = s.saveLayout(addTo(s.layout.value!, 1, "US:NEW")!);
    page = "/admin";
    const before = h.asked.length;
    const added = {
      ...BOARD.sections[1]!,
      items: [...BOARD.sections[1]!.items, boardItem("US:NEW")],
    };
    await h.answer(
      PUT,
      Response.json({
        ...BOARD,
        revision: 4,
        sections: [BOARD.sections[0]!, added],
      }),
    );
    await saving;
    expect(h.asked.slice(before)).toEqual([]);
  });
  test("a Save made on an older revision is refused, never sent over a newer one", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const e = editOf(s.layout.value!, s.revision());
    const other: Board = {
      ...BOARD,
      revision: 5,
      sections: [
        { ...BOARD.sections[0]!, items: [BOARD.sections[0]!.items[0]!] },
        BOARD.sections[1]!,
      ],
    };
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(other));
    expect(s.layout.value![0]!.ids).toEqual(["SNP:^GSPC"]);
    expect(saveOf(e)).toBeNull();
    e.draft = withView(e.draft, 0, "table");
    const { next, revision } = saveOf(e)!;
    const saving = s.saveLayout(next, revision);
    expect(h.puts()[0]!.body.revision).toBe(3);
    await h.answer(
      PUT,
      Response.json(
        { status: 409, code: "conflict", detail: "x", dashboard: other },
        { status: 409 },
      ),
    );
    expect(await saving).toBe("conflict");
    expect(s.layout.value).toEqual(layoutOf(other));
    expect(s.saveError.value).toBe("Changed in another tab. Reloaded.");
  });

  test("an edit begun while this tab's own save is in flight saves on the revision it answered", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const first = s.saveLayout(withView(s.layout.value!, 0, "table"));
    const e = editOf(s.layout.value!, s.revision());
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    expect(await first).toBe("saved");
    e.draft = swap(e.draft, 0, 1);
    const { next, revision } = saveOf(e)!;
    const saving = s.saveLayout(next, revision);
    expect(h.puts()[1]!.body.revision).toBe(4);
    await h.answer(PUT, Response.json({ ...BOARD, revision: 5 }));
    expect(await saving).toBe("saved");
    void s.saveLayout(withView(s.layout.value!, 0, "cards"));
    expect(h.puts()[2]!.body.revision).toBe(5);
  });

  test("a save that fails says so and leaves the edit to try again", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const e = editOf(s.layout.value!, s.revision());
    e.draft = swap(e.draft, 0, 1);
    const { next, revision } = saveOf(e)!;
    const saving = s.saveLayout(next, revision);
    await h.answer(
      PUT,
      Response.json(
        { status: 422, code: "bad_arguments", detail: "x" },
        { status: 422 },
      ),
    );
    expect(await saving).toBe("failed");
    expect(s.saveError.value).not.toBeNull();
    expect(s.layout.value).toEqual(layoutOf(BOARD));
    const again = s.saveLayout(next, revision);
    expect(h.puts()[1]!.body).toEqual(payloadOf(3, next));
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    expect(await again).toBe("saved");
    expect(s.saveError.value).toBeNull();
  });

  test("an earnings answer asked before a save never brings back a share it removed", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const removing = s.saveLayout(removeFrom(s.layout.value!, 1, "US:AAA"));
    const without: Board = {
      ...BOARD,
      revision: 4,
      sections: [BOARD.sections[0]!, { ...BOARD.sections[1]!, items: [] }],
    };
    await h.answer(PUT, Response.json(without));
    await removing;
    await h.answer(
      `GET ${earningsOf(["US:AAA"])}`,
      Response.json({ earnings: [EARNING] }),
    );
    expect(s.earnings.value).toEqual([]);
  });
  test("a save during the first load keeps the earnings answer it did not change", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    void s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    const saving = s.saveLayout(withView(s.layout.value!, 0, "table"));
    await h.answer(PUT, Response.json({ ...BOARD, revision: 4 }));
    await saving;
    await h.answer(
      `GET ${earningsOf(["US:AAA"])}`,
      Response.json({ earnings: [EARNING] }),
    );
    expect(s.earnings.value).toEqual([EARNING]);
  });
});

describe("Home's pre- and post-market moves", () => {
  const CLOSED = { ...SESSION, state: "closed" } as const;
  const PRE: Extended = {
    session: "pre",
    price: 207.38,
    change: 2.74,
    change_percent: 1.33894,
    time: "2026-10-28T11:23:00Z",
  };
  const closedItem = (id: string) => ({
    ...boardItem(id, { kind: "EQUITY", unit: "currency" }),
    session: CLOSED,
  });
  const SHUT: Board = {
    revision: 1,
    created: true,
    sections: [
      {
        name: "Shares",
        view: "table",
        items: [
          closedItem("US:AAA"),
          closedItem("US:BBB"),
          boardItem("US:OPN"),
        ],
      },
      { name: "Cards", view: "cards", items: [closedItem("US:CCC")] },
    ],
  };
  const props = (extended: ReadonlyMap<string, Extended>, index = 0) => ({
    index,
    layout: layoutOf(SHUT),
    editing: false,
    locked: false,
    items: itemsOf(SHUT),
    sparks: new Map(),
    extended,
    drag: null,
    setDrag: () => {},
    save: () => Promise.resolve(),
  });

  test("a move is a sun or a moon with its percent, titled with its price and time", () => {
    const row = homeRow("US:AAA", { unit: "currency" }) as Listed;
    const pre = extMove(PRE, row, NOW)!;
    expect(pre.session).toBe("pre");
    expect(pre.change).toEqual({ text: "+1.34%", dir: 1 });
    expect(pre.title).toMatch(/^Pre-market 207\.38 USD · \d\d:\d\d$/);
    const post = extMove(
      { ...PRE, session: "post", change_percent: -0.004 },
      row,
      NOW,
    )!;
    expect(post.change).toEqual({ text: "0.00%", dir: 0 });
    expect(post.title).toStartWith("After hours ");
    expect(extMove(undefined, row, NOW)).toBeNull();
    expect(extMove({ ...PRE, price: null }, row, NOW)).toBeNull();
    expect(extMove({ ...PRE, change_percent: null }, row, NOW)).toBeNull();
  });

  test("a move from another day names the day", () => {
    const later = Date.parse(PRE.time) + 3 * 86_400_000;
    const m = extMove(PRE, null, later)!;
    expect(m.title).toMatch(/^Pre-market 207\.38 · [A-Z][a-z]{2} \d\d:\d\d$/);
  });

  test("the Market column shows the move in place of Closed, and a phone puts it after the ticker", () => {
    const html = render(
      <SectionView
        {...props(
          new Map([
            ["US:AAA", PRE],
            ["US:OPN", PRE],
          ]),
        )}
      />,
    );
    const rows = html.split('class="table-row');
    const aaa = rows.find((r) => r.includes("US%3AAAA"))!;
    const bbb = rows.find((r) => r.includes("US%3ABBB"))!;
    const opn = rows.find((r) => r.includes("US%3AOPN"))!;
    expect(aaa.match(/class="dash-sun"/g)).toHaveLength(2);
    expect(aaa).toMatch(
      /<span class="show-phone"><span class="small dash-ext"/,
    );
    expect(aaa).not.toContain(">Closed<");
    expect(aaa).toContain("+1.34%");
    expect(bbb).toContain(">Closed<");
    expect(bbb).not.toContain("dash-ext");
    expect(opn).toContain(">Open<");
    expect(html).not.toContain("dash-moon");
  });

  test("a card shows the move in its corner, a moon after hours", () => {
    const post = { ...PRE, session: "post" as const };
    const html = render(
      <SectionView {...props(new Map([["US:CCC", post]]), 1)} />,
    );
    expect(html).toContain('class="dash-moon"');
    expect(html).not.toContain(">Closed<");
  });

  test("the store asks only for closed listings with a session, after the page's answer", async () => {
    const f = fake({
      [`GET ${DASHBOARD_PATH}`]: ok(SHUT),
      [`GET ${barsOf("US:AAA", DAY)}`]: ok(dayAnswer("US:AAA", [101], 100)),
      [`GET ${barsOf("US:BBB", DAY)}`]: ok(dayAnswer("US:BBB", [101], 100)),
      [`GET ${barsOf("US:OPN", DAY)}`]: ok(dayAnswer("US:OPN", [101], 100)),
      [`GET ${barsOf("US:CCC", DAY)}`]: ok(dayAnswer("US:CCC", [101], 100)),
      [`GET ${earningsOf(["US:AAA", "US:BBB", "US:OPN"])}`]: ok({
        earnings: [],
      }),
      [`GET ${extendedPath(["US:AAA", "US:BBB", "US:CCC"])}`]: ok({
        quotes: [
          { id: "US:AAA", extended: PRE },
          { id: "US:BBB", extended: { ...PRE, price: null } },
          { id: "US:CCC", extended: null },
        ],
      }),
    });
    const s = store(
      f.fetch,
      () => NOW,
      () => "/",
    );
    await s.loadDashboard();
    expect(f.asked.map((a) => a.path)).toContain(
      extendedPath(["US:AAA", "US:BBB", "US:CCC"]),
    );
    expect([...s.extended.value.entries()]).toEqual([["US:AAA", PRE]]);
  });

  test("a long list is asked in batches, and a failed ask leaves no moves", async () => {
    const ids = Array.from(
      { length: EXTENDED_BATCH + 1 },
      (_, i) => `US:S${i}`,
    );
    const many: Board = {
      revision: 1,
      created: true,
      sections: [
        {
          name: "Many",
          view: "cards",
          items: ids.map((id) => ({ ...closedItem(id), intraday: false })),
        },
      ],
    };
    const first = extendedPath(ids.slice(0, EXTENDED_BATCH));
    const second = extendedPath(ids.slice(EXTENDED_BATCH));
    const run = async (fail: boolean) => {
      const asked: string[] = [];
      const s = store(
        async (path) => {
          asked.push(path);
          if (path === DASHBOARD_PATH) return Response.json(many);
          if (path === first || path === second) {
            if (fail && path === second) {
              return Response.json({ title: "failed" }, { status: 503 });
            }
            const batch =
              path === first
                ? ids.slice(0, EXTENDED_BATCH)
                : ids.slice(EXTENDED_BATCH);
            return Response.json({
              quotes: batch.map((id) => ({ id, extended: PRE })),
            });
          }
          return Response.json({ bars: [], earnings: [] });
        },
        () => NOW,
        () => "/",
      );
      await s.loadDashboard();
      return { asked, size: s.extended.value.size };
    };
    const ok = await run(false);
    expect(ok.asked).toContain(first);
    expect(ok.asked).toContain(second);
    expect(ok.size).toBe(EXTENDED_BATCH + 1);
    expect((await run(true)).size).toBe(0);
  });
});
