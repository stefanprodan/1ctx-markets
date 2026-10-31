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
import { m0015 } from "./0015-intraday.ts";
import { m0016 } from "./0016-keys.ts";
import { m0017 } from "./0017-dashboard.ts";
import { m0018 } from "./0018-bvb-listings.ts";
import { m0019 } from "./0019-edgar.ts";
import { m0020 } from "./0020-portfolios.ts";
import { m0021 } from "./0021-stated-on.ts";
import { m0022 } from "./0022-trade-indexes.ts";
import { m0023 } from "./0023-key-rules.ts";
import { m0024 } from "./0024-time-zone.ts";
import { m0025 } from "./0025-position-market.ts";
import { m0026 } from "./0026-fund-trades.ts";
import { m0027 } from "./0027-earnings-ahead.ts";

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
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
];
