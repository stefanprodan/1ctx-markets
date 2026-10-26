// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Massive's news endpoint answered from the recorded articles: a test
// sets the articles it holds, re-dated or re-tickered from the
// recordings, and the fake filters, orders and pages them as Massive
// does, with an opaque next_url cursor that holds no key: as Massive's
// own, it names the last article given, its time and id.

import { join } from "node:path";
import { clone, type Recorded } from "./yahoo.ts";

const DIR = join(import.meta.dir, "..", "fixtures", "massive");
// made up: no real key is ever read by a test
export const MASSIVE_KEY = "5ca1ab1e0ddba11c0ffeeb0a710ad5ca";
export const MASSIVE_HOST = "api.massive.com";

export const massiveFixture = (name: string): Promise<Recorded> =>
  Bun.file(join(DIR, `${name}.json`)).json();

// every recorded article, newest first
export async function recordedArticles(): Promise<any[]> {
  const all: any[] = [];
  for (const name of [
    "news-latest",
    "news-latest-page2",
    "news-nvda-older",
    "news-nvda-year-old",
  ]) {
    all.push(...(await massiveFixture(name)).body.results);
  }
  return all;
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

// A recorded article made into another: a new id and time, and its
// tickers and insights where given.
export function made(
  base: any,
  n: number,
  publishedAt: number,
  edit: { tickers?: string[]; insights?: any[] } = {},
): any {
  const a = clone(base);
  a.id = `${String(n).padStart(8, "0")}${"0".repeat(56)}`;
  a.published_utc = iso(publishedAt);
  a.title = `${a.title} (${n})`;
  if (edit.tickers !== undefined) a.tickers = edit.tickers;
  if (edit.insights !== undefined) a.insights = edit.insights;
  return a;
}

// count articles for ticker from the NVDA recording, one every stepMs back
// from newest
export async function series(
  ticker: string,
  count: number,
  newest: number,
  stepMs: number,
  first = 0,
): Promise<any[]> {
  const [base] = (await massiveFixture("news-nvda-older")).body.results;
  const own = base.insights.find((i: any) => i.ticker === "NVDA");
  return Array.from({ length: count }, (_, k) =>
    made(base, first + k, newest - k * stepMs, {
      tickers: [ticker, "MSFT"],
      insights: [
        { ...own, ticker },
        { ticker: "MSFT", sentiment: "neutral", sentiment_reasoning: "x" },
      ],
    }),
  );
}

export type FakeMassive = {
  // the articles it holds, any order
  articles: any[];
  // a page's next_url is this instead, when set
  nextUrl?: (cursor: string) => string;
  // answers every call with this status instead
  status?: number;
  // matches tickers by prefix, as a sloppy source might, so only the
  // server's own exact match keeps JPMpC out of JPM
  prefix?: boolean;
  // leaves published_utc.gt out, so only the server stops paging
  ignoreAfter?: boolean;
};

const encode = (state: object) =>
  Buffer.from(JSON.stringify(state)).toString("base64url");

// the answer for a Massive URL, or undefined for another host
export function massiveAnswer(
  fake: FakeMassive,
  url: URL,
): Recorded | undefined {
  if (url.hostname !== MASSIVE_HOST) return undefined;
  const answer = (status: number, body: unknown): Recorded => ({
    recordedAt: "",
    status,
    headers: { "content-type": "application/json" },
    body,
  });
  if (fake.status !== undefined) {
    return answer(fake.status, { status: "ERROR", error: "made up" });
  }
  if (url.pathname !== "/v2/reference/news") {
    return answer(404, { status: "NOT_FOUND" });
  }
  const cursor = url.searchParams.get("cursor");
  let state: any = null;
  if (cursor !== null) {
    try {
      state = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      // a cursor it no longer knows
      return answer(400, { status: "ERROR", error: "bad cursor" });
    }
  }
  const q =
    state === null
      ? {
          ticker: url.searchParams.get("ticker") ?? "",
          gt: url.searchParams.get("published_utc.gt"),
          lt: url.searchParams.get("published_utc.lt"),
          limit: Number(url.searchParams.get("limit") ?? "10"),
          // the last article given, as Massive's ap and as
          ap: null,
          as: null,
        }
      : state;
  const matches = (t: string) =>
    fake.prefix ? t.startsWith(q.ticker) : t === q.ticker;
  const rows = fake.articles
    .filter((a) => q.ticker === "" || a.tickers.some(matches))
    .filter(
      (a) =>
        fake.ignoreAfter ||
        q.gt === null ||
        Date.parse(a.published_utc) > Date.parse(q.gt),
    )
    .filter(
      (a) => q.lt === null || Date.parse(a.published_utc) < Date.parse(q.lt),
    )
    .sort(
      (a, b) =>
        Date.parse(b.published_utc) - Date.parse(a.published_utc) ||
        (b.id < a.id ? -1 : 1),
    );
  const rest =
    q.ap === null
      ? rows
      : rows.filter((a) => {
          const at = Date.parse(a.published_utc);
          return at < q.ap || (at === q.ap && a.id < q.as);
        });
  const page = rest.slice(0, q.limit);
  const body: Record<string, unknown> = {
    results: page,
    status: "OK",
    request_id: "made-up",
    count: page.length,
  };
  if (rest.length > q.limit) {
    const last = page.at(-1);
    const next = encode({
      ...q,
      ap: Date.parse(last.published_utc),
      as: last.id,
    });
    body.next_url =
      fake.nextUrl?.(next) ??
      `https://${MASSIVE_HOST}/v2/reference/news?cursor=${next}`;
  }
  return answer(200, body);
}
