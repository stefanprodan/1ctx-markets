// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { markRead } from "../../src/market/tracking.ts";
import type { Fetch } from "../../src/source.ts";
import { addInstrument, type YahooContext } from "../../src/yahoo/sync.ts";

const YAHOO = join(import.meta.dir, "..", "fixtures", "yahoo");

export type Recorded = {
  recordedAt: string;
  status: number;
  headers: Record<string, string>;
  body: any;
};

export async function recorded(name: string): Promise<Recorded> {
  return Bun.file(join(YAHOO, `${name}.json`)).json();
}

// answers each call with what route gives for its URL; a route that
// gives nothing fails the test, so no call goes unnoticed
export function fakeFetch(
  route: (url: URL) => Recorded | Promise<Recorded | undefined> | undefined,
): { fetch: Fetch; urls: URL[]; headers: Headers[] } {
  const urls: URL[] = [];
  const headers: Headers[] = [];
  const fetch: Fetch = async (raw, init) => {
    const url = new URL(raw);
    urls.push(url);
    headers.push(new Headers(init.headers));
    const answer = await route(url);
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
  return { fetch, urls, headers };
}

// the symbol a chart URL asks for
export const chartSymbol = (url: URL): string | null =>
  url.pathname.startsWith("/v8/finance/chart/")
    ? decodeURIComponent(url.pathname.slice("/v8/finance/chart/".length))
    : null;

export const clone = <T>(v: T): T => structuredClone(v);

// a recorded chart answer as a listing that began on its first row, so
// a short recording stands for a whole history
export function listed(fx: Recorded): Recorded {
  const out = clone(fx);
  const result = out.body.chart.result[0];
  result.meta.firstTradeDate = result.timestamp[0];
  return out;
}

// a recorded chart answer with a made-up weekday row at 15:00 UTC for
// each day from from up to its first row
export function backTo(fx: Recorded, from: string): Recorded {
  const out = clone(fx);
  const result = out.body.chart.result[0];
  const q = result.indicators.quote[0];
  const stamps: number[] = [];
  const first = result.timestamp[0] * 1000;
  for (
    let at = Date.parse(`${from}T15:00:00Z`);
    at < first - 86_400_000 / 2;
    at += 86_400_000
  ) {
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6) stamps.push(at / 1000);
  }
  result.timestamp = [...stamps, ...result.timestamp];
  for (const k of ["open", "high", "low", "close", "volume"]) {
    q[k] = [...stamps.map(() => (k === "volume" ? 1000 : 10)), ...q[k]];
  }
  return out;
}

// added and named by a read, as a tool would, so the jobs track it
export async function added(ctx: YahooContext, symbol: string) {
  const out = await addInstrument(ctx, symbol);
  await ctx.writer.write((db) =>
    markRead(db, [out.instrument.id], ctx.clock.now()),
  );
  return out;
}
