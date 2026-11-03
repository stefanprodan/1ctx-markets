// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Profile page's rules apart from the DOM: the size, the outline a
// first profile starts from, and what each toolbar button types.

import type { IconName } from "../lib/icons.tsx";

// the server's cap, so the editor says it before a save is refused
export const MAX_BYTES = 24 * 1024;

// a first profile starts from the sections agents look for, each line
// saying what goes there
export const OUTLINE = `## Goals
- What you invest for and over how long.

## Risk
- How large a fall you can sit through.

## Trading style
- How you buy, hold and sell.

## Analysis defaults
- How you want holdings and ideas judged.
`;

// rounded up, so a text past the cap never reads as the cap
export const kb = (bytes: number): string =>
  `${(Math.ceil((bytes * 10) / 1024) / 10).toFixed(1)} KB`;

// a login records its person's name, the admin key `admin` and an older
// login `web`: the reader's own name and those read as "you", another
// person's or an agent key's as itself
export const authorWords = (
  author: string | null,
  self: string | null = null,
): string =>
  author === "web" || author === "admin" || (self !== null && author === self)
    ? "you"
    : (author ?? "");

// the server counts UTF-8 bytes, not characters
export const sizeOf = (text: string): number =>
  new TextEncoder().encode(text).length;

// the text box's value and selection
export type Picked = { value: string; start: number; end: number };

// what a button types: the range it replaces, the text typed there and
// the selection after, so the editor can type it as a person would
export type Typing = {
  from: number;
  to: number;
  text: string;
  start: number;
  end: number;
};

export const typed = (value: string, t: Typing): string =>
  value.slice(0, t.from) + t.text + value.slice(t.to);

// the selection wrapped, or a placeholder wrapped and picked to type over
export function wrap(
  p: Picked,
  before: string,
  after: string,
  word: string,
): Typing {
  const picked = p.value.slice(p.start, p.end) || word;
  const start = p.start + before.length;
  return {
    from: p.start,
    to: p.end,
    text: `${before}${picked}${after}`,
    start,
    end: start + picked.length,
  };
}

// each line the selection touches starts with the mark; a selection
// ending at a line's start leaves that line out, as editors do
export function lines(
  p: Picked,
  mark: string | ((i: number) => string),
): Typing {
  const { value, start } = p;
  const end = p.end > start && value[p.end - 1] === "\n" ? p.end - 1 : p.end;
  const from = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const next = value.indexOf("\n", end);
  const to = next < 0 ? value.length : next;
  const text = value
    .slice(from, to)
    .split("\n")
    .map((line, i) => `${typeof mark === "string" ? mark : mark(i)}${line}`)
    .join("\n");
  return { from, to, text, start: from, end: from + text.length };
}

export type Tool = {
  icon: IconName;
  label: string;
  run: (p: Picked) => Typing;
};

export const TOOLS: Tool[][] = [
  [
    { icon: "heading", label: "Heading", run: (p) => lines(p, "## ") },
    { icon: "bold", label: "Bold", run: (p) => wrap(p, "**", "**", "bold") },
    {
      icon: "italic",
      label: "Italic",
      run: (p) => wrap(p, "_", "_", "italic"),
    },
  ],
  [
    { icon: "quote", label: "Quote", run: (p) => lines(p, "> ") },
    { icon: "code", label: "Code", run: (p) => wrap(p, "`", "`", "code") },
    {
      icon: "link",
      label: "Link",
      run: (p) => wrap(p, "[", "](https://)", "text"),
    },
  ],
  [
    { icon: "list", label: "Bulleted list", run: (p) => lines(p, "- ") },
    {
      icon: "numbered",
      label: "Numbered list",
      run: (p) => lines(p, (i) => `${i + 1}. `),
    },
  ],
];

// only the last ask lands: an earlier one, or any after drop(), is stale
export function latest() {
  let n = 0;
  return {
    ask(): () => boolean {
      const mine = ++n;
      return () => mine === n;
    },
    drop(): void {
      n++;
    },
  };
}
