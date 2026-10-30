// SEC asks for a contact in the User-Agent; record() scrubs that line from
// everything it stores, and request headers are never stored.
import { homedir } from "node:os";
import { join } from "node:path";
import { readKey, record, sleep } from "./record";

const contact = await readKey(
  "EDGAR_KEY_FILE",
  join(homedir(), ".1ctx-markets/secrets/source-edgar.key"),
);
const dir = join(import.meta.dir, "../../test/fixtures/edgar");
const auth = { "User-Agent": contact };
// SEC allows 10 calls a second; stay far under it
const GAP_MS = 400;

// the tests' symbols only: the whole map is 800 KB before pretty-printing
const TICKERS = new Set([
  "AAPL",
  "JPM",
  "TSM",
  "NVDA",
  "SURG",
  "OPTU",
  "BRK-B",
  "GOOG",
  "GOOGL",
]);

type Fixture = Record<string, unknown> & { body: any };

function trimTickers(fx: Fixture) {
  fx.note = `trimmed to ${[...TICKERS].join(", ")}; SEC answers every listed ticker`;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fx.body ?? {})) {
    if (TICKERS.has((v as { ticker: string }).ticker)) kept[k] = v;
  }
  fx.body = kept;
}

// the forms a test reads; others are sampled so a skip is still tested
const KEPT = /^(10-K|10-Q|8-K|NT 10-[KQ]|S-1|S-3|424B[145])/;
const SAMPLE = 20;

function trimFilings(years: number, sampleOthers: boolean) {
  return (fx: Fixture) => {
    const recent = fx.body?.filings?.recent;
    if (recent === undefined) return;
    const floor = new Date(Date.parse(String(fx.recordedAt)));
    floor.setUTCFullYear(floor.getUTCFullYear() - years);
    const since = floor.toISOString().slice(0, 10);
    const keep: number[] = [];
    let others = 0;
    recent.form.forEach((form: string, i: number) => {
      if (recent.filingDate[i] < since) return;
      if (sampleOthers && !KEPT.test(form) && others++ >= SAMPLE) return;
      keep.push(i);
    });
    for (const k of Object.keys(recent)) {
      recent[k] = keep.map((i) => recent[k][i]);
    }
    fx.note = sampleOthers
      ? `filings since ${since} only, and of the other forms the first ${SAMPLE}: the whole answer is over 4 MB`
      : `filings since ${since} only`;
  };
}

const sub = (cik: number) =>
  `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`;

const cases: [string, string, ((fx: Fixture) => void) | undefined][] = [
  [
    "company-tickers",
    "https://www.sec.gov/files/company_tickers.json",
    trimTickers,
  ],
  // a calendar-year and a non-calendar-year US filer, a bank, a 20-F filer
  ["submissions-aapl", sub(320193), trimFilings(2, false)],
  ["submissions-nvda", sub(1045810), trimFilings(2, false)],
  ["submissions-jpm", sub(19617), trimFilings(2, true)],
  ["submissions-tsm", sub(1046179), trimFilings(2, false)],
  // an NT 10-Q and a 424B5 within 90 days of the recording
  ["submissions-surg", sub(1392694), trimFilings(2, false)],
  // an 8-K with items 2.02 and 4.02 within a year
  ["submissions-optu", sub(1702780), trimFilings(2, false)],
  ["submissions-unknown", sub(9999999999), undefined],
];

for (const [name, url, edit] of cases) {
  await record(
    join(dir, `${name}.json`),
    url,
    auth,
    contact,
    edit as ((f: Record<string, unknown>) => void) | undefined,
  );
  await sleep(GAP_MS);
}
