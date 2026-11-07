// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A plan's sections by its headings alone: the text is never parsed for
// levels or orders. Scanned here, since the renderer gives no source spans.

import { CRYPTO } from "../market/calendars.ts";
import { FUND_MARKET } from "../sources/ids.ts";

export type Heading = {
  level: number;
  // the heading's plain text, as a reader sees it
  text: string;
  // 1-based, the heading's first line
  line: number;
  // the section's span in the text: the heading to the next of the same or
  // a higher level
  start: number;
  end: number;
};

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// a list item, a quote or a table row: its lines are no paragraph, so a
// --- under them is a thematic break, never a heading
const BLOCK = /^ {0,3}([-+*]([ \t]|$)|\d{1,9}[.)]([ \t]|$)|>|\|)/;
const BREAK = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;

// emphasis, code spans, links and escapes leave their words behind
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function headings(text: string): Heading[] {
  const found: Omit<Heading, "end">[] = [];
  let fence: { char: string; length: number } | null = null;
  // the paragraph a setext underline turns into a heading
  let para: { start: number; line: number; lines: string[] } | null = null;
  // inside a list item, quote or table up to a blank line
  let block = false;
  let at = 0;
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k]!;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const start = at;
    at += raw.length + 1;
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (
        f !== null &&
        f[1]![0] === fence.char &&
        f[1]!.length >= fence.length &&
        f[2]!.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    // a backtick fence's info string holds no backtick
    if (f !== null && !(f[1]![0] === "`" && f[2]!.includes("`"))) {
      fence = { char: f[1]![0]!, length: f[1]!.length };
      para = null;
      block = false;
      continue;
    }
    const atx = ATX.exec(line);
    if (atx !== null) {
      const content = (atx[2] ?? "").replace(/(^|[ \t]+)#+$/, "");
      found.push({
        level: atx[1]!.length,
        text: plain(content),
        line: k + 1,
        start,
      });
      para = null;
      block = false;
      continue;
    }
    const under = SETEXT.exec(line);
    if (under !== null && para !== null) {
      found.push({
        level: under[1]![0] === "=" ? 1 : 2,
        text: plain(para.lines.join(" ")),
        line: para.line,
        start: para.start,
      });
      para = null;
      continue;
    }
    if (line.trim() === "") {
      para = null;
      block = false;
      continue;
    }
    if (BREAK.test(line)) {
      para = null;
      continue;
    }
    if (BLOCK.test(line)) {
      para = null;
      block = true;
      continue;
    }
    // a lazy line goes on the block above it
    if (block) continue;
    // indented code starts no paragraph
    if (/^( {4}|\t)/.test(line)) {
      para?.lines.push(line.trim());
      continue;
    }
    if (para === null) para = { start, line: k + 1, lines: [line.trim()] };
    else para.lines.push(line.trim());
  }
  return found.map((h, k) => {
    const next = found.slice(k + 1).find((n) => n.level <= h.level);
    return { ...h, end: next?.start ?? text.length };
  });
}

// one anchor form for every heading, so a link names the same section;
// ASCII only, accents folded, so an id needs no escaping in an address
export function slug(text: string): string {
  return plain(text)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// each heading's id in one text, in order: a repeat takes -1, -2 as it
// comes, and a heading of no letters is a section
export function anchors(): (text: string) => string {
  const taken = new Set<string>();
  return (text) => {
    const base = slug(text) || "section";
    let id = base;
    for (let n = 1; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return `md-${id}`;
  };
}

// what a heading may call an instrument: the id's symbol, a crypto pair's
// base, a fund's ISIN or name
export function namesOf(i: {
  id: string;
  market: string;
  name: string | null;
}): string[] {
  const symbol = i.id.slice(i.id.indexOf(":") + 1);
  const names = [symbol];
  if (i.market === CRYPTO) {
    const base = symbol.split("-")[0]!;
    if (base !== "" && base !== symbol) names.push(base);
  }
  if (i.market === FUND_MARKET && i.name !== null && i.name.trim() !== "") {
    names.push(i.name.trim());
  }
  return names;
}

const WORD = /[\p{L}\p{N}]/u;

// case-sensitive, bounded by anything but a letter, a digit or the name's
// own punctuation, so ^VIX, CL=F and BRK-B match whole and ON never matches
// "on"
export function names(heading: string, name: string): boolean {
  const own = new Set([...name].filter((c) => !WORD.test(c)));
  const bound = (c: string | undefined) =>
    c === undefined || (!WORD.test(c) && !own.has(c));
  let from = 0;
  for (;;) {
    const at = heading.indexOf(name, from);
    if (at === -1) return false;
    const before = at === 0 ? undefined : [...heading.slice(0, at)].at(-1);
    const after = [...heading.slice(at + name.length)][0];
    if (bound(before) && bound(after)) return true;
    from = at + 1;
  }
}

export function sectionsFor(text: string, of: readonly string[]): Heading[] {
  return headings(text).filter((h) => of.some((n) => names(h.text, n)));
}
