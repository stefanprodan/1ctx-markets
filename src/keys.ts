// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The only reader of key files; a value goes to its caller and the log
// mask, nowhere else.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BEARER_FILE = "bearer.key";
// names the key's owner wherever it is pasted
export const BEARER_PREFIX = "1ctx-markets-";
export const MIN_BEARER_LENGTH = 32;
const MAX_KEY_BYTES = 4096;
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,47}$/;

export type Keys = {
  readonly dir: string;
  // the value without surrounding whitespace, or null when the file is
  // absent, empty, not a regular file or larger than a key
  bearer(): string | null;
  source(name: string): string | null;
  // every value read so far, for the logger to mask
  values(): string[];
};

export const sourceFile = (name: string): string => {
  if (!SOURCE_NAME.test(name)) throw new Error("bad source name");
  return `source-${name}.key`;
};

export function keys(dir: string): Keys {
  const seen = new Set<string>();
  const read = (file: string): string | null => {
    const path = join(dir, file);
    // a FIFO or a device sizes as 0 and could block the read
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile() || stat.size > MAX_KEY_BYTES) {
      return null;
    }
    const value = readFileSync(path, "utf8").trim();
    if (value === "") return null;
    seen.add(value);
    return value;
  };
  return {
    dir,
    bearer: () => read(BEARER_FILE),
    source: (name) => read(sourceFile(name)),
    values: () => [...seen],
  };
}

export class KeyError extends Error {}

// a first start writes the bearer; an existing file, even an empty one,
// is never replaced, so a bad key is refused rather than rotated
export function createBearer(dir: string): boolean {
  const path = join(dir, BEARER_FILE);
  const random = crypto.getRandomValues(new Uint8Array(32));
  const value = BEARER_PREFIX + Buffer.from(random).toString("base64url");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw new KeyError(`cannot write ${path} (${code ?? "failed"})`);
  }
}

// the message names the file, never what it holds
export function requireBearer(store: Keys): string {
  const bearer = store.bearer();
  // a header token is printable ASCII, so any other bearer could never match
  if (
    bearer === null ||
    bearer.length < MIN_BEARER_LENGTH ||
    !/^[\x21-\x7e]+$/.test(bearer)
  ) {
    throw new KeyError(
      `${join(store.dir, BEARER_FILE)} is missing, unreadable, shorter than ${MIN_BEARER_LENGTH} characters or holds anything but printable ASCII; remove it and start again to have a new one made`,
    );
  }
  return bearer;
}
