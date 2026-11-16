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

// the markers alone, the rest taken with string scans: adjacent quantifiers
// over a line's spaces backtrack without bound
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
// what a regex's . never matches: a line holding one was never a heading
// or a fence
const BREAKS = /[\r\u2028\u2029]/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
// a list item, a quote or a table row: its lines are no paragraph, so a
// --- under them is a thematic break, never a heading
const BLOCK = /^ {0,3}([-+*]([ \t]|$)|\d{1,9}[.)]([ \t]|$)|>|\|)/;
const BREAK = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;

const blank = (c: string | undefined) => c === " " || c === "\t";

function trimmed(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && blank(s[a])) a++;
  while (b > a && blank(s[b - 1])) b--;
  return s.slice(a, b);
}

function fenceOf(line: string): { run: string; info: string } | null {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const info = line.slice(m[0].length);
  return BREAKS.test(info) ? null : { run: m[1]!, info };
}

// a closing run of #s goes with the spaces before it, or alone as the whole
function atxOf(line: string): { level: number; content: string } | null {
  const m = ATX.exec(line);
  if (m === null) return null;
  const rest = line.slice(m[0].length);
  if (BREAKS.test(rest)) return null;
  const content = trimmed(rest);
  let j = content.length;
  while (j > 0 && content[j - 1] === "#") j--;
  if (j === content.length || (j > 0 && !blank(content[j - 1]))) {
    return { level: m[1]!.length, content };
  }
  while (j > 0 && blank(content[j - 1])) j--;
  return { level: m[1]!.length, content: content.slice(0, j) };
}

// [text](url) and ![text](url) keep their text, to the first ] and the
// first ) after it; scanned once, as a regex retries every unclosed [
function unlinked(text: string): string {
  let out = "";
  let from = 0;
  let close = -1;
  let paren = -1;
  for (let p = text.indexOf("["); p !== -1; p = text.indexOf("[", p + 1)) {
    if (close <= p) close = text.indexOf("]", p + 1);
    if (close === -1) break;
    if (text[close + 1] !== "(") continue;
    if (paren <= close + 1) paren = text.indexOf(")", close + 2);
    if (paren === -1) break;
    const start = p > from && text[p - 1] === "!" ? p - 1 : p;
    out += text.slice(from, start) + text.slice(p + 1, close);
    from = paren + 1;
    p = paren;
  }
  return out + text.slice(from);
}

// emphasis, code spans, links and escapes leave their words behind
function plain(text: string): string {
  return unlinked(text)
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
    const f = fenceOf(line);
    if (fence !== null) {
      if (
        f !== null &&
        f.run[0] === fence.char &&
        f.run.length >= fence.length &&
        f.info.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    // a backtick fence's info string holds no backtick
    if (f !== null && !(f.run[0] === "`" && f.info.includes("`"))) {
      fence = { char: f.run[0]!, length: f.run.length };
      para = null;
      block = false;
      continue;
    }
    const atx = atxOf(line);
    if (atx !== null) {
      found.push({
        level: atx.level,
        text: plain(atx.content),
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
