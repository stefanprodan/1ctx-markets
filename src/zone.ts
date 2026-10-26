// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A wall time is epoch ms read as if the zone were UTC, so day and hour
// steps stay plain arithmetic across clock changes.

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

// a UTC offset is refused: it cannot follow a clock change
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

// a repeated hour takes its first instant; a skipped one moves past the gap
export function fromWallTime(zone: string, wall: number): number {
  const before = wall - (wallTime(zone, wall - DAY_MS) - (wall - DAY_MS));
  const after = wall - (wallTime(zone, wall + DAY_MS) - (wall + DAY_MS));
  const fits = [before, after].filter((at) => wallTime(zone, at) === wall);
  return fits.length > 0 ? Math.min(...fits) : before;
}

export function localDate(zone: string, at: number): string {
  return dateOfWall(wallTime(zone, at));
}

export function dateOfWall(wall: number): string {
  return new Date(wall).toISOString().slice(0, 10);
}

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

export function startOfDate(zone: string, date: string): number {
  return fromWallTime(zone, wallOfDate(date));
}
