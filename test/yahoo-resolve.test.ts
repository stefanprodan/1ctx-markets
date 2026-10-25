// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { open } from "../src/db/index.ts";
import { upsertInstrument } from "../src/instruments.ts";
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
import { clone, fakeFetch, type Recorded, recorded } from "./helpers/yahoo.ts";

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
  const f = fakeFetch(
    (url) => answers[(url.searchParams.get("q") ?? "").toUpperCase()],
  );
  return { db, clock, f, client: yahoo({ clock, fetch: f.fetch }) };
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
    const { db, client } = await setup();
    expect(await resolve(db, client, "NVDA")).toEqual({
      kind: "new",
      sourceSymbol: "NVDA",
      id: "US:NVDA",
    });
    expect(await resolve(db, client, "nvda")).toMatchObject({ id: "US:NVDA" });
  });

  test("a NYSE listing is US by its code NYQ", async () => {
    const { db, client } = await setup();
    expect(await resolve(db, client, "KO")).toEqual({
      kind: "new",
      sourceSymbol: "KO",
      id: "US:KO",
    });
  });

  test("a symbol with its suffix is exact without a search", async () => {
    const { db, client, f } = await setup();
    expect(await resolve(db, client, "VVSM.DE")).toEqual({
      kind: "new",
      sourceSymbol: "VVSM.DE",
      id: null,
    });
    expect(await resolve(db, client, "^VIX")).toMatchObject({ id: null });
    expect(f.urls).toHaveLength(0);
  });

  test("a name listed on several exchanges answers candidates", async () => {
    const { db, client } = await setup();
    const r = await resolve(db, client, "Hidroelectrica");
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
    const { db, client } = await setup();
    const bare = await resolve(db, client, "TLV");
    if (bare.kind !== "candidates") throw new Error(bare.kind);
    const ids = bare.candidates.map((c) => c.id);
    expect(ids).toContain("BVB:TLV");
    expect(ids).toContain("TLV:RAYG");
    expect(await resolve(db, client, "BVB:TLV")).toEqual({
      kind: "new",
      sourceSymbol: "TLV.RO",
      id: "BVB:TLV",
    });
    await expect(resolve(db, client, "TLV:TLV")).rejects.toThrow(
      new ResolveError("TLV:TLV"),
    );
  });

  test("a key not yet seen is searched on its market", async () => {
    const { db, client } = await setup();
    expect(await resolve(db, client, "XETRA:VVSM")).toEqual({
      kind: "new",
      sourceSymbol: "VVSM.DE",
      id: "XETRA:VVSM",
    });
    expect(await resolve(db, client, "xetra:vvsm")).toMatchObject({
      id: "XETRA:VVSM",
    });
    await expect(resolve(db, client, "LSE:VVSM")).rejects.toThrow(ResolveError);
  });

  test("none is an error naming the symbol", async () => {
    const empty = clone(await recorded("search-nvda"));
    empty.body.quotes = [];
    const { db, client } = await setup({ ZZZQ: empty });
    await expect(resolve(db, client, "ZZZQ")).rejects.toThrow(
      "no listing found for ZZZQ",
    );
  });

  test("a stored instrument is known without a call", async () => {
    const { db, client, clock, f } = await setup();
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
        zone: "Europe/Berlin",
      },
      clock.now(),
    );
    for (const input of ["XETRA:VVSM", "VVSM.DE"]) {
      expect(await resolve(db, client, input)).toMatchObject({
        kind: "known",
        instrument: { id: "XETRA:VVSM" },
      });
    }
    expect(f.urls).toHaveLength(0);
  });
});
