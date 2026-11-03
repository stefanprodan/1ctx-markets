// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The addresses views link to, apart from the route table, so a view
// imports them without a cycle through it.

export const SCREENER = "/screener";
export const SYMBOL = "/symbol/";

export const symbolHref = (id: string): string =>
  `${SYMBOL}${encodeURIComponent(id)}`;
