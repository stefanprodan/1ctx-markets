// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ALERT_PAGE_BYTES, alertsHandler } from "../src/api/alerts.ts";
import { alertsRead, parseAlertsRead } from "../src/operations/alerts.ts";
import { PAGE_BYTES } from "../src/operations/answer.ts";
import type { Access } from "../src/operations/who.ts";
import type { Snapshot } from "../src/rules/evaluate.ts";
import { insertAlert, insertRule, pruneAlerts } from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { type Log, silent } from "../src/runtime/log.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { api, cookieFor } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock, START } from "./helpers/clock.ts";
import { listing, world } from "./helpers/world.ts";

const snapshot = (rule: number, note: string | null = null): Snapshot => ({
  rule: {
    id: rule,
    symbol: "US:NVDA",
    condition: {
      left: { field: "price", symbol: "US:NVDA" },
      op: "<",
      right: 200,
    },
    note,
  },
  values: [
    {
      left: {
        field: "price",
        symbol: "US:NVDA",
        value: 199.5,
        trade_time: "2026-10-26T14:00:00Z",
      },
      op: "<",
      right: 200,
      holds: true,
    },
  ],
});

// a snapshot this server cannot read: a field it no longer knows
const unreadable = (rule: number): Snapshot => {
  const s = snapshot(rule);
  return {
    ...s,
    rule: {
      ...s.rule,
      condition: {
        left: { field: "gone", symbol: "US:NVDA" },
        op: "<",
        right: 1,
      },
    },
  } as Snapshot;
};

function setup(log: Log = silent) {
  const clock = fakeClock(START);
  const { db } = open(":memory:", clock);
  const handle = alertsHandler({ db, log });
  const get = (tag?: string, path = "/api/v1/alerts/feed") =>
    handle(
      new Request(`http://localhost${path}`, {
        headers: tag === undefined ? {} : { "if-none-match": tag },
      }),
      "operator",
    );
  return { clock, db, get };
}

const fire = (db: Db, at: number, n = 1, note: string | null = null) => {
  for (let k = 0; k < n; k++) {
    insertAlert(db, { id: 1, owner: "operator" }, snapshot(1, note), at);
  }
};

const ids = async (res: Response) =>
  ((await res.json()) as { triggers: { id: number }[] }).triggers.map(
    (a) => a.id,
  );

