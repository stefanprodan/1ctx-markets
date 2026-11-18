// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A bond's interest: made-up bonds, faces and coupons only.

import { describe, expect, test } from "bun:test";
import { spec } from "../src/api/openapi.ts";
import { upsertInstrument } from "../src/market/instruments.ts";
import { createPortfolio, saveSettings } from "../src/operations/portfolio.ts";
import { OPERATOR, type Who } from "../src/operations/who.ts";
import {
  couponDay,
  interestOn,
  NO_SCHEDULE,
  type Schedule,
  soonest,
} from "../src/portfolios/bond-interest.ts";
import { growth } from "../src/portfolios/growth.ts";
import { netWorth } from "../src/portfolios/net-worth.ts";
import {
  cashPortfolio,
  ensureCash,
  insertPortfolio,
  insertPosition,
  listBrokers,
  listPortfolios,
  type NewPosition,
  setDisplayCurrency,
  setTimeZone,
} from "../src/portfolios/store.ts";
import { holdings } from "../src/portfolios/value.ts";
import type { Db } from "../src/storage/db/index.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { ask } from "./helpers/portfolio.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { bar, instrument, LIVE, NOW, quote, world } from "./helpers/world.ts";

const EVERY = 60_000;
const DAY = 86_400_000;

// a yearly 4.5% bond on 8,000 face, bought on the exchange between coupons
const YEARLY: Schedule = {
  face: 8000,
  coupon: 4.5,
  perYear: 1,
  maturity: "2032-10-06",
  issued: "2022-10-06",
  asOf: "2026-08-12",
};

describe("coupon days", () => {
  test("fall on maturity's day and month, every 12 / coupons a year months back", () => {
    const at = (m: string, n: number) =>
      [0, 1, 2, 3, 4].map((k) => couponDay(m, n, k));
    expect(at("2031-06-15", 1)).toEqual([
      "2031-06-15",
      "2030-06-15",
      "2029-06-15",
      "2028-06-15",
      "2027-06-15",
    ]);
    expect(at("2031-06-15", 2)).toEqual([
      "2031-06-15",
      "2030-12-15",
      "2030-06-15",
      "2029-12-15",
      "2029-06-15",
    ]);
    expect(at("2031-06-15", 4)).toEqual([
      "2031-06-15",
      "2031-03-15",
      "2030-12-15",
      "2030-09-15",
      "2030-06-15",
    ]);
  });

  test("a day the month lacks falls back to its last, never drifting", () => {
    expect([0, 1, 2, 3, 4].map((k) => couponDay("2031-08-31", 4, k))).toEqual([
      "2031-08-31",
      "2031-05-31",
      "2031-02-28",
      "2030-11-30",
      "2030-08-31",
    ]);
    expect(couponDay("2032-08-31", 2, 1)).toBe("2032-02-29");
  });
});

