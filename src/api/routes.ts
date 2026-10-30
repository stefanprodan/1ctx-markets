// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Only the stored list pages: a script that never follows a cursor loses
// what is past it.

import {
  parseLayout,
  readDashboard,
  saveDashboard,
} from "../admin/dashboard.ts";
import {
  type AdminDeps,
  deleteOne,
  instrument,
  instruments,
  refetchOne,
  status,
  watchlist,
} from "../admin/http.ts";
import {
  createOne,
  type KeysDeps,
  listAnswer,
  revokeOne,
  setOne,
} from "../admin/keys.ts";
import { iso, price } from "../market/format.ts";
import { localDate } from "../market/zone.ts";
import { ArgError, fields } from "../operations/args.ts";
import { parseEvents, readEventsOf } from "../operations/events.ts";
import { basisOf, parseHistory, readHistory } from "../operations/history.ts";
import { extendedOut, readIntradayHistory } from "../operations/intraday.ts";
import type { ExtendedRead, Markets } from "../operations/markets.ts";
import { parseMovers, readMovers } from "../operations/movers.ts";
import {
  briefItem,
  type Latest,
  parseQuote,
  type QuoteItem,
  quoteRows,
} from "../operations/quote.ts";
import { parseResearchList, researchList } from "../operations/research.ts";
import {
  createRule,
  deleteRuleById,
  parseRules,
  pauseRule,
  ruleItem,
} from "../operations/rules.ts";
import { parseScreen, readScreen } from "../operations/screen.ts";
import { parseSearch, searchAll } from "../operations/search.ts";
import { setAll } from "../operations/sets.ts";
import type { TrackState } from "../operations/track.ts";
import type { Who } from "../operations/who.ts";
import { readRule, readRules } from "../rules/store.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import { NO_EVENTS } from "../sources/finnhub/store.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { ASSET_CACHE, DOC_FILES, docsFile, docsPage } from "./docs.ts";
import {
  detailOf,
  itemOf,
  json,
  MAX_BODY_BYTES,
  NO_STORE,
  noQuery,
  PREFIX,
  pathSymbol,
  problem,
  problemOf,
  queryArgs,
  readBody,
} from "./http.ts";
import { spec } from "./openapi.ts";
import { portfolioRoutes } from "./portfolios.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// read: an agent key, or the admin key, which holds every scope; admin:
// the admin key alone; none: served before either, since it holds no data
// and a browser opening it sends no key; portfolio: and rules: an agent key
// the admin gave that access, holdings being private and rules the owner's
export type Scope =
  | "read"
  | "admin"
  | "none"
  | "portfolio:read"
  | "portfolio:write"
  | "rules:read"
  | "rules:write";

export type Route = {
  method: Method;
  // {name} matches one path segment
  path: string;
  scope: Scope;
  // the web UI's cookie opens every route but these, the rules writes
  cookie?: false;
  values?: Record<string, readonly string[]>;
  handle: (
    req: Request,
    url: URL,
    params: Record<string, string>,
    // who asked, named on what they write
    who: Who,
  ) => Promise<Response>;
};

export type ApiDeps = {
  m: Markets;
  alerts: (req: Request) => Promise<Response>;
  admin: AdminDeps;
  // each --track value and what it resolved to
  track: () => readonly TrackState[];
  log: Log;
  // hides a key made through POST /keys from the log; none in tests that
  // read no log
  mask?: (token: string) => void;
};

// a body is the tool's arguments, never a cursor
async function bodyOf(req: Request): Promise<{ body: unknown } | Response> {
  const read = await readBody(req, MAX_BODY_BYTES);
  if (read instanceof Response) return read;
  const b = read.body;
  if (typeof b === "object" && b !== null && !Array.isArray(b) && "next" in b) {
    throw new ArgError("unknown argument next");
  }
  return read;
}

// 15 digits stay under Number.MAX_SAFE_INTEGER, so no id rounds to another
const RULE_ID = /^[1-9]\d{0,14}$/;

function ruleId(raw: string): number {
  if (!RULE_ID.test(raw)) {
    throw new ArgError("the path ends with a rule id, a positive integer");
  }
  return Number(raw);
}

// a range whose bars are all final changes only by a split or a revision
const FINAL_CACHE = "private, max-age=3600";

