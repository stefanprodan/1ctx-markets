// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One slog-text line per event on stderr, timed by the clock. Every key
// value read so far is masked out of the message and the fields before
// a line is written, so a key that reaches a log call never reaches the
// log.

import type { Clock } from "./clock.ts";

export type LogValue = string | number | boolean | undefined;
export type LogFields = Record<string, LogValue>;
export type LogLevel = "info" | "warn" | "error";
export type Log = Record<LogLevel, (msg: string, fields?: LogFields) => void>;
export type LogFactory = (area: string) => Log;

const RESERVED = new Set(["time", "level", "msg", "area"]);
const FIELD = /^[a-z][a-z0-9_]*$/;
export const MASK = "[key]";

function value(text: string): string {
  return text === "" || /[\s="\p{Cc}]/u.test(text)
    ? JSON.stringify(text)
    : text;
}

// a key sent in a URL arrives percent-encoded in the logged path, in any
// case of hex; each run is decoded alone, so one bad escape spares the rest
const decoded = (text: string): string =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

function masked(text: string, keys: readonly string[]): string {
  let out = decoded(text);
  // the longest first, so a key inside another leaves none of the longer
  for (const key of [...keys].sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(key, MASK);
  }
  return out;
}

export function format(
  at: number,
  area: string,
  level: LogLevel,
  msg: string,
  fields: LogFields = {},
  keys: readonly string[] = [],
): string {
  const parts = [
    `time=${new Date(at).toISOString()}`,
    `level=${level.toUpperCase()}`,
    `msg=${value(masked(msg, keys))}`,
    `area=${value(area)}`,
  ];
  for (const [name, field] of Object.entries(fields)) {
    if (field === undefined || !FIELD.test(name) || RESERVED.has(name)) {
      continue;
    }
    if (typeof field === "string") {
      parts.push(`${name}=${value(masked(field, keys))}`);
    } else if (typeof field === "number") {
      if (!Number.isFinite(field)) continue;
      parts.push(
        name === "duration"
          ? `${name}=${Math.round(field)}ms`
          : `${name}=${field}`,
      );
    } else {
      parts.push(`${name}=${field}`);
    }
  }
  return parts.join(" ");
}

export function logger(
  clock: Clock,
  keys: () => readonly string[],
  write: (line: string) => void = (line) => console.error(line),
): LogFactory {
  return (area) => {
    const at =
      (level: LogLevel) =>
      (msg: string, fields?: LogFields): void =>
        write(format(clock.now(), area, level, msg, fields, keys()));
    return { info: at("info"), warn: at("warn"), error: at("error") };
  };
}

export const silent: Log = { info() {}, warn() {}, error() {} };

// the first line only: a stack or a server's answer stays out of the log
export function errorFields(error: unknown): LogFields {
  const type =
    error instanceof Error ? error.constructor.name || "Error" : "exception";
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return {
    error_type: /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(type) ? type : "exception",
    error: message.split(/\r?\n/, 1)[0] || undefined,
  };
}

// the type and code only: an SDK message can quote the request
export function sdkErrorFields(error: unknown): LogFields {
  const fields: LogFields = {
    error: "mcp sdk error",
    error_type: "exception",
  };
  if (error instanceof Error) {
    const name = error.name === "Error" ? error.constructor.name : error.name;
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) fields.error_type = name;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    fields.error_code = code;
  }
  return fields;
}
