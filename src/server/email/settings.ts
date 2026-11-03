// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The server's one SMTP server, set by an admin in the web UI. Email is on
// while the row is saved and the key file it names is there; the password
// is read from that file at each send, never stored, answered or logged.

import { ArgError } from "../../operations/args.ts";
import { isEmailKeyName, type Keys } from "../../runtime/keys.ts";
import type { Db } from "../../storage/db/index.ts";
import {
  type Address,
  type EmailSender,
  hasControl,
  SECURITY,
  type Security,
  type SendResult,
} from "./smtp.ts";

export type SmtpSettings = {
  host: string;
  port: number;
  security: Security;
  username: string | null;
  keyName: string | null;
  from: string;
  publicUrl: string;
  updatedAt: number;
  updatedBy: string;
};

// the name an email comes from; the address is the settings'
export const FROM_NAME = "1ctx Markets";

export const MAX_EMAIL = 254;
// 1ctx's: a strict subset of RFC 5322's addr-spec, a dot-atom local part
// and a host name, since the SMTP library rewrites anything looser into
// another address
const LOCAL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TOP = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
export function isEmail(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > MAX_EMAIL
  ) {
    return false;
  }
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const labels = value.slice(at + 1).split(".");
  return (
    LOCAL.test(value.slice(0, at)) &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    TOP.test(labels[labels.length - 1]!)
  );
}

// an address as a person types it, lowercased, or null
export const emailOf = (value: unknown): string | null =>
  typeof value === "string" && isEmail(value.trim())
    ? value.trim().toLowerCase()
    : null;

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

// the origin of an https:// address, or of an http:// one on a loopback
// host: links are built on it, never on a request's Host
export function publicOrigin(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new ArgError("public_url must be a URL");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  ) {
    throw new ArgError(
      "public_url must start with https://, or http:// on a loopback host",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ArgError("public_url must not hold a user or a password");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ArgError("public_url must be an origin, with no path");
  }
  return url.origin;
}

const FIELDS = [
  "host",
  "port",
  "security",
  "username",
  "key_name",
  "from",
  "public_url",
] as const;

const MAX_HOST = 253;
const MAX_USERNAME = 255;
const HOST = /^[A-Za-z0-9.:-]+$/;

export type SmtpArgs = Omit<SmtpSettings, "updatedAt" | "updatedBy">;

// every field, so a half-filled form never saves; null only for the
// username and key file, which go together
export function parseSmtp(body: unknown): SmtpArgs {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ArgError("the body is an object");
  }
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!(FIELDS as readonly string[]).includes(k)) {
      throw new ArgError(`unknown argument ${k}`);
    }
  }
  const missing = FIELDS.filter((k) => !Object.hasOwn(b, k));
  if (missing.length > 0) {
    throw new ArgError(`missing ${missing.join(", ")}`);
  }
  const host = b.host;
  if (
    typeof host !== "string" ||
    host === "" ||
    host.length > MAX_HOST ||
    !HOST.test(host)
  ) {
    throw new ArgError("host must be a host name or an IP address");
  }
  const port = b.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ArgError("port must be 1 to 65535");
  }
  if (!(SECURITY as readonly unknown[]).includes(b.security)) {
    throw new ArgError("security must be tls or starttls");
  }
  const username = b.username;
  if (
    username !== null &&
    (typeof username !== "string" ||
      username === "" ||
      username.length > MAX_USERNAME ||
      hasControl(username))
  ) {
    throw new ArgError(
      `username must be 1 to ${MAX_USERNAME} characters on one line, or null`,
    );
  }
  const keyName = b.key_name;
  if (keyName !== null && !isEmailKeyName(keyName)) {
    throw new ArgError(
      "key_name must name an email- key file in secrets/, as email-<name>, or null",
    );
  }
  if ((username === null) !== (keyName === null)) {
    throw new ArgError(
      username === null
        ? "username is required with a key_name"
        : "key_name is required with a username",
    );
  }
  if (!isEmail(b.from)) throw new ArgError("from must be an email address");
  return {
    host: host.toLowerCase(),
    port,
    security: b.security as Security,
    username: username as string | null,
    keyName: keyName as string | null,
    from: (b.from as string).toLowerCase(),
    publicUrl: publicOrigin(b.public_url),
  };
}

type Raw = {
  host: string;
  port: number;
  security: Security;
  username: string | null;
  key_name: string | null;
  from_address: string;
  public_url: string;
  updated_at: number;
  updated_by: string;
};

export function readSmtp(db: Db): SmtpSettings | null {
  const r = db
    .query<Raw, []>(
      `select host, port, security, username, key_name, from_address,
         public_url, updated_at, updated_by from smtp_settings where id = 1`,
    )
    .get();
  return r === null
    ? null
    : {
        host: r.host,
        port: r.port,
        security: r.security,
        username: r.username,
        keyName: r.key_name,
        from: r.from_address,
        publicUrl: r.public_url,
        updatedAt: r.updated_at,
        updatedBy: r.updated_by,
      };
}

export function saveSmtp(
  db: Db,
  s: SmtpArgs,
  by: string,
  now: number,
): SmtpSettings {
  db.query(
    `insert into smtp_settings (id, host, port, security, username, key_name,
       from_address, public_url, updated_at, updated_by)
     values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set host = excluded.host,
       port = excluded.port, security = excluded.security,
       username = excluded.username, key_name = excluded.key_name,
       from_address = excluded.from_address, public_url = excluded.public_url,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(
    s.host,
    s.port,
    s.security,
    s.username,
    s.keyName,
    s.from,
    s.publicUrl,
    now,
    by,
  );
  return { ...s, updatedAt: now, updatedBy: by };
}

export const removeSmtp = (db: Db): boolean =>
  db.query("delete from smtp_settings where id = 1").run().changes > 0;

export type Email = {
  // the key files an admin may pick, by name alone
  keyNames(): string[];
  // saved and its key file there
  on(db: Db): boolean;
  // null while email is off
  origin(db: Db): string | null;
  // through the saved settings, the password read now; null while off
  send(
    db: Db,
    to: Address,
    subject: string,
    text: string,
  ): Promise<SendResult | null>;
};

export function email(deps: {
  keys: Pick<Keys, "email" | "emailNames">;
  sender: EmailSender;
}): Email {
  // the password, or null for none; undefined when its file is missing
  const passwordOf = (s: SmtpSettings): string | null | undefined => {
    if (s.keyName === null) return null;
    return deps.keys.email(s.keyName) ?? undefined;
  };
  const usable = (db: Db) => {
    const s = readSmtp(db);
    if (s === null) return null;
    const password = passwordOf(s);
    return password === undefined ? null : { s, password };
  };
  return {
    keyNames: () => deps.keys.emailNames(),
    on: (db) => usable(db) !== null,
    origin: (db) => usable(db)?.s.publicUrl ?? null,
    async send(db, to, subject, text) {
      const u = usable(db);
      if (u === null) return null;
      return deps.sender(
        {
          host: u.s.host,
          port: u.s.port,
          security: u.s.security,
          username: u.s.username,
          password: u.password,
        },
        { from: { name: FROM_NAME, address: u.s.from }, to, subject, text },
      );
    },
  };
}
