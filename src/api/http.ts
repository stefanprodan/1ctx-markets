// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { ArgError, quoted } from "../operations/args.ts";

export const PREFIX = "/api/v1";

// a body a read route takes: 100 symbols and 8 filters are a few KiB
export const MAX_BODY_BYTES = 64 * 1024;

// a read is live, so no proxy or client may answer it again
export const NO_STORE = { "cache-control": "no-store" };

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = NO_STORE,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// a failed or timed-out source is the caller's to retry, unlike a server fault
const STATUS: Record<string, number> = {
  bad_arguments: 400,
  mixed_units: 400,
  no_event_source: 400,
  no_event: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  candidates: 404,
  no_data: 404,
  refused: 404,
  method_not_allowed: 405,
  conflict: 409,
  split_paused: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal: 500,
  timeout: 503,
  rate_limited: 503,
  source_error: 503,
};

export const statusOf = (code: string): number => STATUS[code] ?? 500;

// /mcp's and the sign-in's {error, message} errors, never /api/v1's
export const failed = (
  body: { error: string; message: string } & Record<string, unknown>,
  headers: Record<string, string> = NO_STORE,
): Response => json(body, statusOf(body.error), headers);

// RFC 9110's phrases: with no type, a problem's title is its status's
const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export const PROBLEM_TYPE = "application/problem+json";

// RFC 9457 without a type URL: code names the error, as the tools do
export function problem(
  code: string,
  detail: string,
  extensions: Record<string, unknown> = {},
  headers: Record<string, string> = NO_STORE,
): Response {
  const status = statusOf(code);
  return new Response(
    JSON.stringify({
      title: TITLES[status],
      status,
      detail,
      code,
      ...extensions,
    }),
    { status, headers: { "content-type": PROBLEM_TYPE, ...headers } },
  );
}

// a tool's error, {error, message, ...extensions}, as a problem
export const problemOf = (
  body: { error: string; message: string } & Record<string, unknown>,
  headers: Record<string, string> = NO_STORE,
): Response => {
  const { error, message, ...extensions } = body;
  return problem(error, message, extensions, headers);
};

// an item's error inside a 200: {code, detail, candidates?}
export function itemOf<T extends object>(item: T): object {
  if (!("error" in item) || typeof item.error !== "string") return item;
  const { error, message, candidates, ...rest } = item as Record<
    string,
    unknown
  >;
  return {
    ...rest,
    error: {
      code: error,
      detail: message,
      ...(candidates === undefined ? {} : { candidates }),
    },
  };
}

export const notFound = (detail = "no such route"): Response =>
  problem("not_found", detail);

export const notAllowed = (allow: readonly string[]): Response =>
  problem(
    "method_not_allowed",
    `use ${allow.join(", ")}`,
    {},
    {
      ...NO_STORE,
      allow: allow.join(", "),
    },
  );

export type Param = "text" | "list" | "number" | "boolean";

// a list is comma-separated as a shell script builds it; next is refused too,
// since only the stored list pages
export function queryArgs(
  url: URL,
  params: Record<string, Param>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const kind = params[name];
    if (kind === undefined) {
      throw new ArgError(`unknown argument ${quoted(name)}`);
    }
    const values = url.searchParams.getAll(name);
    if (values.length !== 1) {
      throw new ArgError(`${quoted(name)} must be given once`);
    }
    const v = values[0]!;
    if (kind === "list") out[name] = v.split(",");
    else if (kind === "number") {
      const n = v.trim() === "" ? Number.NaN : Number(v);
      if (!Number.isFinite(n)) throw new ArgError(`${name} must be a number`);
      out[name] = n;
    } else if (kind === "boolean") {
      if (v !== "true" && v !== "false") {
        throw new ArgError(`${name} must be true or false`);
      }
      out[name] = v === "true";
    } else out[name] = v;
  }
  return out;
}

// a path segment is percent-decoded; a raw ^ arrives as it is
export function pathSymbol(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ArgError("the path holds a malformed symbol");
  }
}

export const noQuery = (url: URL): void => {
  if (url.search !== "") throw new ArgError("this route takes no query");
};

// Bun itself refuses a body over its own cap before any route runs
export async function readBody(
  req: Request,
  max: number,
): Promise<{ body: unknown } | Response> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;.*)?$/i.test(type)) {
    return problem("unsupported_media_type", "the body is application/json");
  }
  const tooLarge = () =>
    problem("payload_too_large", `the body is at most ${max} bytes`);
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > max) return tooLarge();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > max) return tooLarge();
  try {
    return {
      body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return problem("bad_arguments", "the body is not JSON");
  }
}
