// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who asked, as the router hands it to the reads and writes: the name a
// write is entered by, and what the key opens.

export type Access = "none" | "read" | "write";

export type Who = { name: string; portfolio: Access; rules: Access };

// the web UI's cookie: every portfolio write, never a rules write
export const WEB: Who = { name: "web", portfolio: "write", rules: "read" };
export const ADMIN: Who = { name: "admin", portfolio: "write", rules: "write" };
export const NO_ACCESS: Who = {
  name: "none",
  portfolio: "none",
  rules: "none",
};

export const opens = (access: Access, write: boolean): boolean =>
  access === "write" || (access === "read" && !write);
