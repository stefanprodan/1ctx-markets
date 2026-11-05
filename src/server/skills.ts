// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The skills under skills/, served without a key in the index form 1ctx's
// skill import reads. Archives carry a fixed time so a digest holds across
// restarts; Bun.Archive stamps the current one.

import { skillFiles } from "./skill-files.ts" with { type: "macro" };

export const SKILLS_PREFIX = "/.well-known/agent-skills/";

type Bytes = Uint8Array<ArrayBuffer>;

export type Served = { body: Bytes; type: string };

const enc = new TextEncoder();

// zip's 1980-01-01 00:00, the earliest DOS date
const DOS_DATE = (1 << 5) | 1;

function tarHeader(name: string, size: number): Bytes {
  const h = new Uint8Array(512);
  const put = (at: number, text: string) => h.set(enc.encode(text), at);
  const bytes = enc.encode(name);
  if (bytes.length > 100) throw new Error(`skill path too long: ${name}`);
  h.set(bytes, 0);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  const sum = h.reduce((a, b) => a + b, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

export function tarGz(files: [string, Bytes][]): Bytes {
  const parts: Bytes[] = [];
  for (const [name, data] of files) {
    parts.push(tarHeader(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return Bun.gzipSync(concat(parts));
}

export function zip(files: [string, Bytes][]): Bytes {
  const local: Bytes[] = [];
  const central: Bytes[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const path = enc.encode(name);
    const packed = Bun.deflateSync(data);
    const crc = Bun.hash.crc32(data);
    const head = new Uint8Array(30 + path.length);
    const lv = new DataView(head.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    // bit 11: the name is UTF-8
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, path.length, true);
    head.set(path, 30);
    const entry = new Uint8Array(46 + path.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, path.length, true);
    cv.setUint32(42, offset, true);
    entry.set(path, 46);
    local.push(head, packed);
    central.push(entry);
    offset += head.length + packed.length;
  }
  const dir = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, dir.length, true);
  ev.setUint32(16, offset, true);
  return concat([...local, dir, end]);
}

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// plain one-line values only; a quoted or block value would be served as
// its YAML text, so it fails the tests and the start instead
function frontmatter(text: string, skill: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (m === null) throw new Error(`${skill}: SKILL.md has no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const f = /^([a-z]+):\s*(.*)$/.exec(line);
    if (f === null) continue;
    const value = f[2]!.trim();
    if (/^["'|>]/.test(value)) {
      throw new Error(`${skill}: ${f[1]} must be a plain one-line value`);
    }
    fields[f[1]!] = value;
  }
  return fields;
}

const digest = (bytes: Bytes) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

// path under SKILLS_PREFIX → its bytes, built once
export function buildSkills(
  files: Record<string, string> = skillFiles(),
): Map<string, Served> {
  const bySkill = new Map<string, [string, Bytes][]>();
  for (const path of Object.keys(files).sort()) {
    const skill = path.split("/")[0]!;
    const list = bySkill.get(skill) ?? [];
    list.push([path, enc.encode(files[path]!)]);
    bySkill.set(skill, list);
  }
  const served = new Map<string, Served>();
  const index: object[] = [];
  for (const [skill, list] of bySkill) {
    const md = files[`${skill}/SKILL.md`];
    if (md === undefined) throw new Error(`${skill}: no SKILL.md`);
    const meta = frontmatter(md, skill);
    if (meta.name !== skill) {
      throw new Error(`${skill}: frontmatter name is not the folder name`);
    }
    if (!meta.description) throw new Error(`${skill}: no description`);
    const tgz = tarGz(list);
    served.set(`${skill}.tgz`, { body: tgz, type: "application/gzip" });
    served.set(`${skill}.zip`, { body: zip(list), type: "application/zip" });
    index.push({
      name: skill,
      type: "archive",
      description: meta.description,
      url: `${SKILLS_PREFIX}${skill}.tgz`,
      digest: digest(tgz),
    });
  }
  served.set("index.json", {
    body: enc.encode(`${JSON.stringify({ skills: index }, null, 2)}\n`),
    type: "application/json",
  });
  return served;
}
