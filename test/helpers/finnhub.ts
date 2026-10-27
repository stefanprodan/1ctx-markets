// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Finnhub answered from the recordings by path and symbol: NVDA in
// full, VVSM.DE refused with 403, TLV.RO empty and TSM, an ADR, as its
// home listing 2330.TW but for insiders. Made-up US symbols answer as
// one of them, under their own symbol. The calendar asked with no
// symbol is the whole market's, two days or a week as recorded.

import { join } from "node:path";
import { clone, type Recorded } from "./yahoo.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "finnhub");
// made up: no real key is ever read by a test
export const FINNHUB_KEY = "d3adb33fc0ffee00d3adb33fc0ffee00";

export const PATHS: Record<string, string> = {
  "/api/v1/stock/metric": "metric",
  "/api/v1/stock/recommendation": "recommendation",
  "/api/v1/stock/earnings": "earnings",
  "/api/v1/stock/insider-sentiment": "insider-sentiment",
  "/api/v1/calendar/earnings": "calendar-earnings",
};

// each symbol to the recording it answers as
export const AS: Record<string, string> = {
  NVDA: "nvda",
  "VVSM.DE": "vvsm",
  "TLV.RO": "tlv",
  TSM: "tsm",
  // a US share the free key refuses, and one it has nothing for
  REFUSED: "vvsm",
  EMPTY: "tlv",
};

export const finnhubFixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

// answered as recorded: the symbols they name are the point
const AS_RECORDED = new Set(["TSM"]);

// the recording renamed to the symbol asked, wherever it names one
function renamed(fx: Recorded, symbol: string): Recorded {
  const out = clone(fx);
  const rename = (v: any) => {
    if (v !== null && typeof v === "object" && "symbol" in v) v.symbol = symbol;
  };
  rename(out.body);
  if (Array.isArray(out.body)) out.body.forEach(rename);
  for (const list of [out.body?.data, out.body?.earningsCalendar]) {
    if (Array.isArray(list)) list.forEach(rename);
  }
  return out;
}

// two days answer a range of up to two days, the week a longer one
function marketRecording(url: URL): string {
  const from = Date.parse(url.searchParams.get("from") ?? "");
  const to = Date.parse(url.searchParams.get("to") ?? "");
  return to - from <= 86_400_000
    ? "calendar-earnings-two-days"
    : "calendar-earnings-week";
}

// the answer for a Finnhub URL, or undefined for another host; more
// maps made-up symbols to recordings beside AS
export async function finnhubAnswer(
  url: URL,
  more: Record<string, string> = {},
): Promise<Recorded | undefined> {
  if (url.hostname !== "finnhub.io") return undefined;
  const kind = PATHS[url.pathname];
  const symbol = url.searchParams.get("symbol") ?? "";
  if (kind === "calendar-earnings" && symbol === "") {
    return finnhubFixture(marketRecording(url));
  }
  const as = more[symbol] ?? AS[symbol];
  if (kind === undefined || as === undefined) {
    return { recordedAt: "", status: 403, headers: {}, body: { error: "no" } };
  }
  const fx = await finnhubFixture(`${kind}-${as}`);
  return AS_RECORDED.has(symbol) ? fx : renamed(fx, symbol);
}
