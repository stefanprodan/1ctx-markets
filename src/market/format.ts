// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The time and number forms every answer uses, MCP and REST alike.

// UTC to the second; null stays null
export const iso = (ms: number | null): string | null =>
  ms === null ? null : `${new Date(ms).toISOString().slice(0, 19)}Z`;

// signals are computed unrounded; six significant digits is all a
// caller reads, and keeps pages short
export const round = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(6));

// Yahoo's bars carry single-precision noise (215.97999572753906); eight
// significant digits give back 215.98 and keep a crypto price's cents
export const price = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(8));
