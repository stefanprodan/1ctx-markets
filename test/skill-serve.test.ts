// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { buildSkills, SKILLS_PREFIX } from "../src/server/skills.ts";
import { withApp } from "./helpers/app.ts";

const ROOT = join(import.meta.dir, "..", "skills");

// <skill>/<path> → text, read from disk, not through the macro
function onDisk(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const path = join(e.parentPath, e.name);
    if (
      relative(ROOT, path)
        .split(sep)
        .some((p) => p.startsWith("."))
    )
      continue;
    out.set(
      relative(ROOT, path).split(sep).join("/"),
      readFileSync(path, "utf8"),
    );
  }
  return out;
}

const dec = new TextDecoder();

function untar(gz: Uint8Array<ArrayBuffer>): Map<string, string> {
  const tar = Bun.gunzipSync(gz);
  const out = new Map<string, string>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const head = tar.subarray(at, at + 512);
    if (head.every((b) => b === 0)) break;
    const field = (from: number, len: number) =>
      dec.decode(head.subarray(from, from + len)).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12), 8);
    const sum = Number.parseInt(field(148, 8), 8);
    const blank = [...head].reduce(
      (a, b, i) => a + (i >= 148 && i < 156 ? 32 : b),
      0,
    );
    expect(sum).toBe(blank);
    expect(field(257, 6)).toBe("ustar");
    out.set(field(0, 100), dec.decode(tar.subarray(at + 512, at + 512 + size)));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function unzip(bytes: Uint8Array<ArrayBuffer>): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const skip =
      30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = Bun.inflateSync(
      bytes.subarray(local + skip, local + skip + size),
    );
    expect(Bun.hash.crc32(data)).toBe(crc);
    out.set(name, dec.decode(data));
    at += 46 + nameLen;
  }
  return out;
}

const sha256 = (bytes: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

const skills = [...new Set([...onDisk().keys()].map((p) => p.split("/")[0]!))];

const only = (all: Map<string, string>, skill: string) =>
  new Map([...all].filter(([p]) => p.startsWith(`${skill}/`)));

describe("served skills", () => {
  test("the index lists every skill without a key", () =>
    withApp(async ({ url }) => {
      const res = await fetch(`${url}${SKILLS_PREFIX}index.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      const index = (await res.json()) as {
        skills: Record<string, string>[];
      };
      expect(index.skills.map((s) => s.name)).toEqual(skills);
      for (const entry of index.skills) {
        const md = onDisk().get(`${entry.name}/SKILL.md`)!;
        expect(md).toContain(`\ndescription: ${entry.description}\n`);
        expect(entry.type).toBe("archive");
        expect(entry.url).toBe(`${SKILLS_PREFIX}${entry.name}.tgz`);
        const tgz = new Uint8Array(
          await (await fetch(`${url}${entry.url}`)).arrayBuffer(),
        );
        expect(entry.digest).toBe(sha256(tgz));
      }
    }));

  test("both archives hold the folder's files", () =>
    withApp(async ({ url }) => {
      const disk = onDisk();
      for (const skill of skills) {
        const get = async (ext: string) => {
          const res = await fetch(`${url}${SKILLS_PREFIX}${skill}.${ext}`);
          expect(res.status).toBe(200);
          return {
            type: res.headers.get("content-type"),
            body: new Uint8Array(await res.arrayBuffer()),
          };
        };
        const tgz = await get("tgz");
        expect(tgz.type).toBe("application/gzip");
        expect(untar(tgz.body)).toEqual(only(disk, skill));
        const zip = await get("zip");
        expect(zip.type).toBe("application/zip");
        expect(unzip(zip.body)).toEqual(only(disk, skill));
      }
    }));

  test("a build is the same bytes every time", () => {
    const a = buildSkills();
    const b = buildSkills();
    for (const [path, file] of a) {
      expect(
        Buffer.from(b.get(path)!.body).equals(Buffer.from(file.body)),
      ).toBe(true);
    }
  });

  test("only GET, and an unknown name is not found", () =>
    withApp(async ({ url }) => {
      const posted = await fetch(`${url}${SKILLS_PREFIX}index.json`, {
        method: "POST",
      });
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
      const missing = await fetch(`${url}${SKILLS_PREFIX}nope.tgz`);
      expect(missing.status).toBe(404);
    }));

  test("a skill's name must be its folder's", () => {
    expect(() =>
      buildSkills({ "a/SKILL.md": "---\nname: b\ndescription: x\n---\n" }),
    ).toThrow("frontmatter name is not the folder name");
    expect(() => buildSkills({ "a/README.md": "x" })).toThrow("no SKILL.md");
    expect(() =>
      buildSkills({ "a/SKILL.md": "---\nname: a\ndescription: >\n  x\n---\n" }),
    ).toThrow("description must be a plain one-line value");
  });
});
