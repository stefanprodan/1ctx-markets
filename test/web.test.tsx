// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { UI_PATHS } from "../src/server/http.ts";
import { Shell } from "../src/web/app/App.tsx";
import { Rail } from "../src/web/app/Rail.tsx";
import { inApp } from "../src/web/app/router.ts";
import {
  ALIASES,
  HOME,
  lit,
  match,
  RAIL,
  ROUTES,
} from "../src/web/app/routes.ts";
import { Strip } from "../src/web/app/Strip.tsx";
import { resolveTheme } from "../src/web/app/theme.ts";
import {
  ApiError,
  client,
  type Fetch,
  failure,
  says,
} from "../src/web/data/api.ts";
import type { Detail } from "../src/web/data/store.ts";
import {
  INSTRUMENTS_PATH,
  type Listed,
  SESSION_PATH,
  STATUS_PATH,
  type Status,
  store,
} from "../src/web/data/store.ts";
import { Page } from "../src/web/ui/Page.tsx";
import { SettingDelete } from "../src/web/ui/SettingDelete.tsx";
import {
  axisPrice,
  candles,
  changeText,
  DEFAULT_SETTINGS,
  fromOf,
  type History,
  hasCandles,
  hasVolume,
  intervalOf,
  legendOf,
  readSettings,
  tick,
  volumes,
} from "../src/web/views/Chart.model.ts";
import { LegendLine } from "../src/web/views/Chart.tsx";
import {
  choices,
  headline,
  labelOf,
  priceState,
  returnCell,
  summary,
  weekly200,
} from "../src/web/views/Instrument.model.ts";
import { Head, RefetchMenu } from "../src/web/views/Instrument.tsx";
import {
  about,
  bySymbol,
  change,
  matches,
  price,
  symbolOf,
} from "../src/web/views/Instruments.model.ts";
import { InstrumentsList } from "../src/web/views/Instruments.tsx";
import { SignIn } from "../src/web/views/SignIn.tsx";
import {
  ago,
  allOk,
  bytes,
  clockTime,
  groups,
  jobLine,
  jobTone,
  jobWhen,
  plain,
  runTime,
  switchFailure,
  trackFailed,
  trackLine,
} from "../src/web/views/Status.model.ts";
import { JobDetails, StatusBody } from "../src/web/views/Status.tsx";

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
        { scope: "FEED:TLV", error: "no bars", at: "2026-10-28T09:00:01Z" },
        { scope: "FEED:SNP", error: "timeout", at: "2026-10-28T08:00:01Z" },
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
  track: [
    { value: "^GSPC", id: "SNP:^GSPC", state: "tracked" },
    { value: "NOPE", id: null, state: "not_found" },
  ],
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

