// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// By hand, for people reading the docs page; schemas keep to the tested subset.

import { CALLS_PER_MINUTE } from "../server/ratelimit.ts";
import { COOKIE } from "../server/session.ts";
import { paths, responses } from "./paths.ts";
import { portfolioPaths, portfolioSchemas } from "./portfolio-spec.ts";
import { schemas } from "./schemas.ts";

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "1ctx-markets",
    version: "v1",
    // no identifier or url: the page would link to another host
    license: { name: "Apache-2.0" },
    description: `Market data, price rules and portfolios, the same answers as the MCP tools.

- Each operation names the key it takes: an agent key, made by the admin, or the admin key, which opens every route. Portfolio routes take an agent key only when the admin gave it portfolio access.
- Each key makes at most ${CALLS_PER_MINUTE} calls a minute.
- A symbol is taken as written, with its exchange suffix (\`VVSM.DE\`, \`BRK-B\`, \`^VIX\`, \`CL=F\`), or as a stored id (\`US:NVDA\`).
- Results are not paged, except the stored instrument list and the alerts feed.
- Errors are problem details (RFC 9457): \`title\`, \`status\`, \`detail\` and \`code\`, the error to branch on. An error about one symbol among several is that item's \`error\`, inside a 200.`,
  },
  servers: [{ url: "/api/v1" }],
  security: [{ read: [] }],
  tags: [
    { name: "market data", description: "Quotes, research and screens." },
    {
      name: "instruments",
      description: "One instrument, its bars, and the stored instruments.",
    },
    { name: "rules", description: "Price rules and their alerts." },
    {
      name: "portfolios",
      description: "Trades, positions and holdings, valued live.",
    },
    { name: "dashboard", description: "The web UI's home page." },
    { name: "server", description: "The server's sources and jobs." },
    { name: "keys", description: "The agents' keys." },
    { name: "docs", description: "This page and its OpenAPI document." },
  ],
  paths: { ...paths, ...portfolioPaths },
  components: {
    securitySchemes: {
      read: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key, made by the admin, for market data and instruments.",
      },
      portfolioRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key the admin gave portfolio read or write access.",
      },
      portfolioWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key the admin gave portfolio write access.",
      },
      rulesRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key the admin gave rules read or write access: the rules and the alerts feed.",
      },
      rulesWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key the admin gave rules write access.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description:
          "The admin key. It opens every route, the operator's included.",
      },
      session: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE,
        description:
          "The web UI's sign-in cookie. It opens what the admin key opens but the rules writes. A request other than GET must come from this server's own pages.",
      },
    },
    schemas: { ...schemas, ...portfolioSchemas },
    responses,
  },
};
