// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { UI_PATHS } from "../src/server/http.ts";
import { Shell } from "../src/web/app/App.tsx";
import { Rail } from "../src/web/app/Rail.tsx";
import { inApp } from "../src/web/app/router.ts";
import { ALIASES, HOME, match, ROUTES } from "../src/web/app/routes.ts";
import { Strip } from "../src/web/app/Strip.tsx";
import { resolveTheme } from "../src/web/app/theme.ts";
import {
  ApiError,
  client,
  type Fetch,
  failure,
  says,
} from "../src/web/data/api.ts";
import {
  SESSION_PATH,
  STATUS_PATH,
  type Status,
  store,
} from "../src/web/data/store.ts";
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
  runTime,
  sourceState,
  switchFailure,
  trackFailed,
  trackLine,
  until,
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
    expect(match(HOME)?.label).toBe("Status");
    expect(match("/instruments")?.label).toBe("Instruments");
    expect(match("/nothing")).toBeNull();
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
    expect(until("2026-10-28T12:05:00Z", NOW)).toBe("for 5 min");
    expect(until(null, NOW)).toBe("for now");
    // a back-off already past never reads as a negative wait
    expect(until("2026-10-28T11:58:00Z", NOW)).toBe("for now");
    expect(runTime(null)).toBe("never");
    expect(runTime("2026-10-28T13:05:00Z")).not.toMatch(/AM|PM/i);
  });

  test("a source and its jobs read as counts, never a single run", () => {
    const [prices, , research] = STATUS.sources;
    expect(sourceState(prices!, NOW)).toBe("On");
    expect(sourceState(research!, NOW)).toBe(
      "Backing off for 5 min · rate limited",
    );
    const [live, daily, figures] = STATUS.jobs;
    expect(jobLine(live!)).toBe("19 markets · all ok");
    expect(jobLine(daily!)).toBe("14 instruments · 7 failing");
    expect(jobLine({ ...live!, markets: 1 })).toBe("1 market · ok");
    expect(jobLine({ ...live!, markets: 0 })).toBe("");
    expect(allOk(figures!)).toBe("All 19 instruments ok.");
    expect(allOk({ ...live!, markets: 1 })).toBe("1 market ok.");
    // a bars job runs per market and per instrument: it reads as instruments
    expect(jobLine({ ...live!, instruments: 50, markets: 19 })).toBe(
      "50 instruments · all ok",
    );
    expect(jobWhen(live!, NOW)).toBe("2 min ago");
    // the time never says how the run went
    expect(jobWhen(daily!, NOW)).toBe("2 h ago");
    expect(jobTone(live!)).toBe("done");
    expect(jobTone(daily!)).toBe("failed");
    // a good last run still reads failing while another scope failed
    expect(jobTone({ ...live!, failing_scopes: 1 })).toBe("failed");
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
      "Source change for market BVB failed: timeout. Its prices stay stale until a retry succeeds.",
    );
  });
});

describe("the views", () => {
  test("status draws the on sources' cards, the keyed ones to add, and the tracked values", () => {
    const html = render(<StatusBody status={STATUS} now={NOW} />);
    for (const words of [
      "78",
      "61 tracked",
      "PRICES, FEED, RESEARCH",
      "1 failing",
      "62 MB",
      "v1.2.3",
      "Casey prices",
      "Backing off for 5 min · rate limited",
      "19 markets · all ok",
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
    // a failed run whose scope the server did not name still says why
    const unnamed = render(
      <JobDetails job={{ ...daily!, failing: [], failing_scopes: 0 }} />,
    );
    expect(unnamed).toContain("no bars");
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
    for (const r of ROUTES) expect(html).toContain(`aria-label="${r.label}"`);
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
