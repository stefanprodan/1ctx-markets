// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// cycles there before this test, to be broken; never add one
const KNOWN: string[][] = [["tools/quote.ts", "tools/sets.ts"]];

// static, side-effect, type-only and re-export forms, and import()
const SPECIFIER =
  /\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER)) out.push((m[1] ?? m[2])!);
  return out;
}

async function graph(root: string): Promise<Map<string, string[]>> {
  const files = new Set<string>();
  for await (const f of new Bun.Glob("**/*.ts").scan(root)) files.add(f);
  const edges = new Map<string, string[]>();
  for (const f of [...files].sort()) {
    const text = await Bun.file(join(root, f)).text();
    const to = specifiers(text)
      .filter((s) => s.startsWith("."))
      .map((s) => relative(root, join(root, dirname(f), s)))
      .filter((s) => files.has(s));
    edges.set(f, [...new Set(to)].sort());
  }
  return edges;
}

// Tarjan's strongly connected components; a file importing itself counts
function cycles(edges: Map<string, string[]>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    on.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      on.delete(w);
      scc.push(w);
    } while (w !== v);
    if (scc.length > 1 || (edges.get(v) ?? []).includes(v)) {
      out.push(scc.sort());
    }
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

describe("imports", () => {
  test("every import form is read, type-only included", () => {
    const text = [
      'import { a } from "./a.ts";',
      'import type { B } from "../b.ts";',
      "import {\n  type C,\n  d,\n} from './c.ts';",
      'export { e } from "./e.ts";',
      'export * from "./f.ts";',
      'export type { G } from "./g.ts";',
      'import "./h.ts";',
      'import page from "./i.html" with { type: "file" };',
      'const j = await import("./j.ts");',
      'const k = "import x from ./k.ts";',
      "export const l = 1;",
      'export const m = "./m.ts";',
    ].join("\n");
    expect(specifiers(text)).toEqual([
      "./a.ts",
      "../b.ts",
      "./c.ts",
      "./e.ts",
      "./f.ts",
      "./g.ts",
      "./h.ts",
      "./i.html",
      "./j.ts",
    ]);
  });

  test("a cycle is found through any number of files", () => {
    const edges = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["c.ts"]],
      ["c.ts", ["a.ts"]],
      ["d.ts", ["d.ts"]],
      ["e.ts", ["a.ts"]],
    ]);
    expect(cycles(edges)).toEqual([["a.ts", "b.ts", "c.ts"], ["d.ts"]]);
  });

  test("src has no import cycle", async () => {
    expect(cycles(await graph(SRC))).toEqual(KNOWN);
  });
});
