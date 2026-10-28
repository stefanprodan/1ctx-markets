// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { readInstrument } from "../src/market/instruments.ts";
import { markRead, TRACK_MS } from "../src/market/tracking.ts";
import { eventsAnswer, parseEvents } from "../src/operations/events.ts";
import { markets } from "../src/operations/markets.ts";
import { parseQuote, quotePage } from "../src/operations/quote.ts";
import { createRule, parseRules } from "../src/operations/rules.ts";
import { readTargets } from "../src/operations/targets.ts";
import { ruleEngine } from "../src/rules/evaluate.ts";
import { countRules } from "../src/rules/store.ts";
import { silent } from "../src/runtime/log.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import {
  readEvents,
  STALE_RESEARCH,
  sectionState,
} from "../src/sources/finnhub/read.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { fetchInstrument } from "../src/sources/yahoo/sync.ts";
import { open } from "../src/storage/db/index.ts";
import { lastStarted } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { FINNHUB_KEY, finnhubAnswer } from "./helpers/finnhub.ts";
import { gate, NOW, sources } from "./helpers/sources.ts";
import {
  chartSymbol,
  clone,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

type Hold = (url: URL) => Promise<Recorded | undefined> | undefined;

async function setup(
  options: {
    charts?: Record<string, Recorded>;
    hold?: Hold;
    now?: number;
  } = {},
) {
  const clock = fakeClock(options.now ?? NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({
    charts: options.charts,
    hold: async (url) =>
      (await options.hold?.(url)) ?? (await finnhubAnswer(url)),
  });
  const write = writer(db);
  const engine = ruleEngine({ quoteEveryMs: 5 * 60_000 });
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    rules: engine,
    hooks: engine.finnhub,
    tracking: { readMs: TRACK_MS, flagged: new Set(), owed: new Set() },
    log: silent,
  });
  return { clock, db, write, m, calls: s.calls };
}

type Context = Awaited<ReturnType<typeof setup>>;

async function close(t: Context) {
  await t.write.close();
  t.db.close();
}

async function storeShare(t: Context, symbol: string) {
  const instrument = await fetchInstrument(
    {
      db: t.db,
      clock: t.clock,
      writer: t.write,
      yahoo: t.m.yahoo,
      rules: t.m.rules,
    },
    symbol,
    `US:${symbol}`,
    () => true,
  );
  await t.write.write((db) => markRead(db, [instrument.id], t.clock.now()));
  return instrument;
}

function createArgs(symbol: string, condition: unknown) {
  const args = parseRules({ action: "create", symbol, condition });
  if (args.action !== "create") throw new Error("expected create arguments");
  return args;
}

const body = (answer: { content: { text: string }[] }) =>
  JSON.parse(answer.content[0]!.text);

async function malformedCalendar(): Promise<Recorded> {
  const fx = clone(
    (await finnhubAnswer(
      new URL("https://finnhub.io/api/v1/calendar/earnings?symbol=NVDA"),
    ))!,
  );
  fx.body.earningsCalendar = "none";
  return fx;
}

test("rule creation refuses a dependency deleted while another symbol is fetching", async () => {
  const chart = listed(await recorded("chart-nvda-5d-1d"));
  const charts: Record<string, Recorded> = {};
  for (const symbol of ["A", "B", "C"]) {
    const fx = clone(chart);
    fx.body.chart.result[0].meta.symbol = symbol;
    charts[symbol] = fx;
  }
  const search = clone(await recorded("search-nvda"));
  search.body.quotes = [{ ...search.body.quotes[0], symbol: "C" }];
  const held = gate();
  const t = await setup({
    charts,
    hold: async (url) => {
      if (chartSymbol(url) === "C") return held.hold();
      if (
        url.pathname === "/v1/finance/search" &&
        url.searchParams.get("q") === "C"
      ) {
        return search;
      }
      return undefined;
    },
  });
  let pending: ReturnType<typeof createRule> | undefined;
  try {
    await storeShare(t, "A");
    await storeShare(t, "B");
    expect(countRules(t.db)).toBe(0);
    pending = createRule(
      t.m,
      createArgs("US:A", {
        all: [
          { left: "price", op: ">", right: 1 },
          { left: { field: "price", symbol: "US:B" }, op: ">", right: 1 },
          { left: { field: "price", symbol: "C" }, op: ">", right: 1 },
        ],
      }),
    );
    await held.arrived;
    const deleted = await api(t.m)(
      new Request("http://markets.test/api/v1/instruments/US:B", {
        method: "DELETE",
      }),
    );
    expect(deleted.status).toBe(204);
    expect(readInstrument(t.db, "US:B")).toBeNull();
    held.release();
    const created = await pending;
    expect(readInstrument(t.db, "US:C")).not.toBeNull();
    expect(countRules(t.db)).toBe(0);
    expect("error" in created).toBe(true);
  } finally {
    held.release();
    await pending?.catch(() => {});
    await close(t);
  }
});

