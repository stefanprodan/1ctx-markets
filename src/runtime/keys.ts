// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The only reader of key files: a value reaches its caller and the log mask.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MIN_KEY_LENGTH = 32;
// opens /mcp and every /api/v1 scope
export const ADMIN_FILE = "user-admin.key";
// names the key's owner wherever it is pasted
export const ADMIN_PREFIX = "1ctx-markets-admin-";
const MAX_KEY_BYTES = 4096;
const SOURCE_NAME = /^[a-z][a-z0-9-]{0,47}$/;

export type Keys = {
  readonly dir: string;
  // the value without surrounding whitespace, or null when the file is
  // absent, empty, not a regular file or larger than a key
  admin(): string | null;
  source(name: string): string | null;
  // a key made in the running server, so the mask hides it too
  mask(value: string): void;
  // every value read or masked so far, for the log mask
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
    admin: () => read(ADMIN_FILE),
    source: (name) => read(sourceFile(name)),
    mask: (value) => {
      seen.add(value);
    },
    values: () => [...seen],
  };
}

export class KeyError extends Error {}

// a first start writes the admin key; an existing file, even an empty one,
// is never replaced, so a bad key is refused rather than rotated
export const createAdmin = (dir: string): boolean =>
  createKey(dir, ADMIN_FILE, ADMIN_PREFIX);

function createKey(dir: string, file: string, prefix: string): boolean {
  const path = join(dir, file);
  const random = crypto.getRandomValues(new Uint8Array(32));
  const value = prefix + Buffer.from(random).toString("base64url");
  try {
    // only secrets/ is private; its parents keep the umask's mode
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    throw new KeyError(`cannot write ${path} (${code ?? "failed"})`);
  }
}

// a header token is printable ASCII, so any other key could never match
const usable = (key: string | null): key is string =>
  key !== null && key.length >= MIN_KEY_LENGTH && /^[\x21-\x7e]+$/.test(key);

const unusable = (path: string) =>
  new KeyError(
    `${path} is missing, unreadable, shorter than ${MIN_KEY_LENGTH} characters or holds anything but printable ASCII; remove it and start again to have a new one made`,
  );

// the message names the file, never what it holds
export function requireAdmin(store: Keys): string {
  const admin = store.admin();
  if (!usable(admin)) throw unusable(join(store.dir, ADMIN_FILE));
  return admin;
}

// a start's one key file; agents' keys are rows the admin makes
export function startKeys(store: Keys): { admin: string; created: boolean } {
  const created = createAdmin(store.dir);
  return { admin: requireAdmin(store), created };
}
