// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// SEC's Form 8-K items, named short so a list of filings stays readable.

export const ITEM_NAMES: Readonly<Record<string, string>> = {
  "1.01": "material agreement",
  "1.02": "material agreement ended",
  "1.03": "bankruptcy or receivership",
  "1.04": "mine safety",
  "1.05": "cybersecurity incident",
  "2.01": "acquisition or disposition",
  "2.02": "results of operations",
  "2.03": "new financial obligation",
  "2.04": "financial obligation accelerated",
  "2.05": "exit or disposal costs",
  "2.06": "material impairment",
  "3.01": "delisting notice",
  "3.02": "unregistered equity sale",
  "3.03": "holders' rights changed",
  "4.01": "auditor change",
  "4.02": "non-reliance on prior statements",
  "5.01": "change in control",
  "5.02": "officer or director change",
  "5.03": "bylaws or fiscal year change",
  "5.04": "benefit plan trading suspended",
  "5.05": "code of ethics change",
  "5.06": "shell company status change",
  "5.07": "shareholder vote",
  "5.08": "director nominations",
  "6.01": "asset-backed: informational material",
  "6.02": "asset-backed: servicer or trustee change",
  "6.03": "asset-backed: credit enhancement change",
  "6.04": "asset-backed: missed distribution",
  "6.05": "asset-backed: securities act updating",
  "6.06": "asset-backed: static pool",
  "7.01": "regulation FD disclosure",
  "8.01": "other events",
  "9.01": "financial statements and exhibits",
};

// an item code SEC adds later has no name yet, never a guessed one
export const itemName = (code: string): string | null =>
  ITEM_NAMES[code] ?? null;

export const RESULTS = "2.02";
export const NON_RELIANCE = "4.02";
