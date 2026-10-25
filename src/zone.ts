// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Local wall time in an IANA zone from the platform's time zone data,
// so dates and hours follow each zone's clock changes without a table.
// A wall time is held as epoch ms read as if the zone were UTC, which
// keeps day and hour steps plain arithmetic.

import { DAY_MS } from "./clock.ts";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, f);
  }
  return f;
}

// Returns the zone's canonical name, or throws: a UTC offset is
// rejected, since it cannot follow a clock change.
export function checkZone(zone: unknown): string {
  if (typeof zone !== "string" || zone === "") {
    throw new Error("no exchange zone");
  }
  if (/^[+-]/.test(zone)) throw new Error("exchange zone is an offset");
  try {
    return format(zone).resolvedOptions().timeZone;
  } catch {
    throw new Error("unknown exchange zone");
  }
}

export function wallTime(zone: string, at: number): number {
  const p: Record<string, number> = {};
  for (const part of format(zone).formatToParts(at)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const ms = ((at % 1000) + 1000) % 1000;
  return (
    Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) + ms
  );
}

// The instant a wall time names. An hour that occurs twice takes its
// first instant; one skipped by a clock change moves past the gap.
export function fromWallTime(zone: string, wall: number): number {
  const before = wall - (wallTime(zone, wall - DAY_MS) - (wall - DAY_MS));
  const after = wall - (wallTime(zone, wall + DAY_MS) - (wall + DAY_MS));
  const fits = [before, after].filter((at) => wallTime(zone, at) === wall);
  return fits.length > 0 ? Math.min(...fits) : before;
}

// YYYY-MM-DD in the zone
export function localDate(zone: string, at: number): string {
  return dateOfWall(wallTime(zone, at));
}

export function dateOfWall(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10);
}

// a date's midnight as a wall time
export function wallOfDate(date: string): number {
  const m = DATE.exec(date);
  const wall = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) : Number.NaN;
  if (Number.isNaN(wall) || dateOfWall(wall) !== date) {
    throw new Error(`not a date: ${date}`);
  }
  return wall;
}

export function addDays(date: string, days: number): string {
  return dateOfWall(wallOfDate(date) + days * DAY_MS);
}

// the instant a local date begins in the zone
export function startOfDate(zone: string, date: string): number {
  return fromWallTime(zone, wallOfDate(date));
}
