// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// By hand, for people reading the docs page; schemas keep to the tested subset.

import { COOKIE } from "../server/session.ts";
import { paths, responses } from "./paths.ts";
import { schemas } from "./schemas.ts";

export const spec = {
  openapi: "3.1.0",
  info: {
    title: "1ctx-markets",
    version: "v1",
    // no identifier or url: the page would link to another host
    license: { name: "Apache-2.0" },
    description: `Market data and price rules, the same answers as the MCP tools.

- Reads take the bearer key, \`/admin\` routes the admin key.
- Results are not paged, except the admin instrument list.
- Errors are \`{"error": code, "message": text}\`.`,
  },
  servers: [{ url: "/api/v1" }],
  security: [{ read: [] }],
  tags: [
    { name: "market data", description: "Quotes, bars, research and screens." },
    { name: "rules", description: "Price rules and their alerts." },
    { name: "admin", description: "Operator routes, admin key only." },
    { name: "docs", description: "This page and its OpenAPI document." },
  ],
  paths,
  components: {
    securitySchemes: {
      read: {
        type: "http",
        scheme: "bearer",
        description: "The read key, for the market data and rules routes.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description: "The admin key, for the `/admin` routes only.",
      },
      session: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE,
        description:
          "The web UI's sign-in cookie. It opens the `/admin` routes, the GET reads and `POST /screen`. A request other than GET must come from this server's own pages.",
      },
    },
    schemas,
    responses,
  },
};
