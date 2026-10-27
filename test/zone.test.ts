// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  addDays,
  checkZone,
  fromWallTime,
  startOfDate,
  wallTime,
} from "../src/market/zone.ts";

const utc = (iso: string) => Date.parse(iso);

describe("zones", () => {
  test("names a zone canonically and rejects an offset", () => {
    expect(checkZone("europe/berlin")).toBe("Europe/Berlin");
    expect(() => checkZone("-05:00")).toThrow("exchange zone is an offset");
    expect(() => checkZone(42)).toThrow("no exchange zone");
  });

  test("reads the wall time on both sides of a clock change", () => {
    expect(wallTime("Europe/Berlin", utc("2026-10-25T00:30:00Z"))).toBe(
      utc("2026-10-25T02:30:00Z"),
    );
    expect(wallTime("Europe/Berlin", utc("2026-10-25T01:30:00Z"))).toBe(
      utc("2026-10-25T02:30:00Z"),
    );
  });

  test("an hour that occurs twice takes its first instant", () => {
    expect(fromWallTime("Europe/Berlin", utc("2026-10-25T02:30:00Z"))).toBe(
      utc("2026-10-25T00:30:00Z"),
    );
  });

  test("an hour skipped by a clock change moves past the gap", () => {
    expect(fromWallTime("Europe/Berlin", utc("2027-03-28T02:30:00Z"))).toBe(
      utc("2027-03-28T01:30:00Z"),
    );
    expect(fromWallTime("America/New_York", utc("2027-03-14T02:00:00Z"))).toBe(
      utc("2027-03-14T07:00:00Z"),
    );
  });

  test("a local day starts at its own midnight", () => {
    expect(startOfDate("Asia/Tokyo", "2026-10-26")).toBe(
      utc("2026-10-25T15:00:00Z"),
    );
    expect(startOfDate("Europe/London", "2026-10-25")).toBe(
      utc("2026-10-24T23:00:00Z"),
    );
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => startOfDate("UTC", "2026-13-01")).toThrow("not a date");
  });
});