describe("a bond's interest", () => {
  test("accrues actual days over the coupon period's", () => {
    // 43 days since 6 Oct in a 365-day period
    const i = interestOn(YEARLY, "2026-11-18");
    expect(i.accrued).toBeCloseTo((360 * 43) / 365, 9);
    expect(i.next).toEqual({ date: "2027-10-06", amount: 360 });
    // twice a year: 134 of the 183 days from 15 Jun to 15 Dec
    const half = interestOn(
      { ...YEARLY, face: 1000, coupon: 6, perYear: 2, maturity: "2031-06-15" },
      "2026-10-27",
    );
    expect(half.accrued).toBeCloseTo((30 * 134) / 183, 9);
    expect(half.next).toEqual({ date: "2026-12-15", amount: 30 });
  });

  test("is nothing on a coupon day, one day's the day after", () => {
    expect(interestOn(YEARLY, "2026-10-06").accrued).toBe(0);
    expect(interestOn(YEARLY, "2026-10-07").accrued).toBeCloseTo(360 / 365, 9);
  });

  test("an exchange buy owns the period since the last coupon, not its purchase", () => {
    // bought 12 Aug: accrued counts from 6 Oct of the year before
    const i = interestOn(YEARLY, "2026-08-12");
    expect(i.accrued).toBeCloseTo((360 * 310) / 365, 9);
    expect(i.coupons).toBe(0);
    expect(interestOn(YEARLY, "2026-10-05").coupons).toBe(0);
    expect(interestOn(YEARLY, "2026-10-06").coupons).toBe(360);
    expect(interestOn(YEARLY, "2027-10-06").coupons).toBe(720);
  });

  test("accrues nothing before issued, and the issue day is no coupon", () => {
    const sub: Schedule = {
      ...YEARLY,
      maturity: "2029-11-24",
      issued: "2026-11-24",
      asOf: "2026-11-20",
    };
    expect(interestOn(sub, "2026-11-23")).toEqual({
      accrued: 0,
      coupons: 0,
      next: { date: "2027-11-24", amount: 360 },
    });
    expect(interestOn(sub, "2026-11-24")).toEqual({
      accrued: 0,
      coupons: 0,
      next: { date: "2027-11-24", amount: 360 },
    });
    expect(interestOn(sub, "2026-11-25").accrued).toBeCloseTo(360 / 365, 9);
    expect(interestOn(sub, "2027-11-24").coupons).toBe(360);
    // issued mid-period: accrues from it over the whole period
    const late = { ...sub, issued: "2026-12-24" };
    expect(interestOn(late, "2027-01-23").accrued).toBeCloseTo(
      (360 * 30) / 365,
      9,
    );
  });

  test("its last payout is the coupon with the face; nothing after", () => {
    const short = { ...YEARLY, maturity: "2027-10-06" };
    expect(interestOn(short, "2026-11-18").next).toEqual({
      date: "2027-10-06",
      amount: 8360,
    });
    const done = interestOn(short, "2027-10-06");
    // October's coupons of both years held, the last on maturity
    expect(done).toEqual({ accrued: 0, coupons: 720, next: null });
    expect(interestOn(short, "2028-01-01")).toEqual(done);
  });

  test("a merged bond's payouts sum on the earliest day", () => {
    expect(
      soonest([
        { date: "2027-04-15", amount: 25 },
        null,
        { date: "2027-04-15", amount: 75 },
        { date: "2027-10-15", amount: 1 },
      ]),
    ).toEqual({ date: "2027-04-15", amount: 100 });
    expect(soonest([null, undefined])).toBeNull();
  });
});

function setup() {
  const w = world();
  setDisplayCurrency(w.db, OPERATOR, "EUR", NOW);
  ensureCash(w.db, OPERATOR, NOW);
  const bonds = insertPortfolio(w.db, OPERATOR, "Bonds", NOW);
  const bond = (p: Partial<NewPosition>) =>
    insertPosition(
      w.db,
      {
        portfolio: bonds,
        kind: "bond",
        name: "Made Up 2032",
        currency: "EUR",
        instrument: null,
        amount: 8000,
        cost: 8300,
        coupon: 4.5,
        maturity: "2032-10-06",
        couponsPerYear: 1,
        issued: "2022-10-06",
        asOf: "2026-08-12",
        broker: null,
        note: null,
        dryPowder: false,
        replaces: null,
        enteredBy: "test",
        ...p,
      },
      NOW,
    );
  return { ...w, bonds, bond };
}

const scope = (db: Db, portfolio: number | null) => ({
  owner: OPERATOR,
  portfolios: listPortfolios(db, OPERATOR),
  brokers: listBrokers(db, OPERATOR),
  portfolio,
  broker: null,
  currency: "EUR",
});

const read = (db: Db, portfolio: number | null = null, now = NOW) =>
  holdings(db, scope(db, portfolio), now, EVERY);