function brief(
  m: Markets,
  item: QuoteItem,
  latest: Latest,
  ext: ExtendedRead | undefined,
) {
  const b = briefItem(m.db, item, latest);
  if (ext === undefined) return b;
  return {
    ...b,
    extended: ext.extended,
    stale: ext.reason === null ? b.stale : [...b.stale, ext.reason],
  };
}

// a point is a close, not a bar, so it has its own schema
async function intraday(
  m: Markets,
  args: Parameters<typeof readIntradayHistory>[1],
): Promise<Response> {
  const read = await readIntradayHistory(m, args, null);
  if ("error" in read) return problemOf({ input: read.input, ...read.error });
  const i = read.instrument;
  return json({
    input: args.symbol,
    instrument: {
      id: i.id,
      name: i.name,
      exchange: i.exchange,
      type: i.type,
      currency: i.currency,
      unit: i.unit,
      source: i.source,
    },
    stale: read.stale,
    from: read.from,
    to: read.to,
    session: read.session,
    interval: args.interval,
    sessions: read.sessions.map((s) => ({
      session: s.session,
      fetched_at: iso(s.fetchedAt),
    })),
    previous_close: price(read.previousClose),
    ...extendedOut(read.extended),
    points: read.points.map((p) => ({
      at: iso(p.at),
      session: p.session,
      close: price(p.close),
      final: p.final,
    })),
  });
}

async function bars(m: Markets, url: URL, raw: string): Promise<Response> {
  const args = parseHistory({
    ...queryArgs(url, {
      interval: "text",
      from: "text",
      to: "text",
      benchmark: "text",
      extended: "boolean",
    }),
    symbol: pathSymbol(raw),
  });
  if (args.interval === "5m") return intraday(m, args);
  const read = await readHistory(m, args, null);
  if ("error" in read) return problemOf({ input: read.input, ...read.error });
  const i = read.instrument;
  // a range ending today or later still takes the next live bar
  const final =
    args.to !== null &&
    args.to < localDate(i.zone, m.clock.now()) &&
    args.benchmark === null &&
    read.bars.length > 0 &&
    read.bars.every((b) => b.final);
  return json(
    {
      input: args.symbol,
      instrument: {
        id: i.id,
        name: i.name,
        exchange: i.exchange,
        type: i.type,
        currency: i.currency,
        unit: i.unit,
        source: i.source,
        basis: basisOf(i),
      },
      stale: read.stale,
      ...(read.attribution ? { attribution: ATTRIBUTION } : {}),
      from: read.from,
      to: read.to,
      session: read.session,
      interval: args.interval,
      ...(read.relative === null ? {} : { relative: read.relative }),
      bars: read.bars.map((b) => ({
        date: b.date,
        open: price(b.open),
        high: price(b.high),
        low: price(b.low),
        close: price(b.close),
        volume: b.volume,
        final: b.final,
        sma50: (b.row?.sma50 as number | null | undefined) ?? null,
        sma200: (b.row?.sma200 as number | null | undefined) ?? null,
      })),
    },
    200,
    final ? { "cache-control": FINAL_CACHE } : NO_STORE,
  );
}

// a set's items, each a match, unavailable or its error, under its own name
function set(read: object, name: string) {
  const { items, ...rest } = read as { items: object[] };
  return { ...rest, [name]: items.map(itemOf) };
}

