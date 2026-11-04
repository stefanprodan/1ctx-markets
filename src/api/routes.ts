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
  pageSize,
  refetchOne,
  retryFailing,
  status,
  storedCheck,
} from "../admin/http.ts";
import {
  createOne,
  type KeysDeps,
  listAnswer,
  revokeOne,
  setOne,
} from "../admin/keys.ts";
import { screener } from "../admin/screener.ts";
import { deleteSmtp, putSmtp, smtpAnswer, testSmtp } from "../admin/smtp.ts";
import {
  addUser,
  changeUser,
  inviteAgain,
  listUsers,
  type PeopleDeps,
  removeUser,
  signOutUser,
} from "../admin/users.ts";
import {
  analysisVersion,
  analysisVersions,
  type ListAt,
  type Note,
  readAnalysis,
} from "../analysis/store.ts";
import type { Revision } from "../document/read.ts";
import { documentText } from "../document/store.ts";
import { iso, price } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { localDate } from "../market/zone.ts";
import {
  analysisItem,
  analysisTarget,
  listedItem,
  listedPage,
  listPosition,
  missingAnalysis,
  readListPosition,
  saveAnalysisAnswer,
  savedAnalysis,
  sinceWritten,
} from "../operations/analysis.ts";
import { ArgError, fields } from "../operations/args.ts";
import { parseSave } from "../operations/document.ts";
import { parseEvents, readEventsOf } from "../operations/events.ts";
import { basisOf, parseHistory, readHistory } from "../operations/history.ts";
import { extendedOut, readIntradayHistory } from "../operations/intraday.ts";
import type { ExtendedRead, Markets } from "../operations/markets.ts";
import { parseMovers, readMovers } from "../operations/movers.ts";
import {
  missingRevision,
  revisionItem,
  saveAnswer,
  savedItem,
} from "../operations/profile.ts";
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
import type { World } from "../operations/track.ts";
import type { Who } from "../operations/who.ts";
import { renderMarkdown } from "../profile/markdown.ts";
import {
  profileVersion,
  profileVersions,
  readProfile,
} from "../profile/store.ts";
import { readRule, readRules } from "../rules/store.ts";
import { errorFields, type Log } from "../runtime/log.ts";
import { CallerGone } from "../server/caller.ts";
import { type Email, email as emailOf } from "../server/email/settings.ts";
import { type Links, links as linksOf } from "../server/links.ts";
import { NO_EVENTS } from "../sources/finnhub/store.ts";
import { ATTRIBUTION } from "../sources/fred/sync.ts";
import { FUND_SOURCE } from "../sources/ids.ts";
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
import { setSharing, sharingAnswer } from "./sharing.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// read: an agent key, or the admin key, which holds every scope; admin:
// the admin key or an admin's login; session: the admin key or anyone's
// login, never an agent key; none: served before either, since it holds no
// data and a browser opening it sends no key; portfolio:, rules:,
// profile: and analysis: an agent key its person gave that access,
// holdings, the profile and rules being the person's and the analysis
// shared by everyone
export type Scope =
  | "read"
  | "admin"
  | "session"
  | "none"
  | "portfolio:read"
  | "portfolio:write"
  | "rules:read"
  | "rules:write"
  | "profile:read"
  | "profile:write"
  | "analysis:read"
  | "analysis:write";

