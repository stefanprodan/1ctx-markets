// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export type Migration = {
  id: string;
  // false: runs with foreign keys off, for a rebuild of a table others
  // point at; migrate() checks every reference before it commits
  foreignKeys?: false;
  up: (db: Database) => void;
};
