// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Markets } from "../../src/operations/markets.ts";
import { ensureCash, insertPortfolio } from "../../src/portfolios/store.ts";

// a portfolio as an install from before the display currency was
// required holds it, so its answers stay per currency
export const portfolioBefore = (m: Markets, name: string) =>
  m.writer.write((db) => insertPortfolio(db, name, m.clock.now()));

// Cash as the migration makes it for such an install that kept cash
export const cashBefore = (m: Markets) =>
  m.writer.write((db) => ensureCash(db, m.clock.now()));
