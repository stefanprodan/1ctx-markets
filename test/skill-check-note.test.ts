// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "./helpers/temp.ts";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "skills",
  "market-analysis",
  "scripts",
  "check-note.sh",
);

const REFERENCES = join(
  import.meta.dir,
  "..",
  "skills",
  "market-analysis",
  "references",
);

const temp = tempDirs();
const dir = temp("check-note-");

type Kind = "stock" | "etf" | "fx" | "commodity";

const HEADER: Record<Kind, string[]> = {
  stock: [
    "- stance: Neutral · fundamentals: stable · valuation: in band",
    "- value band: 80–120 USD (base 100) · present value · horizon: 2–3 years",
  ],
  etf: [
    "- exposure stance: Neutral · rests on: earnings · horizon: 2–3 years",
    "- vehicle: Adequate (0.20% TER, physical)",
    "- valuation: index P/E 15 (issuer, 2026-01-02): fair",
  ],
  fx: [
    "- stance: range · fundamentals for AAA: stable · valuation: in band",
    "- value band: 4.0–5.0 BBB (base 4.5) · fair value at the writing date",
    "- carry: AAA 2.00% vs BBB 5.00% (policy rates, 2026-01-02)",
  ],
  commodity: [
    "- stance: Neutral · fundamentals: stable · valuation: in band",
    "- value band: 20–30 USD/oz (base 25) · deflated mean, ±20%",
    "- curve: contango: Mar 0.5% over Jan (contract closes 2026-01-02)",
  ],
};

const TEMPLATE: Record<Kind, string> = {
  stock: "stock-v1",
  etf: "etf-v1",
  fx: "fx-v1",
  commodity: "commodity-v1",
};

type Parts = { decide?: string[]; check?: string[]; reference?: string[] };

// a note that passes every rule; each test adds the one line it checks
function note(kind: Kind, parts: Parts = {}): string {
  return [
    "# TEST · Test Company",
    `- written: 2026-01-02 · kind: initiation · template: ${TEMPLATE[kind]}`,
    "- price at writing: 100.00 USD (close 2026-01-02)",
    ...HEADER[kind],
    "- why: steady demand and a fair price (annual report, 2026-01-01)",
    "- review by: 2026-02-15 (written + 45 days)",
    "- full review: 2026-01-02",
    "- changed: initiation",
    "",
    "## Decide",
    "",
    "### Thesis",
    "Demand holds over the horizon (annual report, 2026-01-01).",
    ...(parts.decide ?? []),
    "",
    "### Levels",
    "",
    "| Level (USD) | What it is | Set |",
    "|---|---|---|",
    "| 90.00 | 2025 low | 2025-06-01 |",
    "",
    "## Check",
    "",
    "### Key drivers",
    "- Revenue 1.2 bn USD, +4% (annual report, 2026-01-01).",
    ...(parts.check ?? []),
    "",
    "## Reference",
    "",
    "### Price history",
    "- Drawdowns: 120 → 90 USD (2025-01-01 to 2025-06-01, −25%).",
    ...(parts.reference ?? []),
    "",
    "### Gaps",
    "- none",
    "",
  ].join("\n");
}

function link(lines: string[] = []): string {
  return [
    "# TEST2 · Test Company Class B",
    "Share-class reference · 2026-01-02",
    "",
    "[TEST: main analysis](https://markets.example.com/symbol/US%3ATEST) covers both classes.",
    ...lines,
    "",
  ].join("\n");
}

let n = 0;
function check(text: string, name = `note-${++n}.md`) {
  const path = join(dir, name);
  writeFileSync(path, text);
  // a bare name, as an agent passes it: awk reads "NAME=…" as an assignment
  const r = Bun.spawnSync(["bash", SCRIPT, name], { cwd: dir });
  return { code: r.exitCode, out: r.stdout.toString() };
}

// the line number of the first line holding s, as the checker counts them
const lineOf = (text: string, s: string) =>
  text.split("\n").findIndex((l) => l.includes(s)) + 1;

