// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { SinceWritten } from "../data/analysis.ts";

export const OUTLINE = `## Trend


## Earnings


## Risks


## Watch

`;

// Write analysis is anyone's while there is none; refetch and delete an
// admin's; with neither the button goes
export const moreMenu = (admin: boolean, canWrite: boolean): boolean =>
  admin || canWrite;

// a shared note names its writer; only the reader's own saves read as
// you, and the admin key is no one admin's
export function analysisAuthor(author: string, self: string | null): string {
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
