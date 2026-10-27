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

// the page names its files' fingerprints, so a new build's must be seen
const PAGE_CACHE = "no-cache";

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

export const fingerprint = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12);

// Each file the page loads named with its bytes' fingerprint: a CDN keeps
// .js and .css by their extension, so a changed file needs a new URL.
export function fingerprinted(
  html: string,
  hashes: Record<(typeof DOC_FILES)[number], string>,
): string {
  let out = html;
  for (const name of DOC_FILES) {
    const url = `/api/v1/docs/${name}"`;
    if (out.split(url).length !== 2) {
      throw new Error(`the docs page does not name ${name} once`);
    }
    out = out.replace(url, `/api/v1/docs/${name}?h=${hashes[name]}"`);
  }
  return out;
}

// once at start, from the files embedded in the binary
const HASHES = Object.fromEntries(
  await Promise.all(
    DOC_FILES.map(async (name) => [
      name,
      fingerprint(await Bun.file(FILES[name]).bytes()),
    ]),
  ),
) as Record<(typeof DOC_FILES)[number], string>;

const PAGE = fingerprinted(
  await Bun.file(page as unknown as string).text(),
  HASHES,
);

const headersOf = (type: string, cache: string, more = {}) => ({
  "content-type": type,
  "cache-control": cache,
  "x-content-type-options": "nosniff",
  ...more,
});

export const docsPage = (): Response =>
  new Response(PAGE, {
    headers: headersOf("text/html; charset=utf-8", PAGE_CACHE, {
      "content-security-policy": POLICY,
    }),
  });

// any fingerprint, stale or none, answers the file as this build has it
export const docsFile = (name: keyof typeof TYPES): Response =>
  new Response(Bun.file(FILES[name]), {
    headers: headersOf(TYPES[name], ASSET_CACHE),
  });
