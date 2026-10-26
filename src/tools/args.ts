// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Arguments are checked before anything is fetched, and one the tool
// does not take is refused rather than ignored.

import { wallOfDate } from "../zone.ts";

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

// the longest symbol or name a caller may pass
export const MAX_SYMBOL = 100;

// a caller's own text quoted back in an error, cut so no error outgrows
// a page
export const QUOTED = 64;
export const quoted = (name: string): string =>
  name.length > QUOTED ? `${name.slice(0, QUOTED)}…` : name;

export function fields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ArgError("arguments must be an object");
  }
  for (const name of Object.keys(input)) {
    if (!allowed.includes(name))
      throw new ArgError(`unknown argument ${quoted(name)}`);
  }
  return input as Record<string, unknown>;
}

export function text(value: unknown, name: string, max = MAX_SYMBOL): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ArgError(`${name} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new ArgError(`${name} is longer than ${max} characters`);
  }
  return value.trim();
}

export function optionalText(
  value: unknown,
  name: string,
  max = MAX_SYMBOL,
): string | null {
  return value === undefined || value === null ? null : text(value, name, max);
}

export function symbols(value: unknown, name: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new ArgError(`${name} must be a list of 1 to ${max} symbols`);
  }
  return value.map((v, k) => text(v, `${name}[${k}]`));
}

export function date(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    try {
      wallOfDate(value);
      return value;
    } catch {}
  }
  throw new ArgError(`${name} must be a date, YYYY-MM-DD`);
}

export function oneOf<T extends string>(
  value: unknown,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value === "string" &&
    (values as readonly string[]).includes(value)
  ) {
    return value as T;
  }
  throw new ArgError(`${name} must be one of ${values.join(", ")}`);
}