describe("the holdings answer", () => {
  test("a bond's value adds accrued, its gain the coupons paid", () => {
    const { db, bond } = setup();
    bond({});
    const h = read(db);
    const row = h.holdings.find((r) => r.kind === "bond")!;
    // 17 days since 6 Oct; the 6 Oct coupon came after the purchase
    expect(row).toMatchObject({
      clean_value: 8000,
      accrued: 16.77,
      coupons_paid: 360,
      next_payout: { date: "2027-10-06", amount: 360 },
      value: 8016.77,
      cost: 8300,
      pl: 76.77,
      pl_percent: 0.92,
      stale: [],
    });
    expect(row.parts[0]!.value).toBe(8016.77);
    expect(row.converted).toMatchObject({ value: 8016.77, pl: 76.77 });
    const eur = h.totals.find((t) => t.currency === "EUR")!;
    expect(eur).toMatchObject({
      value: 8016.77,
      pl: 76.77,
      invested: 8016.77,
      next_payout: { date: "2027-10-06", amount: 360 },
    });
    expect(h.converted).toMatchObject({
      value: 8016.77,
      pl: 76.77,
      net_worth: 8016.77,
      next_payout: { date: "2027-10-06", amount: 360 },
    });
  });

  test("an exchange buy's accrued interest paid comes back with its first coupon", async () => {
    const { db, clock, bond } = setup();
    // paid 8,000 face and 252 days of accrued interest since 1 Dec
    bond({
      maturity: "2032-12-01",
      issued: "2022-12-01",
      cost: 8000 + (360 * 252) / 365,
    });
    const before = read(db).holdings[0]!;
    expect(before).toMatchObject({
      accrued: 321.53,
      coupons_paid: 0,
      value: 8321.53,
      pl: 72.99,
      next_payout: { date: "2026-12-01", amount: 360 },
    });
    await clock.advance(Date.parse("2026-12-02T12:00:00Z") - clock.now());
    const after = read(db, null, clock.now()).holdings[0]!;
    expect(after).toMatchObject({
      accrued: 0.99,
      coupons_paid: 360,
      value: 8000.99,
      pl: 112.44,
      next_payout: { date: "2027-12-01", amount: 360 },
    });
  });

  test("interest is counted to the owner's today", () => {
    const { db, bond } = setup();
    bond({});
    // 18:00 UTC is the next morning in Auckland
    setTimeZone(db, OPERATOR, "Pacific/Auckland", NOW);
    expect(read(db).holdings[0]!.accrued).toBe(17.75);
  });

  test("a bond without a schedule names why and keeps its value and gain", () => {
    const { db, bond } = setup();
    bond({ couponsPerYear: null });
    bond({ name: "Made Up 2033", issued: null, asOf: "2026-01-05" });
    const h = read(db);
    for (const row of h.holdings) {
      expect(row).toMatchObject({
        clean_value: 8000,
        accrued: null,
        coupons_paid: null,
        next_payout: null,
        value: 8000,
        pl: -300,
        stale: [NO_SCHEDULE],
      });
      expect(row.parts[0]!.coupons_paid).toBeNull();
    }
    expect(h.totals[0]!.next_payout).toBeUndefined();
  });

  test("no schedule comes first in stale, so a real reason stays last", () => {
    const { db, bond } = setup();
    instrument(db, "BVB:NEW", { currency: "EUR", unit: "percent_of_par" });
    bond({ instrument: "BVB:NEW", issued: null });
    expect(read(db).holdings[0]!.stale).toEqual([NO_SCHEDULE, "no quote yet"]);
  });

  test("a merged bond keeps no schedule first whatever its purchases' order", () => {
    const { db, bond } = setup();
    instrument(db, "BVB:TWO", { currency: "EUR", unit: "percent_of_par" });
    bond({ instrument: "BVB:TWO" });
    bond({ instrument: "BVB:TWO", issued: null });
    expect(read(db).holdings[0]!.stale).toEqual([NO_SCHEDULE, "no quote yet"]);
  });

  test("a merged bond sums its purchases; the totals take the earliest day", () => {
    const { db, bond } = setup();
    instrument(db, "BVB:BND", { currency: "EUR", unit: "percent_of_par" });
    quote(db, "BVB:BND", 100, 100);
    const listed = {
      instrument: "BVB:BND",
      coupon: 5,
      couponsPerYear: 2,
      maturity: "2030-04-15",
      issued: "2020-04-15",
    };
    bond({ ...listed, amount: 1000, cost: 1000, asOf: "2026-01-10" });
    bond({ ...listed, amount: 3400, cost: 3400, asOf: "2026-05-12" });
    bond({ name: "Made Up 2032 B", maturity: "2032-12-01" });
    const h = read(db);
    const merged = h.holdings.find((r) => r.id === "BVB:BND")!;
    // 8 of the 182 days from 15 Oct to 15 Apr
    expect(merged).toMatchObject({
      position: null,
      clean_value: 4400,
      accrued: Number(((110 * 8) / 182).toFixed(2)),
      // the first purchase had April's and October's, the second October's
      coupons_paid: 135,
      next_payout: { date: "2027-04-15", amount: 110 },
      value: 4404.84,
      pl: 139.84,
    });
    expect(merged.parts.map((p) => p.value)).toEqual([1001.1, 3403.74]);
    expect(merged.parts.map((p) => p.coupons_paid)).toEqual([50, 85]);
    expect(h.totals[0]!.next_payout).toEqual({
      date: "2026-12-01",
      amount: 360,
    });
  });

  test("a bond in another currency converts its coupons at today's rate", () => {
    const { db, bond } = setup();
    upsertInstrument(
      db,
      {
        market: "CCY",
        symbol: "USDEUR=X",
        source: "yahoo",
        sourceSymbol: "USDEUR=X",
        exchange: "CCY",
        name: "USDEUR=X",
        type: "CURRENCY",
        currency: "EUR",
        unit: "per_unit",
        zone: "UTC",
      },
      NOW,
    );
    bar(db, "CCY:USDEUR=X", "1d", "2026-08-12", 0.8, true);
    quote(db, "CCY:USDEUR=X", 0.9, 0.9);
    bond({ currency: "USD" });
    const h = read(db);
    const row = h.holdings[0]!;
    // value and coupons at 0.9, cost at the purchase day's 0.8
    expect(row.converted).toMatchObject({
      value: 7215.09,
      cost: 6640,
      pl: 899.09,
    });
    expect(h.converted).toMatchObject({
      value: 7215.09,
      pl: 899.09,
      next_payout: { date: "2027-10-06", amount: 324 },
    });
    expect(h.totals[0]).toMatchObject({
      currency: "USD",
      next_payout: { date: "2027-10-06", amount: 360 },
    });
  });
});

