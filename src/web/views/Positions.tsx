// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// An instrument's position and its trades, opened from its position
// card: the total, each broker's holding with its gain, then one plain
// row per order.

import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import type { Holding, Part, TradeRow } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { briefQuantity, day, money, percent, quantity } from "../lib/format.ts";
import { useRefresh } from "../lib/refresh.ts";
import { amountsHidden, hiddenClass } from "../ui/Amounts.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Change, Hero } from "../ui/Figures.tsx";
import { positionOf } from "./InstrumentPosition.model.ts";
import {
  foldFills,
  holdingTicker,
  isReward,
  orderOf,
  sideTag,
  sideWord,
  unitPrice,
} from "./Portfolios.model.ts";
import "./positions.css";

// orders shown before Show more
const FIRST = 20;

// a broker's gain is its value over the cost of the units it still
// holds, both from the server in the holding's currency
export function gainOf(p: Part): { pl: number | null; pct: number | null } {
  if (p.value === null || p.cost === null) return { pl: null, pct: null };
  const pl = p.value - p.cost;
  return { pl, pct: p.cost > 0 ? (pl / p.cost) * 100 : null };
}

function HeldRow({ p, h }: { p: Part; h: Holding }) {
  const g = gainOf(p);
  const c = h.currency;
  const held =
    h.kind === "bond"
      ? money(p.amount ?? null, c)
      : `${briefQuantity(p.quantity)}${p.average_cost === null ? "" : ` at ${unitPrice(p.average_cost, null, h.unit)}`}`;
  return (
    <li class="pos-row">
      <span class="pos-main">
        <span class="pos-what">{p.broker ?? p.portfolio}</span>
        <span class="pos-sub faint amount">{held}</span>
      </span>
      <span class="pos-figs">
        <span class="num amount">{money(p.value, c)}</span>
        <span class="pos-gain">
          <Change s={percent(g.pct)} />
        </span>
      </span>
    </li>
  );
}

function OrderRow({ fills }: { fills: TradeRow[] }) {
  const t = fills[0]!;
  const o = orderOf(fills);
  const reward = isReward(t);
  return (
    <li class="pos-row">
      <span class="pos-main">
        <span class="pos-what">
          <span class={sideTag(t)}>{sideWord(t)}</span>
        </span>
        <span class="pos-sub faint">
          {[day(t.date), t.broker].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span class="pos-figs">
        <span class="num amount">
          {reward ? `+${quantity(o.quantity)}` : money(o.amount, t.currency)}
        </span>
        {!reward && (
          <span class="pos-sub faint num amount">
            {quantity(o.quantity)} × {unitPrice(o.price, null, t.unit)}
          </span>
        )}
      </span>
    </li>
  );
}

export function PositionsDrawer({
  h,
  onClose,
}: {
  h: Holding;
  onClose: () => void;
}) {
  const trades = useSignal<TradeRow[] | null>(null);
  const failed = useSignal(false);
  const id = h.id!;
  // a read that fails keeps the trades read before
  const load = useCallback(async () => {
    const got = await markets.portfolios.tradesOf(id);
    if (got !== null) trades.value = got;
    failed.value = got === null && trades.peek() === null;
  }, [id, trades, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  useRefresh(load, true);

  return (
    <Drawer
      title={holdingTicker(h)}
      onClose={onClose}
      // the link opens Portfolios in place: the drawer slides out at once
      foot={(close) => (
        <a class="btn" href="/portfolios" onClick={close}>
          Open Portfolios
        </a>
      )}
    >
      <PositionsBody
        h={h}
        trades={trades.value}
        failed={failed.value}
        hide={amountsHidden.value}
      />
    </Drawer>
  );
}

// the drawer's content; trades null while the first read is on its way
export function PositionsBody({
  h,
  trades,
  failed,
  hide,
}: {
  h: Holding;
  trades: readonly TradeRow[] | null;
  failed: boolean;
  hide: boolean;
}) {
  const shown = useSignal(FIRST);
  const p = positionOf(h);
  // the all-time gain alone: today is on the page behind the drawer
  const allTime = p.moves.filter((m) => m.label === "all time");
  const orders =
    trades === null
      ? null
      : foldFills(trades.filter((t) => t.removed_at === null));
  return (
    <div class={`pos ${hiddenClass(hide)}`}>
      <Hero
        compact
        name="Your position"
        value={p.value}
        currency={p.currency}
        valueClass="amount"
        moves={allTime.map((m) => ({ ...m, moneyClass: "amount" }))}
      />
      <section>
        <h3 class="pos-head">Held at</h3>
        <ul class="pos-list">
          {[...h.parts]
            .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
            .map((x) => (
              <HeldRow
                key={`${x.portfolio}/${x.broker ?? ""}/${x.position ?? ""}`}
                p={x}
                h={h}
              />
            ))}
        </ul>
      </section>
      {failed && <p class="faint">The trades did not load.</p>}
      {/* a holding with no trades, such as a bond, has no section */}
      {orders !== null && orders.length > 0 && (
        <section>
          <h3 class="pos-head">
            Trades <span class="faint">{orders.length}</span>
          </h3>
          <ul class="pos-list">
            {orders.slice(0, shown.value).map((f) => (
              <OrderRow key={f[0]!.id} fills={f} />
            ))}
          </ul>
          {orders.length > shown.value && (
            <button
              type="button"
              class="btn-text faint pos-more"
              onClick={() => {
                shown.value += FIRST;
              }}
            >
              Show more
            </button>
          )}
        </section>
      )}
    </div>
  );
}
