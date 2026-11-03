// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who asked, as the router hands it to the reads and writes: the name a
// write is entered by, the person whose rows it reads and writes, the
// credential that sent it, and what the key opens.

export type Access = "none" | "read" | "write";

// the very credential a request came with, so a write can check it again
export type Credential =
  | { kind: "admin" }
  | { kind: "cookie" }
  | { kind: "key"; id: string }
  | { kind: "none" };

export type Who = {
  name: string;
  // users.id: every person's row is read and written as this owner's
  user: string;
  credential: Credential;
  portfolio: Access;
  rules: Access;
  profile: Access;
};

// the person user-admin.key and the web UI's cookie sign in as, made by
// the migration that gave every row an owner
export const OPERATOR = "operator";

// the web UI's cookie: every portfolio and profile write, never a rules write
export const WEB: Who = {
  name: "web",
  user: OPERATOR,
  credential: { kind: "cookie" },
  portfolio: "write",
  rules: "read",
  profile: "write",
};
export const ADMIN: Who = {
  name: "admin",
  user: OPERATOR,
  credential: { kind: "admin" },
  portfolio: "write",
  rules: "write",
  profile: "write",
};
// no user owns the empty id, so a read as no one finds nothing
export const NO_ACCESS: Who = {
  name: "none",
  user: "",
  credential: { kind: "none" },
  portfolio: "none",
  rules: "none",
  profile: "none",
};

export const opens = (access: Access, write: boolean): boolean =>
  access === "write" || (access === "read" && !write);