describe("the routes", () => {
  test("are the paths the server answers with the page", () => {
    const paths = [...Object.keys(ALIASES), ...ROUTES.map((r) => r.path)];
    expect(paths.sort()).toEqual([...UI_PATHS].sort());
    expect(match(HOME)?.route.label).toBe("Status");
    expect(match("/instruments")?.route.label).toBe("Instruments");
    expect(match("/nothing")).toBeNull();
    // an instrument's page takes its id from the path, decoded
    expect(match("/instruments/US%3ANVDA")).toMatchObject({
      route: { label: "Instrument" },
      params: { id: "US:NVDA" },
    });
    expect(match("/instruments/%E0%A4%A")).toBeNull();
    expect(match("/instruments/a/b")).toBeNull();
    // the rail names the pages without a parameter and lights the parent
    expect(RAIL.map((r) => r.label)).toEqual(["Status", "Instruments"]);
    expect(lit("/instruments/US%3ANVDA", "/instruments")).toBe(true);
    expect(lit("/instrumentsx", "/instruments")).toBe(false);
    expect(match(ALIASES["/"]!)).not.toBeNull();
  });

  test("a link opens in place unless it leaves the UI", () => {
    const at = "http://markets.test";
    const link = {
      origin: at,
      pathname: "/status",
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

  test("a failure reads as a short sentence", () => {
    const conflict = failure(409, {
      error: "conflict",
      message: "rules read it",
    });
    expect(says(conflict)).toBe("Rules read it.");
    expect(says(failure(0, null))).toBe("The server did not answer.");
    expect(says("odd")).toBe("The server did not answer.");
  });

  test("a refusal shows the server's message; a fault or no answer, plain words", async () => {
    expect(
      failure(409, { error: "conflict", message: "rules read it" }).message,
    ).toBe("rules read it");
    expect(
      failure(500, { error: "internal", message: "internal error" }).message,
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

  test("the first status says whether the cookie holds", async () => {
    const signed = store(
      fake({ [`GET ${STATUS_PATH}`]: ok(STATUS) }).fetch,
      () => NOW,
    );
    await signed.check();
    expect(signed.signedIn.value).toBe(true);
    expect(signed.status.value).toEqual(STATUS);
    expect(signed.statusAt.value).toBe(NOW);
    const out = store(fake({ [`GET ${STATUS_PATH}`]: status(401, {}) }).fetch);
    await out.check();
    expect(out.signedIn.value).toBe(false);
    expect(out.statusError.value).toBeNull();
    const down = store(fake({ [`GET ${STATUS_PATH}`]: status(502) }).fetch);
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

  test("sign-in posts the key alone; a wrong one keeps the form", async () => {
    let key = "";
    const f = fake({
      [`POST ${SESSION_PATH}`]: () => status(key === "right" ? 204 : 401)(),
      [`GET ${STATUS_PATH}`]: ok(STATUS),
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
    expect(s.status.value).toEqual(STATUS);
    await s.signOut();
    expect(s.signedIn.value).toBe(false);
    expect(f.asked.at(-1)).toMatchObject({
      path: SESSION_PATH,
      init: { method: "DELETE" },
    });
  });

  test("a sign-in the status then refuses says why", async () => {
    for (const [answer, words] of [
      // the browser dropped the cookie: no session ever held
      [status(401, {}), "Not signed in."],
      [status(502), "The server failed."],
    ] as const) {
      const s = store(
        fake({
          [`POST ${SESSION_PATH}`]: status(204),
          [`GET ${STATUS_PATH}`]: answer,
        }).fetch,
      );
      const err = await s.signIn("right").catch((e: unknown) => e);
      expect([words, says(err)]).toEqual([words, words]);
      expect(s.signedIn.value).not.toBe(true);
    }
  });

  test("a sign-in waits for the latest status load", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const s = store(async (_path, init) => {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      const mine = ++n;
      await new Promise<void>((r) => releases.push(r));
      // the load before the sign-in answers a 401, the later ones the status
      return mine === 1
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : Response.json({ ...STATUS, version: `v${mine}` });
    });
    const before = s.loadStatus();
    const signing = s.signIn("right");
    while (releases.length < 2) await Bun.sleep(0);
    // a refresh supersedes the sign-in's own load
    const after = s.loadStatus();
    // the sign-in's load answers first and the refresh last
    releases[1]!();
    await Bun.sleep(0);
    releases[0]!();
    await Bun.sleep(0);
    releases[2]!();
    await Promise.all([before, after]);
    await signing;
    expect(s.signedIn.value).toBe(true);
    expect(s.status.value?.version).toBe("v3");
  });

  test("an old 401 after a sign-in never signs out", async () => {
    const releases: (() => void)[] = [];
    let n = 0;
    const s = store(async (_path, init) => {
      if (init?.method === "POST") return new Response(null, { status: 204 });
      const mine = ++n;
      await new Promise<void>((r) => releases.push(r));
      return mine === 1
        ? Response.json({ error: "unauthorized" }, { status: 401 })
        : Response.json(STATUS);
    });
    const before = s.loadStatus();
    const signing = s.signIn("right");
    while (releases.length < 2) await Bun.sleep(0);
    releases[1]!();
    await signing;
    expect(s.signedIn.value).toBe(true);
    releases[0]!();
    await before;
    expect(s.signedIn.value).toBe(true);
    expect(s.status.value).toEqual(STATUS);
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
  test("the clock is 24-hour", () => {
    expect(clockTime(Date.UTC(2026, 9, 28, 13, 5, 9))).not.toMatch(/AM|PM/i);
  });

  test("sizes, distances and times read as an operator says them", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(65_515_520)).toBe("62 MB");
    expect(bytes(1_500_000)).toBe("1.4 MB");
    expect(ago(null, NOW)).toBe("never");
    expect(ago("2026-10-28T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-28T11:57:00Z", NOW)).toBe("3 min ago");
    expect(ago("2026-10-28T09:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-10-26T12:00:00Z", NOW)).toBe("2 d ago");
    expect(runTime(null)).toBe("never");
    expect(runTime("2026-10-28T13:05:00Z")).not.toMatch(/AM|PM/i);
  });

  test("a source and its jobs read as counts, never a single run", () => {
    // the server's phrases read as plain words
    expect(plain("rate limited")).toBe("too many requests");
    expect(plain("timed out")).toBe("no answer in time");
    expect(plain(null)).toBe("failed");
    expect(STATUS.track.map(trackLine)).toEqual(["SNP:^GSPC", "not found"]);
    expect(trackLine({ value: "X", id: null, state: "candidates" })).toBe(
      "several matches",
    );
    expect(plain("something new")).toBe("something new");
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
    expect(STATUS.track.map(trackLine)).toEqual(["SNP:^GSPC", "not found"]);
    expect(STATUS.track.map(trackFailed)).toEqual([false, true]);
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
            failing: [{ scope: "BVB", error: "timeout", at: null }],
          }
        : j,
    );
    expect(switchFailure(failed)).toBe(
      "Source change for market BVB failed: no answer in time. Its prices stay stale until a retry succeeds.",
    );
  });
});

describe("the views", () => {
  test("status draws the on sources' cards, the keyed ones to add, and the tracked values", () => {
    const html = render(<StatusBody status={STATUS} now={NOW} />);
    for (const words of [
      "78",
      "61 tracked",
      "1 paused",
      "1 failing",
      "1 job",
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
      "Always tracked",
      "SNP:^GSPC",
      "not found",
    ]) {
      expect([words, html.includes(words)]).toEqual([words, true]);
    }
    // a job row that is well says nothing more: the dot does
    expect(html).not.toContain(" ok<");
    // an off source has no card, only its row to add
    expect(html).not.toMatch(/class="label"[^>]*>Casey news</);
    expect(html).not.toContain(">switch<");
    expect(html).toContain('class="srv-mark status-failed"');
    expect(html).not.toContain("rows-meta-bad");
    // the jobs tile counts the jobs shown, not the off source's
    expect(html).toMatch(/Jobs<\/span><span class="srv-figure">3</);
  });

  test("an opened job says what it does, then its failures or that all are ok", () => {
    const [live, daily] = STATUS.jobs;
    const ok = render(<JobDetails job={live!} />);
    expect(ok).toContain("What Live prices does.");
    expect(ok).toContain("All 19 markets ok.");
    expect(ok).not.toContain("srv-failing");
    const bad = render(<JobDetails job={daily!} />);
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
  });

  test("status leaves out what is empty", () => {
    const html = render(
      <StatusBody
        status={{
          ...STATUS,
          sources: STATUS.sources.map((x) => ({ ...x, state: "on" as const })),
          jobs: [],
          track: [],
        }}
        now={NOW}
      />,
    );
    expect(html).toContain("No runs yet");
    expect(html).not.toContain("Add a source");
    expect(html).not.toContain("Always tracked");
    expect(html).not.toContain("notice-failed");
  });

  test("sign-in asks for the admin key alone", () => {
    const html = render(<SignIn store={store(fake({}).fetch)} />);
    expect(html).toContain("Admin key");
    expect(html).toContain('type="password"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain("Markets");
  });

  test("the rail is the logo, Markets, the pages lit where they are, and the menu", () => {
    const html = render(
      <Rail here="/instruments" narrow={false} onHide={() => {}} />,
    );
    expect(html).toContain('aria-label="1ctx"');
    expect(html).toContain('<span class="rail-word">Markets</span>');
    expect(html.indexOf("rail-word")).toBeLessThan(html.indexOf("rail-nav"));
    const lit = [
      ...html.matchAll(/class="rail-item rail-item-on"[^>]*>.*?<span>([^<]+)/g),
    ].map((m) => m[1]);
    expect(lit).toEqual(["Instruments"]);
    expect(html).toContain('href="/status"');
    expect(html).toContain("Hide the menu");
    expect(html).toContain("rail-user-row");
    const drawer = render(<Rail here="/status" narrow onHide={() => {}} />);
    expect(drawer).toContain("rail-drawer");
    expect(drawer).toContain("Close the menu");
  });

  test("the folded rail keeps the pages as icons", () => {
    const html = render(<Strip here="/status" />);
    expect(html).toContain('aria-label="Show the menu"');
    for (const r of RAIL) expect(html).toContain(`aria-label="${r.label}"`);
    expect(html).toContain('class="strip-item strip-item-on"');
  });

  test("the shell puts the rail beside the page", () => {
    const html = render(
      <Shell here="/status">
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

  test("rows sort by symbol, an index's ^ aside, and match the id or name", () => {
    const rows = ["US:NVDA", "DJI:^DJI", "BVB:BET", "XETRA:4GLD"].map((id) =>
      listed(id),
    );
    expect(rows.sort(bySymbol).map((r) => r.id)).toEqual([
      "XETRA:4GLD",
      "BVB:BET",
      "DJI:^DJI",
      "US:NVDA",
    ]);
    expect(matches(listed("US:AAPL", { name: "Apple Inc." }), " apple ")).toBe(
      true,
    );
    expect(matches(listed("US:AAPL"), "us:aa")).toBe(true);
    expect(matches(listed("US:AAPL"), "nvda")).toBe(false);
  });
});

describe("the instruments list", () => {
  test("draws each row with its price and change, filtered by the search", () => {
    const all = [
      listed("US:NVDA", {
        name: "NVIDIA",
        price: 216.885,
        change_percent: -0.48,
      }),
      listed("BVB:H2O", { name: "Hidroelectrica", currency: "RON" }),
    ];
    const html = render(<InstrumentsList all={all} query={signal("")} />);
    expect(html).toContain('placeholder="Search"');
    expect(html.indexOf("H2O")).toBeLessThan(html.indexOf("NVDA"));
    expect(html).toContain('href="/instruments/US%3ANVDA"');
    expect(html).toContain("216.89 USD");
    expect(html).toContain("−0.48%");
    expect(html).toContain('class="rows-count" aria-live="polite">2<');
    const one = render(<InstrumentsList all={all} query={signal("nvidia")} />);
    expect(one).toContain("NVDA");
    expect(one).not.toContain("H2O");
    const none = render(<InstrumentsList all={all} query={signal("zzz")} />);
    expect(none).toContain("No instrument matches.");
    // before the first answer, no count and no rows
    const waiting = render(<InstrumentsList all={null} query={signal("")} />);
    expect(waiting).not.toContain("rows-count");
  });

  test("loads every page, and a second ask joins the load in flight", async () => {
    const first = Promise.withResolvers<Response>();
    const asked: string[] = [];
    const s = store(async (path) => {
      asked.push(path);
      if (path === `${INSTRUMENTS_PATH}?limit=200`) return first.promise;
      return Response.json({
        total: 2,
        more: false,
        instruments: [listed("US:B")],
      });
    });
    const a = s.loadInstruments();
    const b = s.loadInstruments();
    first.resolve(
      Response.json({ total: 2, more: true, instruments: [listed("US:A")] }),
    );
    await Promise.all([a, b]);
    expect(asked).toEqual([
      `${INSTRUMENTS_PATH}?limit=200`,
      `${INSTRUMENTS_PATH}?limit=200&after=US%3AA`,
    ]);
    expect(s.instruments.value?.map((r) => r.id)).toEqual(["US:A", "US:B"]);
  });

  test("a failed refresh keeps the rows and says why", async () => {
    let fail = false;
    const s = store(async () =>
      fail
        ? Response.json({ error: "internal", message: "x" }, { status: 500 })
        : Response.json({
            total: 1,
            more: false,
            instruments: [listed("US:A")],
          }),
    );
    await s.loadInstruments();
    fail = true;
    await s.loadInstruments();
    expect(s.instruments.value?.map((r) => r.id)).toEqual(["US:A"]);
    expect(s.instrumentsError.value).toBe("The server failed.");
  });
});

const detail = (
  more: Partial<Detail["quote"]> = {},
  row: Partial<Listed> = {},
): Detail => ({
  instrument: listed("US:NVDA", { name: "NVIDIA", ...row }),
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
      to: "2026-10-28",
      live: true,
    },
    session: {
      state: "open",
      start: "2026-10-28T13:30:00Z",
      end: "2026-10-28T20:00:00Z",
    },
    ...more,
  },
});

describe("the instrument model", () => {
  test("the head says live or the close, and when it was fetched", () => {
    expect(headline(detail()).price).toBe("217.24 USD");
    expect(priceState(detail(), NOW)).toBe(
      "Live · market open · updated just now",
    );
    expect(
      priceState(
        detail({ session: { state: "closed", start: null, end: null } }),
        NOW,
      ),
    ).toBe("Close · market closed · updated just now");
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
    expect(priceState(series, NOW)).toBe(
      "Latest value, 26 Oct · updated just now",
    );
    expect(returnCell(10.27)).toEqual({ text: "+10.27%", dir: 1 });
    expect(returnCell(null)).toEqual({ text: "—", dir: 0 });
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
    ).toEqual(["Everything", "Price", "Daily history", "News"]);
  });

  test("a refetch reads as one short word, a failure in words", () => {
    const all = choices(listed("US:NVDA"));
    const ok = (part: any, section?: any) => ({
      symbol: "US:NVDA",
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
        [
          ok("quotes"),
          { symbol: "US:NVDA", part: "news", status: "not covered" },
        ],
        all,
        "NVDA",
      ),
    ).toEqual({ text: "Updated", bad: false });
    expect(
      summary(
        [{ symbol: "US:NVDA", part: "news", status: "not covered" }],
        all,
        "NVDA",
      ),
    ).toEqual({ text: "Not available", bad: false });
    const failed = {
      symbol: "US:NVDA",
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
      summary(
        [{ symbol: "US:NVDA", part: "quotes", status: "source off" }],
        all,
        "NVDA",
      ),
    ).toEqual({ text: "Its source is off.", bad: true });
    expect(
      summary([{ symbol: "US:NVDA", status: "not found" }], all, "NVDA").bad,
    ).toBe(true);
  });
});

describe("the instrument page", () => {
  test("the head draws the price, its state and the four returns", () => {
    const html = render(<Head detail={detail()} now={NOW} />);
    expect(html).toContain("Stock · US");
    expect(html).toContain("217.24 USD");
    expect(html).toContain("−0.32%");
    expect(html).toContain("Live · market open");
    for (const label of ["1 week", "1 month", "3 months", "Year to date"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("+16.48%");
    expect(
      render(<Head detail={detail({ returns: null })} now={NOW} />),
    ).not.toContain("1 week");
  });

  test("the refetch button says how it went in the same place", () => {
    const options = choices(listed("US:NVDA"));
    const on = (html: string) =>
      [
        ...html.matchAll(/class="ins-label ins-label-on[^"]*">(.*?)<\/span>/g),
      ].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    const idle = render(
      <RefetchMenu
        options={options}
        busy={false}
        done={null}
        onPick={() => {}}
      />,
    );
    expect(on(idle)).toEqual(["Refetch"]);
    const busy = render(
      <RefetchMenu options={options} busy done={null} onPick={() => {}} />,
    );
    expect(on(busy)).toEqual(["Fetching"]);
    expect(busy).toContain("disabled");
    const done = render(
      <RefetchMenu
        options={options}
        busy={false}
        done="Updated"
        onPick={() => {}}
      />,
    );
    expect(on(done)).toEqual(["Updated"]);
    // every label is drawn, so the button keeps its width
    expect(done).toContain("Not available");
  });

  test("the delete card asks first and says why it was refused", () => {
    const html = render(
      <SettingDelete
        title="Delete NVDA"
        line="Gone."
        ask="Delete NVDA?"
        refused={null}
        busy={false}
        onDelete={() => {}}
      />,
    );
    expect(html).toContain("setting-danger");
    expect(html).toContain("Delete NVDA");
    expect(html).not.toContain("Delete NVDA?");
    const refused = render(
      <SettingDelete
        title="Delete NVDA"
        line="Gone."
        ask="Delete NVDA?"
        refused="A rule uses NVDA. Delete the rule first."
        busy={false}
        onDelete={() => {}}
      />,
    );
    expect(refused).toContain("A rule uses NVDA. Delete the rule first.");
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
        error: "source_error",
        message: "network error; retry this symbol later",
      },
    };
    expect(headline(unread).price).toBe("216.50 USD");
    expect(priceState(unread, NOW)).toBe("Stored price · updated 3 h ago");
    const html = render(<Head detail={unread} now={NOW} />);
    expect(html).toContain("216.50 USD");
    expect(html).not.toContain("1 week");
  });

  test("refetch posts the parts, sections only with research", async () => {
    const f = fake({
      "POST /api/v1/admin/refetch": ok({ results: [] }),
      "GET /api/v1/admin/instruments/US%3ANVDA": ok(detail()),
    });
    const s = store(f.fetch);
    await s.refetch("US:NVDA", ["quotes"], []);
    await s.refetch("US:NVDA", ["research"], ["insider"]);
    const bodies = f.asked
      .filter((a) => a.init?.method === "POST")
      .map((a) => JSON.parse(String(a.init!.body)));
    expect(bodies).toEqual([
      { symbols: ["US:NVDA"], fetch: ["quotes"] },
      { symbols: ["US:NVDA"], fetch: ["research"], sections: ["insider"] },
    ]);
  });

  test("a delete a rule holds names the rules; one that goes leaves the list", async () => {
    const held = store(
      fake({
        "DELETE /api/v1/admin/instruments/US%3ANVDA": status(409, {
          error: "conflict",
          message: "rules read this instrument; delete them first",
          rules: [3],
        }),
      }).fetch,
    );
    expect(await held.remove("US:NVDA")).toEqual({ ok: false, rules: [3] });
    const s = store(
      fake({
        [`GET ${INSTRUMENTS_PATH}?limit=200`]: ok({
          total: 2,
          more: false,
          instruments: [listed("US:NVDA"), listed("US:AMD")],
        }),
        "DELETE /api/v1/admin/instruments/US%3ANVDA": ok({
          deleted: "US:NVDA",
          rows: {},
        }),
      }).fetch,
    );
    await s.loadInstruments();
    expect(await s.remove("US:NVDA")).toEqual({ ok: true });
    expect(s.instruments.value?.map((r) => r.id)).toEqual(["US:AMD"]);
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

describe("the chart model", () => {
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
      id: "US:NVDA",
      unit: "per_share",
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
    const y = legendOf({ ...h, unit: "percent" }, null)!;
    expect(changeText(y.change, y.points)).toBe("+10.00 pts");
    expect(changeText(-0.001)).toBe("0.00%");
  });

  test("a price on the axis has separators, and no cents past five figures", () => {
    expect(axisPrice(120000)).toBe("120,000");
    expect(axisPrice(80684.99)).toBe("80,685");
    expect(axisPrice(1661.62)).toBe("1,661.62");
    expect(axisPrice(5)).toBe("5.00");
  });

  test("the axis says a month or a day with its month, never a bare day", () => {
    expect(tick("2026-09-01", "month")).toBe("Sep");
    expect(tick("2026-10-05", "day")).toBe("5 Oct");
    expect(tick("2026-01-02", "year")).toBe("2026");
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
    expect(readSettings(JSON.stringify({ range: "1D" })).range).toBe(
      DEFAULT_SETTINGS.range,
    );
  });

  test("the legend names each average beside its stroke", () => {
    const h: History = {
      id: "US:NVDA",
      unit: "per_share",
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

  test("the 200-week average says how far the price is from it", () => {
    const d = detail({ price: 150, signals: { weekly: { sma200: 100 } } });
    expect(weekly200(d)).toEqual({
      value: "100.00 USD",
      gap: { text: "50.00% above", dir: 1 },
    });
    expect(
      weekly200(detail({ price: 90, signals: { weekly: { sma200: 100 } } }))
        .gap,
    ).toEqual({
      text: "10.00% below",
      dir: -1,
    });
    // a yield is apart from its average by points
    const y = detail(
      {
        price: null,
        observation: { date: "2026-10-26", value: 5 },
        signals: { weekly: { sma200: 4.2 } },
      },
      { id: "FRED:DGS10", unit: "percent", currency: null },
    );
    expect(weekly200(y)).toEqual({
      value: "4.20%",
      gap: { text: "0.80 pts above", dir: 1 },
    });
    // too young for one: nothing to say
    expect(
      weekly200(detail({ signals: { weekly: { sma200: null } } })),
    ).toEqual({
      value: "—",
      gap: null,
    });
  });

  test("a yield's returns are points; a page footer only where one is asked", () => {
    expect(returnCell(-0.15, true).text).toBe("−0.15 pts");
    expect(render(<Page title="Status" />)).not.toContain("page-foot");
    const foot = render(<Page title="NVDA" foot="Charts by TradingView" />);
    expect(foot).toContain("github.com/stefanprodan/1ctx-markets");
    expect(foot).toContain("Charts by TradingView");
  });
});
