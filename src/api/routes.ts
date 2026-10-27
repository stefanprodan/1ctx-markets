// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// /api/v1: each route calls the code its tool calls, with the same
// resolution, tracking, deadline, limits and error codes, and answers
// the whole result at once: nothing is paged, since a script that does
// not follow a cursor loses what is past it.

import {
  type AdminDeps,
  adminDelete,
  adminRefetch,
  adminStatus,
} from "../admin/http.ts";
import { NO_EVENTS } from "../finnhub/store.ts";
import { ATTRIBUTION } from "../fred/sync.ts";
import { price } from "../market/format.ts";
import { readRules } from "../rules/store.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import { ArgError, fields } from "../tools/args.ts";
import { parseEvents, readEventsOf } from "../tools/events.ts";
import { basisOf, parseHistory, readHistory } from "../tools/history.ts";
import type { ExtendedRead, Markets } from "../tools/markets.ts";
import { parseMovers, readMovers } from "../tools/movers.ts";
import {
  briefItem,
  type Latest,
  parseQuote,
  type QuoteItem,
  quoteRows,
} from "../tools/quote.ts";
import { parseResearchList, researchList } from "../tools/research.ts";
import {
  createRule,
  deleteRuleById,
  parseRules,
  pauseRule,
  ruleItem,
} from "../tools/rules.ts";
import { parseScreen, readScreen } from "../tools/screen.ts";
import { parseSearch, searchAll } from "../tools/search.ts";
import { setAll } from "../tools/sets.ts";
import { localDate } from "../zone.ts";
import { ASSET_CACHE, DOC_FILES, docsFile, docsPage } from "./docs.ts";
import {
  failed,
  json,
  MAX_BODY_BYTES,
  NO_STORE,
  noQuery,
  queryArgs,
  readBody,
} from "./http.ts";
import { spec } from "./openapi.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

// read: the bearer; admin: the admin key alone; none: served before
// either, since it holds no data and a browser opening it sends no key
export type Key = "read" | "admin" | "none";

export type Route = {
  method: Method;
  // under /api/v1, as the spec names it; {name} is one path segment
  path: string;
  key: Key;
  // a segment's only values, when it names a fixed set
  values?: Record<string, readonly string[]>;
  handle: (
    req: Request,
    url: URL,
    params: Record<string, string>,
  ) => Promise<Response>;
};