export type Route = {
  method: Method;
  // {name} matches one path segment
  path: string;
  scope: Scope;
  // a login opens every route but these, the rules writes
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
  alerts: (req: Request, owner: string) => Promise<Response>;
  admin: AdminDeps;
  // World markets and what each symbol resolved to
  world: World;
  log: Log;
  // hides a key made through POST /keys from the log; none in tests that
  // read no log
  mask?: (token: string) => void;
  // email and its links; off when none is given
  email?: Email;
  links?: Links;
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
const PATH_ID = /^[1-9]\d{0,14}$/;

function ruleId(raw: string): number {
  if (!PATH_ID.test(raw)) {
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
  who: Who,
): Promise<Response> {
  const read = await readIntradayHistory(m, args, null, who);
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

async function bars(
  m: Markets,
  url: URL,
  raw: string,
  who: Who,
): Promise<Response> {
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
  if (args.interval === "5m") return intraday(m, args, who);
  const read = await readHistory(m, args, null, who);
  if ("error" in read) return problemOf({ input: read.input, ...read.error });
  const i = read.instrument;
  // a range ending today or later still takes the next live bar; a hand
  // price may be entered again any day
  const final =
    i.source !== FUND_SOURCE &&
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
      handle: (_req, url, params, who) => bars(m, url, params.symbol!, who),
    },
    {
      method: "GET",
      path: "/instruments/{symbol}",
      scope: "read",
      handle: (_req, url, params, who) =>
        instrument(m, who, url, params.symbol!),
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
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return json({
          rules: readRules(m.db, who.user).map((r) => ruleItem(m, r)),
        });
      },
    },
    {
      method: "POST",
      path: "/rules",
      scope: "rules:write",
      cookie: false,
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["symbol", "condition", "note"]);
        const args = parseRules({ ...body, action: "create" });
        if (args.action !== "create") throw new Error("not a create");
        const made = await createRule(m, who.user, args);
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
      handle: async (_req, url, params, who) => {
        noQuery(url);
        const id = ruleId(params.id!);
        const rule = readRule(m.db, who.user, id);
        if (rule === null) return noRule(id);
        return json({ rule: ruleItem(m, rule) });
      },
    },
    {
      method: "PATCH",
      path: "/rules/{id}",
      scope: "rules:write",
      cookie: false,
      handle: async (req, url, params, who) => {
        noQuery(url);
        const id = ruleId(params.id!);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const body = fields(read.body, ["paused"]);
        const args = parseRules({ ...body, action: "pause", id });
        if (args.action !== "pause") throw new Error("not a pause");
        const done = await pauseRule(m, who.user, args);
        if ("error" in done) return problemOf(done);
        return json(done);
      },
    },
    {
      method: "DELETE",
      path: "/rules/{id}",
      scope: "rules:write",
      cookie: false,
      handle: async (_req, url, params, who) => {
        noQuery(url);
        const done = await deleteRuleById(m, who.user, ruleId(params.id!));
        if ("error" in done) return problemOf(done);
        return new Response(null, { status: 204, headers: NO_STORE });
      },
    },
  ];
}

// the text drawn as HTML too, so the web UI ships no Markdown parser
const profileItem = (r: Revision | null) =>
  r === null
    ? {
        text: null,
        html: null,
        revision: null,
        author: null,
        updated_at: null,
        bytes: null,
      }
    : { text: r.text, html: renderMarkdown(r.text), ...revisionItem(r) };

// the profile is private as holdings are: every route takes a profile scope
function profile(m: Markets): Route[] {
  return [
    {
      method: "GET",
      path: "/profile",
      scope: "profile:read",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return json(profileItem(readProfile(m.db, who.user)));
      },
    },
    {
      method: "PUT",
      path: "/profile",
      scope: "profile:write",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const save = parseSave(
          fields(read.body, ["revision", "text", "edits"]),
        );
        const done = await saveAnswer(m, who, save);
        if ("error" in done) return problemOf(done);
        return json(savedItem(done));
      },
    },
    // the editor's Preview: a draft drawn as a save would draw it, never kept
    {
      method: "POST",
      path: "/profile/preview",
      scope: "profile:write",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const f = fields(read.body, ["text"]);
        if (typeof f.text !== "string") {
          throw new ArgError("text must be a string");
        }
        return json({ html: renderMarkdown(documentText(f.text)) });
      },
    },
    {
      method: "GET",
      path: "/profile/versions",
      scope: "profile:read",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return json({
          revisions: profileVersions(m.db, who.user).map(revisionItem),
        });
      },
    },
    {
      method: "GET",
      path: "/profile/versions/{revision}",
      scope: "profile:read",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        if (!PATH_ID.test(params.revision!)) {
          throw new ArgError(
            "the path ends with a revision, a positive integer",
          );
        }
        const n = Number(params.revision);
        const r = profileVersion(m.db, who.user, n);
        if (r === null) return problemOf(missingRevision(m, who.user, n));
        return json(profileItem(r));
      },
    },
  ];
}

// drawn as the profile is, with the move since measured at the read
function analysisBody(m: Markets, i: Instrument, note: Note | null) {
  return note === null
    ? {
        text: null,
        html: null,
        revision: null,
        author: null,
        written_at: null,
        bytes: null,
        since_written: null,
      }
    : {
        text: note.text,
        html: renderMarkdown(note.text),
        ...analysisItem(note),
        since_written: sinceWritten(m, i, note),
      };
}

