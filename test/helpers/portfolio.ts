// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Markets } from "../../src/operations/markets.ts";
import { insertPortfolio } from "../../src/portfolios/store.ts";

// a portfolio as an install from before the display currency was
// required holds it, so its answers stay per currency
export const portfolioBefore = (m: Markets, name: string) =>
  m.writer.write((db) => insertPortfolio(db, name, m.clock.now()));