export type ApiDeps = {
  m: Markets;
  // the alerts feed, as it has always answered
  alerts: (req: Request) => Promise<Response>;
  // the operator's routes, while there is an admin key
  admin: AdminDeps | null;
  log: Log;
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

function reads(m: Markets): Route[] {
  return [
    {
      method: "GET",
      path: "/quotes",
      key: "read",
      handle: async (_req, url) => {
        const args = parseQuote(
          queryArgs(url, { symbols: "list", extended: "boolean" }),
        );
        const { rows } = await quoteRows(m, args, (item, latest, ext) =>
          brief(m, item, latest, ext),
        );
        return json({
          ...(rows.some((r) => r.fred) ? { attribution: ATTRIBUTION } : {}),
          items: rows.map((r) => r.item),
        });
      },
    },
    {
      method: "GET",
      path: "/history",
      key: "read",
      handle: async (_req, url) => {
        const args = parseHistory(
          queryArgs(url, {
            symbol: "text",
            interval: "text",
            from: "text",
            to: "text",
            benchmark: "text",
          }),
        );
        const read = await readHistory(m, args, null);
        if ("error" in read) {
          return failed({ input: read.input, ...read.error });
        }
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
            id: i.id,
            name: i.name,
            exchange: i.exchange,
            type: i.type,
            currency: i.currency,
            unit: i.unit,
            source: i.source,
            basis: basisOf(i),
            stale: read.stale,
            ...(read.attribution ? { attribution: ATTRIBUTION } : {}),
            from: read.from,
            to: read.to,
            session: read.session,
            interval: args.interval,
            ...(read.relative === null ? {} : { relative: read.relative }),
            bars: read.bars.map((b) => ({
              date: b.date,
              close: price(b.close),
              final: b.final,
              sma50: (b.row?.sma50 as number | null | undefined) ?? null,
              sma200: (b.row?.sma200 as number | null | undefined) ?? null,
            })),
          },
          200,
          final ? { "cache-control": FINAL_CACHE } : NO_STORE,
        );
      },
    },
    {
      method: "GET",
      path: "/search",
      key: "read",
      handle: async (_req, url) => {
        const args = parseSearch(queryArgs(url, { query: "text" }));
        const { notes, all } = await searchAll(m, args.query);
        return json({
          query: args.query,
          ...(notes.length > 0 ? { errors: notes } : {}),
          candidates: all,
        });
      },
    },
    {
      method: "GET",
      path: "/research",
      key: "read",
      handle: async (_req, url) => {
        const args = parseResearchList(
          queryArgs(url, { symbols: "list", sections: "list", since: "text" }),
        );
        return json(await researchList(m, args));
      },
    },
    {
      method: "GET",
      path: "/events",
      key: "read",
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
            events: [],
          });
        }
        return json({
          from: args.from,
          to: args.to,
          source: "finnhub",
          ...(read.notes.length > 0 ? { unavailable: read.notes } : {}),
          ...(read.quiet.length > 0 ? { no_event: read.quiet } : {}),
          events: read.events.map((e) => e.item),
        });
      },
    },
    {
      method: "GET",
      path: "/movers",
      key: "read",
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
        return json(setAll(await readMovers(m, args)));
      },
    },
    {
      method: "POST",
      path: "/screen",
      key: "read",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const set = await readScreen(m, parseScreen(read.body));
        if ("error" in set) return failed(set);
        return json(setAll(set));
      },
    },
    {
      method: "GET",
      path: "/rules",
      key: "read",
      handle: async (_req, url) => {
        noQuery(url);
        return json({ rules: readRules(m.db).map((r) => ruleItem(m, r)) });
      },
    },
    {
      method: "POST",
      path: "/rules",
      key: "read",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["symbol", "condition", "note"]);
        const args = parseRules({ ...body, action: "create" });
        if (args.action !== "create") throw new Error("not a create");
        const made = await createRule(m, args);
        if ("error" in made) return failed(made);
        return json(made, 201);
      },
    },
    {
      method: "PATCH",
      path: "/rules/{id}",
      key: "read",
      handle: async (req, url, params) => {
        noQuery(url);
        const id = ruleId(params.id!);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["paused"]);
        const args = parseRules({ ...body, action: "pause", id });
        if (args.action !== "pause") throw new Error("not a pause");
        const done = await pauseRule(m, args);
        if ("error" in done) return failed(done);
        return json(done);
      },
    },
    {
      method: "DELETE",
      path: "/rules/{id}",
      key: "read",
      handle: async (_req, url, params) => {
        noQuery(url);
        const done = await deleteRuleById(m, ruleId(params.id!));
        if ("error" in done) return failed(done);
        return new Response(null, { status: 204, headers: NO_STORE });
      },
    },
  ];
}

export function routes(deps: ApiDeps): Route[] {
  const { admin } = deps;
  const body = JSON.stringify(spec);
  const list: Route[] = [
    ...reads(deps.m),
    {
      method: "GET",
      path: "/alerts",
      key: "read",
      handle: (req) => deps.alerts(req),
    },
    {
      method: "GET",
      path: "/openapi.json",
      key: "none",
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
      key: "none",
      handle: async () => docsPage(),
    },
    {
      method: "GET",
      path: "/docs/{file}",
      key: "none",
      values: { file: DOC_FILES },
      handle: async (_req, url, params) => {
        queryArgs(url, { h: "text" });
        return docsFile(params.file as (typeof DOC_FILES)[number]);
      },
    },
  ];
  if (admin !== null) {
    list.push(
      {
        method: "GET",
        path: "/admin/status",
        key: "admin",
        handle: async (_req, url) => adminStatus(admin, url),
      },
      {
        method: "POST",
        path: "/admin/refetch",
        key: "admin",
        handle: (req, url) => adminRefetch(admin, req, url),
      },
      {
        method: "DELETE",
        path: "/admin/instruments/{id}",
        key: "admin",
        handle: (_req, url, params) => adminDelete(admin, url, params.id!),
      },
    );
  }
  // a bad argument is the caller's to fix; anything else is logged and
  // answered without its text, which can quote a source
  return list.map((r) => ({
    ...r,
    handle: async (req, url, params) => {
      try {
        return await r.handle(req, url, params);
      } catch (error) {
        if (error instanceof ArgError) {
          return failed({ error: "bad_arguments", message: error.message });
        }
        deps.log.error("api failed", {
          path: `${r.method} ${r.path}`,
          ...errorFields(error),
        });
        return failed({ error: "internal", message: "internal error" });
      }
    },
  }));
}

export type Found = { routes: Route[]; params: Record<string, string> };

// The routes of the one path a request names, whatever their methods,
// or null for a path no route has.
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
