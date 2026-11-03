// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who asked, as the router hands it to the reads and writes: the name a
// write is entered by, the person whose rows it reads and writes, the
// credential that sent it, and what the key opens.

export type Access = "none" | "read" | "write";

// the very credential a request came with, so a write can check it again
export type Credential =
  | { kind: "admin" }
  | { kind: "login"; id: string }
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

// the person user-admin.key signs in as, made by the migration that gave
// every row an owner
export const OPERATOR = "operator";

// a person signed in to the web UI: every portfolio and profile write of
// their own, never a rules write; what they write names them, so a shared
// fund's price or a removed row tells who
export const loginWho = (user: string, login: string, name: string): Who => ({
  name,
  user,
  credential: { kind: "login", id: login },
  portfolio: "write",
  rules: "read",
  profile: "write",
});
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
