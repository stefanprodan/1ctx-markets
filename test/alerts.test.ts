// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ALERT_PAGE_BYTES, alertsHandler } from "../src/api/alerts.ts";
import type { Snapshot } from "../src/rules/evaluate.ts";
import { insertAlert, pruneAlerts } from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock, START } from "./helpers/clock.ts";

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

function setup() {
  const clock = fakeClock(START);
  const { db } = open(":memory:", clock);
  const handle = alertsHandler({ db, log: silent });
  const get = (tag?: string, path = "/api/v1/alerts") =>
    handle(
      new Request(`http://localhost${path}`, {
        headers: tag === undefined ? {} : { "if-none-match": tag },
      }),
    );
  return { clock, db, get };
}

const fire = (db: Db, at: number, n = 1, note: string | null = null) => {
  for (let k = 0; k < n; k++) insertAlert(db, 1, snapshot(1, note), at);
};

const ids = async (res: Response) =>
  ((await res.json()) as { alerts: { id: number }[] }).alerts.map((a) => a.id);

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
    expect(body.alerts).toEqual([
      expect.objectContaining({ id: 1, rule_id: 1, symbol: "US:NVDA" }),
      expect.objectContaining({ id: 2, fired_at: "2026-10-26T07:00:00Z" }),
    ]);
    expect(body.alerts[0].values[0].left.value).toBe(199.5);

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
      const page = body.alerts.map((a: any) => a.id);
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
      alerts: [],
    });
    fire(t.db, t.clock.now());
    const res = await t.get('W/"alerts-1"');
    const body = (await res.json()) as any;
    expect(body.retention_gap).toBe(true);
    expect(body.alerts.map((a: any) => a.id)).toEqual([4]);
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
    expect(body.alerts.map((a: any) => a.id)).toEqual([1, 2]);
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
    expect((await t.get(undefined, "/api/v1/alerts?since=1")).status).toBe(400);
  });

  test("is served behind a key, GET only", () =>
    withApp(async (t) => {
      insertAlert(t.db, 1, snapshot(1), t.clock.now());
      const auth = { authorization: `Bearer ${t.bearer}` };
      expect((await fetch(`${t.url}/api/v1/alerts`)).status).toBe(401);
      const post = await fetch(`${t.url}/api/v1/alerts`, {
        method: "POST",
        headers: auth,
      });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET");
      const res = await fetch(`${t.url}/api/v1/alerts`, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('W/"alerts-1"');
      const again = await fetch(`${t.url}/api/v1/alerts`, {
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
