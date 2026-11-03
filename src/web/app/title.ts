// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The tab's title: the page first and the brand last, so a narrow tab
// still says which page it is. An instrument is named by the symbol in
// its address, so the title needs no answer.

import { effect } from "@preact/signals";
import { markets } from "../data/store.ts";
import { tickerOf } from "../lib/names.ts";
import { SYMBOL } from "./paths.ts";
import { path } from "./router.ts";
import { HOME, match } from "./routes.ts";

export const BRAND = "1ctx Markets";

// signedIn is the store's: undefined until the first status answer
export function tabTitle(
  here: string,
  signedIn: boolean | undefined,
  kind?: string,
): string {
  if (signedIn === false) return `Sign in · ${BRAND}`;
  const found = match(here);
  // the landing page is the product itself
  if (found === null || found.route.path === HOME) return BRAND;
  const id = found.params.id;
  const page =
    id === undefined || found.route.path !== `${SYMBOL}:id`
      ? found.route.label
      : tickerOf(id, kind);
  return `${page} · ${BRAND}`;
}

export function watchTitle(): () => void {
  return effect(() => {
    const id = markets.detailId.value;
    const kind =
      id !== null && match(path.value)?.params.id === id
        ? markets.detail.value?.instrument.kind
        : undefined;
    const title = tabTitle(path.value, markets.signedIn.value, kind);
    if (document.title !== title) document.title = title;
  });
}
