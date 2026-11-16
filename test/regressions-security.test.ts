// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { PREFIX } from "../src/api/http.ts";
import { MAX_DOCUMENT_BYTES } from "../src/document/store.ts";
import { ArgError, decimalText } from "../src/operations/args.ts";
import { drawMarkdown } from "../src/profile/markdown.ts";
import { parseTradeTool } from "../src/tools/portfolio.ts";
import { headings, slug } from "../src/trade-plans/sections.ts";
import { ADMIN_KEY, api } from "./helpers/api.ts";
import { world } from "./helpers/world.ts";

describe("number text", () => {
  const cases: [string, boolean][] = [
    ["0", true],
    ["1", true],
    ["-1", true],
    ["1.", true],
    ["1.5", true],
    [".5", true],
    ["-.5", true],
    [" 2.5 ", true],
    ["007", true],
    ["-0.0", true],
    ["123456789.123456789", true],
    ["1".repeat(64), true],
    ["", false],
    ["-", false],
    [".", false],
    ["-.", false],
    ["1..2", false],
    ["1.2.3", false],
    ["+1", false],
    ["1e5", false],
    ["0x10", false],
    ["1,5", false],
    [" ", false],
    ["1 2", false],
    ["--1", false],
    ["1-", false],
    [`${"1".repeat(30)}x`, false],
    [`${"1".repeat(40)}.${"2".repeat(40)}x`, false],
  ];
  for (const [value, read] of cases) {
    test(`${JSON.stringify(value)} reads as a number: ${read}`, () => {
      expect(decimalText(value)).toBe(read);
    });
  }

  test("text past 64 characters is no number", () => {
    expect(decimalText("1".repeat(65))).toBe(false);
    expect(decimalText(`0.${"0".repeat(70)}1`)).toBe(false);
  });

  test("a trade's over-long number text is refused in the parser's words", () => {
    const add = (quantity: unknown) =>
      parseTradeTool({
        action: "add",
        symbol: "AAA",
        side: "buy",
        quantity,
        price: 100,
        date: "2026-01-02",
      });
    expect(() => add("2.5")).not.toThrow();
    expect(() => add(`0.${"0".repeat(70)}1`)).toThrow(ArgError);
    expect(() => add(`0.${"0".repeat(70)}1`)).toThrow(/quantity must be/);
  });
});

describe("headings", () => {
  const cases: [string, [number, string][]][] = [
    ["# Title", [[1, "Title"]]],
    ["###### Six", [[6, "Six"]]],
    ["####### Seven", []],
    ["#Tight", []],
    ["#", [[1, ""]]],
    ["#   ", [[1, ""]]],
    ["   ## Indented", [[2, "Indented"]]],
    ["    # Code", []],
    ["# Closed ##", [[1, "Closed"]]],
    ["# Closed ##   ", [[1, "Closed"]]],
    ["# Not#closed", [[1, "Not#closed"]]],
    ["# a #b##", [[1, "a #b##"]]],
    ["# ##", [[1, ""]]],
    ["## Tab\tclosed\t#", [[2, "Tab closed"]]],
    ["#\tTab", [[1, "Tab"]]],
    ["# Inner break", []],
    ["# Inner\rbreak", []],
    ["# [Link](http://x) and ![img](y)", [[1, "Link and img"]]],
    ["# [open [nested](u)", [[1, "open [nested"]]],
    ["# a [b] (c)", [[1, "a [b] (c)"]]],
    ["# !![x](y)", [[1, "!x"]]],
    ["# \\*esc\\*", [[1, "esc"]]],
    [`#${" ".repeat(40)} `, []],
    [`# ${"[".repeat(40)}`, [[1, "[".repeat(40)]]],
    [`# a${" ".repeat(40)}a`, [[1, "a a"]]],
    [`# ${"[a](".repeat(10)}`, [[1, "[a](".repeat(10)]]],
    [`# x${" #".repeat(20)}  `, []],
  ];
  for (const [line, want] of cases) {
    test(`${JSON.stringify(line)} heads ${JSON.stringify(want)}`, () => {
      expect(headings(line).map((h) => [h.level, h.text])).toEqual(want);
    });
  }

  test("fences and setext underlines keep their meaning", () => {
    const of = (text: string) =>
      headings(text).map((h) => [h.level, h.text, h.line]);
    expect(of("```js\n# In fence\n```\n# After")).toEqual([[1, "After", 4]]);
    expect(of(`${"`".repeat(40)} \n# h`)).toEqual([[1, "h", 2]]);
    expect(of("Para\n===\nSub\n---")).toEqual([
      [1, "Para", 1],
      [2, "Sub", 3],
    ]);
  });
});

describe("slugs", () => {
  const cases: [string, string][] = [
    ["Hello World", "hello-world"],
    ["Café Crème", "cafe-creme"],
    ["[NVDA](https://x) ladder", "nvda-ladder"],
    ["**Bold** _it_", "bold-it"],
    ["a  -  b", "a---b"],
    ["", ""],
    ["[".repeat(40), ""],
    ["Q3: buy ≤ $180!", "q3-buy-180"],
  ];
  for (const [text, want] of cases) {
    test(`${JSON.stringify(text)} slugs to ${JSON.stringify(want)}`, () => {
      expect(slug(text)).toBe(want);
    });
  }

  test("a heading of unclosed brackets is drawn with a section id", () => {
    const drawn = drawMarkdown(`# ${"[".repeat(40)}`);
    expect(drawn.headings).toEqual([
      { id: "md-section", text: "[".repeat(40) },
    ]);
  });
});

describe("previews", () => {
  const send = (
    handle: ReturnType<typeof api>,
    method: string,
    path: string,
    text: string,
  ) =>
    handle(
      new Request(`http://markets.test${PREFIX}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ADMIN_KEY}`,
        },
        body: JSON.stringify({ text }),
      }),
    );
  const over = "x".repeat(MAX_DOCUMENT_BYTES + 1);
  const at = "x".repeat(MAX_DOCUMENT_BYTES);

  for (const [path, noun] of [
    ["/profile/preview", "profile"],
    ["/instruments/AAA/analysis/preview", "analysis"],
    ["/trade-plans/preview", "trade plan"],
  ] as const) {
    test(`${path} draws only a draft a save takes`, async () => {
      const handle = api(world().m);
      expect((await send(handle, "POST", path, at)).status).toBe(200);
      const refused = await send(handle, "POST", path, over);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { detail: string }).detail).toStartWith(
        `the ${noun} would be ${MAX_DOCUMENT_BYTES + 1} bytes, over ${MAX_DOCUMENT_BYTES} (24 KiB); `,
      );
    });
  }

  test("a preview refuses an over-cap draft as the save does", async () => {
    const handle = api(world().m);
    const saved = await send(handle, "PUT", "/profile", over);
    const drawn = await send(handle, "POST", "/profile/preview", over);
    expect(saved.status).toBe(400);
    expect(drawn.status).toBe(400);
    const detail = async (r: Response) =>
      ((await r.json()) as { detail: string }).detail;
    expect(await detail(drawn)).toBe(await detail(saved));
  });
});
