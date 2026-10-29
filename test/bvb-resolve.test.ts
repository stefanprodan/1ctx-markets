// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readInstrument, upsertInstrument } from "../src/market/instruments.ts";
import { markets } from "../src/operations/markets.ts";
import { searchPage } from "../src/operations/search.ts";
import { readTargets, type Target } from "../src/operations/targets.ts";
import { MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import { bvb } from "../src/sources/bvb/client.ts";
import { bvbJobs } from "../src/sources/bvb/jobs.ts";
import { findListings, storeListings } from "../src/sources/bvb/listings.ts";
import { NO_DATA } from "../src/sources/bvb/sync.ts";
import type { Fetch } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { api } from "./helpers/api.ts";
import { bvbAnswer, bvbRecorded, made } from "./helpers/bvb.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import { NOW, sources } from "./helpers/sources.ts";
import { clone, listed, type Recorded, recorded } from "./helpers/yahoo.ts";

// a made-up US listing named TLV, built from the recorded NVDA chart
async function usTlv(): Promise<Recorded> {
  const fx = listed(clone(await recorded("chart-nvda-5y-1d")));
  const meta = fx.body.chart.result[0].meta;
  meta.symbol = "TLV";
  meta.longName = "Example Holdings";
  return fx;
}

// the recorded TLV search with the made-up US listing added
async function tlvSearch(): Promise<Recorded> {
  const fx = clone(await recorded("search-tlv"));
  fx.body.quotes.push({
    symbol: "TLV",
    exchange: "NMS",
    quoteType: "EQUITY",
    longname: "Example Holdings",
    isYahooFinance: true,
  });
  return fx;
}

// the exchange's search answer for TLV, in the recorded answer's shape:
// one tradable listing and a delisted one
async function bvbTlvSearch(): Promise<Recorded> {
  const fx = clone(await bvbRecorded("instruments-autocomplete-petrom"));
  fx.body.d = [
    {
      Symbol: "TLV",
      Isin: "ROTLVAACNOR1",
      Name: "BANCA TRANSILVANIA S.A.",
      Status: "T",
    },
    { Symbol: "TLVX", Isin: "ROTLVXACNOR0", Name: "OLD LISTING", Status: "D" },
  ];
  return fx;
}

// withoutRo: Yahoo's top results leave the Bucharest listing out
async function setup(feed: boolean, withoutRo = false) {
  const clock = fakeClock(NOW);
  const { db } = open(":memory:", clock);
  const search = await tlvSearch();
  if (withoutRo) {
    search.body.quotes = search.body.quotes.filter(
      (q: { symbol: string }) => !q.symbol.endsWith(".RO"),
    );
  }
  const s = await sources({
    charts: {
      TLV: await usTlv(),
      "TLV.RO": listed(await recorded("chart-tlv-ro-bonus-2026")),
    },
    hold: (url) =>
      url.pathname === "/v1/finance/search" &&
      url.searchParams.get("q")?.toUpperCase() === "TLV"
        ? Promise.resolve(search)
        : undefined,
  });
  const exchangeSearch = await bvbTlvSearch();
  const urls: URL[] = [];
  const fetch: Fetch = async (raw, init) => {
    const url = new URL(raw);
    if (url.hostname !== "bvb.ro" && url.hostname !== "wapi.bvb.ro") {
      return s.fetch(raw, init);
    }
    urls.push(url);
    let answer: Recorded | undefined;
    if (url.pathname === "/proxyshld.aspx/GetInstrumentsList") {
      const text = JSON.parse(String(init.body)).searchtext as string;
      answer = /^tlv/i.test(text)
        ? exchangeSearch
        : /petrom/i.test(text)
          ? await bvbRecorded("instruments-autocomplete-petrom")
          : /btbetretf/i.test(text)
            ? await bvbRecorded("instruments-autocomplete-btbetretf")
            : made(200, { d: [] });
    } else {
      answer = await bvbAnswer(url);
    }
    if (answer === undefined) throw new Error(`no fixture for ${raw}`);
    const body =
      typeof answer.body === "string"
        ? answer.body
        : JSON.stringify(answer.body);
    return new Response(body, {
      status: answer.status,
      headers: answer.headers,
    });
  };
  const w = writer(db);
  const exchange = feed
    ? bvb({
        clock,
        fetch,
        onList: (kind, rows, at) =>
          w.write((db) => storeListings(db, kind, rows, at)),
      })
    : null;
  const m = markets({
    db,
    clock,
    writer: w,
    yahoo: yahoo({ clock, fetch }),
    fred: null,
    bvb: exchange,
    log: silent,
  });
  const read = (inputs: string[]) =>
    exchange === null
      ? readTargets(m, inputs)
      : drive(clock, exchange, readTargets(m, inputs));
  // every list page, as the jobs read them each exchange day
  const lists = async () => {
    const reads: (() => Promise<unknown>)[] = [
      () => exchange!.shares(),
      () => exchange!.units(),
      () => exchange!.bonds(),
      () => exchange!.indices(),
    ];
    for (const read of reads) {
      await drive(clock, exchange!, read());
    }
  };
  const find = async (query: string) => {
    const before = urls.length;
    const page = JSON.parse(await searchPage(m, { query, next: null }));
    return { page, asked: urls.slice(before) };
  };
  return {
    clock,
    db,
    w,
    m,
    read,
    urls,
    calls: s.calls,
    exchange,
    lists,
    find,
  };
}

const idOf = (t: Target | undefined) =>
  t !== undefined && "instrument" in t ? t.instrument.id : null;
const errorOf = (t: Target | undefined) =>
  t !== undefined && "error" in t ? t.error : null;

describe("REST's bare symbol, with the feed on", () => {
  const rest = (t: Awaited<ReturnType<typeof setup>>) => {
    const m = { ...t.m, yahooFirst: true };
    return {
      read: (inputs: string[]) =>
        drive(t.clock, t.exchange!, readTargets(m, inputs)),
      call: async (path: string, init: RequestInit = {}) =>
        drive(
          t.clock,
          t.exchange!,
          api(t.m)(new Request(`http://markets.test/api/v1${path}`, init)),
        ),
    };
  };

  test("is Yahoo's exact listing, though the feed's is stored alone", async () => {
    const t = await setup(true);
    const [b] = await t.read(["BVB:TLV"]);
    expect(idOf(b)).toBe("BVB:TLV");
    const [bare] = await rest(t).read(["TLV"]);
    expect(idOf(bare)).toBe("US:TLV");
    expect(readInstrument(t.db, "US:TLV")!.source).toBe("yahoo");
  });

  test("is Yahoo's with both stored, on every route; MCP still answers both", async () => {
    const t = await setup(true);
    await t.read(["BVB:TLV", "US:TLV"]);
    const r = rest(t);
    const [bare, ro, prefixed] = await r.read(["TLV", "TLV.RO", "BVB:TLV"]);
    expect([idOf(bare), idOf(ro), idOf(prefixed)]).toEqual([
      "US:TLV",
      "BVB:TLV",
      "BVB:TLV",
    ]);
    const [mcp] = await t.read(["TLV"]);
    expect(errorOf(mcp)?.error).toBe("candidates");
    const quotes: any = await (
      await r.call("/quotes?symbols=TLV,TLV.RO,BVB:TLV")
    ).json();
    expect(quotes.quotes.map((q: any) => q.id)).toEqual([
      "US:TLV",
      "BVB:TLV",
      "BVB:TLV",
    ]);
    for (const path of ["/instruments/TLV", "/instruments/TLV/bars"]) {
      const res = await r.call(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(((await res.json()) as any).instrument.id).toBe("US:TLV");
    }
    // stored only, so the stored Yahoo listing; nothing is asked
    const asked = t.calls.urls.length + t.urls.length;
    const gone = await r.call("/instruments/TLV", { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(t.calls.urls.length + t.urls.length).toBe(asked);
    expect(readInstrument(t.db, "US:TLV")).toBeNull();
    expect(readInstrument(t.db, "BVB:TLV")).not.toBeNull();
  });

  test("a failed Yahoo lookup never answers the feed's stored listing of the code", async () => {
    const t = await setup(true);
    const [b] = await t.read(["BVB:TLV"]);
    expect(idOf(b)).toBe("BVB:TLV");
    const down = {
      ...t.m,
      yahoo: yahoo({
        clock: t.clock,
        fetch: async () => {
          throw new Error("offline");
        },
      }).failFast(),
    };
    const res = await drive(
      t.clock,
      t.exchange!,
      api(down)(new Request("http://markets.test/api/v1/instruments/TLV")),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "source_error",
      input: "TLV",
    });
  });

  test("delete and refetch take a .RO symbol as the feed's stored row, asking nothing", async () => {
    const t = await setup(true);
    await t.read(["BVB:TLV"]);
    expect(readInstrument(t.db, "BVB:TLV")!.source).toBe("bvb");
    const r = rest(t);
    const asked = t.calls.urls.length + t.urls.length;
    const again = await r.call("/instruments/TLV.RO/refetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: ["calendar"] }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      input: "TLV.RO",
      id: "BVB:TLV",
    });
    const gone = await r.call("/instruments/tlv.ro", { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(readInstrument(t.db, "BVB:TLV")).toBeNull();
    expect(t.calls.urls.length + t.urls.length).toBe(asked);
  });

  test("is the feed's when only the feed lists it", async () => {
    const t = await setup(true);
    const [etf] = await rest(t).read(["BTBETRETF"]);
    expect(idOf(etf)).toBe("BVB:BTBETRETF");
  });
});

describe("resolution with the feed on", () => {
  test("BVB:TLV and US:TLV stay apart", async () => {
    const t = await setup(true);
    // a bare TLV is exact on both, so it answers both as candidates
    const [first] = await t.read(["TLV"]);
    expect(
      errorOf(first)
        ?.candidates?.map((c) => c.id)
        .sort(),
    ).toEqual(["BVB:TLV", "US:TLV"]);
    const [b, u] = await t.read(["BVB:TLV", "US:TLV"]);
    expect(idOf(b)).toBe("BVB:TLV");
    expect(idOf(u)).toBe("US:TLV");
    expect(readInstrument(t.db, "BVB:TLV")).toMatchObject({
      source: "bvb",
      sourceSymbol: "TLV",
    });
    expect(readInstrument(t.db, "US:TLV")).toMatchObject({
      source: "yahoo",
      sourceSymbol: "TLV",
    });
    // and so once both are stored
    const [bare] = await t.read(["TLV"]);
    expect(errorOf(bare)?.error).toBe("candidates");
    expect(
      errorOf(bare)
        ?.candidates?.map((c) => c.id)
        .sort(),
    ).toEqual(["BVB:TLV", "US:TLV"]);
  });

  test("a symbol Yahoo names exactly, absent from the exchange's lists, asks no exchange search", async () => {
    const t = await setup(true);
    // quote passes read every list, so the exchange's symbols are known
    await drive(t.clock, t.exchange!, t.exchange!.shares());
    await drive(t.clock, t.exchange!, t.exchange!.units());
    await drive(t.clock, t.exchange!, t.exchange!.bonds());
    await drive(t.clock, t.exchange!, t.exchange!.indices());
    const [nvda] = await t.read(["NVDA"]);
    expect(idOf(nvda)).toBe("US:NVDA");
    expect(
      t.urls.filter((u) => u.pathname === "/proxyshld.aspx/GetInstrumentsList"),
    ).toEqual([]);
  });

  test("the feed's jobs read the lists with nothing tracked, so a new symbol asks no exchange search", async () => {
    for (const ticked of [false, true]) {
      const t = await setup(true);
      const jobs = bvbJobs({
        ctx: { db: t.db, clock: t.clock, bvb: t.exchange!, writer: t.w },
        quoteEveryMs: 5 * MINUTE_MS,
        log: silent,
      });
      // before the jobs' first tick the lists are unread: the exchange is asked
      if (ticked) await drive(t.clock, t.exchange!, jobs.quoteTick());
      const before = t.urls.length;
      expect(idOf((await t.read(["NVDA"]))[0])).toBe("US:NVDA");
      expect(t.urls.slice(before).map((u) => u.pathname)).toEqual(
        ticked ? [] : ["/proxyshld.aspx/GetInstrumentsList"],
      );
    }
  });

  test("with a list page unread, a symbol Yahoo names exactly still asks the exchange", async () => {
    const t = await setup(true);
    await drive(t.clock, t.exchange!, t.exchange!.shares());
    await t.read(["NVDA"]);
    expect(
      t.urls.filter((u) => u.pathname === "/proxyshld.aspx/GetInstrumentsList"),
    ).toHaveLength(1);
  });

  test("a symbol the exchange lists is asked of it though Yahoo's results lack it", async () => {
    for (const listsRead of [false, true]) {
      const t = await setup(true, true);
      if (listsRead) {
        await drive(t.clock, t.exchange!, t.exchange!.shares());
        await drive(t.clock, t.exchange!, t.exchange!.bonds());
        await drive(t.clock, t.exchange!, t.exchange!.indices());
      }
      const [tlv] = await t.read(["TLV"]);
      expect(
        errorOf(tlv)
          ?.candidates?.map((c) => c.id)
          .sort(),
      ).toEqual(["BVB:TLV", "US:TLV"]);
    }
  });

  test("a name the exchange lists once resolves to the feed", async () => {
    const t = await setup(true);
    // Yahoo's TLV.RO names the same key, served from the feed
    const [viaYahoo] = await t.read(["TLV.RO"]);
    expect(idOf(viaYahoo)).toBe("BVB:TLV");
    expect(readInstrument(t.db, "BVB:TLV")!.source).toBe("bvb");
    expect(t.calls.charts("TLV.RO")).toHaveLength(1);
    // the bare symbol, read again, is the stored instrument
    const [again] = await t.read(["tlv"]);
    expect(idOf(again)).toBe("BVB:TLV");
  });

  test("only a tradable listing counts", async () => {
    const t = await setup(true);
    const [old] = await t.read(["TLVX"]);
    const ids = errorOf(old)?.candidates?.map((c) => c.id) ?? [];
    expect(ids).not.toContain("BVB:TLVX");
    expect(readInstrument(t.db, "BVB:TLVX")).toBeNull();
  });

  test("an index and a bond come from the feed", async () => {
    const t = await setup(true);
    const [bet, bond] = await t.read(["BVB:BET", "BVB:R2807A"]);
    expect(idOf(bet)).toBe("BVB:BET");
    expect(idOf(bond)).toBe("BVB:R2807A");
  });

  test("search lists the exchange's listings from its stored list pages, asking it nothing", async () => {
    const t = await setup(true);
    await t.lists();
    const { page, asked } = await t.find("TLV");
    expect(asked).toEqual([]);
    const bvbOnes = page.candidates.filter(
      (c: { source: string }) => c.source === "bvb",
    );
    // the exact symbol first, then the symbols it starts
    expect(bvbOnes.map((c: { id: string }) => c.id)).toEqual([
      "BVB:TLV",
      "BVB:TLV28E",
      "BVB:TLV32",
      "BVB:TLV33E",
    ]);
    expect(page.candidates.map((c: { id: string }) => c.id)).toContain(
      "US:TLV",
    );
    // the same key from Yahoo is not listed twice
    expect(
      page.candidates.filter((c: { id: string }) => c.id === "BVB:TLV"),
    ).toHaveLength(1);
  });

  test("before the list pages are first read, search lists no Bucharest listing", async () => {
    const t = await setup(true);
    const { page, asked } = await t.find("petrom");
    expect(asked).toEqual([]);
    expect(
      page.candidates.filter((c: { source: string }) => c.source === "bvb"),
    ).toEqual([]);
  });

  test("the exchange's listings match by name and ISIN and carry the list's type", async () => {
    const t = await setup(true);
    await t.lists();
    const { page } = await t.find("petrom");
    const bvbOnes = page.candidates.filter(
      (c: { source: string }) => c.source === "bvb",
    );
    expect(bvbOnes).toEqual([
      {
        id: "BVB:SNP",
        name: "OMV PETROM S.A.",
        type: "EQUITY",
        exchange: "BVB",
        source: "bvb",
        source_symbol: "SNP",
        isin: "ROSNPPACNOR9",
        stored: false,
      },
    ]);
    const byIsin = await t.find("rotlvadbc023");
    expect(byIsin.page.candidates[0]).toMatchObject({
      id: "BVB:TLV28E",
      type: "BOND",
    });
    // Yahoo's candidates have no ISIN
    expect(
      page.candidates.some(
        (c: { source: string; isin?: string }) =>
          c.source === "yahoo" && "isin" in c,
      ),
    ).toBe(false);
  });

  test("a list page read again replaces its kind's listings", () => {
    const clock = fakeClock(NOW);
    const { db } = open(":memory:", clock);
    const row = (symbol: string) => ({ symbol, isin: null, name: null });
    storeListings(db, "shares", [row("AAA"), row("BBB")], 1);
    storeListings(db, "bonds", [row("AAA30")], 1);
    storeListings(db, "shares", [row("BBB")], 2);
    expect(findListings(db, "a", 10).map((l) => l.symbol)).toEqual(["AAA30"]);
    expect(findListings(db, "b", 10)).toEqual([
      { symbol: "BBB", isin: null, name: null, type: "EQUITY" },
    ]);
  });

  test("a fund unit resolves to the feed and searches as an ETF", async () => {
    const t = await setup(true);
    await t.lists();
    const [etf] = await t.read(["BTBETRETF"]);
    expect(idOf(etf)).toBe("BVB:BTBETRETF");
    expect(readInstrument(t.db, "BVB:BTBETRETF")).toMatchObject({
      source: "bvb",
      type: "ETF",
      unit: "per_share",
    });
    const page = JSON.parse(
      await drive(
        t.clock,
        t.exchange!,
        searchPage(t.m, { query: "BTBETRETF", next: null }),
      ),
    );
    expect(page.candidates).toContainEqual({
      id: "BVB:BTBETRETF",
      name: "FONDUL DESCHIS DE INVESTITII BT INDEX ROMANIA ETF BET TR",
      type: "ETF",
      exchange: "BVB",
      source: "bvb",
      source_symbol: "BTBETRETF",
      isin: "ROGEF1KGQBE5",
      stored: true,
    });
  });
});

describe("resolution with the feed off", () => {
  test("search lists no stored Bucharest listing", async () => {
    const t = await setup(false);
    storeListings(
      t.db,
      "shares",
      [{ symbol: "TLV", isin: null, name: "BANCA TRANSILVANIA S.A." }],
      0,
    );
    const { page } = await t.find("transilvania");
    expect(
      page.candidates.filter((c: { source: string }) => c.source === "bvb"),
    ).toEqual([]);
  });

  test("a Bucharest name resolves through Yahoo under the same key", async () => {
    const t = await setup(false);
    const [tlv] = await t.read(["TLV.RO"]);
    expect(idOf(tlv)).toBe("BVB:TLV");
    expect(readInstrument(t.db, "BVB:TLV")).toMatchObject({
      source: "yahoo",
      sourceSymbol: "TLV.RO",
    });
    expect(t.urls).toEqual([]);
  });

  test("an index or bond answers no data from that source", async () => {
    const t = await setup(false);
    // stored while the feed was on
    await t.m.writer.write((db) =>
      upsertInstrument(
        db,
        {
          market: "BVB",
          symbol: "R2807A",
          source: "bvb",
          sourceSymbol: "R2807A",
          exchange: "BVB",
          name: null,
          type: "BOND",
          currency: "RON",
          unit: "percent_of_par",
          zone: "Europe/Bucharest",
        },
        t.clock.now(),
      ),
    );
    const [bet, bond] = await t.read(["BVB:BET", "BVB:R2807A"]);
    expect(errorOf(bet)).toEqual({ error: "no_data", message: NO_DATA });
    expect(errorOf(bond)).toEqual({ error: "no_data", message: NO_DATA });
    expect(t.urls).toEqual([]);
  });
});
