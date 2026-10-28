// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// what does not match a format exactly is an error, never a guess

import { SourceError } from "../source.ts";

export const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

// 34.678,23: a thousands dot and a decimal comma
const NUMBER = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;

export function roNumber(text: string, what: string): number {
  const t = text.trim();
  if (!NUMBER.test(t)) throw malformed(`${what} is not a number`);
  return Number(t.replaceAll(".", "").replace(",", "."));
}

// an empty cell is no value: a listing that has not traded
export function optionalRoNumber(text: string, what: string): number | null {
  return text.trim() === "" ? null : roNumber(text, what);
}

const STAMP = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/;

// dd.mm.yyyy HH:mm[:ss] as a wall time: the site writes local time with
// no offset, so the instant needs the exchange's zone
export function roWallTime(text: string, what: string): number {
  const m = STAMP.exec(text.trim());
  if (m === null) throw malformed(`${what} is not a time`);
  const [, d, mo, y, h, mi, s] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0));
  const back = new Date(wall);
  if (
    back.getUTCDate() !== +d! ||
    back.getUTCMonth() !== +mo! - 1 ||
    +h! > 23 ||
    +mi! > 59 ||
    +(s ?? 0) > 59
  ) {
    throw malformed(`${what} is not a time`);
  }
  return wall;
}

export function optionalRoWallTime(text: string, what: string): number | null {
  return text.trim() === "" ? null : roWallTime(text, what);
}

const CLOCK = /^(\d{2}):(\d{2})$/;

// HH:mm as ms after local midnight
export function roClock(text: string, what: string): number {
  const m = CLOCK.exec(text.trim());
  if (m === null || +m[1]! > 23 || +m[2]! > 59) {
    throw malformed(`${what} is not a time of day`);
  }
  return (+m[1]! * 60 + +m[2]!) * 60_000;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  reg: "®",
};

export function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name: string) => {
      if (name.startsWith("#")) {
        const code =
          name[1] === "x" || name[1] === "X"
            ? Number.parseInt(name.slice(2), 16)
            : Number.parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[name.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// the table with this id, without nested tables
export function tableById(html: string, id: string): string | null {
  const open = new RegExp(`<table[^>]*\\bid="${id}"[^>]*>`).exec(html);
  if (open === null) return null;
  const end = html.indexOf("</table>", open.index);
  return end < 0 ? null : html.slice(open.index, end);
}

// each row's cells as raw HTML, header cells included
export function rowsOf(table: string): string[][] {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1]!),
  );
}

export function column(headers: readonly string[], label: string): number {
  const k = headers.findIndex((h) => h.startsWith(label));
  if (k < 0) throw malformed(`no ${label} column`);
  return k;
}

const STATUS = /<span id="statusMarket">([^<]*)<\/span>/;

export type Status = "open" | "closed";

// every page carries it; INCHISA is the only closed reading seen
export function statusOf(html: string): Status {
  const m = STATUS.exec(html);
  const text = m === null ? "" : textOf(m[1]!);
  if (text === "") throw malformed("no market status");
  return text.toUpperCase() === "INCHISA" ? "closed" : "open";
}
