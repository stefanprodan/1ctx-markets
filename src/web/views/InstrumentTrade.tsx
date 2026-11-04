// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// A symbol page's trades: its head's + buys or sells it, held or not; a
// fund the owner prices adds Set price to its menu. The Portfolios page's
// own drawers do the work.

import type { Signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { Holding } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { AddButton } from "../ui/AddButton.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { AddSheet } from "./PortfolioForms.tsx";
import { EditSheet } from "./Portfolios.tsx";

export type TradeSheet = "buy" | "sell" | "price";

// the drawers read the owner's portfolios, brokers and time zone
async function show(open: Signal<TradeSheet | null>, what: TradeSheet) {
  const store = markets.portfolios;
  if (store.overview.peek() === null) await store.load();
  // the drawers need the owner's portfolios: none read, nothing opens
  if (store.overview.peek() !== null) open.value = what;
}

// the buttons sit in the page head; their drawers render in the page body,
// since the head's backdrop blur would hold a fixed drawer inside it
export function BuyButton({ open }: { open: Signal<TradeSheet | null> }) {
  return (
    // a sell is the drawer's other side, so one + opens both
    <AddButton label="Buy or sell" onClick={() => void show(open, "buy")} />
  );
}

export function FundMenu({ open }: { open: Signal<TradeSheet | null> }) {
  return (
    <MenuButton
      head
      label="More"
      items={[{ label: "Set price", run: () => void show(open, "price") }]}
    />
  );
}

export function TradeSheets({
  id,
  fund,
  held,
  open,
  onSaved,
}: {
  id: string;
  // a fund the owner prices: its ISIN, name and market
  fund: { isin: string; name: string; market: string | null } | null;
  held: Holding | null;
  open: Signal<TradeSheet | null>;
  onSaved: () => void;
}) {
  const store = markets.portfolios;
  // a save reloads the holdings; a cancel leaves them, and the page as drawn
  const before = useRef(store.holdings.peek());
  const side = open.value;
  // read once it is open: opening may load them first
  useEffect(() => {
    if (side !== null) before.current = store.holdings.peek();
  }, [side]);
  const done = () => {
    open.value = null;
    if (store.holdings.peek() !== before.current) onSaved();
  };
  if (side === "buy" || side === "sell") {
    return (
      <AddSheet
        store={store}
        start={{ symbol: id, side, ...(fund ? { fund } : {}) }}
        onDone={done}
      />
    );
  }
  if (side === "price" && held) {
    return <EditSheet store={store} h={held} what="price" onDone={done} />;
  }
  return null;
}
