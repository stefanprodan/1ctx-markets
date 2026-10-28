// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import { navigate } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { says } from "../data/api.ts";
import { type Detail, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Page } from "../ui/Page.tsx";
import { SettingDelete } from "../ui/SettingDelete.tsx";
import { CHART_CREDIT, Chart } from "./Chart.tsx";
import {
  type Choice,
  choices,
  deleteLine,
  headline,
  priceState,
  RETURNS,
  returnCell,
  summary,
  UNREAD,
  weekly200,
} from "./Instrument.model.ts";
import { about, symbolOf } from "./Instruments.model.ts";
import "./instruments.css";

const tone = (dir: -1 | 0 | 1) =>
  dir > 0 ? "ins-up" : dir < 0 ? "ins-down" : undefined;

export function Head({ detail, now }: { detail: Detail; now: number }) {
  const h = headline(detail);
  const r = detail.quote?.returns ?? null;
  const w200 = weekly200(detail);
  return (
    <section class="card ins-head" aria-label="Price">
      <span class="label">{about(detail.instrument)}</span>
      <div class="ins-figure">
        <span class="ins-big">{h.price}</span>
        {h.change.text && (
          <span class={`ins-move ${tone(h.change.dir) ?? ""}`}>
            {h.change.text}
          </span>
        )}
      </div>
      <span class="ins-state">{priceState(detail, now)}</span>
      {r !== null && (
        <dl class="ins-returns">
          {RETURNS.map(({ key, label }) => {
            const c = returnCell(
              r[key] as number | null,
              detail.instrument.unit === "percent",
            );
            return (
              <div key={key} class="ins-return">
                <dt>{label}</dt>
                <dd class={tone(c.dir)}>{c.text}</dd>
              </div>
            );
          })}
          <div class="ins-return">
            <dt>200-week average</dt>
            <dd class={w200 ? tone(w200.dir) : undefined}>
              {w200?.text ?? "—"}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

// a button with its menu, as 1ctx's More: picking a part runs it at once
// the button says how it went, as 1ctx's Saved, then reads Refetch again;
// every label shares one cell, so the button keeps its width
export const SAID_MS = 2500;

export function RefetchMenu({
  options,
  busy,
  done,
  onPick,
}: {
  options: readonly Choice[];
  busy: boolean;
  // a short outcome while it shows, else null
  done: string | null;
  onPick: (c: Choice) => void;
}) {
  const { open, root } = useMenu();
  const on = (yes: boolean) => `ins-label${yes ? " ins-label-on" : ""}`;
  return (
    <div class="ins-more" ref={root}>
      <button
        type="button"
        class="btn"
        aria-haspopup="menu"
        aria-expanded={open.value}
        disabled={busy}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="ins-labels" aria-live="polite">
          <span class={on(!busy && done === null)}>
            <Icon name="redo" size={14} />
            Refetch
            <Icon name="chevron" size={12} />
          </span>
          <span class={on(busy)}>Fetching</span>
          <span class={`${on(!busy && done === "Updated")} ins-label-done`}>
            <Icon name="check" size={14} />
            Updated
          </span>
          <span class={on(!busy && done === "Not available")}>
            Not available
          </span>
        </span>
      </button>
      {open.value && (
        <div class="menu ins-menu" role="menu">
          {options.map((c, i) => (
            <button
              key={c.label}
              type="button"
              class={`menu-item${i === 0 ? " ins-menu-all" : ""}`}
              role="menuitem"
              onClick={() => {
                open.value = false;
                onPick(c);
              }}
            >
              <span class="cut">{c.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Instrument({ params }: { params: Params }) {
  const id = params.id!;
  const load = useCallback(() => markets.loadInstrument(id), [id]);
  useRefresh(load);
  const fetching = useSignal(false);
  const said = useSignal<{ text: string; bad: boolean } | null>(null);
  // the button's outcome fades back to Refetch
  useEffect(() => {
    if (said.value === null || said.value.bad) return;
    const timer = setTimeout(() => {
      said.value = null;
    }, SAID_MS);
    return () => clearTimeout(timer);
  }, [said.value]);
  const removing = useSignal(false);
  const refused = useSignal<string | null>(null);

  const detail = markets.detailId.value === id ? markets.detail.value : null;
  const symbol = symbolOf(id);
  const options = detail === null ? [] : choices(detail.instrument);

  const run = async (c: Choice) => {
    fetching.value = true;
    said.value = null;
    try {
      const results = await markets.refetch(id, c.parts, c.sections);
      said.value = summary(results, options, symbol);
    } catch (error) {
      said.value = { text: says(error), bad: true };
    } finally {
      fetching.value = false;
    }
  };
  const remove = async () => {
    removing.value = true;
    refused.value = null;
    const r = await markets.remove(id);
    removing.value = false;
    if (r.ok) navigate("/instruments");
    else
      refused.value =
        "rules" in r
          ? `A rule uses ${symbol}. Delete the rule first.`
          : r.error;
  };

  return (
    <Page
      title={symbol}
      meta={detail?.instrument.name ?? undefined}
      error={
        markets.detailError.value ??
        (said.value?.bad ? said.value.text : null) ??
        (detail?.error ? UNREAD : null)
      }
      foot={
        detail !== null && (
          <>
            {detail.credit && (
              <>
                Data by{" "}
                <a href={detail.credit.url} target="_blank" rel="noopener">
                  {detail.credit.name}
                </a>
                {" · "}
              </>
            )}
            Charts by{" "}
            <a href={CHART_CREDIT} target="_blank" rel="noopener">
              TradingView
            </a>
          </>
        )
      }
      actions={
        detail !== null && (
          <RefetchMenu
            options={options}
            busy={fetching.value}
            done={
              said.value !== null && !said.value.bad ? said.value.text : null
            }
            onPick={(c) => void run(c)}
          />
        )
      }
    >
      {detail !== null && (
        <>
          <Head detail={detail} now={Date.now()} />
          <Chart id={id} />
          <SettingDelete
            title={`Delete ${symbol}`}
            line={deleteLine}
            ask={`Delete ${symbol}?`}
            refused={refused.value}
            busy={removing.value}
            onDelete={() => void remove()}
          />
        </>
      )}
    </Page>
  );
}
