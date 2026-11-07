// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The reader's own trade plans tagged with a symbol: a card on its page
// once one is, each opening the plan at the first section the symbol heads.

import { useEffect, useState } from "preact/hooks";
import { tradePlanHref } from "../app/paths.ts";
import type { TradePlansStore } from "../data/trade-plans.ts";
import { ago } from "../lib/format.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Notice } from "../ui/Notice.tsx";
import { cardPlans, hasArchived } from "./TradePlans.model.ts";
import { DueTag, StatusTag } from "./TradePlans.tsx";
import "./trade-plans.css";

export type TaggedPlans = ReturnType<TradePlansStore["tagged"]>;

export function TradePlansSection({
  store,
  id,
}: {
  store: TaggedPlans;
  // the page's id, as the plan page asks its sections by
  id: string;
}) {
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    void store.load();
  }, [store]);
  useRefresh(() => store.load(), true);
  const all = store.plans.value;
  // a symbol mostly has none, and an empty card on every page is noise
  if (all === null || all.length === 0) return null;
  const shown = cardPlans(all, archived);
  const now = Date.now();
  return (
    <div class="tp-card">
      <Card
        title="Trade plans"
        count={shown.length}
        actions={
          hasArchived(all) && (
            <button
              type="button"
              class="btn btn-small"
              aria-pressed={archived}
              onClick={() => setArchived(!archived)}
            >
              {archived ? "Hide archived" : "Show archived"}
            </button>
          )
        }
      >
        {shown.length === 0 ? (
          <Notice>No active plans.</Notice>
        ) : (
          <ul class="tp-card-list">
            {shown.map((p) => (
              <li key={p.id}>
                <a class="tp-card-row" href={tradePlanHref(p.id, id)}>
                  <span class="tp-name">{p.name}</span>
                  {p.status !== "active" && <StatusTag status={p.status} />}
                  {p.review_due && <DueTag />}
                  <span class="tp-card-when faint small">
                    Updated {ago(p.updated_at, now)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
