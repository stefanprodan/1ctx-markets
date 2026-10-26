// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One JSON text part that fits a client's untouched 32 KiB defaults;
// nothing is cut inside an item.

import { createHash } from "node:crypto";

// Codex has the smallest byte-based default among the clients 1ctx supports
export const PAGE_BYTES = 32 * 1024;
// the JSON-RPC envelope and an event-stream frame around the result
const ENVELOPE_BYTES = 512;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

const bytes = (text: string): number => Buffer.byteLength(text);

// the bytes a text takes once quoted inside the result's JSON
const quotedBytes = (text: string): number => bytes(JSON.stringify(text)) - 2;

const resultBytes = (text: string): number =>
  bytes(JSON.stringify({ content: [{ type: "text", text }] }));

export function fits(text: string): boolean {
  return (
    bytes(text) <= PAGE_BYTES &&
    resultBytes(text) + ENVELOPE_BYTES <= PAGE_BYTES
  );
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

// The same one-part form, flagged so a client knows nothing was
// answered, under the same limits: one too long keeps only its error
// and a cut message.
export function errorResult(
  body: { error: string; message: string } & Record<string, unknown>,
): ToolResult {
  const result = (text: string): ToolResult => ({
    content: [{ type: "text", text }],
    isError: true,
  });
  const full = result(JSON.stringify(body));
  if (sent(full)) return full;
  return result(
    JSON.stringify({ error: body.error, message: body.message.slice(0, 1024) }),
  );
}

// the result as it goes out, isError included, inside the page
const sent = (r: ToolResult): boolean =>
  bytes(r.content[0]!.text) <= PAGE_BYTES &&
  bytes(JSON.stringify(r)) + ENVELOPE_BYTES <= PAGE_BYTES;

export class PageOverflow extends Error {
  constructor() {
    super("an item is longer than one page");
    this.name = "PageOverflow";
  }
}

// The longest prefix of items that fits under the fields shell(count)
// gives; the items go last, under key. shell sees how many items are in,
// so a cursor or a line that only some items need can follow them.
export function fitPage<T>(
  items: readonly T[],
  shell: (count: number) => Record<string, unknown>,
  key = "items",
): { text: string; count: number } {
  const json = items.map((item) => JSON.stringify(item));
  const head = (count: number) => {
    const text = JSON.stringify({ ...shell(count), [key]: [] });
    if (!text.endsWith("[]}")) throw new Error(`${key} is not the last field`);
    return text;
  };
  // sizes add up item by item, so only the shell is measured again
  let raw = 0;
  let quoted = 0;
  let count = -1;
  for (let k = 0; k <= items.length; k++) {
    if (k > 0) {
      const sep = k > 1 ? 1 : 0;
      raw += sep + bytes(json[k - 1]!);
      quoted += sep + quotedBytes(json[k - 1]!);
    }
    const h = head(k);
    if (
      bytes(h) + raw > PAGE_BYTES ||
      resultBytes(h) + quoted + ENVELOPE_BYTES > PAGE_BYTES
    ) {
      break;
    }
    count = k;
  }
  if (count < 0 || (count === 0 && items.length > 0)) throw new PageOverflow();
  const text = `${head(count).slice(0, -2)}${json.slice(0, count).join(",")}]}`;
  // the sums above are exact; this guards a change to how they are made
  if (!fits(text)) throw new PageOverflow();
  return { text, count };
}

// A cursor names where the next page starts and the arguments it
// continues, so one passed with other arguments is refused.
export function cursor(position: string, args: unknown): string {
  return `${position}~${digest(args)}`;
}

export function readCursor(next: string, args: unknown): string | null {
  const at = next.lastIndexOf("~");
  if (at < 1 || next.slice(at + 1) !== digest(args)) return null;
  return next.slice(0, at);
}

const digest = (args: unknown): string =>
  createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 10);

// UTC to the second; null stays null
export const iso = (ms: number | null): string | null =>
  ms === null ? null : `${new Date(ms).toISOString().slice(0, 19)}Z`;

// signals are computed unrounded; six significant digits is all a
// caller reads, and keeps pages short
export const round = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(6));

// Yahoo's bars carry single-precision noise (215.97999572753906); eight
// significant digits give back 215.98 and keep a crypto price's cents
export const price = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(8));
