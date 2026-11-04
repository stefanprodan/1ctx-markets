// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { PREFIX } from "../src/api/http.ts";
import { spec } from "../src/api/openapi.ts";
import type { WorldEntry } from "../src/market/world.ts";
import { markets } from "../src/operations/markets.ts";
import { readTargets } from "../src/operations/targets.ts";
import type { World } from "../src/operations/track.ts";
import { silent } from "../src/runtime/log.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { sources } from "./helpers/sources.ts";
import { listed, type Recorded, recorded } from "./helpers/yahoo.ts";

// recorded at 09:19 UTC on Wednesday 4 November, the US closed and CME
// trading: the S&P's last trade 21:30 the day before, its futures' 09:09
const RECORDED = Date.parse("2026-11-04T09:20:00Z");
const GSPC = "SNP:^GSPC";
const ES = "CME:ES=F";
const N225 = "OSA:^N225";
const NIY = "CME:NIY=F";

const FIXTURES: Record<string, string> = {
  "^GSPC": "gspc",
  "ES=F": "es-f",
  "^N225": "n225",
  "NIY=F": "niy-f",
};

const PAIRED: WorldEntry[] = [
  {
    group: "Americas",
    name: "S&P 500",
    symbol: "^GSPC",
    futures: { symbol: "ES=F", label: "S&P Futures" },
  },
  {
    group: "Asia",
    name: "Nikkei 225",
    symbol: "^N225",
    futures: { symbol: "NIY=F", label: "Nikkei Futures" },
  },
];

// the four stored as a first read stores them, then read at the clock's
// time, the answers unchanged since
async function home(
  at: number,
  entries: WorldEntry[] = PAIRED,
  saved: string[] | null = null,
  // changes the stored rows before the read
  edit: (db: Db) => void = () => {},
  unresolved: string[] = [],
) {
  const clock = fakeClock(RECORDED);
  const { db } = open(":memory:", clock);
  const charts: Record<string, Recorded> = {};
  for (const [symbol, name] of Object.entries(FIXTURES)) {
    charts[symbol] = listed(await recorded(`chart-${name}-5d-1d-overnight`));
  }
  const s = await sources({ charts });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    log: silent,
  });
  const targets = await readTargets(m, Object.keys(FIXTURES));
  const ids = targets.map((t) => ("instrument" in t ? t.instrument.id : null));
  expect(ids).toEqual([GSPC, ES, N225, NIY]);
  const world: World = {
    entries,
    status: () =>
      Object.keys(FIXTURES).map((value, k) => ({
        value,
        ...(unresolved.includes(value)
          ? { id: null, state: "pending" as const }
          : { id: ids[k]!, state: "tracked" as const }),
      })),
    resolving: true,
  };
  const handle = api(m, { world });
  const path = `http://markets.test${PREFIX}/dashboard`;
  if (saved !== null) {
    const put = await handle(
      new Request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: 0,
          sections: [{ name: "Mine", view: "table", symbols: saved }],
        }),
      }),
    );
    expect(put.status).toBe(200);
  }
  edit(db);
  await clock.advance(at - RECORDED);
  const asked = s.calls.urls.length;
  const res = await handle(new Request(path));
  const body = (await res.json()) as any;
  // no read and no fetch, as for every item
  expect(s.calls.urls.length).toBe(asked);
  expect(
    validate(body, answerSchema(spec, "GET", "/dashboard", 200)!, spec),
  ).toEqual([]);
  const items = new Map<string, any>(
    body.sections.flatMap((x: any) => x.items.map((i: any) => [i.id, i])),
  );
  db.close();
  return items;
}

