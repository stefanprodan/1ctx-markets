// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// the key only in a header; a next_url only to Massive's own news path

import type { Clock } from "../../runtime/clock.ts";
import { MASSIVE } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  limiter,
  type RunOptions,
  SourceError,
  scrub,
  Unreadable,
} from "../source.ts";

export const SOURCE = MASSIVE;
export const HOST = "https://api.massive.com";
export const NEWS_PATH = "/v2/reference/news";
// the free key allows 5 a minute and sends no rate-limit headers
export const SPACING_MS = 13_000;
export const PAGE_LIMIT = 100;
const TIMEOUT_MS = 30_000;
// longer text is cut and flagged, so an article always fits an answer
export const MAX_TITLE = 300;
export const MAX_PUBLISHER = 300;
export const MAX_REASONING = 1_000;
const MAX_URL = 2_000;

export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export type Insight = {
  ticker: string;
  sentiment: Sentiment | null;
  reasoning: string | null;
  // the reasoning was cut
  truncated: boolean;
};

export type Article = {
  id: string;
  publishedAt: number;
  title: string;
  url: string;
  publisher: string | null;
  tickers: string[];
  insights: Insight[];
  // the title or publisher was cut
  truncated: boolean;
};

export type Page = {
  articles: Article[];
  // the cursor to the next, older page, checked to be Massive's own
  next: string | null;
  fetchedAt: number;
};

export type NewsQuery = {
  ticker: string;
  // published after, and before when given, UTC ms
  after: number;
  before?: number | null;
  limit?: number;
};

export type Massive = {
  news(query: NewsQuery): Promise<Page>;
  // the page a previous page's next names
  next(cursor: string): Promise<Page>;
  failFast(): Massive;
  within(live: () => boolean): Massive;
  close(): void;
  due(): number | null;
  backoff(): Backoff | null;
};

export type MassiveOptions = {
  clock: Clock;
  key: string;
  fetch?: Fetch;
  host?: string;
};

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw malformed(`no ${what}`);
  return v.trim();
}

const optionalStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// never between the halves of a surrogate pair, which no reader can print
export function cut(v: string, max: number): string {
  if (v.length <= max) return v;
  let end = max - 1;
  const unit = v.charCodeAt(end - 1);
  if (unit >= 0xd800 && unit <= 0xdbff) end--;
  return `${v.slice(0, end)}…`;
}

