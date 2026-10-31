// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Source and market ids, for code that names a source without using it.

export const YAHOO = "yahoo";
export const BVB = "bvb";
export const BVB_MARKET = "BVB";
export const FRED = "fred";
export const FRED_MARKET = "FRED";
export const FINNHUB = "finnhub";
export const MASSIVE = "massive";
export const EDGAR = "edgar";
// a fund the owner prices: no source fetches it, and every source's
// market is upper case, so this lower-case one is never a listing's
export const FUND_SOURCE = "owner";
export const FUND_MARKET = "fund";
