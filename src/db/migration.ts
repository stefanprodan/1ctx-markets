// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Database } from "bun:sqlite";

export type Migration = {
  id: string;
  up: (db: Database) => void;
};