describe("growth and net worth", () => {
  test("growth's bond adds the day's accrued to its value, coupons to its gain", () => {
    const { db, bonds, bond } = setup();
    bond({});
    const g = growth(
      db,
      { ...scope(db, bonds), currency: "EUR" },
      LIVE,
      NOW,
      EVERY,
    );
    const on = (d: string) => g.points.find((p) => p.date === d)!;
    expect(on("2026-08-12")).toEqual({
      date: "2026-08-12",
      value: 8305.75,
      invested: 8300,
      gain: 5.75,
    });
    expect(on("2026-10-05").value).toBe(8359.01);
    expect(on("2026-10-06")).toEqual({
      date: "2026-10-06",
      value: 8000,
      invested: 8300,
      gain: 60,
    });
    expect(g.points.at(-1)).toEqual({
      date: LIVE,
      value: 8016.77,
      invested: 8300,
      gain: 76.77,
    });
    expect(g.points.at(-1)!.gain).toBe(read(db, bonds).converted!.pl!);
  });

  test("net worth counts a bond's accrued, never its coupons", () => {
    const { db, bond } = setup();
    bond({});
    insertPosition(
      db,
      {
        portfolio: cashPortfolio(db, OPERATOR)!.id,
        kind: "cash",
        name: "Made-up account",
        currency: "EUR",
        instrument: null,
        amount: 100,
        cost: null,
        coupon: null,
        maturity: null,
        asOf: "2026-09-01",
        broker: null,
        note: null,
        dryPowder: false,
        replaces: null,
        enteredBy: "test",
      },
      NOW - 60 * DAY,
    );
    const n = netWorth(
      db,
      {
        owner: OPERATOR,
        portfolios: listPortfolios(db, OPERATOR),
        brokers: listBrokers(db, OPERATOR),
        currency: "EUR",
        zone: "UTC",
      },
      LIVE,
      NOW,
      EVERY,
    );
    const on = (d: string) => n.points.find((p) => p.date === d)!;
    expect(on("2026-10-05")).toEqual({
      date: "2026-10-05",
      invested: 8359.01,
      cash: 100,
      total: 8459.01,
    });
    expect(on("2026-10-06").total).toBe(8100);
    expect(n.points.at(-1)).toEqual({
      date: LIVE,
      invested: 8016.77,
      cash: 100,
      total: 8116.77,
    });
  });
});

const AGENT: Who = {
  name: "made-up-agent",
  user: OPERATOR,
  credential: { kind: "key", id: "made-up-agent" },
  portfolio: "write",
  alerts: "none",
  profile: "none",
  analysis: "none",
  tradePlans: "none",
};

