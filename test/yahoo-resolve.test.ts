// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { upsertInstrument } from "../src/market/instruments.ts";
import { SourceError } from "../src/source.ts";
import { open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { yahoo } from "../src/yahoo/client.ts";
import {
  isExact,
  keyOf,
  marketOf,
  ResolveError,
  resolve,
  symbolOf,
} from "../src/yahoo/resolve.ts";
import { fakeClock } from "./helpers/clock.ts";
import {
  chartSymbol,
  clone,
  fakeFetch,
  type Recorded,
  recorded,
} from "./helpers/yahoo.ts";

const CHARTS: Record<string, string> = {
  "VVSM.DE": "chart-vvsm-de-5d-1d",
  "^VIX": "chart-vix-5d-1d",
  "BRK.B": "chart-unknown-symbol",
};

const SEARCHES: Record<string, string> = {
  NVDA: "search-nvda",
  KO: "search-ko",
  TLV: "search-tlv",
  VVSM: "search-vvsm",
  HIDROELECTRICA: "search-hidroelectrica",
  SOLANA: "search-solana",
};

async function setup(extra: Record<string, Recorded> = {}) {
  const clock = fakeClock();
  const { db } = open(":memory:", clock);
  const answers: Record<string, Recorded> = { ...extra };
  for (const [q, name] of Object.entries(SEARCHES)) {
    answers[q] ??= await recorded(name);
  }
  for (const [symbol, name] of Object.entries(CHARTS)) {
    answers[`chart:${symbol}`] = await recorded(name);
  }
  const f = fakeFetch((url) => {
    const symbol = chartSymbol(url);
    if (symbol !== null) return answers[`chart:${symbol}`];
    return answers[(url.searchParams.get("q") ?? "").toUpperCase()];
  });
  const client = yahoo({ clock, fetch: f.fetch });
  return {
    db,
    clock,
    f,
    client,
    ctx: { db, clock, yahoo: client, writer: writer(db) },
  };
}

describe("markets from exchange codes", () => {
  test("aliases the codes that are one market", () => {
    for (const code of [
      "NMS",
      "NGM",
      "NCM",
      "NAS",
      "NYQ",
      "ASE",
      "PCX",
      "BTS",
      "PNK",
    ]) {
      expect(marketOf(code)).toBe("US");
    }
    expect(marketOf("GER")).toBe("XETRA");
    expect(marketOf("CCC")).toBe("CRYPTO");
  });

  test("a code not in the table is a market of its own", () => {
    for (const code of ["FRA", "LSE", "BVB", "CXI", "NYM", "CCY", "TLV"]) {
      expect(marketOf(code)).toBe(code);
    }
  });

  test("drops the suffix and keeps index, futures and FX forms", () => {
    expect(keyOf("GER", "VVSM.DE")).toBe("XETRA:VVSM");
    expect(keyOf("BVB", "TLV.RO")).toBe("BVB:TLV");
    expect(keyOf("NMS", "NVDA")).toBe("US:NVDA");
    expect(keyOf("CCC", "SOL-USD")).toBe("CRYPTO:SOL-USD");
    expect(keyOf("CXI", "^VIX")).toBe("CXI:^VIX");
    expect(keyOf("NYM", "CL=F")).toBe("NYM:CL=F");
    expect(keyOf("CCY", "EURUSD=X")).toBe("CCY:EURUSD=X");
    expect(symbolOf("AT0000A36C80.VI")).toBe("AT0000A36C80");
    expect(isExact("VVSM.DE")).toBe(true);
    expect(isExact("^GSPC")).toBe(true);
    expect(isExact("NVDA")).toBe(false);
    expect(isExact("SOL-USD")).toBe(false);
  });
});

describe("which listing a symbol means", () => {
  test("a bare symbol takes the listing whose Yahoo symbol equals it", async () => {
    const { ctx } = await setup();
    expect(await resolve(ctx, "NVDA")).toMatchObject({
      kind: "new",
      sourceSymbol: "NVDA",
      id: "US:NVDA",
    });
    expect(await resolve(ctx, "nvda")).toMatchObject({ id: "US:NVDA" });
  });

  test("a NYSE listing is US by its code NYQ", async () => {
    const { ctx } = await setup();
    expect(await resolve(ctx, "KO")).toMatchObject({
      kind: "new",
      sourceSymbol: "KO",
      id: "US:KO",
    });
  });

  test("a symbol with its suffix is exact: its chart names the key, no search", async () => {
    const { ctx, f } = await setup();
    expect(await resolve(ctx, "VVSM.DE")).toEqual({
      kind: "new",
      sourceSymbol: "VVSM.DE",
      id: "XETRA:VVSM",
    });
    expect(await resolve(ctx, "^VIX")).toMatchObject({ id: "CXI:^VIX" });
    expect(f.urls.map((u) => u.pathname)).toEqual([
      "/v8/finance/chart/VVSM.DE",
      "/v8/finance/chart/%5EVIX",
    ]);
  });

  test("an exact-looking symbol that is not found falls back to candidates", async () => {
    const search = clone(await recorded("search-ko"));
    search.body.quotes = [
      {
        symbol: "BRK-B",
        exchange: "NYQ",
        quoteType: "EQUITY",
        shortname: "Berkshire Hathaway Inc. New",
      },
      {
        symbol: "BRKB.MX",
        exchange: "MEX",
        quoteType: "EQUITY",
        shortname: "Berkshire Hathaway Inc. New",
      },
    ];
    const { ctx } = await setup({ "BRK.B": search });
    const r = await resolve(ctx, "BRK.B");
    if (r.kind !== "candidates") throw new Error(r.kind);
    expect(r.candidates.map((c) => c.id)).toEqual(["US:BRK-B", "MEX:BRKB"]);
  });

  test("a name listed on several exchanges answers candidates", async () => {
    const { ctx } = await setup();
    const r = await resolve(ctx, "Hidroelectrica");
    if (r.kind !== "candidates") throw new Error(r.kind);
    expect(r.candidates.map((c) => c.id)).toEqual([
      "BVB:H2O",
      "VIE:AT0000A36C80",
      "VIE:AT0000A36C64",
      "FRA:E28",
      "VIE:AT0000A36C72",
    ]);
  });

  test("Tel Aviv's TLV never becomes Banca Transilvania", async () => {
    const { ctx } = await setup();
    const bare = await resolve(ctx, "TLV");
    if (bare.kind !== "candidates") throw new Error(bare.kind);
    const ids = bare.candidates.map((c) => c.id);
    expect(ids).toContain("BVB:TLV");
    expect(ids).toContain("TLV:RAYG");
    expect(await resolve(ctx, "BVB:TLV")).toEqual({
      kind: "new",
      sourceSymbol: "TLV.RO",
      id: "BVB:TLV",
    });
    await expect(resolve(ctx, "TLV:TLV")).rejects.toThrow(
      new ResolveError("TLV:TLV"),
    );
  });

  test("a key not yet seen is searched on its market", async () => {
    const { ctx } = await setup();
    expect(await resolve(ctx, "XETRA:VVSM")).toEqual({
      kind: "new",
      sourceSymbol: "VVSM.DE",
      id: "XETRA:VVSM",
    });
    expect(await resolve(ctx, "xetra:vvsm")).toMatchObject({
      id: "XETRA:VVSM",
    });
    await expect(resolve(ctx, "LSE:VVSM")).rejects.toThrow(ResolveError);
  });

  test("none is an error naming the symbol", async () => {
    const empty = clone(await recorded("search-nvda"));
    empty.body.quotes = [];
    const { ctx } = await setup({ ZZZQ: empty });
    await expect(resolve(ctx, "ZZZQ")).rejects.toThrow(
      "no listing found for ZZZQ",
    );
  });

  test("a stored source symbol answered under another market is refused", async () => {
    const { db, clock } = await setup();
    const fields = {
      market: "US",
      symbol: "VVSMF",
      source: "yahoo",
      sourceSymbol: "VVSMF",
      exchange: "PNK",
      name: null,
      type: "ETF",
      currency: "USD",
      unit: "per_share" as const,
      zone: "America/New_York",
    };
    upsertInstrument(db, fields, clock.now());
    expect(() =>
      upsertInstrument(
        db,
        { ...fields, market: "OTC", exchange: "OTC" },
        clock.now(),
      ),
    ).toThrow(
      new SourceError(
        "malformed answer",
        "VVSMF is stored as US:VVSMF, answered as OTC:VVSMF",
      ),
    );
  });

  test("a stored instrument is known without a call", async () => {
    const { db, ctx, clock, f } = await setup();
    upsertInstrument(
      db,
      {
        market: "XETRA",
        symbol: "VVSM",
        source: "yahoo",
        sourceSymbol: "VVSM.DE",
        exchange: "GER",
        name: null,
        type: "ETF",
        currency: "EUR",
        unit: "per_share",
        zone: "Europe/Berlin",
      },
      clock.now(),
    );
    for (const input of ["XETRA:VVSM", "VVSM.DE"]) {
      expect(await resolve(ctx, input)).toMatchObject({
        kind: "known",
        instrument: { id: "XETRA:VVSM" },
      });
    }
    expect(f.urls).toHaveLength(0);
  });
});
