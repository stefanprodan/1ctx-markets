// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a source's writes tell the rules, kept apart from the rules
// themselves so the sync modules depend on a type, not on the engine.

import type { Db } from "../db/index.ts";

export type RuleHooks = {
  // inside the write that stored these instruments' quotes, bars or
  // signals, or ended the run their staleness is read from
  evaluate(db: Db, instruments: Iterable<string>, now: number): void;
  // inside the write that applied a new split or rescaled past prices,
  // before that write evaluates anything
  rescaled(db: Db, instrument: string, now: number): void;
};

export const NO_RULES: RuleHooks = {
  evaluate() {},
  rescaled() {},
};
