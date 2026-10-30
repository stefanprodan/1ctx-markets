// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios over REST, the tool's own reads and writes; holdings are
// private, so every route takes a portfolio scope, never read.

import type { Failure } from "../operations/answer.ts";
import { ArgError, date, fields } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import {
  ADD_KINDS,
  type AddKind,
  addPosition,
  addTrade,
  createBroker,
  createPortfolio,
  findBroker,
  findPortfolio,
  historyOf,
  KIND_ARGS,
  listAll,
  namedCurrency,
  parseChange,
  parsePosition,
  parseTrade,
  portfolioItem,
  positionItem,
  readHoldings,
  readTradeList,
  removeBroker,
  removePortfolio,
  saveSettings,
  setPositionState,
  setTradeState,
  settingsItem,
  UPDATE_FIELDS,
  updateBroker,
  updatePortfolio,
  updatePosition,
  type Who,
} from "../operations/portfolio.ts";
import {
  exportCsv,
  importCsv,
  MAX_IMPORT_BODY,
  parseImport,
} from "../operations/portfolio-import.ts";
import { readPositions } from "../portfolios/store.ts";
import {
  json,
  MAX_BODY_BYTES,
  NO_STORE,
  noQuery,
  PREFIX,
  problem,
  problemOf,
  queryArgs,
  readBody,
} from "./http.ts";

// routes.ts's Route, spelled here so the two files import one way
type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  scope: "portfolio:read" | "portfolio:write";
  handle: (
    req: Request,
    url: URL,
    params: Record<string, string>,
    who: Who,
  ) => Promise<Response>;
};

const ID = /^[1-9]\d{0,14}$/;

function idOf(raw: string, what: string): number {
  if (!ID.test(raw)) {
    throw new ArgError(`the path ends with a ${what} id, a positive integer`);
  }
  return Number(raw);
}

async function body(
  req: Request,
  max = MAX_BODY_BYTES,
): Promise<{ body: unknown } | Response> {
  return readBody(req, max);
}

const isFailure = (v: unknown): v is Failure =>
  typeof v === "object" && v !== null && "error" in v;

const answer = (v: object | Failure, status = 200): Response =>
  isFailure(v) ? problemOf(v) : json(v, status);

const created = (v: object | Failure, location: (v: any) => string) =>
  isFailure(v)
    ? problemOf(v)
    : json(v, 201, { ...NO_STORE, location: `${PREFIX}${location(v)}` });

const gone = (v: true | Failure) =>
  v === true
    ? new Response(null, { status: 204, headers: NO_STORE })
    : problemOf(v);

const R = "portfolio:read" as const;
const W = "portfolio:write" as const;

