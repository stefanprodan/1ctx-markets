// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { bvb, SPACING_MS } from "../src/sources/bvb/client.ts";
import {
  optionalRoNumber,
  roClock,
  roNumber,
  roWallTime,
  statusOf,
  textOf,
} from "../src/sources/bvb/format.ts";
import {
  parseBonds,
  parseDetail,
  parseHistory,
  parseIndices,
  parseMeta,
  parseSchedule,
  parseSearch,
  parseShares,
  parseTypes,
} from "../src/sources/bvb/parse.ts";
import { SourceError } from "../src/sources/source.ts";
import {
  bvbFetch,
  bvbRecorded,
  made,
  opened,
  PAGE_KEY,
  site,
  wapi,
} from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { gate } from "./helpers/sources.ts";
import { clone, fakeFetch } from "./helpers/yahoo.ts";

const wall = (iso: string) => Date.parse(`${iso}Z`);
const page = async (name: string) => (await bvbRecorded(name)).body as string;

describe("Romanian formats", () => {
  test("numbers take a thousands dot and a decimal comma", () => {
    expect(roNumber("34.678,23", "x")).toBe(34678.23);
    expect(roNumber("-0,60", "x")).toBe(-0.6);
    expect(roNumber("1.247.586.650", "x")).toBe(1247586650);
    expect(roNumber("36,1800", "x")).toBe(36.18);
    expect(optionalRoNumber(" ", "x")).toBeNull();
    for (const bad of ["34,678.23", "1.2", "1,2,3", "", "0x10", "12a"]) {
      expect(() => roNumber(bad, "x")).toThrow("malformed answer");
    }
  });

  test("times are local wall times, never instants", () => {
    expect(roWallTime("23.10.2026 17:59", "x")).toBe(
      wall("2026-10-23T17:59:00"),
    );
    expect(roWallTime("23.10.2026 17:59:45", "x")).toBe(
      wall("2026-10-23T17:59:45"),
    );
    for (const bad of ["31.02.2026 10:00", "23.10.2026 25:00", "2026-10-23"]) {
      expect(() => roWallTime(bad, "x")).toThrow("malformed answer");
    }
    expect(roClock("17:45", "x")).toBe((17 * 60 + 45) * 60_000);
  });

  test("a cell's text drops tags and reads entities", () => {
    expect(textOf("<b>TLV</b>&nbsp;<p>RO&amp;1</p>")).toBe("TLV RO&1");
    expect(textOf("&#174; &#xAE;")).toBe("® ®");
  });

  test("the market status is closed only when it says so", () => {
    expect(statusOf('<span id="statusMarket">INCHISA</span>')).toBe("closed");
    expect(statusOf('<span id="statusMarket">DESCHISA</span>')).toBe("open");
    expect(() => statusOf("<div></div>")).toThrow("malformed answer");
  });
});