describe("portfolio_bond's schedule", () => {
  test("is set on add, changed or cleared on update, and checked", async () => {
    const { m } = world();
    await saveSettings(m, OPERATOR, { display_currency: "EUR" });
    await createPortfolio(m, OPERATOR, { name: "Bonds" });
    const tool = (args: object) => ask(m, AGENT, "portfolio_bond", args);
    const add = {
      action: "add",
      name: "Made Up 2032",
      amount: 8000,
      currency: "EUR",
      coupon: 4.5,
      maturity: "2032-10-06",
      cost: 8300,
      date: "2026-08-12",
    };
    const made = await tool({
      ...add,
      coupons_per_year: 1,
      issued: "2022-10-06",
    });
    expect(made.body.position).toMatchObject({
      coupons_per_year: 1,
      issued: "2022-10-06",
    });
    const held = await ask(m, AGENT, "portfolio", { action: "holdings" });
    expect(held.body.holdings[0]).toMatchObject({
      accrued: 16.77,
      coupons_paid: 360,
      value: 8016.77,
    });
    const id = made.body.position.position as number;
    const cleared = await tool({
      action: "update",
      position: id,
      issued: null,
    });
    expect(cleared.body.position).toMatchObject({
      coupons_per_year: 1,
      issued: null,
    });
    const set = await tool({
      action: "update",
      position: cleared.body.position.position,
      coupons_per_year: "2",
      issued: "2022-10-06",
    });
    expect(set.body.position).toMatchObject({
      coupons_per_year: 2,
      issued: "2022-10-06",
    });
    const three = await tool({ ...add, name: "Other", coupons_per_year: 3 });
    expect(three.body.message).toBe("coupons_per_year must be 1, 2, 4");
    const late = await tool({ ...add, name: "Other", issued: "2033-01-01" });
    expect(late.body.message).toBe("issued must be before maturity");
    const lateUpdate = await tool({
      action: "update",
      position: set.body.position.position,
      issued: "2032-10-06",
    });
    expect(lateUpdate.body.message).toBe("issued must be before maturity");
  });

  test("REST answers the figures as its spec says", async () => {
    const { m, bond } = setup();
    bond({});
    bond({ name: "Made Up 2033", issued: null });
    const res = await api(m)(
      new Request("http://markets.test/api/v1/holdings", {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      }),
    );
    const body = await res.json();
    expect(
      validate(body, answerSchema(spec, "GET", "/holdings", 200)!, spec),
    ).toEqual([]);
    expect(body.totals[0].next_payout).toEqual({
      date: "2027-10-06",
      amount: 360,
    });
  });

  test("buying more of a held bond takes its schedule", async () => {
    const { m } = world();
    await saveSettings(m, OPERATOR, { display_currency: "EUR" });
    await createPortfolio(m, OPERATOR, { name: "Bonds" });
    instrument(m.db, "BVB:BND", { currency: "EUR", unit: "percent_of_par" });
    quote(m.db, "BVB:BND", 100, 100);
    const tool = (args: object) =>
      ask(m, AGENT, "portfolio_bond", {
        action: "add",
        amount: 1000,
        currency: "EUR",
        coupon: 5,
        maturity: "2030-04-15",
        cost: 1000,
        ...args,
      });
    await tool({
      name: "Made Up 2030",
      symbol: "BVB:BND",
      date: "2026-01-10",
      coupons_per_year: 2,
      issued: "2020-04-15",
    });
    const more = await tool({
      name: "Made Up 2030",
      symbol: "BVB:BND",
      date: "2026-05-12",
    });
    expect(more.body.position).toMatchObject({
      coupons_per_year: 2,
      issued: "2020-04-15",
    });
    const held = await ask(m, AGENT, "portfolio", { action: "holdings" });
    expect(held.body.holdings[0].stale).toEqual([]);
    // unlisted: the same name, broker and currency
    await tool({
      name: "Made Up Unlisted",
      date: "2026-01-10",
      coupons_per_year: 1,
      issued: "2020-04-15",
    });
    const again = await tool({ name: "made up unlisted", date: "2026-05-12" });
    expect(again.body.position).toMatchObject({
      coupons_per_year: 1,
      issued: "2020-04-15",
    });
    const other = await tool({ name: "Made Up Other", date: "2026-05-12" });
    expect(other.body.position).toMatchObject({
      coupons_per_year: null,
      issued: null,
    });
  });

  test("cash takes neither field over REST", async () => {
    const { m } = world();
    await saveSettings(m, OPERATOR, { display_currency: "EUR" });
    const handle = api(m);
    const send = (method: string, path: string, body: object) =>
      handle(
        new Request(`http://markets.test/api/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${ADMIN_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const made = await send("POST", "/positions", {
      kind: "cash",
      name: "Made-up account",
      amount: 100,
      currency: "EUR",
    });
    const { position } = (await made.json()) as { position: { id: number } };
    const res = await send("PATCH", `/positions/${position.id}`, {
      issued: "2026-01-01",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      "coupons_per_year and issued are a bond's",
    );
  });
});
