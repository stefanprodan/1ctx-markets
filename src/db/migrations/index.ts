// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ordered list. Every schema change is a migration appended here,
// a rename or a retype included; a migration on main is never edited,
// since a running server holds real data.

import type { Migration } from "../migration.ts";
import { m0001 } from "./0001-init.ts";
import { m0002 } from "./0002-markets.ts";
import { m0003 } from "./0003-yahoo.ts";
import { m0004 } from "./0004-scopes-units.ts";

export const MIGRATIONS: readonly Migration[] = [m0001, m0002, m0003, m0004];
