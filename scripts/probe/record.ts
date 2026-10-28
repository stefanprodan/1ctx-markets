// the key in any form, URL, header or body, is replaced before the first write

import { scrub } from "../../src/sources/source.ts";

const MAX_BYTES = 1_000_000;
const SECRET_PARAMS = ["token", "apikey", "apiKey", "api_key"];
const DROP_HEADERS = new Set([
  "set-cookie",
  "authorization",
  "x-finnhub-token",
]);

export async function readKey(
  envName: string,
  defaultPath: string,
): Promise<string> {
  const key = (
    await Bun.file(process.env[envName] ?? defaultPath).text()
  ).trim();
  if (!key) throw new Error(`empty key file (set ${envName})`);
  return key;
}

export function scrubUrl(raw: string): string {
  const u = new URL(raw);
  for (const p of SECRET_PARAMS)
    if (u.searchParams.has(p)) u.searchParams.set(p, "REDACTED");
  return u.toString();
}

// a source may echo the key, percent-encoded inside a cursor URL for one
function clean(value: unknown, key: string): unknown {
  if (typeof value === "string") return scrub(value, key);
  if (Array.isArray(value)) return value.map((v) => clean(v, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [scrub(k, key), clean(v, key)]),
    );
  }
  return value;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export async function record(
  file: string,
  url: string,
  authHeaders: Record<string, string>,
  key: string,
  // rewrites restricted data before the first write, so it never reaches disk
  edit?: (fixture: Record<string, unknown>) => void,
): Promise<Recorded> {
  const recordedAt = new Date().toISOString();
  const res = await fetch(url, {
    headers: { ...authHeaders, accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  });
  const fixture = {
    recordedAt,
    request: { method: "GET", url: scrubUrl(url) },
    status: res.status,
    headers,
    body,
  };
  edit?.(fixture);
  const out = JSON.stringify(clean(fixture, key), null, 2) + "\n";
  if (out.length > MAX_BYTES)
    throw new Error(`${file}: fixture over 1 MB, use a smaller limit`);
  await Bun.write(file, out);
  console.log(`${res.status} ${file}`);
  return { status: res.status, headers, body };
}
