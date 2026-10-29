// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { refetch } from "../src/admin/refetch.ts";
import { recordSession } from "../src/market/calendars.ts";
import { type Instrument, readInstrument } from "../src/market/instruments.ts";
import { readQuote } from "../src/market/quotes.ts";
import { JOBS, quoteStale, STALE } from "../src/market/stale.ts";
import { markRead } from "../src/market/tracking.ts";
import { fromWallTime } from "../src/market/zone.ts";
import { type Markets, markets } from "../src/operations/markets.ts";
import { researchTargets } from "../src/operations/research.ts";
import { createRule } from "../src/operations/rules.ts";
import { readTargets } from "../src/operations/targets.ts";
import { ruleEngine } from "../src/rules/evaluate.ts";
import { parseCondition } from "../src/rules/format.ts";
import { readAlertsAfter, readRule } from "../src/rules/store.ts";
import { DAY_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import {
  LABEL,
  type LaunchdFiles,
  launchdBackend,
} from "../src/service/launchd.ts";
import { plistPath, renderPlist } from "../src/service/plist.ts";
import { runService } from "../src/service/service.ts";
import { readSignals } from "../src/signals/read.ts";
import { bvb } from "../src/sources/bvb/client.ts";
import { sessionOf } from "../src/sources/bvb/quotes.ts";
import { fetchInstrument } from "../src/sources/bvb/sync.ts";
import { finnhub } from "../src/sources/finnhub/client.ts";
import { refreshResearch } from "../src/sources/finnhub/sync.ts";
import { fred } from "../src/sources/fred/client.ts";
import { fredJobs } from "../src/sources/fred/jobs.ts";
import { addSeries } from "../src/sources/fred/sync.ts";
import { SourceError } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { yahooJobs } from "../src/sources/yahoo/jobs.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import {
  failRun,
  lastRun,
  lastStarted,
  startRun,
} from "../src/storage/runs.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { bvbFetch, bvbRecorded } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive, pacedOf } from "./helpers/drive.ts";
import {
  FINNHUB_KEY,
  finnhubAnswer,
  finnhubFixture,
} from "./helpers/finnhub.ts";
import { FRED_KEY, gate, NOW, sources } from "./helpers/sources.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

async function setup(
  options: {
    fred?: boolean;
    charts?: Record<string, Recorded>;
    hold?: (url: URL) => Promise<Recorded | undefined> | undefined;
  } = {},
) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const s = await sources({
    charts: options.charts,
    hold: async (url) =>
      (await options.hold?.(url)) ?? (await finnhubAnswer(url)),
  });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: s.fetch }),
    fred: options.fred ? fred({ clock, key: FRED_KEY, fetch: s.fetch }) : null,
    finnhub: finnhub({ clock, key: FINNHUB_KEY, fetch: s.fetch }),
    rules: ruleEngine({ quoteEveryMs: 5 * 60_000 }),
    log: silent,
  });
  return { clock, db, m, calls: s.calls };
}