function marketData(m: Markets): Route[] {
  return [
    {
      method: "GET",
      path: "/quotes",
      scope: "read",
      handle: async (_req, url) => {
        const args = parseQuote(
          queryArgs(url, { symbols: "list", extended: "boolean" }),
        );
        const { rows } = await quoteRows(m, args, (item, latest, ext) =>
          brief(m, item, latest, ext),
        );
        return json({
          ...(rows.some((r) => r.fred) ? { attribution: ATTRIBUTION } : {}),
          quotes: rows.map((r) => itemOf(r.item)),
        });
      },
    },
    {
      method: "GET",
      path: "/research",
      scope: "read",
      handle: async (_req, url) => {
        const args = parseResearchList(
          queryArgs(url, { symbols: "list", sections: "list", since: "text" }),
        );
        return json({ research: (await researchList(m, args)).map(itemOf) });
      },
    },
    {
      method: "GET",
      path: "/symbols",
      scope: "read",
      handle: async (_req, url) => {
        const { upstream, ...rest } = queryArgs(url, {
          query: "text",
          upstream: "boolean",
        });
        const args = parseSearch(rest);
        const { notes, all } = await searchAll(
          m,
          args.query,
          upstream !== false,
        );
        return json({
          query: args.query,
          ...(notes.length > 0 ? { errors: notes } : {}),
          candidates: all,
        });
      },
    },
    {
      method: "GET",
      path: "/earnings",
      scope: "read",
      handle: async (_req, url) => {
        const args = parseEvents(
          queryArgs(url, { from: "text", to: "text", symbols: "list" }),
        );
        const read = await readEventsOf(m, args, null);
        if (read.off) {
          return json({
            from: args.from,
            to: args.to,
            message: NO_EVENTS,
            earnings: [],
          });
        }
        return json({
          from: args.from,
          to: args.to,
          source: "finnhub",
          ...(read.notes.length > 0
            ? {
                unavailable: read.notes.map((n) => ({
                  ...n,
                  message: detailOf(n.message),
                })),
              }
            : {}),
          ...(read.quiet.length > 0 ? { no_event: read.quiet } : {}),
          earnings: read.events.map((e) => e.item),
        });
      },
    },
    {
      method: "GET",
      path: "/movers",
      scope: "read",
      handle: async (_req, url) => {
        const args = parseMovers(
          queryArgs(url, {
            symbols: "list",
            min_move_pct: "number",
            direction: "text",
            average: "text",
            relation: "text",
          }),
        );
        return json(set(setAll(await readMovers(m, args)), "movers"));
      },
    },
    {
      method: "POST",
      path: "/screen",
      scope: "read",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const screened = await readScreen(m, parseScreen(read.body));
        if ("error" in screened) return problemOf(screened);
        return json(set(setAll(screened), "matches"));
      },
    },
    {
      method: "GET",
      path: "/instruments/{symbol}/bars",
      scope: "read",
      handle: (_req, url, params) => bars(m, url, params.symbol!),
    },
    {
      method: "GET",
      path: "/instruments/{symbol}",
      scope: "read",
      handle: (_req, url, params) => instrument(m, url, params.symbol!),
    },
  ];
}

function rules(m: Markets): Route[] {
  const noRule = (id: number) => problem("not_found", `no rule ${id}`);
  return [
    {
      method: "GET",
      path: "/rules",
      scope: "rules:read",
      handle: async (_req, url) => {
        noQuery(url);
        return json({ rules: readRules(m.db).map((r) => ruleItem(m, r)) });
      },
    },
    {
      method: "POST",
      path: "/rules",
      scope: "rules:write",
      cookie: false,
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["symbol", "condition", "note"]);
        const args = parseRules({ ...body, action: "create" });
        if (args.action !== "create") throw new Error("not a create");
        const made = await createRule(m, args);
        if ("error" in made) return problemOf(made);
        return json(made, 201, {
          ...NO_STORE,
          location: `${PREFIX}/rules/${made.rule.id}`,
        });
      },
    },
    {
      method: "GET",
      path: "/rules/{id}",
      scope: "rules:read",
      handle: async (_req, url, params) => {
        noQuery(url);
        const id = ruleId(params.id!);
        const rule = readRule(m.db, id);
        if (rule === null) return noRule(id);
        return json({ rule: ruleItem(m, rule) });
      },
    },
    {
      method: "PATCH",
      path: "/rules/{id}",
      scope: "rules:write",
      cookie: false,
      handle: async (req, url, params) => {
        noQuery(url);
        const id = ruleId(params.id!);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["paused"]);
        const args = parseRules({ ...body, action: "pause", id });
        if (args.action !== "pause") throw new Error("not a pause");
        const done = await pauseRule(m, args);
        if ("error" in done) return problemOf(done);
        return json(done);
      },
    },
    {
      method: "DELETE",
      path: "/rules/{id}",
      scope: "rules:write",
      cookie: false,
      handle: async (_req, url, params) => {
        noQuery(url);
        const done = await deleteRuleById(m, ruleId(params.id!));
        if ("error" in done) return problemOf(done);
        return new Response(null, { status: 204, headers: NO_STORE });
      },
    },
  ];
}

