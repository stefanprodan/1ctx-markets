// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SinceWritten } from "../data/analysis.ts";

export const OUTLINE = `## Trend


## Earnings


## Risks


## Watch

`;

// a shared note names its writer; only the reader's own saves read as
// you, and the admin key is no one admin's. A fund's note by another
// names no one
export function analysisAuthor(
  author: string | null,
  self: string | null,
): string {
  if (author === null) return "";
  if (author === "admin") return "the admin";
  if (self !== null && author === self) return "you";
  return author;
}

// measured since the save: the move, and whether earnings came out
export function sinceLine(s: SinceWritten): {
  change: number | null;
  reported: boolean;
} {
  return {
    change: s?.change_percent ?? null,
    reported: s?.earnings.some((e) => e.status === "reported") ?? false,
  };
}
