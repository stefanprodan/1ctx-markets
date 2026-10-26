// One real call, one fixture; a key in a header, query or echoed cursor
// never reaches disk.

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
  let out = JSON.stringify(fixture, null, 2) + "\n";
  // a source may echo the key, inside a cursor URL for one
  if (out.includes(key)) out = out.split(key).join("REDACTED");
  if (out.length > MAX_BYTES)
    throw new Error(`${file}: fixture over 1 MB, use a smaller limit`);
  await Bun.write(file, out);
  console.log(`${res.status} ${file}`);
  return { status: res.status, headers, body };
}
