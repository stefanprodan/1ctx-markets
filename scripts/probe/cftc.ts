// The CFTC's reports are keyless; the queries are the client's own, so a
// recording is what the server asks. Every date is moved MOVED_WEEKS back
// before the first write, weekdays and cadence kept, so a fixture's weeks
// are no real report's and tests follow the moved recording time.
import { join } from "node:path";
import {
  DATASETS,
  HOST,
  marketsQuery,
  type Report,
  SPACING_MS,
  weeksQuery,
} from "../../src/sources/cftc/client.ts";
import { HISTORY_WEEKS, LIST_WEEKS } from "../../src/sources/cftc/list.ts";
import { record, sleep } from "./record";

const dir = join(import.meta.dir, "../../test/fixtures/cftc");
const url = (report: Report, query: Record<string, string>) =>
  `${HOST}/resource/${DATASETS[report]}.json?${new URLSearchParams(query)}`;

const since = new Date(Date.now() - LIST_WEEKS * 7 * 86_400_000)
  .toISOString()
  .slice(0, 10);

export const MOVED_WEEKS = 156;
const WEEK_MS = 7 * 86_400_000;

const moved = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - MOVED_WEEKS * WEEK_MS)
    .toISOString()
    .slice(0, 10);

export function moveDates(fixture: Record<string, unknown>) {
  const text = JSON.stringify(fixture).replace(/\d{4}-\d{2}-\d{2}/g, moved);
  const out = JSON.parse(text) as Record<string, unknown>;
  const headers = out.headers as Record<string, string>;
  for (const [k, v] of Object.entries(headers)) {
    const at = Date.parse(v);
    if (/date|modified/.test(k) && !Number.isNaN(at)) {
      headers[k] = new Date(at - MOVED_WEEKS * WEEK_MS).toUTCString();
    }
  }
  for (const k of Object.keys(fixture)) delete fixture[k];
  Object.assign(fixture, {
    note: `every date moved ${MOVED_WEEKS} weeks back from the recording`,
    ...out,
  });
}

const cases: [string, string][] = [
  ["markets-disaggregated", url("disaggregated", marketsQuery(since))],
  ["markets-financial", url("financial", marketsQuery(since))],
  // a commodity market, and a financial one that sums its micro contracts
  [
    "weeks-088691",
    url(
      "disaggregated",
      weeksQuery("disaggregated", "088691", HISTORY_WEEKS + 1),
    ),
  ],
  [
    "weeks-13874+",
    url("financial", weeksQuery("financial", "13874+", HISTORY_WEEKS + 1)),
  ],
  // a list that fills its limit, which the client refuses as cut short
  [
    "markets-at-limit",
    url("financial", { ...marketsQuery(since), $limit: "20" }),
  ],
];

// case names record only those, so the others keep their recording time
const only = new Set(process.argv.slice(2));
for (const [name, u] of import.meta.main ? cases : []) {
  if (only.size > 0 && !only.has(name)) continue;
  await record(join(dir, `${name}.json`), u, {}, "", moveDates);
  // four times the client's spacing: a probe shares the server's address
  await sleep(4 * SPACING_MS);
}