describe("recorded pages", () => {
  test("the shares list gives each share's price and last trade time", async () => {
    const p = parseShares(await page("shares-list"), 1);
    expect(p.status).toBe("closed");
    expect(p.currency).toBe("RON");
    expect(p.rows.length).toBeGreaterThan(50);
    expect(p.rows[0]).toEqual({
      symbol: "TLV",
      isin: "ROTLVAACNOR1",
      name: "BANCA TRANSILVANIA S.A.",
      price: 36.18,
      at: wall("2026-10-23T17:59:00"),
    });
    const symbols = p.rows.map((r) => r.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  test("bonds are in percent of par with their issue currency", async () => {
    const p = parseBonds(await page("bonds-list"), 1);
    const r2807a = p.rows.find((r) => r.symbol === "R2807A")!;
    expect(r2807a).toMatchObject({
      price: 98.9999,
      currency: "RON",
      at: wall("2026-10-23T18:00:00"),
    });
    expect(p.rows.find((r) => r.symbol === "R3601AE")!.currency).toBe("EUR");
    // a bond that has not traded has no price and no time
    const blank = p.rows.find((r) => r.symbol === "R3010A")!;
    expect(blank.price).toBeNull();
    expect(blank.at).toBeNull();
  });

  test("the index table gives each value and its exact change", async () => {
    const p = parseIndices(await page("markets-today"), 1);
    expect(p.rows.length).toBe(13);
    expect(p.rows[0]).toEqual({
      symbol: "BET",
      value: 34678.23,
      change: -339.79,
    });
    expect(p.rows.map((r) => r.symbol)).toContain("BETPlus");
  });

  test("an instrument page gives the previous close and the last trade", async () => {
    const d = parseDetail(await page("detail-tlv"), 1);
    expect(d).toEqual({
      status: "closed",
      symbol: "TLV",
      isin: "ROTLVAACNOR1",
      name: "BANCA TRANSILVANIA S.A.",
      kind: "Actiuni",
      tradable: true,
      price: 36.18,
      at: wall("2026-10-23T17:59:45"),
      reference: 36.4,
      high: 36.4,
      low: 35.94,
      fetchedAt: 1,
    });
    const bond = parseDetail(await page("detail-bond-r2807a"), 1);
    expect(bond).toMatchObject({
      kind: "Obligatiuni",
      price: 98.9999,
      reference: 98.5001,
    });
  });

  test("an unknown instrument's page is not found", async () => {
    const html = await page("detail-unknown");
    expect(() => parseDetail(html, 1)).toThrow(new SourceError("not found"));
  });

  test("the schedule page gives a session ending at 18:00", async () => {
    const s = parseSchedule(await page("trading-schedule"), 1);
    expect(s).toEqual({
      status: "closed",
      start: 10 * 60 * 60_000,
      end: 18 * 60 * 60_000,
      fetchedAt: 1,
    });
  });

  test("a page without its table or rows fails, never empty rows", async () => {
    const html = await page("shares-list");
    const noTable = html.replace('id="gv"', 'id="other"');
    expect(() => parseShares(noTable, 1)).toThrow("malformed answer");
    const empty = html.replace(/<tbody>[\s\S]*<\/tbody>/, "<tbody></tbody>");
    expect(() => parseShares(empty, 1)).toThrow("malformed answer");
    const renamed = html.replace("Pret (RON)", "Valoare");
    expect(() => parseShares(renamed, 1)).toThrow("malformed answer");
    const noStatus = html.replace(/<span id="statusMarket">[^<]*<\/span>/, "");
    expect(() => parseShares(noStatus, 1)).toThrow("malformed answer");
    const badPrice = html.replace(">36,1800<", ">36.1800,0<");
    expect(() => parseShares(badPrice, 1)).toThrow("malformed answer");
  });
});

describe("recorded chart feed answers", () => {
  test("daily bars are dated by their UTC midnight and filtered by t", async () => {
    const body = (await bvbRecorded("wapi-history-tlv-1d")).body;
    const all = parseHistory(body, 0, Infinity, 1);
    expect(all.bars.length).toBe(30);
    expect(all.bars[0]).toEqual({
      date: "2026-09-14",
      open: 34.52,
      high: 34.86,
      low: 34.28,
      close: 34.54,
      volume: 346819,
    });
    expect(all.bars.at(-1)!.date).toBe("2026-10-23");
    // countback answers bars before from, which are dropped
    const since = parseHistory(
      body,
      Date.parse("2026-10-20T00:00:00Z"),
      Infinity,
      1,
    );
    expect(since.bars.map((b) => b.date)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    // and bars after to
    const until = parseHistory(
      body,
      Date.parse("2026-10-16T00:00:00Z"),
      Date.parse("2026-10-20T12:00:00Z"),
      1,
    );
    expect(until.bars.map((b) => b.date)).toEqual([
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]);
  });

  test("an index has no volume and an unknown symbol is not found", async () => {
    const bet = parseHistory(
      (await bvbRecorded("wapi-history-bet-1d")).body,
      0,
      Infinity,
      1,
    );
    expect(bet.bars.every((b) => b.volume === null)).toBe(true);
    const unknown = (await bvbRecorded("wapi-history-unknown")).body;
    expect(() => parseHistory(unknown, 0, Infinity, 1)).toThrow(
      new SourceError("not found"),
    );
  });

  test("bars off midnight, out of order or short fail the answer", async () => {
    const body = (await bvbRecorded("wapi-history-tlv-1d")).body;
    const off = clone(body);
    off.t[3] += 3600;
    expect(() => parseHistory(off, 0, Infinity, 1)).toThrow("malformed answer");
    const twice = clone(body);
    twice.t[3] = twice.t[2];
    expect(() => parseHistory(twice, 0, Infinity, 1)).toThrow(
      "malformed answer",
    );
    const short = clone(body);
    short.c.pop();
    expect(() => parseHistory(short, 0, Infinity, 1)).toThrow(
      "malformed answer",
    );
  });

  test("the symbol answer names the type, zone and currency", async () => {
    expect(parseMeta((await bvbRecorded("wapi-symbols-tlv")).body)).toEqual({
      symbol: "TLV",
      name: "BANCA TRANSILVANIA S.A.",
      type: "Shares",
      currency: "RON",
      zone: "Europe/Bucharest",
      expired: false,
    });
    const bet = parseMeta((await bvbRecorded("wapi-symbols-bet")).body);
    expect(bet).toMatchObject({ type: "index", currency: null });
    expect(
      parseMeta((await bvbRecorded("wapi-symbols-r2807a")).body).type,
    ).toBe("Bonds");
  });

  test("the instrument search lists symbol, ISIN, name and status", async () => {
    const found = parseSearch(
      (await bvbRecorded("instruments-autocomplete-petrom")).body,
    );
    expect(found.length).toBe(10);
    expect(found[0]).toEqual({
      symbol: "SNP",
      isin: "ROSNPPACNOR9",
      name: "OMV PETROM S.A.",
      status: "T",
    });
  });

  test("the chart feed's search names each listing's type", async () => {
    const types = parseTypes(
      (await bvbRecorded("wapi-search-transilvania")).body,
    );
    expect(types.get("TLV")).toBe("Shares");
    expect(types.get("TLV32")).toBe("Bonds");
    expect(types.get("EBTLVTL19")).toBe("Structured");
    const units = parseTypes((await bvbRecorded("wapi-search-btbetretf")).body);
    expect([...units]).toEqual([["BTBETRETF", "Units"]]);
    // a refused search answers a bare string
    const refused = (await bvbRecorded("wapi-search-limit-31")).body;
    expect(() => parseTypes(refused)).toThrow("malformed answer");
  });
});

describe("the client", () => {
  test("calls go one at a time, spaced, with the Referer and the page key", async () => {
    const clock = fakeClock();
    const f = await bvbFetch();
    const starts: number[] = [];
    const client = bvb({
      clock,
      fetch: (url, init) => {
        starts.push(clock.now());
        return f.fetch(url, init);
      },
    });
    const detail = await drive(clock, client, client.detail("TLV"));
    expect(detail.reference).toBe(36.4);
    const t0 = clock.now();
    const history = await drive(
      clock,
      client,
      client.history("TLV", "RON", t0 - 45 * 86_400_000, t0),
    );
    expect(history.bars.length).toBe(30);
    expect(starts[1]! - starts[0]!).toBe(SPACING_MS);
    const [h] = wapi(f.urls, "/api/history");
    expect(h!.searchParams.get("ajust")).toBe("1");
    expect(h!.searchParams.get("currencyCode")).toBe("RON");
    // the window's weekdays and a margin, never one a calendar day
    const countback = Number(h!.searchParams.get("countback"));
    expect(countback).toBeGreaterThanOrEqual(33);
    expect(countback).toBeLessThan(45);
    const sent = f.headers[f.urls.indexOf(h!)]!;
    expect(sent.get("referer")).toBe("https://bvb.ro/");
    expect(sent.get("x-sk-api")).toBe(PAGE_KEY);
    expect(client.due()).toBeNull();
  });

  test("a 401 fetches a fresh key once", async () => {
    const clock = fakeClock();
    const recordedHistory = await bvbRecorded("wapi-history-tlv-1d");
    // never recorded: a 401 is built from the recorded answer's shape
    const refused = made(401, { message: "Unauthorized" });
    let asked = 0;
    const f = fakeFetch(async (url) => {
      if (url.hostname === "wapi.bvb.ro") {
        asked++;
        return asked === 1 ? refused : recordedHistory;
      }
      if (url.pathname.endsWith("FinancialInstrumentsDetails.aspx")) {
        const fx = await bvbRecorded("detail-tlv");
        return {
          ...fx,
          body: `<script>var sk = 'fresh-key';</script>${fx.body}`,
        };
      }
      return undefined;
    });
    const client = bvb({ clock, fetch: f.fetch });
    const now = clock.now();
    const h = await drive(clock, client, client.history("TLV", "RON", 0, now));
    expect(h.bars.length).toBe(30);
    expect(f.urls.map((u) => u.hostname)).toEqual([
      "wapi.bvb.ro",
      "bvb.ro",
      "wapi.bvb.ro",
    ]);
    expect(f.headers[0]!.get("x-sk-api")).toBeNull();
    expect(f.headers[2]!.get("x-sk-api")).toBe("fresh-key");

    // refused again after the fresh key: the key is refused, once
    asked = -10;
    const again = fakeFetch(async (url) =>
      url.hostname === "wapi.bvb.ro"
        ? refused
        : {
            ...(await bvbRecorded("detail-tlv")),
            body: "<script>var sk = 'k';</script>",
          },
    );
    const other = bvb({ clock, fetch: again.fetch });
    await expect(
      drive(clock, other, other.history("TLV", "RON", 0, now)),
    ).rejects.toThrow(new SourceError("key refused"));
    expect(again.urls.length).toBe(3);
    // the final refusal backs the queue off like any other
    await expect(
      drive(clock, other, other.failFast().shares()),
    ).rejects.toThrow("backing off");
    expect(again.urls.length).toBe(3);
  });

  test("ten years ask about 252 trading days a year, not a bar a day", async () => {
    const clock = fakeClock();
    const f = await bvbFetch();
    const client = bvb({ clock, fetch: f.fetch });
    const now = clock.now();
    await drive(
      clock,
      client,
      client.history("TLV", "RON", now - 3653 * 86_400_000, now),
    );
    const [h] = wapi(f.urls, "/api/history");
    const countback = Number(h!.searchParams.get("countback"));
    // at least every weekday of the window, far short of 3653
    expect(countback).toBeGreaterThanOrEqual(2609);
    expect(countback).toBeLessThan(2700);
  });

  test("a call with a deadline goes ahead of queued job calls", async () => {
    const clock = fakeClock();
    const g = gate();
    const f = await bvbFetch({
      hold: (url) =>
        url.pathname === "/TradingAndStatistics/TradingSessionSchedule"
          ? g.hold()
          : undefined,
    });
    const client = bvb({ clock, fetch: f.fetch });
    const job = client.schedule();
    await drive(clock, client, g.arrived);
    const queued = [client.shares(), client.bonds()];
    const read = client.within(() => true).indices();
    g.release();
    await drive(clock, client, Promise.all([job, read, ...queued]));
    expect(f.urls.map((u) => u.pathname)).toEqual([
      "/TradingAndStatistics/TradingSessionSchedule",
      "/TradingAndStatistics/Trading/MarketsToday",
      "/FinancialInstruments/Markets/Shares",
      "/FinancialInstruments/Markets/Bonds",
    ]);
  });

  test("an open market reads open on every page", async () => {
    const clock = fakeClock();
    const f = await bvbFetch({ open: true });
    const client = bvb({ clock, fetch: f.fetch });
    const s = await drive(clock, client, client.schedule());
    expect(s.status).toBe("open");
    const shares = await drive(clock, client, client.shares());
    expect(shares.status).toBe("open");
    expect(opened(await bvbRecorded("bonds-list")).body).toContain("DESCHISA");
    expect(site(f.urls, "/FinancialInstruments/Markets/Shares").length).toBe(1);
  });

  test("the search posts the text and keeps every listing", async () => {
    const clock = fakeClock();
    const f = await bvbFetch();
    const client = bvb({ clock, fetch: f.fetch });
    const found = await drive(clock, client, client.search("petrom"));
    expect(found.map((l) => l.symbol)).toContain("SNP");
    expect(f.bodies.at(-1)).toBe(JSON.stringify({ searchtext: "petrom" }));
    expect(await drive(clock, client, client.search("nothing"))).toEqual([]);
    const types = await drive(clock, client, client.types("petrom", "SNP"));
    expect(types.get("SNP")).toBe("Shares");
    const asked = wapi(f.urls, "/api/search").at(-1)!;
    expect(asked.searchParams.get("query")).toBe("petrom");
    expect(asked.searchParams.get("limit")).toBe("30");
  });

  test("a failed call backs off and a tool fails fast meanwhile", async () => {
    const clock = fakeClock();
    const f = fakeFetch(() => made(503, "down"));
    const client = bvb({ clock, fetch: f.fetch });
    await expect(drive(clock, client, client.shares())).rejects.toThrow(
      "source error",
    );
    await expect(client.failFast().shares()).rejects.toThrow("backing off");
    expect(f.urls.length).toBe(1);
  });
});
