// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { bvb } from "../src/bvb/client.ts";
import { NO_DATA } from "../src/bvb/sync.ts";
import { open } from "../src/db/index.ts";
import { readInstrument, upsertInstrument } from "../src/instruments.ts";
import { silent } from "../src/log.ts";
import type { Fetch } from "../src/source.ts";
import { searchPage } from "../src/tools/search.ts";
import { markets, readTargets, type Target } from "../src/tools/targets.ts";
import { writer } from "../src/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
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
  const exchange = feed ? bvb({ clock, fetch }) : null;
  const m = markets({
    db,
    clock,
    writer: writer(db),
    yahoo: yahoo({ clock, fetch }),
    fred: null,
    bvb: exchange,
    log: silent,
  });
  const read = (inputs: string[]) =>
    exchange === null
      ? readTargets(m, inputs)
      : drive(clock, exchange, readTargets(m, inputs));
  return { clock, db, m, read, urls, calls: s.calls, exchange };
}

const idOf = (t: Target | undefined) =>
  t !== undefined && "instrument" in t ? t.instrument.id : null;
const errorOf = (t: Target | undefined) =>
  t !== undefined && "error" in t ? t.error : null;

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
    await drive(t.clock, t.exchange!, t.exchange!.bonds());
    await drive(t.clock, t.exchange!, t.exchange!.indices());
    const [nvda] = await t.read(["NVDA"]);
    expect(idOf(nvda)).toBe("US:NVDA");
    expect(
      t.urls.filter((u) => u.pathname === "/proxyshld.aspx/GetInstrumentsList"),
    ).toEqual([]);
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
      if (listsRead) await drive(t.clock, t.exchange!, t.exchange!.shares());
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

  test("search lists the exchange's own tradable listings", async () => {
    const t = await setup(true);
    const page = JSON.parse(
      await drive(
        t.clock,
        t.exchange!,
        searchPage(t.m, { query: "TLV", next: null }),
      ),
    );
    const bvbOnes = page.candidates.filter(
      (c: { source: string }) => c.source === "bvb",
    );
    expect(bvbOnes.map((c: { id: string }) => c.id)).toEqual(["BVB:TLV"]);
    expect(page.candidates.map((c: { id: string }) => c.id)).toContain(
      "US:TLV",
    );
    // the same key from Yahoo is not listed twice
    expect(
      page.candidates.filter((c: { id: string }) => c.id === "BVB:TLV"),
    ).toHaveLength(1);
  });
});

describe("resolution with the feed off", () => {
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
