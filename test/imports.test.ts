// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

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
    expect(cycles(await graph(SRC))).toEqual([]);
  });
});

// every import of every file under root: a file under src by its path
// from src, anything else (a package, bun:, node:) as written
type Import = { file: boolean; to: string };

async function imports(root: string): Promise<Map<string, Import[]>> {
  const out = new Map<string, Import[]>();
  for await (const f of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
    const text = await Bun.file(join(root, f)).text();
    out.set(
      f,
      specifiers(text).map((s) =>
        s.startsWith(".")
          ? { file: true, to: relative(root, join(root, dirname(f), s)) }
          : { file: false, to: s },
      ),
    );
  }
  return out;
}

const crossings = (
  all: Map<string, Import[]>,
  from: string,
  allowed: (i: Import) => boolean,
) =>
  [...all]
    .filter(([f]) => f.startsWith(from))
    .flatMap(([f, to]) =>
      to.filter((i) => !allowed(i)).map((i) => `${f} -> ${i.to}`),
    );

describe("shared", () => {
  test("a shared file imports only other shared files", async () => {
    const all = await imports(SRC);
    expect(
      crossings(all, "shared/", (i) => i.file && i.to.startsWith("shared/")),
    ).toEqual([]);
  });

  test("the web UI imports outside itself only from shared", async () => {
    const all = await imports(SRC);
    expect(
      crossings(
        all,
        "web/",
        (i) => !i.file || i.to.startsWith("web/") || i.to.startsWith("shared/"),
      ),
    ).toEqual([]);
  });

  test("a crossing is found for a file, never for a package", () => {
    const all = new Map<string, Import[]>([
      [
        "web/a.tsx",
        [
          { file: false, to: "preact/hooks" },
          { file: true, to: "shared/c.ts" },
          { file: true, to: "market/format.ts" },
        ],
      ],
      [
        "shared/c.ts",
        [
          { file: false, to: "bun:sqlite" },
          { file: true, to: "shared/d.ts" },
        ],
      ],
    ]);
    expect(
      crossings(
        all,
        "web/",
        (i) => !i.file || i.to.startsWith("web/") || i.to.startsWith("shared/"),
      ),
    ).toEqual(["web/a.tsx -> market/format.ts"]);
    expect(
      crossings(all, "shared/", (i) => i.file && i.to.startsWith("shared/")),
    ).toEqual(["shared/c.ts -> bun:sqlite"]);
  });
});

describe("layers", () => {
  test("the REST API never imports the MCP tools", async () => {
    const edges = await graph(SRC);
    const crossing = [...edges]
      .filter(([f]) => f.startsWith("api/"))
      .flatMap(([f, to]) =>
        to.filter((t) => t.startsWith("tools/")).map((t) => `${f} -> ${t}`),
      );
    expect(crossing).toEqual([]);
  });

  test("only the MCP endpoint imports the tool registry", async () => {
    const edges = await graph(SRC);
    const importers = [...edges]
      .filter(
        ([f, to]) => !f.startsWith("tools/") && to.includes("tools/index.ts"),
      )
      .map(([f]) => f);
    expect(importers).toEqual(["server/mcp.ts"]);
  });
});