function operator(
  admin: AdminDeps,
  track: () => readonly TrackState[],
): Route[] {
  const { m } = admin;
  return [
    {
      method: "GET",
      path: "/watchlist",
      scope: "read",
      handle: async (_req, url) => watchlist(m, track, url),
    },
    {
      method: "GET",
      path: "/dashboard",
      scope: "admin",
      handle: async (_req, url) => {
        noQuery(url);
        return json(readDashboard(m, track));
      },
    },
    {
      method: "PUT",
      path: "/dashboard",
      scope: "admin",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return saveDashboard(m, track, parseLayout(read.body));
      },
    },
    {
      method: "GET",
      path: "/status",
      scope: "admin",
      handle: async (_req, url) => status(admin, url),
    },
    {
      method: "GET",
      path: "/instruments",
      scope: "admin",
      handle: async (_req, url) => instruments(m, url),
    },
    {
      method: "DELETE",
      path: "/instruments/{symbol}",
      scope: "admin",
      handle: (_req, url, params) => deleteOne(admin, url, params.symbol!),
    },
    {
      method: "POST",
      path: "/instruments/{symbol}/refetch",
      scope: "admin",
      handle: (req, url, params) => refetchOne(admin, req, url, params.symbol!),
    },
  ];
}

function keys(d: KeysDeps): Route[] {
  return [
    {
      method: "GET",
      path: "/keys",
      scope: "admin",
      handle: async (_req, url) => {
        noQuery(url);
        return listAnswer(d.m);
      },
    },
    {
      method: "POST",
      path: "/keys",
      scope: "admin",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return createOne(d, read.body);
      },
    },
    {
      method: "PATCH",
      path: "/keys/{id}",
      scope: "admin",
      handle: async (req, url, params) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return setOne(d, params.id!, read.body);
      },
    },
    {
      method: "DELETE",
      path: "/keys/{id}",
      scope: "admin",
      handle: async (_req, url, params) => {
        noQuery(url);
        return revokeOne(d, params.id!);
      },
    },
  ];
}

export function routes(deps: ApiDeps): Route[] {
  // REST's bare symbol is Yahoo's, so a Yahoo export's symbols read as written
  const m: Markets = { ...deps.m, yahooFirst: true };
  const admin: AdminDeps = {
    ...deps.admin,
    m: { ...deps.admin.m, yahooFirst: true },
  };
  const body = JSON.stringify(spec);
  const list: Route[] = [
    ...marketData(m),
    ...rules(m),
    ...portfolioRoutes(m),
    {
      method: "GET",
      path: "/alerts",
      scope: "rules:read",
      handle: (req) => deps.alerts(req),
    },
    ...operator(admin, deps.track),
    ...keys({ m: deps.admin.m, mask: deps.mask ?? (() => {}) }),
    {
      method: "GET",
      path: "/openapi.json",
      scope: "none",
      handle: async (_req, url) => {
        noQuery(url);
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": ASSET_CACHE,
          },
        });
      },
    },
    {
      method: "GET",
      path: "/docs",
      scope: "none",
      handle: async () => docsPage(),
    },
    {
      method: "GET",
      path: "/docs/{file}",
      scope: "none",
      values: { file: DOC_FILES },
      handle: async (_req, url, params) => {
        queryArgs(url, { h: "text" });
        return docsFile(params.file as (typeof DOC_FILES)[number]);
      },
    },
  ];
  // other errors are logged and answered without text that can quote a source
  return list.map((r) => ({
    ...r,
    handle: async (req, url, params, who) => {
      try {
        return await r.handle(req, url, params, who);
      } catch (error) {
        if (error instanceof ArgError) {
          return problem("bad_arguments", error.message);
        }
        deps.log.error("api failed", {
          path: `${r.method} ${r.path}`,
          ...errorFields(error),
        });
        return problem("internal", "internal error");
      }
    },
  }));
}

export type Found = { routes: Route[]; params: Record<string, string> };

export function match(list: readonly Route[], path: string): Found | null {
  const parts = path.split("/");
  for (const r of list) {
    const want = r.path.split("/");
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = want.every((w, k) => {
      const got = parts[k]!;
      if (!w.startsWith("{")) return w === got;
      const name = w.slice(1, -1);
      if (got === "") return false;
      const only = r.values?.[name];
      if (only !== undefined && !only.includes(got)) return false;
      params[name] = got;
      return true;
    });
    if (ok) {
      return { routes: list.filter((x) => x.path === r.path), params };
    }
  }
  return null;
}
