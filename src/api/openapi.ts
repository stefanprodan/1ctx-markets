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
    description: `Market data and price rules for scripts and other tools, the same reads the MCP tools answer. JSON in and out; query parameters for reads, a JSON body where the arguments are a structure. Nothing a script reads is paged: every such route answers its whole result, since a script that does not follow a cursor would lose what is past it; only the operator's instrument list, drawn a screen at a time, is. An argument a route does not take is refused (400), next included. Every error is {"error": code, "message": text}, with the tools' own codes. Another method on a path answers 405 with Allow. Reads answer cache-control: no-store, since prices are live. The read key is the server's bearer; the admin key is for the operator's routes alone, and neither is taken where the other is; the web UI's session cookie opens the reads and the operator's routes.`,
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
        description: "The server's bearer, secrets/bearer.key.",
      },
      admin: {
        type: "http",
        scheme: "bearer",
        description: "The operator's key, secrets/admin.key.",
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
