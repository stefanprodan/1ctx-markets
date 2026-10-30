// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  CURRENCIES,
  findCurrencies,
  inCirculation,
  isCurrencyCode,
} from "../src/shared/currencies.ts";

describe("currencies", () => {
  test("the list holds each code once, three capitals each", () => {
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    expect(CURRENCIES.every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
  });

  test("a code in circulation passes, a made-up or lowercase one does not", () => {
    expect(inCirculation("EUR")).toBe(true);
    expect(inCirculation("ABC")).toBe(false);
    expect(inCirculation("eur")).toBe(false);
  });

  test("money held or paid also takes a listing's hundredth, never a conversion target", () => {
    expect(isCurrencyCode("GBp")).toBe(true);
    expect(inCirculation("GBp")).toBe(false);
    expect(isCurrencyCode("toString")).toBe(false);
  });

  test("a code typed comes before the names that hold it", () => {
    const codes = findCurrencies("ron");
    expect(codes[0]).toBe("RON");
    expect(findCurrencies("")).toEqual([...CURRENCIES]);
    expect(findCurrencies("zzzz")).toEqual([]);
  });
});
