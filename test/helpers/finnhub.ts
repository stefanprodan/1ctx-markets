// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Finnhub answered from the recordings by path and symbol: NVDA in
// full, VVSM.DE refused with 403 and TLV.RO empty. Made-up US symbols
// answer as one of them, under their own symbol.

import { join } from "node:path";
import type { FakeClock } from "./clock.ts";
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
  // a US share the free key refuses, and one it has nothing for
  REFUSED: "vvsm",
  EMPTY: "tlv",
};

export const finnhubFixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

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

// the answer for a Finnhub URL, or undefined for another host
export async function finnhubAnswer(url: URL): Promise<Recorded | undefined> {
  if (url.hostname !== "finnhub.io") return undefined;
  const kind = PATHS[url.pathname];
  const symbol = url.searchParams.get("symbol") ?? "";
  const as = AS[symbol];
  if (kind === undefined || as === undefined) {
    return { recordedAt: "", status: 403, headers: {}, body: { error: "no" } };
  }
  return renamed(await finnhubFixture(`${kind}-${as}`), symbol);
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
// turns with no timer due before the work counts as waiting on a later one
const IDLE_TURNS = 2_000;

// Moves the fake clock to each timer due within one spacing until p
// settles, so the limiter's waits fire as they come due; a later timer
// (a back-off's end) fires only once the work has sat idle, so a
// fetch's timeout never fires under a call in flight. Bounded, so a
// stuck call fails the test.
export async function drive<T>(
  clock: FakeClock,
  p: Promise<T>,
  turns = 200_000,
): Promise<T> {
  let done = false;
  const settled = p.finally(() => {
    done = true;
  });
  settled.catch(() => {});
  let idle = 0;
  for (let k = 0; k < turns && !done; k++) {
    const next = clock.next();
    if (next !== null && (next <= clock.now() + 1_100 || idle >= IDLE_TURNS)) {
      idle = 0;
      await clock.advance(Math.max(0, next - clock.now()));
    } else {
      idle++;
      await turn();
    }
  }
  if (!done) throw new Error("did not settle");
  return settled;
}
