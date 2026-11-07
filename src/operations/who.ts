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
  alerts: Access;
  profile: Access;
  // the analysis per symbol, shared by everyone on the server
  analysis: Access;
  // the person's own trade plans, never shared
  tradePlans: Access;
};

// the person user-admin.key signs in as, made by the migration that gave
// every row an owner
export const OPERATOR = "operator";

// a person signed in to the web UI: every write of their own and the
// shared analysis; what they write names them, so a shared fund's price or
// a removed row tells who
export const loginWho = (user: string, login: string, name: string): Who => ({
  name,
  user,
  credential: { kind: "login", id: login },
  portfolio: "write",
  alerts: "write",
  profile: "write",
  analysis: "write",
  tradePlans: "write",
});
export const ADMIN: Who = {
  name: "admin",
  user: OPERATOR,
  credential: { kind: "admin" },
  portfolio: "write",
  alerts: "write",
  profile: "write",
  analysis: "write",
  tradePlans: "write",
};
// no user owns the empty id, so a read as no one finds nothing
export const NO_ACCESS: Who = {
  name: "none",
  user: "",
  credential: { kind: "none" },
  portfolio: "none",
  alerts: "none",
  profile: "none",
  analysis: "none",
  tradePlans: "none",
};

export const opens = (access: Access, write: boolean): boolean =>
  access === "write" || (access === "read" && !write);
