// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { dateOfWall } from "../../src/market/zone.ts";
import { DAY_MS } from "../../src/runtime/clock.ts";
import {
  DATASETS,
  HOST,
  REPORTS,
  type Report,
} from "../../src/sources/cftc/client.ts";
import type { Fetch } from "../../src/sources/source.ts";
import { fakeFetch, type Recorded } from "./yahoo.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "cftc");
const HOSTNAME = new URL(HOST).hostname;

// recorded on a Saturday at 17:35 UTC, the latest report Tuesday's, every
// date moved back by the recorder
export const RECORDED = Date.parse("2023-11-11T17:40:00Z");
export const LATEST = dateOfWall(RECORDED - 4 * DAY_MS);
// a report date that many weeks before the recording's newest
export const weeksBack = (weeks: number) =>
  dateOfWall(RECORDED - 4 * DAY_MS - weeks * 7 * DAY_MS);
// the recorded weeks, a commodity market and a consolidated financial one
export const GOLD = "088691";
export const SP = "13874+";

export const cftcFixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

export const isCftc = (url: URL) => url.hostname === HOSTNAME;

export const reportOf = (url: URL): Report | null =>
  REPORTS.find((r) => url.pathname === `/resource/${DATASETS[r]}.json`) ?? null;

// the code a weeks call asks, null for a list
export const codeOf = (url: URL): string | null =>
  /cftc_contract_market_code = '([^']+)'/.exec(
    url.searchParams.get("$where") ?? "",
  )?.[1] ?? null;

const empty = (): Recorded => ({
  recordedAt: "",
  status: 200,
  headers: { "content-type": "application/json" },
  body: [],
});

// the answer for a CFTC URL, or undefined for another host; a market with
// no recorded weeks answers none
export async function cftcAnswer(url: URL): Promise<Recorded | undefined> {
  if (!isCftc(url)) return undefined;
  const report = reportOf(url);
  if (report === null) return undefined;
  if (url.searchParams.has("$group")) return cftcFixture(`markets-${report}`);
  const code = codeOf(url);
  if (code === GOLD && report === "disaggregated") {
    return cftcFixture(`weeks-${GOLD}`);
  }
  if (code === SP && report === "financial") return cftcFixture(`weeks-${SP}`);
  return empty();
}

// every CFTC call answered from the recordings, the URLs it was asked
export function cftcFetch(): { fetch: Fetch; urls: URL[] } {
  return fakeFetch((url) => cftcAnswer(url));
}
