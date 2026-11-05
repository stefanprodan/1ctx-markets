// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { alertsStore } from "../src/web/data/alerts.ts";

test("opening History marks the newest trigger seen, readable or not", async () => {
  const puts: unknown[] = [];
  const at = "2026-10-23T20:00:00Z";
  let head = 9;
  const call = (async (path: string, method?: string, body?: unknown) => {
    if (method === "PUT") {
      puts.push(body);
      return { seen: (body as { id: number }).id, unseen: 0 };
    }
    if (path.startsWith("/api/v1/alerts/history")) {
      return {
        triggers: [
          { id: head, alert_id: 1, triggered_at: at, truncated: true },
          {
            id: 8,
            alert_id: 1,
            symbol: "US:X",
            when: "price < 1",
            note: null,
            triggered_at: at,
            values: {},
          },
        ],
        instruments: {},
      };
    }
    if (path === "/api/v1/alerts/seen") return { seen: 0, unseen: 2 };
    return { alerts: [], instruments: {} };
  }) as never;
  const s = alertsStore(
    call,
    () => 1,
    () => () => {},
  );
  await s.loadAll();
  await s.loadSeen();
  await s.markSeen();
  expect(s.history.value?.map((t) => t.id)).toEqual([8]);
  expect(puts).toEqual([{ id: 9 }]);
  // a refresh bringing a newer unreadable trigger moves what the page watches
  head = 10;
  await s.loadAll();
  expect(s.newest.value).toBe(10);
  s.signedOut();
  expect(s.newest.value).toBe(0);
});