// RFC 3339 to the second, as Massive's published_utc filters take it
export const utc = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 19)}Z`;

function articleUrl(v: unknown): string {
  const raw = str(v, "article_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw malformed("no article_url");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    raw.length > MAX_URL
  ) {
    throw malformed("no article_url");
  }
  return raw;
}

function insight(v: unknown): Insight {
  if (!isObj(v)) throw malformed("no insight");
  const sentiment = SENTIMENTS.find((s) => s === v.sentiment) ?? null;
  const given = optionalStr(v.sentiment_reasoning);
  // an unknown word is no sentiment, never a neutral one
  const reasoning = sentiment === null ? null : given;
  return {
    ticker: str(v.ticker, "insight ticker"),
    sentiment,
    reasoning: reasoning === null ? null : cut(reasoning, MAX_REASONING),
    truncated: reasoning !== null && reasoning.length > MAX_REASONING,
  };
}

function article(v: unknown): Article {
  if (!isObj(v)) throw malformed("no article");
  const published = str(v.published_utc, "published_utc");
  const publishedAt = Date.parse(published);
  if (!Number.isFinite(publishedAt)) throw malformed("no published_utc");
  const id = str(v.id, "id");
  if (id.length > 200) throw malformed("no id");
  const tickers = Array.isArray(v.tickers)
    ? v.tickers.filter((t): t is string => typeof t === "string")
    : [];
  const insights = v.insights === undefined ? [] : v.insights;
  if (!Array.isArray(insights)) throw malformed("no insights");
  const title = str(v.title, "title");
  const publisher = isObj(v.publisher) ? optionalStr(v.publisher.name) : null;
  return {
    id,
    publishedAt,
    title: cut(title, MAX_TITLE),
    url: articleUrl(v.article_url),
    publisher: publisher === null ? null : cut(publisher, MAX_PUBLISHER),
    tickers,
    insights: insights.map(insight),
    truncated:
      title.length > MAX_TITLE ||
      (publisher !== null && publisher.length > MAX_PUBLISHER),
  };
}

// an answer can echo the key, so every kept text is scrubbed
export function scrubbed(a: Article, key: string): Article {
  const s = (v: string) => scrub(v, key);
  return {
    ...a,
    id: s(a.id),
    title: s(a.title),
    url: s(a.url),
    publisher: a.publisher === null ? null : s(a.publisher),
    tickers: a.tickers.map(s),
    insights: a.insights.map((i) => ({
      ...i,
      ticker: s(i.ticker),
      reasoning: i.reasoning === null ? null : s(i.reasoning),
    })),
  };
}

export function parseNews(body: unknown): Omit<Page, "fetchedAt"> {
  if (!isObj(body)) throw malformed("no body");
  if (body.status !== undefined && body.status !== "OK") {
    throw new SourceError("source error", "status not OK");
  }
  const results = body.results ?? [];
  if (!Array.isArray(results)) throw malformed("no results");
  const next = body.next_url;
  if (next !== undefined && next !== null && typeof next !== "string") {
    throw malformed("no next_url");
  }
  return {
    articles: results.map(article),
    next: typeof next === "string" && next !== "" ? next : null,
  };
}

// A key never travels in a query, by any name.
const KEY_PARAMS = new Set(["apikey", "api_key", "key", "token"]);

// The cursor as written and each form decoding it gives, lowercase: a
// key escaped once or twice, or as a query writes a space, still shows.
function decodings(cursor: string): string[] {
  const forms = [cursor];
  for (let k = 0; k < 3; k++) {
    const last = forms.at(-1)!;
    let next: string;
    try {
      next = decodeURIComponent(last.replaceAll("+", " "));
    } catch {
      break;
    }
    if (next === last) break;
    forms.push(next);
  }
  try {
    forms.push(decodeURIComponent(cursor));
  } catch {}
  return forms.map((f) => f.toLowerCase());
}

// it goes out with the key in its header: checked, never rewritten
export function checkCursor(cursor: string, host: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(cursor);
  } catch {
    throw malformed("next_url is not a URL");
  }
  const own = new URL(host);
  const lower = key.toLowerCase();
  const keyed =
    (key !== "" && decodings(cursor).some((f) => f.includes(lower))) ||
    [...url.searchParams.keys()].some((k) => KEY_PARAMS.has(k.toLowerCase()));
  if (
    url.protocol !== "https:" ||
    url.origin !== own.origin ||
    url.pathname !== NEWS_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    keyed
  ) {
    throw malformed("next_url is not Massive's news");
  }
  return url;
}

export function massive(options: MassiveOptions): Massive {
  const { clock, key } = options;
  const host = options.host ?? HOST;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = limiter(clock, SPACING_MS);

  const get = (url: string, run: RunOptions): Promise<Page> =>
    calls.run(async () => {
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(url, {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${key}`,
            },
            signal: abort.signal,
          });
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        if (res.status === 429) throw new SourceError("rate limited");
        // unlike Finnhub's, a Massive 403 is a refused key, never no data
        if (res.status === 401 || res.status === 403) {
          throw new SourceError("key refused");
        }
        if (res.status === 404) throw new SourceError("not found");
        if (res.status === 400) throw new SourceError("bad request");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Unreadable();
        }
        const page = parseNews(body);
        // a cursor that is not Massive's own is never followed
        if (page.next !== null) checkCursor(page.next, host, key);
        return {
          articles: page.articles.map((a) => scrubbed(a, key)),
          next: page.next,
          fetchedAt,
        };
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Massive => ({
    news(query) {
      const params = new URLSearchParams({
        ticker: query.ticker,
        "published_utc.gt": utc(query.after),
      });
      if (query.before !== undefined && query.before !== null) {
        params.set("published_utc.lt", utc(query.before));
      }
      params.set("order", "desc");
      params.set("sort", "published_utc");
      params.set("limit", String(query.limit ?? PAGE_LIMIT));
      return get(`${host}${NEWS_PATH}?${params}`, run);
    },
    next(cursor) {
      try {
        checkCursor(cursor, host, key);
      } catch (error) {
        return Promise.reject(error);
      }
      // sent as Massive wrote it: the cursor is opaque
      return get(cursor, run);
    },
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close: () => calls.close(),
    due: () => calls.due(),
    backoff: () => calls.backoff(),
  });
  return client({});
}