export function portfolioRoutes(m: Markets): Route[] {
  const holdingsOf = async (url: URL, portfolio: number | null) => {
    const q = queryArgs(url, { broker: "text", currency: "text" });
    const read = await readHoldings(m, {
      portfolio,
      broker: q.broker === undefined ? null : String(q.broker),
      currency: namedCurrency(q.currency),
    });
    return answer(read);
  };
  return [
    {
      method: "GET",
      path: "/portfolios",
      scope: R,
      handle: async (_req, url) => {
        noQuery(url);
        return json(listAll(m));
      },
    },
    {
      method: "POST",
      path: "/portfolios",
      scope: W,
      handle: async (req, url) => {
        noQuery(url);
        const read = await body(req);
        if (read instanceof Response) return read;
        return created(
          await createPortfolio(m, read.body),
          (v) => `/portfolios/${v.portfolio.id}`,
        );
      },
    },
    {
      method: "GET",
      path: "/portfolios/{id}",
      scope: R,
      handle: async (_req, url, params) => {
        noQuery(url);
        const id = idOf(params.id!, "portfolio");
        const p = findPortfolio(m.db, id);
        if (p === null || isFailure(p)) {
          return problem("not_found", `no portfolio ${id}`);
        }
        return json({ portfolio: portfolioItem(m.db, p) });
      },
    },
    {
      method: "PATCH",
      path: "/portfolios/{id}",
      scope: W,
      handle: async (req, url, params) => {
        noQuery(url);
        const id = idOf(params.id!, "portfolio");
        const read = await body(req);
        if (read instanceof Response) return read;
        return answer(await updatePortfolio(m, id, read.body));
      },
    },
    {
      method: "DELETE",
      path: "/portfolios/{id}",
      scope: W,
      handle: async (_req, url, params) => {
        noQuery(url);
        return gone(await removePortfolio(m, idOf(params.id!, "portfolio")));
      },
    },
    {
      method: "GET",
      path: "/portfolios/{id}/holdings",
      scope: R,
      handle: async (_req, url, params) =>
        holdingsOf(url, idOf(params.id!, "portfolio")),
    },
    {
      method: "GET",
      path: "/holdings",
      scope: R,
      handle: async (_req, url) => holdingsOf(url, null),
    },
    {
      method: "GET",
      path: "/portfolios/{id}/export",
      scope: R,
      handle: async (_req, url, params) => {
        noQuery(url);
        const id = idOf(params.id!, "portfolio");
        const p = findPortfolio(m.db, id);
        if (p === null || isFailure(p)) {
          return problem("not_found", `no portfolio ${id}`);
        }
        return new Response(exportCsv(m, p), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="portfolio-${p.id}.csv"`,
            ...NO_STORE,
          },
        });
      },
    },
    {
      method: "POST",
      path: "/portfolios/{id}/import",
      scope: W,
      handle: async (req, url, params, who) => {
        noQuery(url);
        const id = idOf(params.id!, "portfolio");
        const read = await body(req, MAX_IMPORT_BODY);
        if (read instanceof Response) return read;
        const b = fields(read.body, [
          "csv",
          "broker",
          "currency",
          "confirm",
          "dry_powder",
        ]);
        return answer(
          await importCsv(m, who, parseImport({ ...b, portfolio: id })),
        );
      },
    },
    {
      method: "GET",
      path: "/trades",
      scope: R,
      handle: async (_req, url) => {
        const q = queryArgs(url, {
          portfolio: "text",
          broker: "text",
          symbol: "text",
          from: "text",
          to: "text",
          removed: "boolean",
        });
        const list = readTradeList(m, {
          portfolio: (q.portfolio as string | undefined) ?? null,
          broker: (q.broker as string | undefined) ?? null,
          symbol: (q.symbol as string | undefined) ?? null,
          from: date(q.from, "from"),
          to: date(q.to, "to"),
          removed: q.removed === true,
        });
        return isFailure(list) ? problemOf(list) : json({ trades: list });
      },
    },
    {
      method: "POST",
      path: "/trades",
      scope: W,
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await body(req);
        if (read instanceof Response) return read;
        const f = fields(read.body, ["portfolio", ...KIND_ARGS.trade]);
        const done = await addTrade(m, who, parseTrade(f));
        return created(done, (v) =>
          v.trade === undefined ? "/trades" : `/trades/${v.trade.id}`,
        );
      },
    },
    {
      method: "DELETE",
      path: "/trades/{id}",
      scope: W,
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return answer(
          await setTradeState(m, who, idOf(params.id!, "trade"), true),
        );
      },
    },
    {
      method: "POST",
      path: "/trades/{id}/restore",
      scope: W,
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return answer(
          await setTradeState(m, who, idOf(params.id!, "trade"), false),
        );
      },
    },
    {
      method: "GET",
      path: "/positions",
      scope: R,
      handle: async (_req, url) => {
        const q = queryArgs(url, {
          portfolio: "text",
          broker: "text",
          removed: "boolean",
        });
        const p = findPortfolio(
          m.db,
          (q.portfolio as string | undefined) ?? null,
        );
        if (isFailure(p)) return problemOf(p);
        const b = findBroker(m.db, (q.broker as string | undefined) ?? null);
        if (isFailure(b)) return problemOf(b);
        return json({
          positions: readPositions(m.db, {
            portfolio: p?.id ?? null,
            broker: b?.id ?? null,
            removed: q.removed === true,
          }).map((x) => positionItem(m.db, x)),
        });
      },
    },
    {
      method: "POST",
      path: "/positions",
      scope: W,
      handle: async (req, url, _params, who) => {
        noQuery(url);
        const read = await body(req);
        if (read instanceof Response) return read;
        const raw = read.body as Record<string, unknown> | null;
        const kind = (
          typeof raw === "object" && raw !== null ? raw.kind : undefined
        ) as AddKind | undefined;
        if (
          kind === undefined ||
          kind === "trade" ||
          !ADD_KINDS.includes(kind)
        ) {
          throw new ArgError("kind must be one of cash, fund, bond");
        }
        const f = fields(read.body, ["kind", "portfolio", ...KIND_ARGS[kind]]);
        const done = await addPosition(m, who, parsePosition(kind, f));
        return created(done, (v) => `/positions/${v.position.id}`);
      },
    },
    {
      method: "PATCH",
      path: "/positions/{id}",
      scope: W,
      handle: async (req, url, params, who) => {
        noQuery(url);
        const id = idOf(params.id!, "position");
        const read = await body(req);
        if (read instanceof Response) return read;
        const f = fields(read.body, [...UPDATE_FIELDS, "currency"]);
        return answer(await updatePosition(m, who, id, parseChange(f)));
      },
    },
    {
      method: "DELETE",
      path: "/positions/{id}",
      scope: W,
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return answer(
          await setPositionState(m, who, idOf(params.id!, "position"), true),
        );
      },
    },
    {
      method: "POST",
      path: "/positions/{id}/restore",
      scope: W,
      handle: async (_req, url, params, who) => {
        noQuery(url);
        return answer(
          await setPositionState(m, who, idOf(params.id!, "position"), false),
        );
      },
    },
    {
      method: "GET",
      path: "/positions/{id}/history",
      scope: R,
      handle: async (_req, url, params) => {
        noQuery(url);
        return answer(historyOf(m, idOf(params.id!, "position")));
      },
    },
    {
      method: "GET",
      path: "/brokers",
      scope: R,
      handle: async (_req, url) => {
        noQuery(url);
        return json({ brokers: listAll(m).brokers });
      },
    },
    {
      method: "POST",
      path: "/brokers",
      scope: W,
      handle: async (req, url) => {
        noQuery(url);
        const read = await body(req);
        if (read instanceof Response) return read;
        return created(
          await createBroker(m, read.body),
          (v) => `/brokers/${v.broker.id}`,
        );
      },
    },
    {
      method: "PATCH",
      path: "/brokers/{id}",
      scope: W,
      handle: async (req, url, params) => {
        noQuery(url);
        const id = idOf(params.id!, "broker");
        const read = await body(req);
        if (read instanceof Response) return read;
        return answer(await updateBroker(m, id, read.body));
      },
    },
    {
      method: "DELETE",
      path: "/brokers/{id}",
      scope: W,
      handle: async (_req, url, params) => {
        noQuery(url);
        return gone(await removeBroker(m, idOf(params.id!, "broker")));
      },
    },
    {
      method: "GET",
      path: "/portfolio-settings",
      scope: R,
      handle: async (_req, url) => {
        noQuery(url);
        return json(settingsItem(m.db));
      },
    },
    {
      method: "PUT",
      path: "/portfolio-settings",
      scope: W,
      handle: async (req, url) => {
        noQuery(url);
        const read = await body(req);
        if (read instanceof Response) return read;
        return json(await saveSettings(m, read.body));
      },
    },
  ];
}