const removeInstrument = (m: Markets, id: string) =>
  api(m)(
    new Request(
      `http://markets.test/api/v1/instruments/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  );

async function close(m: Markets) {
  m.fred?.close();
  m.finnhub?.close();
  m.bvb?.close();
  await m.writer.close();
  m.db.close();
}

const researchRows = (db: Db, id: string) =>
  db
    .query<{ n: number }, [string]>(
      "select count(*) as n from research where instrument = ?",
    )
    .get(id)!.n;

test("a foreign service definition is refused before purging its data", async () => {
  const home = "/home/u";
  const path = plistPath(LABEL, home);
  const xml = renderPlist({
    label: "dev.1ctx.markets.other",
    programArguments: [
      "/other-instance/bin/1ctx-markets",
      "--data",
      "/other-instance",
    ],
    workingDirectory: "/other-instance",
  });
  const removed: string[] = [];
  const clock = fakeClock(NOW);
  const unexpected = async () => {
    throw new Error("unexpected file operation");
  };
  const files: LaunchdFiles = {
    mkdir: unexpected,
    write: unexpected,
    read: async (name) => {
      expect(name).toBe(path);
      return xml;
    },
    size: unexpected,
    rename: unexpected,
    remove: async (name) => {
      removed.push(name);
    },
  };
  const backend = launchdBackend({
    home,
    uid: 501,
    clock,
    files,
    alive: () => true,
    spawn: async (argv) => {
      expect(argv).toEqual(["launchctl", "print", `gui/501/${LABEL}`]);
      return { code: 113, stdout: "", stderr: "" };
    },
  });
  const error = await runService(["uninstall", "--purge"], {
    home,
    backend,
    clock,
    write: () => {},
    probe: async () => {
      throw new Error("unexpected health probe");
    },
    remove: async (name) => {
      removed.push(name);
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(removed).toEqual([]);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("service definition is invalid");
});

test("deleting a series cannot fail an unrelated quote pass", async () => {
  const bars = gate();
  const quotes = gate();
  let hold = false;
  const t = await setup({
    fred: true,
    hold: (url) => {
      if (!hold) return undefined;
      if (url.pathname === "/fred/series/observations") return bars.hold();
      if (url.pathname === "/v7/finance/spark") return quotes.hold();
      return undefined;
    },
  });
  let fredPass: ReturnType<ReturnType<typeof fredJobs>["pass"]> | undefined;
  let quotePass:
    | ReturnType<ReturnType<typeof yahooJobs>["quoteTick"]>
    | undefined;
  try {
    await readTargets(t.m, ["NVDA"]);
    const share = readInstrument(t.db, "US:NVDA")!;
    const added = await addSeries(t.m, "DGS10");
    expect(added.kind).toBe("added");
    if (added.kind !== "added") throw new Error("series was not added");
    hold = true;
    fredPass = fredJobs({ ctx: t.m, log: silent }).pass([added.instrument]);
    await bars.arrived;
    const old = lastStarted(t.db, "fred", JOBS.bars, added.instrument.id)!;
    expect(old.status).toBe("running");

    expect((await removeInstrument(t.m, added.instrument.id)).status).toBe(204);
    expect(readInstrument(t.db, added.instrument.id)).toBeNull();
    expect(
      lastStarted(t.db, "fred", JOBS.bars, added.instrument.id),
    ).toBeNull();
    quotePass = yahooJobs({
      ctx: t.m,
      quoteEveryMs: t.m.quoteEveryMs,
      log: silent,
    }).quoteTick();
    await quotes.arrived;
    expect(lastStarted(t.db, "yahoo", JOBS.quotes, "US")?.status).toBe(
      "running",
    );

    bars.release();
    await fredPass;
    quotes.release();
    expect((await quotePass).quoted).toEqual(["US"]);
    expect(readQuote(t.db, share.id)).not.toBeNull();

    expect(lastRun(t.db, "yahoo", JOBS.quotes, "US")?.status).toBe("ok");
    expect(quoteStale(t.db, share)).not.toContain(STALE.quotesFailed);
  } finally {
    bars.release();
    quotes.release();
    await Promise.allSettled(
      [fredPass, quotePass].filter((p) => p !== undefined),
    );
    await close(t.m);
  }
});

async function repairedRule(
  m: Markets,
  i: Instrument,
  run: <T>(p: Promise<T>) => Promise<T>,
  repair: () => void,
) {
  const created = await run(
    createRule(m, {
      action: "create",
      symbol: i.id,
      condition: parseCondition({ left: "price", op: ">", right: "sma50" }),
      note: null,
    }),
  );
  expect(created).not.toHaveProperty("error");
  if ("error" in created) throw new Error("rule was not created");
  expect(created.evaluation).toMatchObject({ result: "false", reasons: [] });
  expect(created.rule.armed).toBe(true);
  expect(readAlertsAfter(m.db, 0, 10)).toEqual([]);
  const quote = readQuote(m.db, i.id)!;
  const previous = readSignals(m.db, i.id, m.clock.now(), m.quoteEveryMs)!;
  await m.writer.write((db) => {
    const now = m.clock.now();
    failRun(
      db,
      startRun(db, i.source, JOBS.bars, now, i.id),
      now,
      new SourceError("malformed answer"),
    );
    m.rules.evaluate(db, [i.id], now);
  });
  expect(readRule(m.db, created.rule.id)?.lastResult).toBe("unknown");
  expect(
    readSignals(m.db, i.id, m.clock.now(), m.quoteEveryMs)!.stale.live,
  ).toEqual([STALE.barsFailed]);

  repair();
  expect(await run(refetch(m, [i], { parts: ["bars"], sections: [] }))).toEqual(
    [
      {
        symbol: i.id,
        part: "bars",
        status: "fetched",
        rows: expect.any(Number),
      },
    ],
  );
  expect(lastRun(m.db, i.source, JOBS.bars, i.id)?.status).toBe("ok");
  expect(readQuote(m.db, i.id)).toEqual(quote);
  const current = readSignals(m.db, i.id, m.clock.now(), m.quoteEveryMs)!;
  expect(current.stale.live).toEqual([]);
  expect(current.daily.live!.sma50).not.toBe(previous.daily.live!.sma50);
  expect(current.daily.live!.sma50).toBeLessThan(quote.price);

  expect(readRule(m.db, created.rule.id)?.lastResult).toBe("true");
  expect(readRule(m.db, created.rule.id)?.armed).toBe(false);
  expect(readAlertsAfter(m.db, 0, 10)).toHaveLength(1);
}

test("a successful Yahoo bars-only refetch fires a newly true rule", async () => {
  const repaired = listed(await recorded("chart-nvda-5y-1d"));
  const corrected = repaired.body.chart.result[0].indicators.quote[0];
  for (const field of ["open", "high", "low", "close"]) {
    corrected[field] = corrected[field].map(() => 100);
  }
  const bad = clone(repaired);
  const prices = bad.body.chart.result[0].indicators.quote[0];
  for (const field of ["open", "high", "low", "close"]) {
    prices[field] = prices[field].map(() => 1000);
  }
  let answer = bad;
  const t = await setup({
    charts: { NVDA: bad },
    hold: async (url) =>
      url.pathname === "/v8/finance/chart/NVDA" ? answer : undefined,
  });
  try {
    await readTargets(t.m, ["NVDA"]);
    await repairedRule(
      t.m,
      readInstrument(t.db, "US:NVDA")!,
      (p) => drive(t.clock, pacedOf(t.m), p),
      () => {
        answer = repaired;
      },
    );
  } finally {
    await close(t.m);
  }
});

test("a successful BVB bars-only refetch fires a newly true rule", async () => {
  const repaired = clone(await bvbRecorded("wapi-history-tlv-1d"));
  const first = repaired.body.t[0] * 1000;
  // More closed days let the recorded thirty-day window form a fifty-day mean.
  const earlier = Array.from(
    { length: 60 },
    (_, k) => first - (60 - k) * DAY_MS,
  ).filter((at) => ![0, 6].includes(new Date(at).getUTCDay()));
  repaired.body.t = [...earlier.map((at) => at / 1000), ...repaired.body.t];
  for (const field of ["o", "h", "l", "c", "v"]) {
    repaired.body[field] = [
      ...earlier.map(() => (field === "v" ? 1000 : 10)),
      ...repaired.body[field],
    ];
  }
  const bad = clone(repaired);
  for (const field of ["o", "h", "l", "c"]) {
    bad.body[field] = bad.body[field].map(() => 100);
  }
  const histories = { TLV: bad };
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const f = await bvbFetch({ histories });
  const client = bvb({ clock, fetch: f.fetch });
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch: f.fetch }),
    fred: null,
    bvb: client,
    rules: ruleEngine({ quoteEveryMs: 5 * 60_000 }),
    log: silent,
  });
  const run = <T>(p: Promise<T>) => drive(clock, client, p);
  try {
    const schedule = await run(client.schedule());
    const meta = await run(client.meta("TLV"));
    const detail = await run(client.detail("TLV"));
    await m.writer.write((db) =>
      recordSession(
        db,
        "BVB",
        sessionOf(meta.zone, schedule, fromWallTime(meta.zone, detail.at!)),
        clock.now(),
      ),
    );
    const i = await run(
      fetchInstrument({ ...m, bvb: client }, "TLV", null, () => true),
    );
    await m.writer.write((db) => {
      markRead(db, [i.id], clock.now());
    });
    await repairedRule(m, i, run, () => {
      histories.TLV = repaired;
    });
  } finally {
    await close(m);
  }
});

test("readding an instrument fetches research lost during deletion", async () => {
  const held = gate();
  const empty = await finnhubFixture("recommendation-tlv");
  let first = true;
  const t = await setup({
    hold: async (url) => {
      if (
        url.hostname !== "finnhub.io" ||
        url.pathname !== "/api/v1/stock/recommendation" ||
        !first
      ) {
        return undefined;
      }
      first = false;
      await held.hold();
      return empty;
    },
  });
  let pending: ReturnType<typeof refreshResearch> | undefined;
  const calls = () =>
    t.calls.urls.filter(
      (u) =>
        u.hostname === "finnhub.io" &&
        u.pathname === "/api/v1/stock/recommendation",
    );
  try {
    await readTargets(t.m, ["NVDA"]);
    const i = readInstrument(t.db, "US:NVDA")!;
    pending = refreshResearch(t.m, i, ["analysts"]);
    await drive(t.clock, pacedOf(t.m), held.arrived);
    expect((await removeInstrument(t.m, i.id)).status).toBe(204);
    expect(readInstrument(t.db, i.id)).toBeNull();
    held.release();
    const late = await drive(
      t.clock,
      pacedOf(t.m),
      pending.then(
        () => null,
        (error: unknown) => error,
      ),
    );
    expect((late as Error).message).toContain("US:NVDA was deleted");
    expect(researchRows(t.db, i.id)).toBe(0);

    await t.clock.advance(1);
    await readTargets(t.m, ["NVDA"]);
    expect(readInstrument(t.db, i.id)!.addedAt).toBeGreaterThan(i.addedAt);
    expect(researchRows(t.db, i.id)).toBe(0);
    const before = calls().length;
    const result = await drive(
      t.clock,
      pacedOf(t.m),
      researchTargets(t.m, [i.id], { sections: ["analysts"] }),
    );
    expect(result.inline.get(i.id)).toEqual({ kind: "stored" });

    expect(calls()).toHaveLength(before + 1);
    expect(researchRows(t.db, i.id)).toBeGreaterThan(0);
  } finally {
    held.release();
    if (pending !== undefined) await pending.catch(() => {});
    await close(t.m);
  }
});