describe("the alerts feed", () => {
  test("answers 204 with no cursor and no alerts", async () => {
    const t = setup();
    const res = await t.get();
    expect(res.status).toBe(204);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("answers every alert with its id as the ETag, then 304", async () => {
    const t = setup();
    // two alerts in the same millisecond are both delivered
    fire(t.db, t.clock.now(), 2);
    const res = await t.get();
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe('W/"alerts-2"');
    expect(res.headers.get("last-modified")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as any;
    expect(body.more).toBe(false);
    // a snapshot stored as a tree reads in the words of when
    expect(body.triggers).toEqual([
      {
        id: 1,
        alert_id: 1,
        symbol: "US:NVDA",
        when: "price < 200",
        note: null,
        triggered_at: "2026-10-26T07:00:00Z",
        values: { price: 199.5 },
      },
      expect.objectContaining({ id: 2, triggered_at: "2026-10-26T07:00:00Z" }),
    ]);

    const none = await t.get('W/"alerts-2"');
    expect(none.status).toBe(304);
    expect(none.headers.get("etag")).toBe('W/"alerts-2"');
    expect(await none.text()).toBe("");

    fire(t.db, t.clock.now());
    const after = await t.get('W/"alerts-2"');
    expect(after.headers.get("etag")).toBe('W/"alerts-3"');
    expect(await ids(after)).toEqual([3]);
    // a strong tag of the same id is read the same
    expect(await ids(await t.get('"alerts-2"'))).toEqual([3]);
  });

  test("an unreadable stored trigger goes out by its id, the rest whole", async () => {
    const warned: unknown[] = [];
    const t = setup({ ...silent, warn: (_m, f) => warned.push(f) });
    fire(t.db, t.clock.now());
    const bad = insertAlert(
      t.db,
      { id: 2, owner: "operator" },
      unreadable(2),
      t.clock.now(),
    );
    fire(t.db, t.clock.now());
    for (const _ of [1, 2]) {
      const res = await t.get();
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('W/"alerts-3"');
      const body = (await res.json()) as any;
      expect(body.triggers.map((x: any) => x.when ?? null)).toEqual([
        "price < 200",
        null,
        "price < 200",
      ]);
      expect(body.triggers[1]).toEqual({
        id: bad,
        alert_id: 2,
        triggered_at: "2026-10-26T07:00:00Z",
        truncated: true,
      });
    }
    expect(warned).toEqual([expect.objectContaining({ id: bad })]);
  });

  test("the same alerts answer the same bytes", async () => {
    const t = setup();
    fire(t.db, t.clock.now(), 3);
    const a = await (await t.get('W/"alerts-1"')).text();
    await t.clock.advance(DAY_MS);
    const b = await (await t.get('W/"alerts-1"')).text();
    expect(b).toBe(a);
  });

  test("a backlog drains over several pages, each under 16 KiB", async () => {
    const t = setup();
    fire(t.db, t.clock.now(), 120, "é".repeat(200));
    const seen: number[] = [];
    let tag: string | undefined;
    let pages = 0;
    for (; pages < 50; pages++) {
      const res = await t.get(tag);
      if (res.status === 304) break;
      const text = await res.text();
      expect(Buffer.byteLength(text)).toBeLessThan(ALERT_PAGE_BYTES);
      const body = JSON.parse(text);
      const page = body.triggers.map((a: any) => a.id);
      expect(res.headers.get("etag")).toBe(`W/"alerts-${page.at(-1)}"`);
      expect(body.more).toBe(page.at(-1) < 120);
      seen.push(...page);
      tag = res.headers.get("etag")!;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, k) => k + 1));
    expect(pages).toBeGreaterThan(3);
  });

  test("a cursor before retained history answers the rest with a gap", async () => {
    const t = setup();
    fire(t.db, t.clock.now(), 3);
    await t.clock.advance(91 * DAY_MS);
    pruneAlerts(t.db, t.clock.now());
    const lost = await t.get('W/"alerts-1"');
    expect(lost.status).toBe(200);
    expect(lost.headers.get("etag")).toBe('W/"alerts-3"');
    expect(await lost.json()).toEqual({
      retention_gap: true,
      more: false,
      triggers: [],
    });
    fire(t.db, t.clock.now());
    const res = await t.get('W/"alerts-1"');
    const body = (await res.json()) as any;
    expect(body.retention_gap).toBe(true);
    expect(body.triggers.map((a: any) => a.id)).toEqual([4]);
    // the cursor at the last pruned id misses nothing
    const whole = (await (await t.get('W/"alerts-3"')).json()) as any;
    expect(whole.retention_gap).toBeUndefined();
    // and with no cursor nothing is missing either
    expect(
      ((await (await t.get()).json()) as any).retention_gap,
    ).toBeUndefined();
  });

  test("a cursor this database never gave starts over", async () => {
    const t = setup();
    fire(t.db, t.clock.now(), 2);
    const res = await t.get('W/"alerts-90"');
    const body = (await res.json()) as any;
    expect(body.cursor_reset).toBe(true);
    expect(body.triggers.map((a: any) => a.id)).toEqual([1, 2]);
  });

  test("refuses a malformed cursor or any query argument", async () => {
    const t = setup();
    for (const tag of [
      "alerts-1",
      'W/"alerts-01"',
      'W/"x-1"',
      "*",
      'W/"alerts-1", W/"alerts-2"',
    ]) {
      const res = await t.get(tag);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toBe("application/problem+json");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(((await res.json()) as any).code).toBe("bad_arguments");
    }
    expect((await t.get(undefined, "/api/v1/alerts/feed?since=1")).status).toBe(
      400,
    );
  });

  test("is served behind a key, GET only", () =>
    withApp(async (t) => {
      insertAlert(
        t.db,
        { id: 1, owner: "operator" },
        snapshot(1),
        t.clock.now(),
      );
      const auth = { authorization: `Bearer ${t.bearer}` };
      expect((await fetch(`${t.url}/api/v1/alerts/feed`)).status).toBe(401);
      const post = await fetch(`${t.url}/api/v1/alerts/feed`, {
        method: "POST",
        headers: auth,
      });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET");
      const res = await fetch(`${t.url}/api/v1/alerts/feed`, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('W/"alerts-1"');
      const again = await fetch(`${t.url}/api/v1/alerts/feed`, {
        headers: { ...auth, "if-none-match": res.headers.get("etag")! },
      });
      expect(again.status).toBe(304);
    }));

  test("alerts are kept 90 days", () => {
    const t = setup();
    fire(t.db, t.clock.now());
    expect(pruneAlerts(t.db, t.clock.now() + 90 * DAY_MS)).toBe(0);
    expect(pruneAlerts(t.db, t.clock.now() + 90 * DAY_MS + 1)).toBe(1);
  });
});

// the web UI's reads of the alerts: two people, each by their own sign-in
function pages() {
  const w = world();
  listing(w.db, "US:NVDA", { currency: "USD", name: "Made Up Chips" });
  w.db
    .query(
      "insert into users (id, name, role, created_at) values ('ana', 'Ana', 'member', 0)",
    )
    .run();
  const handle = api(w.m);
  const as = (user: string) => cookieFor(w.db, w.clock.now(), user);
  const get = (user: string, path: string) =>
    handle(
      new Request(`http://markets.test/api/v1${path}`, {
        headers: { cookie: as(user) },
      }),
    );
  const mark = (user: string, id: unknown) =>
    handle(
      new Request("http://markets.test/api/v1/alerts/seen", {
        method: "PUT",
        headers: {
          cookie: as(user),
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        },
        body: JSON.stringify({ id }),
      }),
    );
  const fireFor = (owner: string, note: string) =>
    insertAlert(w.db, { id: 1, owner }, snapshot(1, note), w.clock.now());
  return { ...w, get, mark, fireFor };
}

const historyOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as {
    triggers: { id: number; note: string; alert_id: number }[];
    instruments: Record<string, unknown>;
    next_page_token?: string;
  };
};

const seenOf = async (res: Response) => {
  expect(res.status).toBe(200);
  return (await res.json()) as { seen: number; unseen: number };
};

describe("the alerts history route", () => {
  test("answers one's own newest first, a page at a time", async () => {
    const t = pages();
    const mine: number[] = [];
    for (let k = 0; k < 60; k++) {
      mine.push(t.fireFor("operator", `mine ${k}`));
      if (k % 20 === 0) t.fireFor("ana", "hers");
    }
    const first = await historyOf(await t.get("operator", "/alerts/history"));
    const newest = mine.toReversed();
    expect(first.triggers.map((a) => a.id)).toEqual(newest.slice(0, 50));
    expect(first.next_page_token).toBe(String(newest[49]));
    expect(first.instruments).toEqual({
      "US:NVDA": {
        name: "Made Up Chips",
        type: "EQUITY",
        currency: "USD",
        unit: "per_share",
      },
    });
    const rest = await historyOf(
      await t.get(
        "operator",
        `/alerts/history?page_token=${first.next_page_token}`,
      ),
    );
    expect(rest.triggers.map((a) => a.id)).toEqual(newest.slice(50));
    expect(rest.next_page_token).toBeUndefined();
    // another person's never show, in theirs only theirs
    const all = [...first.triggers, ...rest.triggers];
    expect(all.some((a) => a.note === "hers")).toBe(false);
    const hers = await historyOf(await t.get("ana", "/alerts/history"));
    expect(hers.triggers.map((a) => a.note)).toEqual(["hers", "hers", "hers"]);
    expect(hers.next_page_token).toBeUndefined();
  });

  test("keeps to an alert, a symbol and a day", async () => {
    const t = pages();
    const insert = (rule: number, at: number) =>
      insertAlert(t.db, { id: rule, owner: "operator" }, snapshot(rule), at);
    const old = insert(7, t.clock.now() - 3 * DAY_MS);
    const recent = insert(7, t.clock.now());
    const other = insert(8, t.clock.now());
    const of = async (q: string) =>
      (
        await historyOf(await t.get("operator", `/alerts/history?${q}`))
      ).triggers.map((a) => a.id);
    expect(await of("alert=7")).toEqual([recent, old]);
    expect(await of("symbol=US:NVDA")).toEqual([other, recent, old]);
    expect(await of("symbol=US:NOTHING")).toEqual([]);
    const day = new Date(t.clock.now() - DAY_MS).toISOString().slice(0, 10);
    expect(await of(`since=${day}`)).toEqual([other, recent]);
    expect(await of(`since=${day}&alert=8`)).toEqual([other]);
  });

  test("reads past an unreadable trigger, and a deleted listing's by its id", async () => {
    const t = pages();
    const good = t.fireFor("operator", "kept");
    const bad = insertAlert(
      t.db,
      { id: 2, owner: "operator" },
      unreadable(2),
      t.clock.now(),
    );
    const page = await historyOf(await t.get("operator", "/alerts/history"));
    expect(page.triggers.map((a) => a.id)).toEqual([bad, good]);
    expect(page.triggers[0]).toMatchObject({ truncated: true });
    // no listing is stored for it: the id is taken as given
    const s = snapshot(3);
    const gone = insertAlert(
      t.db,
      { id: 3, owner: "operator" },
      {
        ...s,
        rule: {
          ...s.rule,
          symbol: "US:GONE",
          condition: {
            left: { field: "price", symbol: "US:GONE" },
            op: "<",
            right: 200,
          },
        },
      } as Snapshot,
      t.clock.now(),
    );
    const of = await historyOf(
      await t.get("operator", "/alerts/history?symbol=US:GONE"),
    );
    expect(of.triggers.map((a) => a.id)).toEqual([gone]);
  });

  test("answers an empty page with no triggers", async () => {
    const t = pages();
    expect(await historyOf(await t.get("operator", "/alerts/history"))).toEqual(
      { triggers: [], instruments: {} },
    );
  });

  test("refuses a malformed page_token or any other argument", async () => {
    const t = pages();
    for (const query of [
      "page_token=x",
      "page_token=0",
      "page_token=-1",
      "page_token=01",
      "page_token=",
      "alert=x",
      "since=yesterday",
      "before=1",
    ]) {
      const res = await t.get("operator", `/alerts/history?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
    }
  });
});

describe("the alerts tool's history", () => {
  const setup = () => {
    const t = pages();
    const fireOn = (rule: number, owner: string, note: string) =>
      insertAlert(
        t.db,
        { id: rule, owner },
        snapshot(rule, note),
        t.clock.now(),
      );
    const ask = async (user: string, alerts: Access, args: object) => {
      const r = await alertsRead(
        t.m,
        {
          name: "agent",
          user,
          credential: { kind: "key", id: "made-up" },
          portfolio: "none",
          alerts,
          profile: "none",
          analysis: "none",
        },
        parseAlertsRead({ history: true, ...args }),
      );
      return {
        error: r.isError === true,
        body: JSON.parse(r.content[0]!.text),
      };
    };
    // every page, following next with the same arguments
    const all = async (user: string, args: object = {}) => {
      const out: { id: number; note: string; alert_id: number }[] = [];
      let next: string | null = null;
      let pages = 0;
      do {
        const r = await ask(
          user,
          "read",
          next === null ? args : { ...args, next },
        );
        expect(r.error).toBe(false);
        out.push(...r.body.triggers);
        next = r.body.next;
        pages++;
      } while (next !== null && pages < 10);
      return { triggers: out, pages };
    };
    return { ...t, fireOn, ask, all };
  };

  test("answers one's own newest first, next paging to the oldest kept", async () => {
    const t = setup();
    const mine: number[] = [];
    for (let k = 0; k < 60; k++) {
      mine.push(t.fireOn(1 + (k % 3), "operator", `mine ${k}`));
      if (k % 20 === 0) t.fireOn(1, "ana", "hers");
    }
    const read = await t.all("operator");
    expect(read.triggers.map((a) => a.id)).toEqual(mine.toReversed());
    expect(read.pages).toBeGreaterThan(1);
    expect(read.triggers.some((a) => a.note === "hers")).toBe(false);
    const hers = await t.all("ana");
    expect(hers.triggers.map((a) => a.note)).toEqual(["hers", "hers", "hers"]);

    // the same items and listings as the route
    const first = await t.ask("operator", "read", {});
    const route = await historyOf(await t.get("operator", "/alerts/history"));
    const n = first.body.triggers.length;
    expect(first.body.triggers).toEqual(route.triggers.slice(0, n));
    expect(first.body.instruments).toEqual(route.instruments);
  });

  test("with id, that alert's only, a deleted alert's too", async () => {
    const t = setup();
    t.fireOn(7, "operator", "a");
    t.fireOn(8, "operator", "b");
    t.fireOn(7, "operator", "c");
    t.fireOn(7, "ana", "hers");
    // alert 7 is no alert now: its history stays, read by its id
    const read = await t.all("operator", { id: 7 });
    expect(read.triggers.map((a) => a.note)).toEqual(["c", "a"]);
    expect((await t.all("operator", { id: 99 })).triggers).toEqual([]);
    const page = await t.ask("operator", "read", { id: 99 });
    expect(page.body).toEqual({ next: null, instruments: {}, triggers: [] });
  });

  test("a next continues only the arguments it came from", async () => {
    const t = setup();
    for (let k = 0; k < 60; k++) t.fireOn(7, "operator", "x".repeat(400));
    const first = await t.ask("operator", "read", { id: 7 });
    expect(first.body.next).not.toBeNull();
    // the tool's call answers it as bad_arguments
    await expect(
      t.ask("operator", "read", { next: first.body.next }),
    ).rejects.toThrow("next does not continue this history");
  });

  test("a read-only key reads them, a key without alerts access cannot", async () => {
    const t = setup();
    t.fireOn(1, "operator", "mine");
    const read = await t.ask("operator", "read", {});
    expect(read.error).toBe(false);
    expect(read.body.triggers).toHaveLength(1);
    const none = await t.ask("operator", "none", {});
    expect(none).toEqual({
      error: true,
      body: {
        error: "forbidden",
        message: "this key has no alerts access; its owner grants it",
      },
    });
  });
});

describe("the alerts tool's list", () => {
  test("names only the listings of the alerts a page holds", async () => {
    const t = pages();
    const id = (k: number) => `US:S${k}`;
    for (let k = 0; k < 200; k++) {
      listing(t.db, id(k), {
        currency: "USD",
        name: `Made Up ${k} `.repeat(8),
      });
    }
    for (let a = 0; a < 50; a++) {
      const reads = [0, 1, 2, 3].map((j) => id(a * 4 + j));
      insertRule(
        t.db,
        "operator",
        {
          instrument: reads[0]!,
          condition: JSON.stringify({
            all: reads.map((symbol) => ({
              left: { field: "price", symbol },
              op: "<",
              right: 1,
            })),
          }),
          note: null,
        },
        t.clock.now(),
      );
    }
    const r = await alertsRead(
      t.m,
      {
        name: "agent",
        user: "operator",
        credential: { kind: "key", id: "made-up" },
        portfolio: "none",
        alerts: "read",
        profile: "none",
        analysis: "none",
      },
      parseAlertsRead({}),
    );
    expect(r.isError).toBeUndefined();
    const text = r.content[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThan(PAGE_BYTES);
    const body = JSON.parse(text);
    expect(body.next).not.toBeNull();
    const named = new Set<string>(
      body.alerts.flatMap((a: any) => [
        a.symbol,
        ...a.now.map((n: any) => n.symbol ?? a.symbol),
      ]),
    );
    expect(Object.keys(body.instruments).sort()).toEqual([...named].sort());
  });
});

describe("the alerts seen", () => {
  test("move forward only, never past one's newest, per person", async () => {
    const t = pages();
    const ids = [1, 2, 3].map(() => t.fireFor("operator", "mine"));
    // the newest alert of all is the other person's
    const hers = t.fireFor("ana", "hers");
    expect(await seenOf(await t.get("operator", "/alerts/seen"))).toEqual({
      seen: 0,
      unseen: 3,
    });
    expect(await seenOf(await t.mark("operator", ids[1]))).toEqual({
      seen: ids[1]!,
      unseen: 1,
    });
    // an older id leaves it as it was
    expect(await seenOf(await t.mark("operator", ids[0]))).toEqual({
      seen: ids[1]!,
      unseen: 1,
    });
    // past one's newest stops at it, so a later alert is never seen ahead
    expect(await seenOf(await t.mark("operator", hers + 100))).toEqual({
      seen: ids[2]!,
      unseen: 0,
    });
    t.fireFor("operator", "mine");
    expect(await seenOf(await t.get("operator", "/alerts/seen"))).toEqual({
      seen: ids[2]!,
      unseen: 1,
    });
    // the other person's mark is their own
    expect(await seenOf(await t.get("ana", "/alerts/seen"))).toEqual({
      seen: 0,
      unseen: 1,
    });
  });

  test("refuse an id that is not one", async () => {
    const t = pages();
    for (const id of ["1", -1, 1.5, null]) {
      const res = await t.mark("operator", id);
      expect([id, res.status]).toEqual([id, 400]);
    }
  });
});
