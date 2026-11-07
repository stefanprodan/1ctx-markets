// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { jobLabel } from "../src/admin/http.ts";
import { spec } from "../src/api/openapi.ts";
import { cftcPair, WORLD_MARKETS } from "../src/market/world.ts";
import { dateOfWall } from "../src/market/zone.ts";
import { ArgError } from "../src/operations/args.ts";
import { markets } from "../src/operations/markets.ts";
import {
  cftcCode,
  cotIndex,
  NOT_COVERED,
  RETIRED,
  SECTION_NOT_COVERED,
  UNKNOWN_MARKET,
  weekRows,
} from "../src/operations/positioning.ts";
import { searchPage } from "../src/operations/search.ts";
import { ADMIN } from "../src/operations/who.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { logger, silent } from "../src/runtime/log.ts";
import {
  cftc,
  FIELDS,
  LIST_LIMIT,
  parseMarkets,
  parseWeeks,
  type Week,
} from "../src/sources/cftc/client.ts";
import {
  cftcJobs,
  HISTORY_WEEKS,
  LIST_MS,
  marketList,
  NO_PRICE,
  POSITIONING_MS,
  POSITIONING_WEEKS,
  RETRY_MS,
} from "../src/sources/cftc/list.ts";
import type { SourceError } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { open } from "../src/storage/db/index.ts";
import { lastRun } from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { call, tools } from "../src/tools/index.ts";
import { api } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import {
  cftcAnswer,
  cftcFixture,
  codeOf,
  GOLD,
  isCftc,
  LATEST,
  RECORDED,
  SP,
  weeksBack,
} from "./helpers/cftc.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { sources } from "./helpers/sources.ts";
import {
  clone,
  fakeFetch,
  listed,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const failed = (detail: string): Recorded => ({
  recordedAt: "",
  status: 500,
  headers: {},
  body: detail,
});

// the server's reads over the recordings, the CFTC's list not yet held;
// hold answers a CFTC call in place of the recordings
async function setup(
  options: {
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
    charts?: Record<string, Recorded>;
  } = {},
) {
  const clock = fakeClock(RECORDED);
  const { db } = open(":memory:", clock);
  const lines: string[] = [];
  const s = await sources({
    hold: (url) => (isCftc(url) ? options.hold?.(url) : undefined),
    charts: options.charts,
  });
  const list = marketList(clock);
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: null,
    cftc: { client: cftc({ clock, fetch: s.fetch }), list },
    log: logger(
      clock,
      () => [],
      (line) => lines.push(line),
    )("tools"),
  });
  const list_ = tools(m);
  const tool = (name: string, args: Record<string, unknown>) =>
    drive(
      clock,
      pacedOf(m),
      call(m, list_.find((t) => t.name === name)!, args, ADMIN),
    );
  const ask = async (args: Record<string, unknown>) =>
    body(await tool("research", args));
  const rest = async (path: string) => {
    const res = await drive(
      clock,
      pacedOf(m),
      api(m)(new Request(`http://markets.test/api/v1/${path}`)),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  // what each CFTC call asked: a report's list, or a market's weeks
  const asked = () =>
    s.calls.urls
      .filter(isCftc)
      .map((u) => codeOf(u) ?? `list ${u.pathname.split("/").at(-1)}`);
  const fill = () =>
    drive(
      clock,
      pacedOf(m),
      Promise.all([
        list.fetch(m.cftc!.client, "disaggregated"),
        list.fetch(m.cftc!.client, "financial"),
      ]),
    );
  return { clock, db, m, list, lines, tool, ask, rest, asked, fill, s };
}

describe("the CFTC's answers", () => {
  test("map each report's groups, null where the report has none", async () => {
    for (const [code, report] of [
      [GOLD, "disaggregated"],
      [SP, "financial"],
    ] as const) {
      const fx = await cftcFixture(`weeks-${code}`);
      const weeks = parseWeeks(fx.body, report, code);
      expect(weeks).toHaveLength(HISTORY_WEEKS + 1);
      expect(weeks[0]!.date).toBe(LATEST);
      const raw = fx.body[0];
      expect(weeks[0]!.openInterest).toBe(Number(raw.open_interest_all));
      for (const [group, c] of Object.entries(FIELDS[report])) {
        const n = (column: string | null) =>
          column === null ? null : Number(raw[column]);
        expect([group, weeks[0]!.groups[group]] as unknown[]).toEqual([
          group,
          {
            long: n(c.long),
            short: n(c.short),
            spread: n(c.spread),
            tradersLong: n(c.tradersLong),
            tradersShort: n(c.tradersShort),
          },
        ]);
      }
    }
    const gold = parseWeeks(
      (await cftcFixture(`weeks-${GOLD}`)).body,
      "disaggregated",
      GOLD,
    );
    expect(gold[0]!.groups.producer_merchant!.spread).toBeNull();
    expect(gold[0]!.groups.non_reportable).toMatchObject({
      spread: null,
      tradersLong: null,
      tradersShort: null,
    });
  });

  test("refuse a row of another shape", async () => {
    const rows = (await cftcFixture(`weeks-${GOLD}`)).body.slice(0, 3);
    const bad = (edit: (rows: any[]) => void, detail: string) => {
      const copy = clone(rows);
      edit(copy);
      let error: SourceError | null = null;
      try {
        parseWeeks(copy, "disaggregated", GOLD);
      } catch (e) {
        error = e as SourceError;
      }
      expect([detail, error?.phrase]).toEqual([detail, "malformed answer"]);
    };
    bad((r) => delete r[0].swap__positions_short_all, "a mapped field missing");
    bad((r) => (r[1].cftc_contract_market_code = SP), "another market");
    bad(
      (r) =>
        (r[1].report_date_as_yyyy_mm_dd =
          r[1].report_date_as_yyyy_mm_dd.replace(/-\d\d-\d\d/, "-02-30")),
      "no such date",
    );
    bad(
      (r) => (r[2].report_date_as_yyyy_mm_dd = r[1].report_date_as_yyyy_mm_dd),
      "a date twice",
    );
    bad((r) => (r[0].open_interest_all = "-1"), "a negative count");
    bad((r) => (r[0].m_money_positions_long_all = "12.5"), "a fraction");
    bad((r) => (r[0].traders_swap_long_all = ""), "an empty count");
    // a column the map does not name is never read
    const extra = clone(rows);
    extra[0].change_in_open_interest_all = "-x";
    expect(parseWeeks(extra, "disaggregated", GOLD)).toHaveLength(3);
  });

  test("refuse a list that fills its limit, or names a market twice", async () => {
    const full = (await cftcFixture("markets-at-limit")).body;
    expect(full).toHaveLength(20);
    expect(() => parseMarkets(full, 20)).toThrow("a list cut short");
    expect(parseMarkets(full, LIST_LIMIT)).toHaveLength(20);
    const twice = [...full, full[0]];
    expect(() => parseMarkets(twice, LIST_LIMIT)).toThrow("listed twice");
  });

  test("a page that is not JSON backs the queue off", async () => {
    const clock = fakeClock(RECORDED);
    const f = fakeFetch(() => ({
      recordedAt: "",
      status: 200,
      headers: {},
      body: "<html>maintenance</html>",
    }));
    const client = cftc({ clock, fetch: f.fetch });
    await expect(client.weeks("disaggregated", GOLD, 3)).rejects.toThrow(
      "malformed answer",
    );
    expect(client.backoff()?.after).toBe("malformed answer");
    client.close();
  });

  test("ask only the field map's columns, the newest weeks first", async () => {
    const t = await setup();
    await t.ask({ symbol: `CFTC:${GOLD}` });
    const url = t.s.calls.urls.filter(isCftc).at(-1)!;
    const select = url.searchParams.get("$select")!.split(",");
    expect(select).toHaveLength(24);
    expect(select).toContain("swap__positions_short_all");
    expect(url.searchParams.get("$order")).toBe(
      "report_date_as_yyyy_mm_dd DESC",
    );
    expect(url.searchParams.get("$limit")).toBe(String(HISTORY_WEEKS + 1));
  });
});

describe("CFTC ids", () => {
  test("are six digits, capitals or +, any case", () => {
    expect(cftcCode("cftc:13874+")).toBe("13874+");
    expect(cftcCode(" CFTC: 0233at ")).toBe("0233AT");
    expect(cftcCode("GC=F")).toBeNull();
    for (const bad of [
      "CFTC:1387",
      "CFTC:13874 ",
      "CFTC:088691X",
      "CFTC:08-691",
    ]) {
      expect(() => cftcCode(bad)).toThrow(ArgError);
    }
  });

  test("take %2B for + over REST, and a bare + is refused", async () => {
    const t = await setup();
    const plus = await t.rest(
      "research?symbols=CFTC:13874%2B&sections=positioning",
    );
    expect(plus.status).toBe(200);
    expect(plus.body.research[0].id).toBe("CFTC:13874+");
    expect(plus.body.research[0].positioning.cftc.report).toBe("financial");
    const schema = answerSchema(spec, "GET", "/research", 200)!;
    expect(validate(plus.body, schema, spec)).toEqual([]);
    // a bare + decodes to a space
    const bare = await t.rest(
      "research?symbols=CFTC:13874+&sections=positioning",
    );
    expect(bare.status).toBe(400);
  });

  test("every other tool refuses one, asking no source", async () => {
    const t = await setup();
    const id = `CFTC:${GOLD}`;
    const item = (r: any) => r.items?.[0] ?? r;
    for (const [name, args] of [
      ["quote", { symbols: [id] }],
      ["history", { symbol: id }],
      ["movers", { symbols: [id], min_move_pct: 0 }],
      ["screen", { symbols: [id], sort: "rsi14" }],
      ["alerts_edit", { action: "create", symbol: id, when: "price > 1" }],
    ] as const) {
      const got = item(body(await t.tool(name, args)));
      // alerts_edit names the symbol before the message
      expect([name, got.error, got.message.endsWith(NO_PRICE)]).toEqual([
        name,
        "not_found",
        true,
      ]);
    }
    expect(t.s.calls.urls).toHaveLength(0);
  });
});

describe("the market list", () => {
  async function jobs() {
    const clock = fakeClock(RECORDED);
    const { db } = open(":memory:", clock);
    let fail = false;
    const f = fakeFetch((url) => (fail ? failed("down") : cftcAnswer(url)));
    const client = cftc({ clock, fetch: f.fetch });
    const list = marketList(clock);
    const lines: string[] = [];
    const job = cftcJobs({
      clock,
      writer: writer(db),
      cftc: client,
      list,
      log: logger(
        clock,
        () => [],
        (line) => lines.push(line),
      )("cftc"),
    });
    const tick = () => drive(clock, client, job.tick());
    return {
      clock,
      db,
      list,
      lines,
      tick,
      calls: () => f.urls.length,
      fail: (v: boolean) => {
        fail = v;
      },
    };
  }

  test("is fetched at start, then a day after its last good fetch", async () => {
    const t = await jobs();
    await t.tick();
    expect(t.calls()).toBe(2);
    expect(t.list.held("disaggregated")!.markets).toHaveLength(339);
    expect(t.list.held("financial")!.latest).toBe(LATEST);
    for (const report of ["disaggregated", "financial"]) {
      expect(lastRun(t.db, "cftc", "markets", report)).toMatchObject({
        status: "ok",
      });
    }
    await t.tick();
    expect(t.calls()).toBe(2);
    await t.clock.advance(LIST_MS - 1_000);
    await t.tick();
    expect(t.calls()).toBe(2);
    await t.clock.advance(1_000);
    await t.tick();
    expect(t.calls()).toBe(4);
  });

  test("a failure keeps the held list and asks again after the retry wait", async () => {
    const t = await jobs();
    await t.tick();
    const held = t.list.held("disaggregated")!;
    t.fail(true);
    await t.clock.advance(LIST_MS);
    await t.tick();
    expect(t.calls()).toBe(4);
    expect(t.list.held("disaggregated")).toBe(held);
    expect(lastRun(t.db, "cftc", "markets", "disaggregated")).toMatchObject({
      status: "failed",
      error: "source error",
    });
    expect(
      t.lines.filter((l) => l.includes("cftc markets failed")),
    ).toHaveLength(2);
    t.fail(false);
    await t.clock.advance(RETRY_MS - 60_000);
    await t.tick();
    expect(t.calls()).toBe(4);
    await t.clock.advance(60_000);
    await t.tick();
    expect(t.calls()).toBe(6);
    expect(t.list.held("disaggregated")).not.toBe(held);
  });

  test("the app fetches it at start and logs the CFTC on, always", () =>
    withApp(async ({ app, clock }) => {
      expect(app.sources.cftc).toBe("on (always)");
      // the start's own tick, which a second one joins rather than repeats
      const list = app.markets.cftc!.list;
      // bounded, so a list that never fills fails here, not at the timeout
      const filled = async () => {
        for (let k = 0; k < 1_000 && list.held("financial") === null; k++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      };
      await drive(clock, app.cftc, filled());
      expect(list.held("financial")).not.toBeNull();
      expect(app.markets.cftc!.list.find(GOLD)?.report).toBe("disaggregated");
      expect(app.markets.cftc!.list.find(SP)?.report).toBe("financial");
      expect(jobLabel("cftc", "markets")).toBe("Futures markets");
    }));

  test("holds every World markets code", async () => {
    const t = await setup();
    await t.fill();
    const codes = WORLD_MARKETS.flatMap((e) => (e.cftc ? [e.cftc] : []));
    expect(codes).toHaveLength(14);
    for (const code of codes) {
      expect([code, t.list.find(code) !== null]).toEqual([code, true]);
    }
    // never a pair quoted the other way round
    expect(cftcPair("JPY=X")).toBeNull();
    expect(cftcPair("CHF=X")).toBeNull();
    expect(cftcPair("es=f")?.code).toBe(cftcPair("^GSPC")!.code);
  });
});

describe("search", () => {
  test("finds held markets by name or code, asking the CFTC nothing", async () => {
    const t = await setup();
    const find = async (query: string) =>
      JSON.parse(
        await drive(t.clock, [], searchPage(t.m, { query, next: null })),
      );
    // none before the first fill
    expect((await find("gold")).candidates).toEqual([]);
    await t.fill();
    const before = t.asked().length;
    const gold = await find("gold");
    expect(gold.candidates[0]).toEqual({
      id: `CFTC:${GOLD}`,
      name: "GOLD - COMMODITY EXCHANGE INC.",
      source: "cftc",
      latest_report: LATEST,
    });
    expect(gold.errors).toBeUndefined();
    const calls = t.s.calls.urls.length;
    expect((await find(`cftc:${SP}`)).candidates[0].id).toBe(`CFTC:${SP}`);
    // a CFTC id is no listing, so Yahoo is not asked
    expect(t.s.calls.urls.length).toBe(calls);
    expect((await find("japanese yen")).candidates.length).toBeGreaterThan(0);
    expect(t.asked().length).toBe(before);
    // the job failing for two days is said beside what is still found
    await t.clock.advance(2 * DAY_MS + 1_000);
    const old = await find("gold");
    expect(old.candidates[0].id).toBe(`CFTC:${GOLD}`);
    expect(old.errors).toEqual([
      {
        source: "cftc",
        error: "source_error",
        message: "the CFTC's market list has not been refreshed for two days",
      },
    ]);
    // the REST search adds instruments, so it lists no market
    const rest = await t.rest("symbols?query=gold&upstream=false");
    expect(rest.body.candidates).toEqual([]);
  });
});

describe("the positioning section", () => {
  test("a read before the first fill fetches the list it needs inline", async () => {
    const t = await setup();
    const gold = await t.ask({
      symbol: `CFTC:${GOLD}`,
      section: "positioning",
    });
    expect(t.asked()).toEqual(["list 72hh-3qpy.json", GOLD]);
    expect(gold.cftc).toEqual({
      id: `CFTC:${GOLD}`,
      name: "GOLD - COMMODITY EXCHANGE INC.",
      exchange: "COMMODITY EXCHANGE INC.",
      report: "disaggregated",
    });
    const sp = await t.ask({ symbol: `CFTC:${SP}`, section: "positioning" });
    expect(t.asked()).toEqual([
      "list 72hh-3qpy.json",
      GOLD,
      "list gpe5-46if.json",
      SP,
    ]);
    expect(sp.cftc.report).toBe("financial");
  });

  test("answers the default weeks newest first with their arithmetic", async () => {
    const t = await setup();
    const a = await t.ask({ symbol: `CFTC:${GOLD}`, section: "positioning" });
    expect(a).toMatchObject({
      id: `CFTC:${GOLD}`,
      section: "positioning",
      source: "cftc",
      latest_report: LATEST,
      in_latest_report: true,
      since: dateOfWall(RECORDED - POSITIONING_WEEKS * 7 * DAY_MS),
      next: null,
    });
    expect(a.weeks).toHaveLength(12);
    expect(a.weeks[0].report_date).toBe(LATEST);
    const weeks = parseWeeks(
      (await cftcFixture(`weeks-${GOLD}`)).body,
      "disaggregated",
      GOLD,
    );
    const [w, before] = weeks;
    const mm = w!.groups.managed_money!;
    const net = mm.long - mm.short;
    expect(a.weeks[0].managed_money).toEqual({
      long: mm.long,
      short: mm.short,
      spread: mm.spread,
      net,
      net_pct_oi: Math.round((net / w!.openInterest) * 1000) / 10,
      net_change:
        net -
        (before!.groups.managed_money!.long -
          before!.groups.managed_money!.short),
      traders_long: mm.tradersLong,
      traders_short: mm.tradersShort,
    });
    // the oldest of the history still has a change: one more week is fetched
    expect(weekRows(weeks)[HISTORY_WEEKS - 1]!.managed_money).toMatchObject({
      net_change: expect.any(Number),
    });
  });

  test("pages a long since newest first, cot_index on page one", async () => {
    const t = await setup();
    const args = {
      symbol: `CFTC:${GOLD}`,
      section: "positioning",
      // the earliest since takes, so the whole history
      since: dateOfWall(RECORDED - HISTORY_WEEKS * 7 * DAY_MS),
    };
    const pages = [await t.ask(args)];
    while (pages.at(-1)!.next !== null) {
      pages.push(await t.ask({ ...args, next: pages.at(-1)!.next }));
    }
    expect(pages.length).toBeGreaterThan(3);
    const dates = pages.flatMap((p) => p.weeks.map((w: any) => w.report_date));
    expect(dates).toHaveLength(HISTORY_WEEKS);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(pages[0]).toContainKey("cot_index");
    expect(pages[1]).not.toContainKey("cot_index");
    expect(t.asked()).toEqual(["list 72hh-3qpy.json", GOLD]);
    // further back than the history is refused before any call
    const far = await t.tool("research", {
      ...args,
      since: weeksBack(HISTORY_WEEKS + 1),
    });
    expect(body(far).error).toBe("bad_arguments");
    expect(body(far).message).toContain(`at most ${HISTORY_WEEKS} weeks back`);
  });

  test("a market that skipped the latest report says so, never stale", async () => {
    const t = await setup({
      hold: async (url) => {
        // the list's own latest for the market agrees with its weeks
        if (url.searchParams.has("$group") && url.pathname.includes("72hh")) {
          const fx = clone(await cftcFixture("markets-disaggregated"));
          fx.body = fx.body.map((r: Record<string, string>) =>
            r.cftc_contract_market_code === GOLD
              ? { ...r, latest: `${weeksBack(1)}T00:00:00.000` }
              : r,
          );
          return fx;
        }
        if (codeOf(url) !== GOLD) return undefined;
        const fx = clone(await cftcFixture(`weeks-${GOLD}`));
        fx.body = fx.body.slice(1);
        return fx;
      },
    });
    await t.fill();
    const ask = () => t.ask({ symbol: `CFTC:${GOLD}`, section: "positioning" });
    const a = await ask();
    expect(a.latest_report).toBe(LATEST);
    expect(a.in_latest_report).toBe(false);
    expect(a.weeks[0].report_date).not.toBe(LATEST);
    expect(a).not.toContainKey("stale");
    // a market behind the list's latest by its own report is not refetched
    await ask();
    await ask();
    expect(t.asked().filter((x) => x === GOLD)).toHaveLength(1);
  });

  test("is kept for its window, then asked again", async () => {
    const t = await setup();
    const ask = () => t.ask({ symbol: `CFTC:${GOLD}` });
    await ask();
    await ask();
    expect(t.asked().filter((a) => a === GOLD)).toHaveLength(1);
    await t.clock.advance(POSITIONING_MS - 60_000);
    await ask();
    expect(t.asked().filter((a) => a === GOLD)).toHaveLength(1);
    await t.clock.advance(60_000);
    await ask();
    expect(t.asked().filter((a) => a === GOLD)).toHaveLength(2);
  });

  test("a list refreshed after a report fetches the held weeks again", async () => {
    let released = false;
    const t = await setup({
      hold: async (url) => {
        if (released) return undefined;
        // before the report: the list and the weeks end a week earlier
        if (url.searchParams.has("$group")) {
          const fx = clone((await cftcAnswer(url))!);
          fx.body = fx.body.map((r: any) =>
            r.latest.startsWith(LATEST)
              ? { ...r, latest: `${weeksBack(1)}T00:00:00.000` }
              : r,
          );
          return fx;
        }
        if (codeOf(url) !== GOLD) return undefined;
        const fx = clone(await cftcFixture(`weeks-${GOLD}`));
        fx.body = fx.body.slice(1);
        return fx;
      },
    });
    await t.fill();
    const ask = () => t.ask({ symbol: `CFTC:${GOLD}`, section: "positioning" });
    const before = await ask();
    expect(before.weeks[0].report_date).toBe(weeksBack(1));
    expect(before.in_latest_report).toBe(true);
    released = true;
    await t.clock.advance(60 * 60_000);
    await t.fill();
    const after = await ask();
    expect(after.weeks[0].report_date).toBe(LATEST);
    expect(after.latest_report).toBe(LATEST);
    expect(after.in_latest_report).toBe(true);
    expect(t.asked().filter((a) => a === GOLD)).toHaveLength(2);
  });

  test("a failed list still finds a market the other report lists", async () => {
    // an answer of another shape, which backs no queue off
    const t = await setup({
      hold: async (url) => {
        if (!url.searchParams.has("$group") || !url.pathname.includes("72hh")) {
          return undefined;
        }
        const fx = clone((await cftcAnswer(url))!);
        fx.body = [{}];
        return fx;
      },
    });
    const sp = await t.ask({ symbol: `CFTC:${SP}`, section: "positioning" });
    expect(sp.cftc.report).toBe("financial");
    expect(sp.weeks[0].report_date).toBe(LATEST);
    // a market neither list holds is an error while one failed, never missing
    const none = await t.ask({ symbol: "CFTC:ZZZZZZ" });
    expect(none.error).toBe("source_error");
  });

  test("a CFTC id's overview is its latest week, its other sections none", async () => {
    const t = await setup();
    const o = await t.ask({ symbol: `CFTC:${GOLD}` });
    expect(o.section).toBe("overview");
    expect(o.latest.report_date).toBe(LATEST);
    expect(o.cot_index.managed_money.weeks).toBe(HISTORY_WEEKS);
    const news = await t.ask({ symbol: `CFTC:${GOLD}`, section: "news" });
    expect(news).toMatchObject({
      source: "cftc",
      message: SECTION_NOT_COVERED,
    });
    const none = await t.ask({ symbol: "CFTC:ZZZZZZ" });
    expect(none).toMatchObject({ error: "not_found", message: UNKNOWN_MARKET });
    const expiry = await t.tool("research", {
      symbol: `CFTC:${GOLD}`,
      section: "positioning",
      expiry: weeksBack(-2),
    });
    expect(body(expiry).error).toBe("bad_arguments");
  });

  test("answers a paired symbol's market, its futures as the entry", async () => {
    const gspc = await recorded("chart-gspc-5d-1d");
    const es = clone(listed(gspc));
    Object.assign(es.body.chart.result[0].meta, {
      symbol: "ES=F",
      exchangeName: "CME",
      fullExchangeName: "CME",
      instrumentType: "FUTURE",
    });
    const t = await setup({ charts: { "ES=F": es } });
    const index = await t.ask({ symbol: "^GSPC", section: "positioning" });
    const future = await t.ask({ symbol: "ES=F", section: "positioning" });
    expect(index.cftc.id).toBe(`CFTC:${SP}`);
    expect(future.id).not.toBe(index.id);
    expect(future.cftc).toEqual(index.cftc);
    expect(future.weeks).toEqual(index.weeks);
    expect(t.asked().filter((a) => a === SP)).toHaveLength(1);
    const nvda = await t.ask({ symbol: "NVDA", section: "positioning" });
    expect(nvda).toMatchObject({ source: "cftc", message: NOT_COVERED });
  });

  test("a retired World markets code is not covered, logged once a day", async () => {
    const t = await setup({
      hold: async (url) => {
        if (!url.searchParams.has("$group")) return undefined;
        const fx = clone((await cftcAnswer(url))!);
        fx.body = fx.body.filter(
          (r: any) => r.cftc_contract_market_code !== SP,
        );
        return fx;
      },
    });
    const ask = () => t.ask({ symbol: "^GSPC", section: "positioning" });
    expect(await ask()).toMatchObject({ source: "cftc", message: RETIRED });
    await ask();
    expect(
      t.lines.filter((l) => l.includes("cftc market retired")),
    ).toHaveLength(1);
    await t.clock.advance(DAY_MS);
    await ask();
    expect(
      t.lines.filter((l) => l.includes("cftc market retired")),
    ).toHaveLength(2);
    expect(t.asked().filter((a) => a === SP)).toHaveLength(0);
  });
});

describe("the overview's pointer", () => {
  test("names a paired symbol's market without a CFTC call", async () => {
    const t = await setup();
    const before = await t.ask({ symbol: "^GSPC" });
    expect(before.positioning).toEqual({
      id: `CFTC:${SP}`,
      name: null,
      read_with: "research section positioning",
    });
    expect(t.asked()).toEqual([]);
    await t.fill();
    const after = await t.ask({ symbol: "^GSPC" });
    expect(after.positioning.name).toBe(
      "S&P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE",
    );
    expect(t.asked()).toHaveLength(2);
    expect(await t.ask({ symbol: "NVDA" })).not.toContainKey("positioning");
    const rest = await t.rest("research?symbols=^GSPC");
    expect(rest.body.research[0]).not.toContainKey("positioning");
    expect(t.asked()).toHaveLength(2);
  });
});

describe("the COT index", () => {
  const week = (i: number, net: number): Week => ({
    date: new Date(Date.UTC(2026, 10, 3) - i * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10),
    openInterest: 1_000,
    groups: {
      managed_money: {
        long: 500 + net,
        short: 500,
        spread: 0,
        tradersLong: 1,
        tradersShort: 1,
      },
    },
  });

  test("places the latest net in its range, from the history only", () => {
    // nets 0 to 200 over 156 weeks, the latest 50, one older week far out
    const weeks = [
      week(0, 50),
      ...Array.from({ length: HISTORY_WEEKS - 3 }, (_, i) => week(i + 1, 100)),
      week(HISTORY_WEEKS - 2, 0),
      week(HISTORY_WEEKS - 1, 200),
      week(HISTORY_WEEKS, 10_000),
    ];
    expect(cotIndex(weeks)).toEqual({
      managed_money: { value: 25, weeks: HISTORY_WEEKS },
    });
  });

  test("is null under a year of weeks, or over a flat range", () => {
    const short = Array.from({ length: 51 }, (_, i) => week(i, i));
    expect(cotIndex(short)).toEqual({ managed_money: null });
    const year = Array.from({ length: 52 }, (_, i) => week(i, 52 - i));
    expect(cotIndex(year)).toEqual({
      managed_money: { value: 100, weeks: 52 },
    });
    const flat = Array.from({ length: 60 }, (_, i) => week(i, 7));
    expect(cotIndex(flat)).toEqual({
      managed_money: { value: null, weeks: 60 },
    });
  });
});

describe("the research route", () => {
  test("answers CFTC ids and paired symbols with positioning only when asked", async () => {
    const t = await setup();
    const both = await t.rest(
      `research?symbols=CFTC:${GOLD},^GSPC,NVDA&sections=positioning`,
    );
    expect(both.status).toBe(200);
    const [gold, gspc, nvda] = both.body.research;
    expect(Object.keys(gold)).toEqual(["input", "id", "positioning"]);
    expect(gold.positioning.weeks).toHaveLength(12);
    expect(gspc.positioning.cftc.id).toBe(`CFTC:${SP}`);
    expect(nvda.positioning).toEqual({ source: "cftc", message: NOT_COVERED });
    const schema = answerSchema(spec, "GET", "/research", 200)!;
    expect(validate(both.body, schema, spec)).toEqual([]);
    const plain = await t.rest(`research?symbols=CFTC:${GOLD}`);
    expect(plain.body.research[0].error.code).toBe("not_found");
    const since = await t.rest(
      `research?symbols=CFTC:${GOLD}&sections=positioning&since=${LATEST}`,
    );
    expect(since.status).toBe(400);
  });
});

test("reads without a CFTC client answer an error, never a crash", async () => {
  const clock = fakeClock(RECORDED);
  const { db } = open(":memory:", clock);
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: fakeFetch(() => undefined).fetch }),
    fred: null,
    log: silent,
  });
  const research = tools(m).find((t) => t.name === "research")!;
  const r = body(await call(m, research, { symbol: `CFTC:${GOLD}` }));
  expect(r.error).toBe("source_error");
});
