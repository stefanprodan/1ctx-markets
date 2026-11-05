// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The addresses views link to, apart from the route table, so a view
// imports them without a cycle through it.

export const SCREENER = "/screener";
export const SYMBOL = "/symbol/";
// Server admin: Status, Settings and Users
export const ALERTS = "/alerts";
export const ALERTS_HISTORY = "/alerts/history";
export const ADMIN = "/admin";
export const ADMIN_SETTINGS = "/admin/settings";
export const ADMIN_USERS = "/admin/users";

export const symbolHref = (id: string): string =>
  `${SYMBOL}${encodeURIComponent(id)}`;
