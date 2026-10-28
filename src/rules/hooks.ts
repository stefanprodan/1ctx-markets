// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Apart from the engine, so the sync modules depend on a type, not on it.

import type { Db } from "../storage/db/index.ts";

export type RuleHooks = {
  // inside the write that stored these instruments' quotes, bars or
  // signals, or ended the run their staleness is read from
  evaluate(db: Db, instruments: Iterable<string>, now: number): void;
  // before a write evaluates on the new scale, or alone once a window shows it
  rescaled(db: Db, instrument: string, now: number): void;
};

export const NO_RULES: RuleHooks = {
  evaluate() {},
  rescaled() {},
};