// shared by everyone, yet every route takes an analysis scope
function analysis(m: Markets): Route[] {
  const P = "/instruments/{symbol}/analysis";
  const target = async (raw: string, who: Who, read: boolean) => {
    const i = await analysisTarget(m, who, pathSymbol(raw), read);
    return "input" in i ? problemOf(i) : i;
  };
  return [
    {
      method: "GET",
      path: P,
      scope: "analysis:read",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        const i = await target(params.symbol!, who, true);
        if (i instanceof Response) return i;
        return json(analysisBody(m, i, readAnalysis(m.db, i.id)));
      },
    },
    {
      method: "PUT",
      path: P,
      scope: "analysis:write",
      handle: async (req, url, params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const save = parseSave(
          fields(read.body, ["revision", "text", "edits"]),
        );
        const i = await target(params.symbol!, who, false);
        if (i instanceof Response) return i;
        const done = await saveAnalysisAnswer(m, who, i.id, save);
        if ("error" in done) return problemOf(done);
        return json(savedAnalysis(done));
      },
    },
    // the editor's Preview: a draft drawn as a save would draw it, never kept
    {
      method: "POST",
      path: `${P}/preview`,
      scope: "analysis:write",
      handle: async (req, url) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        const f = fields(read.body, ["text"]);
        if (typeof f.text !== "string") {
          throw new ArgError("text must be a string");
        }
        return json({ html: renderMarkdown(documentText(f.text)) });
      },
    },
    {
      method: "GET",
      path: `${P}/versions`,
      scope: "analysis:read",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        const i = await target(params.symbol!, who, true);
        if (i instanceof Response) return i;
        return json({
          revisions: analysisVersions(m.db, i.id).map(analysisItem),
        });
      },
    },
    {
      method: "GET",
      path: `${P}/versions/{revision}`,
      scope: "analysis:read",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        if (!PATH_ID.test(params.revision!)) {
          throw new ArgError(
            "the path ends with a revision, a positive integer",
          );
        }
        const n = Number(params.revision);
        const i = await target(params.symbol!, who, true);
        if (i instanceof Response) return i;
        const note = analysisVersion(m.db, i.id, n);
        if (note === null) return problemOf(missingAnalysis(m, i.id, n));
        return json(analysisBody(m, i, note));
      },
    },
    {
      method: "GET",
      path: "/analysis",
      scope: "analysis:read",
      handle: async (_req, url, _params, who) => {
        const q = queryArgs(url, { page_size: "number", page_token: "text" });
        let at: ListAt | null = null;
        if (q.page_token !== undefined) {
          at = readListPosition(String(q.page_token));
          if (at === null) {
            throw new ArgError(
              "page_token is a next_page_token answered before",
            );
          }
        }
        const page = listedPage(m, who, at, pageSize(q.page_size));
        return json({
          analyses: page.shown.map(listedItem),
          ...(page.last === null
            ? {}
            : { next_page_token: listPosition(page.last) }),
        });
      },
    },
  ];
}

function operator(admin: AdminDeps, world: World): Route[] {
  const { m } = admin;
  return [
    {
      method: "GET",
      path: "/dashboard",
      scope: "session",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return json(readDashboard(m, who.user, world));
      },
    },
    {
      method: "PUT",
      path: "/dashboard",
      scope: "session",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return saveDashboard(m, who.user, world, parseLayout(read.body));
      },
    },
    {
      method: "GET",
      path: "/status",
      scope: "admin",
      handle: async (_req, url) => status(admin, url),
    },
    {
      method: "POST",
      path: "/status/retry",
      scope: "admin",
      handle: (req, url) => retryFailing(admin, req, url),
    },
    {
      method: "GET",
      path: "/instruments",
      scope: "admin",
      handle: async (_req, url, _params, who) => instruments(m, who.user, url),
    },
    {
      method: "GET",
      path: "/screener",
      scope: "session",
      handle: async (_req, url, _params, who) => screener(m, who.user, url),
    },
    {
      method: "DELETE",
      path: "/instruments/{symbol}",
      scope: "admin",
      handle: (_req, url, params, who) =>
        deleteOne(admin, who, url, params.symbol!),
    },
    {
      method: "GET",
      path: "/instruments/{symbol}/stored",
      scope: "session",
      handle: async (_req, url, params, who) =>
        storedCheck(m, who, url, params.symbol!),
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
      scope: "session",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return listAnswer(d.m, who);
      },
    },
    {
      method: "POST",
      path: "/keys",
      scope: "session",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return createOne(d, who, read.body);
      },
    },
    {
      method: "PATCH",
      path: "/keys/{id}",
      scope: "session",
      handle: async (req, url, params, who) => {
        noQuery(url);
        const read = await bodyOf(req);
        if (read instanceof Response) return read;
        return setOne(d, who, params.id!, read.body);
      },
    },
    {
      method: "DELETE",
      path: "/keys/{id}",
      scope: "session",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return revokeOne(d, who, params.id!);
      },
    },
  ];
}

