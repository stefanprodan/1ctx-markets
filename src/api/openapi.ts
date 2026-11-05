// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// By hand, for people reading the docs page; schemas keep to the tested subset.

import { CALLS_PER_MINUTE } from "../server/ratelimit.ts";
import { COOKIE } from "../server/session.ts";
import { analysisPaths, analysisSchemas } from "./analysis-spec.ts";
import { paths, responses } from "./paths.ts";
import { peoplePaths, peopleSchemas } from "./people-spec.ts";
import { portfolioPaths, portfolioSchemas } from "./portfolio-spec.ts";
import { profilePaths, profileSchemas } from "./profile-spec.ts";
import { schemas } from "./schemas.ts";

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "1ctx-markets",
    version: "v1",
    // no identifier or url: the page would link to another host
    license: { name: "Apache-2.0" },
    description: `Market data, price alerts and portfolios, the same answers as the MCP tools.

- Each operation names the key it takes: an agent key, made by a person for their agent, or the admin key, which opens every route as the operator. An agent key reads and writes its person's own portfolios, profile and alerts, and the analysis every person shares, and those routes take it only when its person gave it that access. It never opens a web UI or admin route.
- Each key makes at most ${CALLS_PER_MINUTE} calls a minute.
- A symbol is taken as written, with its exchange suffix (\`VVSM.DE\`, \`BRK-B\`, \`^VIX\`, \`CL=F\`), or as a stored id (\`US:NVDA\`).
- Results are not paged, except where an answer gives \`next_page_token\`, and the alerts feed.
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
    { name: "alerts", description: "Price alerts and what triggered them." },
    {
      name: "portfolios",
      description: "Trades, positions and holdings, valued live.",
    },
    {
      name: "profile",
      description:
        "The owner's profile: one Markdown document, every save a revision.",
    },
    {
      name: "analysis",
      description:
        "An agent's dated analysis per symbol, shared by everyone on the server, every save a revision.",
    },
    { name: "dashboard", description: "The web UI's home page." },
    { name: "server", description: "The server's sources and jobs." },
    { name: "keys", description: "The agents' keys." },
    {
      name: "people",
      description: "The people on the server and the email that signs them in.",
    },
    { name: "docs", description: "This page and its OpenAPI document." },
  ],
  paths: {
    ...paths,
    ...portfolioPaths,
    ...profilePaths,
    ...analysisPaths,
    ...peoplePaths,
  },
  components: {
    securitySchemes: {
      read: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key, made by a person for their agent, for market data and instruments.",
      },
      portfolioRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key its person gave portfolio read or write access.",
      },
      portfolioWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key its person gave portfolio write access.",
      },
      alertsRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key its person gave alerts read or write access: the alerts, their history and the feed.",
      },
      alertsWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key its person gave alerts write access.",
      },
      profileRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key its person gave profile read or write access.",
      },
      profileWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key its person gave profile write access.",
      },
      analysisRead: {
        type: "http",
        scheme: "bearer",
        description:
          "An agent key its person gave analysis read or write access.",
      },
      analysisWrite: {
        type: "http",
        scheme: "bearer",
        description: "An agent key its person gave analysis write access.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description: "The admin key. It opens every route as the operator.",
      },
      session: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE,
        description:
          "A person's sign-in to the web UI, by an emailed link or, for the operator, the admin key. It opens their own rows and the market data, and the admin routes for an admin. A request other than GET must come from this server's own pages.",
      },
    },
    schemas: {
      ...schemas,
      ...portfolioSchemas,
      ...profileSchemas,
      ...analysisSchemas,
      ...peopleSchemas,
    },
    responses,
  },
};
