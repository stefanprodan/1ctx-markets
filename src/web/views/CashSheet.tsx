// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A cash row's drawer: one box for a new balance, the rest folded away,
// and the row's kept updates as a step line and a list.

import { useSignal } from "@preact/signals";
import { useEffect, useId, useMemo } from "preact/hooks";
import type { Holding, PortfolioStore } from "../data/portfolios.ts";
import { amount, day, signedAmount } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Change } from "../ui/Figures.tsx";
import {
  balanceChange,
  type ChainRow,
  historyLines,
  stepPath,
  steps,
} from "./CashHistory.model.ts";
import { PositionEdit } from "./PortfolioForms.tsx";
import { cashWord, matured, today } from "./Portfolios.model.ts";
import "./cash.css";
import "./positions.css";

const BOX_W = 300;
const BOX_H = 72;

export function CashSheet({
  store,
  h,
  open = false,
  onMoved,
  onDone,
}: {
  store: PortfolioStore;
  h: Holding;
  // Edit details unfolded from the start, as the row's ⋯ Edit opens it
  open?: boolean;
  onMoved: (id: number) => void;
  onDone: () => void;
}) {
  const id = h.position!;
  const ccy = h.currency;
  const now = today(store.overview.value?.time_zone ?? null);
  const box = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const details = useSignal(open);
  const asking = useSignal(false);
  const chain = useSignal<ChainRow[] | null>(null);
  useEffect(() => {
    let live = true;
    void store.positionHistory<ChainRow>(id).then((got) => {
      if (live) chain.value = got;
    });
    return () => {
      live = false;
    };
  }, [id]);
  const balance = h.parts[0]?.amount ?? h.value;
  const at = h.parts[0]?.as_of ?? h.as_of;
  const update = async (ev: Event) => {
    ev.preventDefault();
    const got = balanceChange(box.value, balance);
    if ("error" in got) {
      error.value = got.error;
      return;
    }
    if ("none" in got) {
      box.value = "";
      error.value = null;
      return;
    }
    busy.value = true;
    const r = await store.updatePositionTo(id, got.change, onMoved);
    busy.value = false;
    if ("refused" in r) {
      error.value = r.refused;
      return;
    }
    box.value = "";
    error.value = null;
  };
  const where = [cashWord(h), h.parts[0]?.broker, ccy]
    .filter(Boolean)
    .join(" · ");
  const head = (
    <div class={`cs-head${matured(h) ? " cs-matured" : ""}`}>
      <p class="small faint">{where}</p>
      <p class="cs-figure">
        <span class="num amount">{amount(balance, null)}</span>{" "}
        <span class="cs-ccy faint">{ccy}</span>
      </p>
      <p class="small faint">
        {matured(h) && <span class="tag tag-side pf-matured-tag">Matured</span>}{" "}
        {[
          at ? `Updated ${day(at)}` : null,
          h.maturity ? `matures ${day(h.maturity)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
  // the open form and the question keep their buttons in the drawer's
  // foot, as every other drawer does
  return (
    <Drawer title={h.name ?? "Cash"} onClose={onDone} busy={busy.value} bare>
      {(close) => (
        <div class="cs-sheet">
          {asking.value ? (
            <>
              <div class="drawer-body">
                {head}
                <p>
                  Remove {h.name ?? "this cash"}? Its amount stops counting in
                  the totals.
                </p>
              </div>
              <div class="drawer-foot">
                {error.value && (
                  <p class="error pf-refusal" role="alert">
                    {error.value}
                  </p>
                )}
                <button
                  type="button"
                  class="btn btn-small"
                  onClick={() => {
                    asking.value = false;
                    error.value = null;
                  }}
                >
                  Keep
                </button>
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  disabled={busy.value}
                  onClick={async () => {
                    busy.value = true;
                    error.value = await store.removePosition(id);
                    busy.value = false;
                    if (error.value === null) close();
                  }}
                >
                  {busy.value ? "Removing" : "Remove"}
                </button>
              </div>
            </>
          ) : details.value ? (
            <PositionEdit
              drawer
              store={store}
              h={h}
              head={head}
              onMoved={onMoved}
              onDone={() => {
                details.value = false;
              }}
              lead={
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  onClick={() => {
                    asking.value = true;
                  }}
                >
                  <Icon name="trash" size={14} /> Remove
                </button>
              }
            />
          ) : (
            <div class="drawer-body">
              {head}
              <form class="cs-update" onSubmit={update}>
                <input
                  class="cs-box"
                  inputMode="decimal"
                  aria-label="New balance or change"
                  placeholder="New balance, or +/− change"
                  value={box.value}
                  onInput={(e) => {
                    box.value = e.currentTarget.value;
                    error.value = null;
                  }}
                />
                <button
                  type="submit"
                  class="btn btn-small btn-primary"
                  disabled={busy.value}
                >
                  {busy.value ? "Saving" : "Update"}
                </button>
              </form>
              {error.value && (
                <p class="error small" role="alert">
                  {error.value}
                </p>
              )}
              <button
                type="button"
                class="btn-text cs-fold"
                onClick={() => {
                  details.value = true;
                  error.value = null;
                }}
              >
                Edit details <Icon name="chevron" size={14} />
              </button>
              <History
                chain={chain.value}
                today={now}
                zone={store.overview.value?.time_zone ?? null}
              />
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function History({
  chain,
  today,
  zone,
}: {
  chain: ChainRow[] | null;
  today: string;
  zone: string | null;
}) {
  const gid = useId();
  const lines = useMemo(
    () => (chain ? historyLines(chain, zone) : []),
    [chain, zone],
  );
  const path = useMemo(
    () => (chain ? stepPath(steps(chain, zone), today, BOX_W, BOX_H) : null),
    [chain, today, zone],
  );
  if (chain === null) return null;
  return (
    <section class="cs-history">
      <h3 class="pos-head">History</h3>
      {path && (
        <svg
          class="cs-chart amount"
          viewBox={`0 0 ${BOX_W} ${BOX_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" class="cs-chart-top" />
              <stop offset="100%" class="cs-chart-bottom" />
            </linearGradient>
          </defs>
          <path d={path.area} fill={`url(#${gid})`} />
          <path d={path.line} class="cs-chart-line" />
        </svg>
      )}
      <ul class="pos-list">
        {lines.map((l) => (
          <li key={l.key} class="pos-row">
            <div class="pos-main">
              <span class="pos-what">{day(l.date)}</span>
              {l.what && <span class="pos-sub faint cs-sub">{l.what}</span>}
            </div>
            {!l.event && (
              <div class="pos-figs">
                <span class="num amount">{amount(l.amount, l.currency)}</span>
                {l.change !== null && (
                  <Change
                    s={signedAmount(l.change, null)}
                    class="pos-gain amount"
                  />
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