test.each(["named", "tracked"])(
  "a failed calendar refresh remains unavailable in a %s request with no events in range",
  async (kind) => {
    const malformed = await malformedCalendar();
    let fail = false;
    const t = await setup({
      hold: async (url) =>
        fail && url.pathname === "/api/v1/calendar/earnings"
          ? malformed
          : undefined,
    });
    try {
      const initial = body(
        await drive(
          t.clock,
          pacedOf(t.m),
          eventsAnswer(
            t.m,
            parseEvents({
              symbols: ["NVDA"],
              from: "2026-10-01",
              to: "2026-12-31",
            }),
          ),
        ),
      );
      expect(initial.events).toHaveLength(1);
      expect(initial.unavailable).toBeUndefined();
      expect(
        lastStarted(t.db, "finnhub", "calendar", "US:NVDA", "ok"),
      ).toMatchObject({ rows: 1 });
      fail = true;
      const refreshed = await drive(
        t.clock,
        pacedOf(t.m),
        refreshResearch(
          { db: t.db, clock: t.clock, writer: t.write, finnhub: t.m.finnhub },
          readInstrument(t.db, "US:NVDA")!,
          ["calendar"],
        ),
      );
      expect(refreshed).toMatchObject([
        { section: "calendar", status: "failed" },
      ]);
      expect(lastStarted(t.db, "finnhub", "calendar", "US:NVDA")).toMatchObject(
        { status: "failed", error: "malformed answer" },
      );
      expect(
        readEvents(t.db, "2026-10-01", "2026-12-31", ["US:NVDA"]),
      ).toHaveLength(1);
      const answer = body(
        await eventsAnswer(
          t.m,
          parseEvents({
            ...(kind === "named" ? { symbols: ["NVDA"] } : {}),
            from: "2026-10-26",
            to: "2026-10-31",
          }),
        ),
      );
      expect(answer.events).toEqual([]);
      expect(
        t.calls.urls.filter((u) => u.hostname === "finnhub.io"),
      ).toHaveLength(2);
      expect(answer).toMatchObject({
        unavailable: [{ id: "US:NVDA", error: "source_error" }],
      });
      expect(answer.unavailable[0].message).toContain("malformed answer");
      expect(answer.no_event).toBeUndefined();
    } finally {
      await close(t);
    }
  },
);

async function failedInline() {
  const malformed = await malformedCalendar();
  const t = await setup({
    hold: async (url) =>
      url.pathname === "/api/v1/calendar/earnings" ? malformed : undefined,
  });
  try {
    const targets = await readTargets(t.m, ["NVDA"]);
    expect(targets[0]).toHaveProperty("instrument.id", "US:NVDA");
    expect(lastStarted(t.db, "finnhub", "calendar", "US:NVDA")).toBeNull();
    return t;
  } catch (error) {
    await close(t);
    throw error;
  }
}

function expectCalendarFailure(t: Context) {
  expect(
    t.calls.urls
      .filter((u) => u.hostname === "finnhub.io")
      .map((u) => u.pathname),
  ).toEqual(["/api/v1/calendar/earnings"]);
  expect(lastStarted(t.db, "finnhub", "calendar", "US:NVDA")).toMatchObject({
    status: "failed",
    error: "malformed answer",
  });
  expect(
    sectionState(t.db, "US:NVDA", "calendar", t.clock.now()).stale,
  ).toContain(STALE_RESEARCH.failed);
}

test("research requesting only the next event reports an inline calendar failure", async () => {
  const t = await failedInline();
  try {
    const response = await drive(
      t.clock,
      pacedOf(t.m),
      api(t.m)(
        new Request(
          "http://markets.test/api/v1/research?symbols=NVDA&sections=next_event",
        ),
      ),
    );
    expect(response.status).toBe(200);
    const answer: any = await response.json();
    expectCalendarFailure(t);
    expect(answer.research[0].id).toBe("US:NVDA");
    expect(answer.research[0].company.next_event).toBeNull();
    expect(answer.research[0].company.error).toBe("source_error");
    expect(answer.research[0].company.message).toContain("malformed answer");
  } finally {
    await close(t);
  }
});

test("an earnings-gated rule reports a calendar source failure instead of no event", async () => {
  const t = await failedInline();
  try {
    const created = await drive(
      t.clock,
      pacedOf(t.m),
      createRule(
        t.m,
        createArgs("US:NVDA", {
          afterEarnings: "NVDA",
          left: "price",
          op: ">",
          right: 1,
        }),
      ),
    );
    expectCalendarFailure(t);
    expect(countRules(t.db)).toBe(0);
    expect(created).toHaveProperty("error", "source_error");
    if ("error" in created)
      expect(created.message).toContain("malformed answer");
  } finally {
    await close(t);
  }
});

test("an extended quote for another listing is refused and not cached as a price", async () => {
  const other = await recorded("chart-hood-2d-1m-prepost-post-2122");
  const chart = listed(await recorded("chart-nvda-5d-1d"));
  const meta = chart.body.chart.result[0].meta;
  const otherMeta = other.body.chart.result[0].meta;
  meta.currentTradingPeriod = clone(otherMeta.currentTradingPeriod);
  meta.regularMarketTime = otherMeta.regularMarketTime;
  meta.regularMarketPrice = 210.96;
  meta.hasPrePostMarketData = true;
  const t = await setup({
    now: Date.parse(other.recordedAt),
    charts: { NVDA: chart },
    hold: async (url) =>
      chartSymbol(url) === "NVDA" &&
      url.searchParams.get("includePrePost") === "true"
        ? other
        : undefined,
  });
  try {
    await storeShare(t, "NVDA");
    const args = parseQuote({ symbols: ["US:NVDA"], extended: true });
    const first = JSON.parse(await quotePage(t.m, args)).items[0];
    const cached = JSON.parse(await quotePage(t.m, args)).items[0];
    expect(first.id).toBe("US:NVDA");
    expect(first.price).toBe(210.96);
    expect(cached).toEqual(first);
    expect(
      t.calls
        .charts("NVDA")
        .filter((u) => u.searchParams.get("includePrePost") === "true").length,
    ).toBeGreaterThan(0);
    expect({
      first: first.extended,
      repeat: cached.extended,
      cached: t.m.extended.get("US:NVDA")?.read.extended ?? null,
    }).toEqual({ first: null, repeat: null, cached: null });
    expect(first.stale).toContain("extended: fetch failed");
  } finally {
    await close(t);
  }
});
