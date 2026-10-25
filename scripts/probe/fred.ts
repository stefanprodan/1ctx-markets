// Records FRED answers as test fixtures.
// Run: bun scripts/probe/fred.ts  (FRED_KEY_FILE overrides the key path)
// FRED takes its key only in the URL; record() scrubs it from what it stores.
import { homedir } from "node:os";
import { join } from "node:path";
import { readKey, record, sleep } from "./record";

const key = await readKey(
  "FRED_KEY_FILE",
  join(homedir(), ".1ctx-markets/secrets/source-fred.key"),
);
const base = "https://api.stlouisfed.org/fred";
const dir = join(import.meta.dir, "../../test/fixtures/fred");

const url = (path: string, params: Record<string, string>) =>
  `${base}/${path}?${new URLSearchParams({ ...params, api_key: key, file_type: "json" })}`;

const series = ["DGS10", "BAMLH0A0HYM2", "VIXCLS", "DCOILWTICO"];
// ICE BofA series may not be redistributed: keep the shape, never the values
const synthetic = new Set(["BAMLH0A0HYM2"]);

const cases: [string, string][] = [];
for (const id of series) {
  const slug = id.toLowerCase();
  cases.push(
    [`series-${slug}`, url("series", { series_id: id })],
    [
      `observations-${slug}`,
      url("series/observations", {
        series_id: id,
        sort_order: "desc",
        limit: "30",
      }),
    ],
  );
}
cases.push(
  [
    "observations-unknown",
    url("series/observations", { series_id: "NOSUCHSERIES" }),
  ],
  [
    "observations-bad-key",
    `${base}/series/observations?${new URLSearchParams({ series_id: "DGS10", api_key: "0".repeat(32), file_type: "json" })}`,
  ],
);

// 120 calls a minute is the limit; stay far under it.
for (const [name, u] of cases) {
  const file = join(dir, `${name}.json`);
  await record(file, u, {}, key);
  const id = series.find((s) => name === `observations-${s.toLowerCase()}`);
  if (id && synthetic.has(id)) {
    const fixture = await Bun.file(file).json();
    fixture.note =
      "values replaced with made-up numbers: this series may not be redistributed";
    let n = 0;
    for (const obs of fixture.body.observations ?? []) {
      if (obs.value !== ".") obs.value = (3 + (n++ % 7) / 10).toFixed(2);
    }
    await Bun.write(file, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  await sleep(1000);
}
