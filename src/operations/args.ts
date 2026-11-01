// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// An unknown argument is refused, not ignored, before anything is fetched.

import { wallOfDate } from "../market/zone.ts";

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export const MAX_SYMBOL = 100;

// a caller's text quoted in an error is cut so no error outgrows a page
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

const DECIMAL = /^-?(\d+\.?\d*|\.\d+)$/;
const DIGITS = /^\d+$/;

export const decimalText = (value: unknown): value is string =>
  typeof value === "string" && DECIMAL.test(value.trim());

// some clients send a number or a boolean as text, mostly where the
// schema also takes a string; read as the value, other text is left for
// the parser to refuse in its own words
export function textValues(
  f: Record<string, unknown>,
  names: { numbers?: string[]; ids?: string[]; flags?: string[] },
): Record<string, unknown> {
  const out = { ...f };
  for (const name of names.numbers ?? []) {
    if (decimalText(out[name])) out[name] = Number(String(out[name]).trim());
  }
  for (const name of names.ids ?? []) {
    const v = out[name];
    if (typeof v === "string" && DIGITS.test(v.trim())) out[name] = Number(v);
  }
  for (const name of names.flags ?? []) {
    const v = out[name];
    if (v === "true" || v === "false") out[name] = v === "true";
  }
  return out;
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
