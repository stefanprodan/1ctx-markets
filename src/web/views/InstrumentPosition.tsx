// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import type { Holding } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { hiddenClass } from "../ui/Amounts.tsx";
import { Card } from "../ui/Card.tsx";
import { Facts, Hero } from "../ui/Figures.tsx";
import { heldOf, positionOf } from "./InstrumentPosition.model.ts";
import { PositionsDrawer } from "./Positions.tsx";

// a read that fails keeps the holdings read before
export function useHolding(id: string | null): Holding | null {
  const all = useSignal<Holding[] | null>(null);
  const load = useCallback(async () => {
    const h = await markets.portfolios.everything();
    if (h !== null) all.value = h.holdings;
  }, [all]);
  useEffect(() => {
    void load();
  }, [load]);
  useRefresh(load);
  return id === null || all.value === null ? null : heldOf(all.value, id);
}

export function PositionCard({ h, hide }: { h: Holding; hide: boolean }) {
  const p = positionOf(h);
  const open = useSignal(false);
  return (
    <Card
      title="Your position"
      class={hiddenClass(hide)}
      actions={
        <>
          <button
            type="button"
            class="btn-icon"
            aria-label="Activity"
            title="Activity"
            aria-haspopup="dialog"
            onClick={() => {
              open.value = true;
            }}
          >
            <Icon name="briefcase" />
          </button>
          {open.value && (
            <PositionsDrawer
              h={h}
              onClose={() => {
                open.value = false;
              }}
            />
          )}
        </>
      }
    >
      <Hero
        compact
        value={p.value}
        currency={p.currency}
        valueClass="amount"
        moves={p.moves.map((m) => ({ ...m, moneyClass: "amount" }))}
      />
      <Facts
        items={p.facts.map((f) => ({
          label: f.label,
          value: f.amount ? <span class="amount">{f.value}</span> : f.value,
          num: true,
        }))}
      />
      {p.parts.length > 0 && (
        <dl class="ins-parts small">
          {p.parts.map((x) => (
            <div key={x.key} class="ins-part">
              <dt class="faint">{x.where}</dt>
              <dd class="num amount">{x.held}</dd>
              <dd class="num amount">{x.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
