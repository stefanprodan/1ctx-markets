// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Append only, renames included; never edit one on main: servers hold data.

import type { Migration } from "../migration.ts";
import { m0001 } from "./0001-init.ts";
import { m0002 } from "./0002-markets.ts";
import { m0003 } from "./0003-yahoo.ts";
import { m0004 } from "./0004-scopes-units.ts";
import { m0005 } from "./0005-signals.ts";
import { m0006 } from "./0006-tracking.ts";
import { m0007 } from "./0007-research.ts";
import { m0008 } from "./0008-news.ts";
import { m0009 } from "./0009-rules.ts";
import { m0010 } from "./0010-bvb.ts";
import { m0011 } from "./0011-fx-currency.ts";
import { m0012 } from "./0012-listing.ts";
import { m0013 } from "./0013-index-units.ts";
import { m0014 } from "./0014-run-ids.ts";

export const MIGRATIONS: readonly Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
];
