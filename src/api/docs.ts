// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The bundled Swagger UI: embedded in the binary, so the page works on a
// box with no internet, and served under a policy that lets it reach this
// server alone.

import css from "swagger-ui-dist/swagger-ui.css" with { type: "file" };
import bundle from "swagger-ui-dist/swagger-ui-bundle.js" with { type: "file" };
import page from "./docs/index.html" with { type: "file" };
import init from "./docs/init.js" with { type: "file" };

// Swagger UI draws its icons as data: images; a browser run of the page,
// Authorize and Try it out included, needed nothing else beyond self.
export const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// the same for a build, and holding no data, so a browser may keep them
export const ASSET_CACHE = "public, max-age=3600";

const TYPES = {
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
  "swagger-ui.css": "text/css; charset=utf-8",
  "init.js": "text/javascript; charset=utf-8",
} as const;

export const DOC_FILES = Object.keys(TYPES) as (keyof typeof TYPES)[];

// Bun types an .html import as a bundle; with type file it is a path
const FILES: Record<keyof typeof TYPES, string> = {
  "swagger-ui-bundle.js": bundle,
  "swagger-ui.css": css,
  "init.js": init,
};

const served = (path: string, type: string, headers = {}) =>
  new Response(Bun.file(path), {
    headers: {
      "content-type": type,
      "cache-control": ASSET_CACHE,
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });

export const docsPage = (): Response =>
  served(page as unknown as string, "text/html; charset=utf-8", {
    "content-security-policy": POLICY,
  });

export const docsFile = (name: keyof typeof TYPES): Response =>
  served(FILES[name], TYPES[name]);