describe("the analysis note checker", () => {
  test.each(["stock", "etf", "fx", "commodity"] as Kind[])(
    "passes a clean %s note and prints its sizes",
    (kind) => {
      const text = note(kind);
      const { code, out } = check(text);
      expect(out).toContain(`${kind} note: ${Buffer.byteLength(text) - 1}/`);
      expect(out).toContain("· Decide ");
      expect(out.trim().endsWith("OK")).toBe(true);
      expect(code).toBe(0);
    },
  );

  test("counts a note without a trailing newline as it is", () => {
    const text = note("stock").trimEnd();
    const sizes = (out: string) => out.split("\n")[0]!.split(" bytes")[1];
    const bare = check(text).out;
    expect(bare).toContain(`stock note: ${Buffer.byteLength(text)}/8000`);
    expect(sizes(bare)).toBe(sizes(check(`${text}\n`).out));
  });

  test("reads a file whose name holds an equals sign", () => {
    const { code, out } = check(note("fx"), "EURRON=X.md");
    expect(out).toContain("fx note:");
    expect(out).not.toContain("missing part");
    expect(code).toBe(0);
  });

  test.each([
    ["stock", ["stance", "value band"]],
    ["etf", ["exposure stance", "vehicle", "valuation"]],
    ["fx", ["stance", "value band", "carry"]],
    ["commodity", ["stance", "value band", "curve"]],
  ] as [Kind, string[]][])(
    "names the %s header lines missing",
    (kind, keys) => {
      const text = note(kind)
        .split("\n")
        .filter((l) => !keys.some((k) => l.startsWith(`- ${k}:`)))
        .join("\n");
      const { code, out } = check(text);
      for (const k of keys) expect(out).toContain(`header line missing: ${k}:`);
      expect(code).toBe(1);
    },
  );

  test("names a missing part and parts out of order", () => {
    const missing = check(note("stock").replace("## Check\n", ""));
    expect(missing.out).toContain("missing part ## Check");
    const swapped = note("stock")
      .replace("## Check", "## CHECK")
      .replace("## Reference", "## Check")
      .replace("## CHECK", "## Reference");
    expect(check(swapped).out).toContain(
      "parts out of order: Decide, Check, Reference",
    );
    expect([missing.code, check(swapped).code]).toEqual([1, 1]);
  });

  test.each([
    ["It is high now.", 'time word "now"'],
    ["Margins are currently wide.", 'time word "currently"'],
    ["Buy it if you like.", 'personal word "you"'],
    ["Set the add zone at 90.", 'personal word "add zone"'],
    ["Revenue was $5 bn.", "bare $"],
    ["Dividend NT$7.0 a share.", "bare $"],
    ["RSI is 71.", "live reading RSI"],
    ["Price over the SMA50.", "live reading SMA"],
    ["Price over its 200-day average.", "live reading N-day average:"],
    ["<!-- fill this in -->", "template guidance left in"],
  ])("flags %p in Decide on its line", (line, message) => {
    const text = note("stock", { decide: [line] });
    const { code, out } = check(text);
    expect(out).toContain(`L${lineOf(text, line)} ${message}`);
    expect(code).toBe(1);
  });

  test.each([
    "Listed in MY and SG (exchange, 2026-01-01).",
    "Revenue in `$` per the filing (10-K, 2026-01-01).",
    "Source [page](https://example.com/$x) (2026-01-01).",
  ])("lets %p pass", (line) => {
    expect(check(note("stock", { decide: [line] })).code).toBe(0);
  });

  test("keeps past moving-average readings in Price history", () => {
    const text = note("stock", {
      reference: ["- Close ÷ weekly SMA50 peaked at 1.4 (2025-01-01)."],
    });
    expect(check(text).code).toBe(0);
  });

  test("wants a blank line on both sides of a table", () => {
    const text = note("stock")
      .replace("### Levels\n\n|", "### Levels\nText before.\n|")
      .replace(
        "| 2025-06-01 |\n\n## Check",
        "| 2025-06-01 |\nText after.\n\n## Check",
      );
    const { code, out } = check(text);
    expect(out).toContain(
      `L${lineOf(text, "| Level (USD)")} no blank line before the table: Text before.`,
    );
    expect(out).toContain(
      `L${lineOf(text, "Text after.")} no blank line after the table`,
    );
    expect(code).toBe(1);
  });

  test("allows four unverified coverage items, never five", () => {
    const items = (k: number) => [
      "",
      "### Unverified coverage",
      ...Array.from(
        { length: k },
        (_, i) => `- claim ${i} — press, 2026-01-01`,
      ),
    ];
    expect(check(note("stock", { reference: items(4) })).code).toBe(0);
    const five = check(note("stock", { reference: items(5) }));
    expect(five.out).toContain(
      "Unverified coverage holds 5 items, at most four",
    );
    expect(five.code).toBe(1);
  });

  test("reads a line starting with a number sign as text", () => {
    const text = note("stock").replace(
      "### Levels\n\n|",
      "### Levels\n#1 producer, now at $5.\n|",
    );
    const { code, out } = check(text);
    const at = lineOf(text, "#1 producer");
    expect(out).toContain(`L${at + 1} no blank line before the table`);
    expect(out).toContain(`L${at} time word "now"`);
    expect(out).toContain(`L${at} bare $`);
    expect(code).toBe(1);
  });

  test("lets a table sit right under its heading", () => {
    const text = note("stock").replace("### Levels\n\n|", "### Levels\n|");
    expect(check(text).code).toBe(0);
  });

  test("refuses a Sources list", () => {
    const text = note("stock", { reference: ["", "## Sources", "- a list"] });
    const { code, out } = check(text);
    expect(out).toContain("no Sources list");
    expect(code).toBe(1);
  });

  test.each(["stock", "etf", "fx", "commodity"])(
    "passes the %s template as written, its guidance deleted",
    (kind) => {
      const template = readFileSync(
        join(REFERENCES, `${kind}-template.md`),
        "utf8",
      );
      const body = template
        .split("```markdown\n")[1]!
        .split("\n```")[0]!
        .replace(/<!--[\s\S]*?-->/g, "");
      const { code, out } = check(body);
      expect(out.trim().split("\n").at(-1)).toBe("OK");
      expect(code).toBe(0);
    },
  );

  test("prints no negative size for an empty file", () => {
    const { out } = check("");
    expect(out).toContain("stock note: 0/8000 bytes · header 0/900");
  });

  test("names the whole cut and where to make it over the limit", () => {
    const filler = Array.from(
      { length: 120 },
      (_, i) => `- Filler fact ${i} about the business (report, 2026-01-01).`,
    );
    const text = note("etf", { check: filler });
    const total = Buffer.byteLength(text) - 1;
    const { code, out } = check(text);
    expect(out).toContain(
      `over the 6000-byte limit by ${total - 6000}: cut ${total - 5700} (to 5700)`,
    );
    expect(out).toMatch(
      /cut from Check: \d+ is \d+ over its 1300 budget; longest: L\d+ ~\d+/,
    );
    expect(out).not.toContain("cut from Decide");
    expect(code).toBe(1);
  });

  test("passes a link note and checks its own rules", () => {
    const ok = check(
      link(["The two classes differ in votes (charter, 2026-01-01)."]),
    );
    expect(ok.out).toContain("link note: ");
    expect(ok.code).toBe(0);

    const twin = check(link().replace("Share-class", "Twin"));
    const tracker = check(link().replace("Share-class", "Tracker"));
    expect([twin.code, tracker.code]).toEqual([0, 0]);

    const unlinked = check(link().replace(/\]\([^)]*\)/, "]"));
    expect(unlinked.out).toContain("no link to the page of the main note");

    const parts = check(`${link()}\n## Decide\n\nx\n`);
    expect(parts.out).toContain("a link note has no parts");

    const long = check(link([`Detail ${"x".repeat(1500)}`]));
    expect(long.out).toContain("over the 1500-byte limit");
    expect(long.out).toContain("keep only what differs from the main note");
    expect(long.out).not.toContain("each part below");

    const personal = check(link(["You should hold both."]));
    expect(personal.out).toContain('personal word "you"');
    expect([unlinked.code, parts.code, long.code, personal.code]).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test("prints its usage without a note", () => {
    const r = Bun.spawnSync(["bash", SCRIPT, join(dir, "absent.md")]);
    expect(r.stderr.toString()).toContain("usage: bash check-note.sh");
    expect(r.exitCode).toBe(2);
  });
});