// who sees a person's portfolios, set by that person in the web UI
function sharing(m: Markets): Route[] {
  return [
    {
      method: "GET",
      path: "/sharing",
      scope: "session",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return sharingAnswer(m, who);
      },
    },
    {
      method: "PUT",
      path: "/sharing/{id}",
      scope: "session",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return setSharing(m, who, params.id!, true);
      },
    },
    {
      method: "DELETE",
      path: "/sharing/{id}",
      scope: "session",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return setSharing(m, who, params.id!, false);
      },
    },
  ];
}

// admins only: people and email
function people(d: PeopleDeps): Route[] {
  const body = async (req: Request) => {
    const read = await bodyOf(req);
    if (read instanceof Response) return read;
    return read.body;
  };
  return [
    {
      method: "GET",
      path: "/users",
      scope: "admin",
      handle: async (_req, url) => {
        noQuery(url);
        return listUsers(d);
      },
    },
    {
      method: "POST",
      path: "/users",
      scope: "admin",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const b = await body(req);
        return b instanceof Response ? b : addUser(d, who, b);
      },
    },
    {
      method: "PATCH",
      path: "/users/{id}",
      scope: "admin",
      handle: async (req, url, params, who) => {
        noQuery(url);
        const b = await body(req);
        return b instanceof Response ? b : changeUser(d, who, params.id!, b);
      },
    },
    {
      method: "DELETE",
      path: "/users/{id}",
      scope: "admin",
      handle: async (_req, url, params, who) => {
        const q = queryArgs(url, { dry_run: "boolean" });
        return removeUser(d, who, params.id!, q.dry_run === true);
      },
    },
    {
      method: "POST",
      path: "/users/{id}/invite",
      scope: "admin",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return inviteAgain(d, who, params.id!);
      },
    },
    {
      method: "POST",
      path: "/users/{id}/sign-out",
      scope: "admin",
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return signOutUser(d, who, params.id!);
      },
    },
    {
      method: "GET",
      path: "/smtp",
      scope: "admin",
      handle: async (_req, url) => {
        noQuery(url);
        return smtpAnswer(d);
      },
    },
    {
      method: "PUT",
      path: "/smtp",
      scope: "admin",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const b = await body(req);
        return b instanceof Response ? b : putSmtp(d, who, b);
      },
    },
    {
      method: "DELETE",
      path: "/smtp",
      scope: "admin",
      handle: async (_req, url, _params, who) => {
        noQuery(url);
        return deleteSmtp(d, who);
      },
    },
    {
      method: "POST",
      path: "/smtp/test",
      scope: "admin",
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const b = await body(req);
        return b instanceof Response ? b : testSmtp(d, who, b);
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
  // without email given, it is off: no key file is ever read
  const email =
    deps.email ??
    emailOf({
      keys: { email: () => null, emailNames: () => [] },
      sender: async () => ({ ok: false, failure: "other", reply: null }),
    });
  const sent =
    deps.links ??
    linksOf({
      db: deps.m.db,
      writer: deps.m.writer,
      email,
      clock: deps.m.clock,
      log: deps.log,
    });
  const list: Route[] = [
    ...marketData(m),
    ...rules(m),
    ...portfolioRoutes(m),
    ...profile(m),
    ...analysis(m),
    {
      method: "GET",
      path: "/alerts",
      scope: "rules:read",
      handle: (req, _url, _params, who) => deps.alerts(req, who.user),
    },
    ...operator(admin, deps.world),
    ...keys({ m: deps.admin.m, mask: deps.mask ?? (() => {}) }),
    ...people({ m: deps.admin.m, email, links: sent }),
    ...sharing(deps.admin.m),
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
        // the credential went mid-call, so the write wrote nothing
        if (error instanceof CallerGone) {
          return problem(
            error.status === 401 ? "unauthorized" : "forbidden",
            error.message,
          );
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
