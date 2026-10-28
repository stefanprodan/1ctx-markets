import { homedir } from "node:os";
import { join } from "node:path";
import { readKey, record, sleep } from "./record";

const key = await readKey(
  "FINNHUB_KEY_FILE",
  join(homedir(), ".1ctx-markets/secrets/source-finnhub.key"),
);
const base = "https://finnhub.io/api/v1";
const dir = join(import.meta.dir, "../../test/fixtures/finnhub");
const auth = { "X-Finnhub-Token": key };

// One US share, one Xetra ETF, one Bucharest share: the free key's coverage differs by exchange.
const symbols: Record<string, string> = {
  nvda: "NVDA",
  vvsm: "VVSM.DE",
  tlv: "TLV.RO",
};

const cases: [string, string][] = [];
for (const [slug, s] of Object.entries(symbols)) {
  const q = encodeURIComponent(s);
  cases.push(
    [`metric-${slug}`, `${base}/stock/metric?symbol=${q}&metric=all`],
    [`recommendation-${slug}`, `${base}/stock/recommendation?symbol=${q}`],
    [`earnings-${slug}`, `${base}/stock/earnings?symbol=${q}`],
    [
      `insider-sentiment-${slug}`,
      `${base}/stock/insider-sentiment?symbol=${q}&from=2026-01-01&to=2026-10-25`,
    ],
    [
      `calendar-earnings-${slug}`,
      `${base}/calendar/earnings?from=2026-07-01&to=2027-01-31&symbol=${q}`,
    ],
  );
}
// One day only keeps the whole-market calendar small.
cases.push([
  "calendar-earnings-day",
  `${base}/calendar/earnings?from=2026-10-28&to=2026-10-28`,
]);
// Two days past their dates hold actuals; a week shows whether a busy range is cut off.
cases.push([
  "calendar-earnings-two-days",
  `${base}/calendar/earnings?from=2026-10-26&to=2026-10-27`,
]);
cases.push([
  "calendar-earnings-week",
  `${base}/calendar/earnings?from=2026-10-26&to=2026-11-01`,
]);
cases.push(["price-target-nvda", `${base}/stock/price-target?symbol=NVDA`]);

const wanted = process.argv.slice(2);
const missing = wanted.filter((w) => !cases.some(([name]) => name === w));
if (missing.length) throw new Error(`unknown case: ${missing.join(", ")}`);
const run = wanted.length
  ? cases.filter(([name]) => wanted.includes(name))
  : cases;

// Free tier is 60 calls a minute; stay well under it.
for (const [name, url] of run) {
  await record(join(dir, `${name}.json`), url, auth, key);
  await sleep(1500);
}
