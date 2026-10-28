// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// By hand, so each limit carries its reason; schemas keep to the tested subset.

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
    { name: "market data" },
    { name: "rules" },
    { name: "admin" },
    { name: "docs" },
  ],
  paths,
  components: {
    securitySchemes: {
      read: {
        type: "http",
        scheme: "bearer",
        description: "The server's bearer key.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description: "The operator's admin key.",
      },
      session: {
        type: "apiKey",
        in: "cookie",
        name: COOKIE,
        description:
          "The web UI's sign-in, set by POST /ui/session with the admin key: it opens the admin routes and every read, and a write by it needs an Origin of this server's host.",
      },
    },
    schemas,
    responses,
  },
};
