import { homedir } from "node:os";
import { join } from "node:path";
import { readKey, record, sleep } from "./record";

const key = await readKey(
  "MASSIVE_KEY_FILE",
  join(homedir(), ".1ctx-markets/secrets/source-massive.key"),
);
const base = "https://api.massive.com";
const dir = join(import.meta.dir, "../../test/fixtures/massive");
const auth = { Authorization: `Bearer ${key}` };
// Free tier is 5 calls a minute.
const gap = 15_000;

const first = await record(
  join(dir, "news-latest.json"),
  `${base}/v2/reference/news?order=desc&limit=5&sort=published_utc`,
  auth,
  key,
);
await sleep(gap);

const next = (first.body as { next_url?: string })?.next_url;
if (next) {
  await record(join(dir, "news-latest-page2.json"), next, auth, key);
  await sleep(gap);
}

await record(
  join(dir, "news-nvda-older.json"),
  `${base}/v2/reference/news?ticker=NVDA&published_utc.lt=2026-09-01T00:00:00Z&order=desc&limit=3&sort=published_utc`,
  auth,
  key,
);
await sleep(gap);

// Over a year back probes how deep the free history goes.
await record(
  join(dir, "news-nvda-year-old.json"),
  `${base}/v2/reference/news?ticker=NVDA&published_utc.lt=2025-09-01T00:00:00Z&order=desc&limit=3&sort=published_utc`,
  auth,
  key,
);