describe("an index's futures on Home", () => {
  test("while the index is closed and its futures trade, the item carries them, open", async () => {
    const items = await home(RECORDED);
    const gspc = items.get(GSPC);
    expect(gspc.session.state).toBe("closed");
    expect(gspc.instrument.price).toBe(7568.92);
    expect(gspc.futures).toMatchObject({
      label: "S&P Futures",
      instrument: { id: ES, price: 7617.5, change: 3.5 },
      session: { state: "open" },
      intraday: true,
    });
    expect(items.get(N225).futures).toMatchObject({
      label: "Nikkei Futures",
      instrument: { id: NIY },
      session: { state: "open" },
    });
  });

  test("a saved Home flips too", async () => {
    const items = await home(RECORDED, PAIRED, [GSPC]);
    expect([...items.keys()]).toEqual([GSPC]);
    expect(items.get(GSPC).futures.instrument.id).toBe(ES);
  });

  test("a last trade older than half an hour reads closed, as in CME's daily break", async () => {
    const items = await home(Date.parse("2026-11-04T22:30:00Z"));
    expect(items.get(GSPC).session.state).toBe("closed");
    expect(items.get(GSPC).futures).toMatchObject({
      instrument: { id: ES },
      session: { state: "closed" },
    });
  });

  test("a weekend shows the futures' last trade, closed", async () => {
    const items = await home(Date.parse("2026-11-07T12:00:00Z"));
    expect(items.get(GSPC).futures).toMatchObject({
      instrument: { id: ES, price: 7617.5 },
      session: { state: "closed" },
    });
  });

  test("while the index's market is open, the index shows", async () => {
    const items = await home(Date.parse("2026-11-04T15:00:00Z"));
    expect(items.get(GSPC).session.state).toBe("open");
    expect(items.get(GSPC)).not.toHaveProperty("futures");
    // Tokyo closed hours before: the Nikkei still shows its futures
    expect(items.get(N225).futures.session.state).toBe("closed");
  });

  test("an index without a pair never flips", async () => {
    const items = await home(
      RECORDED,
      PAIRED.map(({ futures: _, ...e }) => e),
    );
    expect(items.get(GSPC)).not.toHaveProperty("futures");
    expect(items.get(N225)).not.toHaveProperty("futures");
  });

  test("a futures trade at or before the index's own last trade never flips", async () => {
    const items = await home(RECORDED, PAIRED, null, (db) => {
      db.query(
        "update quotes set time = (select time from quotes where instrument = ?) where instrument = ?",
      ).run(GSPC, ES);
    });
    expect(items.get(GSPC).session.state).toBe("closed");
    expect(items.get(GSPC)).not.toHaveProperty("futures");
  });

  test("with no index quote, its session's end marks the close once past", async () => {
    const noQuote = (db: Db) => {
      db.query("delete from quotes where instrument = ?").run(GSPC);
    };
    // before the open the stored session is the coming one
    const early = await home(RECORDED, PAIRED, null, noQuote);
    expect(early.get(GSPC).id).toBe(GSPC);
    expect(early.get(GSPC)).not.toHaveProperty("futures");
    const late = await home(
      Date.parse("2026-11-04T22:30:00Z"),
      PAIRED,
      null,
      (db) => {
        noQuote(db);
        db.query("update quotes set time = ? where instrument = ?").run(
          Date.parse("2026-11-04T22:20:00Z"),
          ES,
        );
      },
    );
    expect(late.get(GSPC).futures.session.state).toBe("open");
  });

  test("a pair not yet resolved, or without a quote, never flips", async () => {
    const pending = await home(RECORDED, PAIRED, null, undefined, ["ES=F"]);
    expect(pending.get(GSPC).id).toBe(GSPC);
    expect(pending.get(GSPC)).not.toHaveProperty("futures");
    const unquoted = await home(RECORDED, PAIRED, null, (db) => {
      db.query("delete from quotes where instrument = ?").run(ES);
    });
    expect(unquoted.get(GSPC).id).toBe(GSPC);
    expect(unquoted.get(GSPC)).not.toHaveProperty("futures");
    expect(unquoted.get(N225).futures.instrument.id).toBe(NIY);
  });
});
