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

export const failed = (
  body: { error: string; message: string } & Record<string, unknown>,
  headers: Record<string, string> = NO_STORE,
): Response => json(body, statusOf(body.error), headers);

export const notFound = (message = "no such route"): Response =>
  failed({ error: "not_found", message });

export const notAllowed = (allow: readonly string[]): Response =>
  failed(
    { error: "method_not_allowed", message: `use ${allow.join(", ")}` },
    { ...NO_STORE, allow: allow.join(", ") },
  );

export type Param = "text" | "list" | "number" | "boolean";

// a list is comma-separated as a shell script builds it; next is refused too,
// since nothing is paged
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
    return failed({
      error: "unsupported_media_type",
      message: "the body is application/json",
    });
  }
  const tooLarge = () =>
    failed({
      error: "payload_too_large",
      message: `the body is at most ${max} bytes`,
    });
  const length = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > max) return tooLarge();
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > max) return tooLarge();
  try {
    return {
      body: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    };
  } catch {
    return failed({ error: "bad_arguments", message: "the body is not JSON" });
  }
}
