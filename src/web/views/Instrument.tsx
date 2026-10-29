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
import { didNotLoad, Page } from "../ui/Page.tsx";
import { CHART_CREDIT, Chart } from "./Chart.tsx";
import { HeadSearch } from "./Dashboard.tsx";
import {
  afterHours,
  type Choice,
  choices,
  deleteLine,
  headline,
  priceState,
  RETURNS,
  returnCell,
  type StatCard,
  stats,
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
  const x = afterHours(detail);
  const r = detail.quote?.returns ?? null;
  const w200 = weekly200(detail);
  return (
    <section class="card ins-head" aria-label="Price">
      <span class="label">{about(detail.instrument)}</span>
      <div class="ins-quotes">
        <div class="ins-quote">
          <div class="ins-figure">
            <span class="ins-big">{h.price}</span>
            {h.change.text && (
              <span class={`ins-move ${tone(h.change.dir) ?? ""}`}>
                {h.change.text}
              </span>
            )}
          </div>
          <span class="ins-state">{priceState(detail, now)}</span>
        </div>
        {x !== null && (
          <div class="ins-quote">
            <div class="ins-figure">
              <span class="ins-big">{x.price}</span>
              {x.change.text && (
                <span class={`ins-move ${tone(x.change.dir) ?? ""}`}>
                  {x.change.text}
                </span>
              )}
            </div>
            <span class="ins-state">{x.label}</span>
          </div>
        )}
      </div>
      {r !== null && (
        <dl class="ins-returns">
          {RETURNS.map(({ key, label, short }) => {
            const c = returnCell(
              r[key] as number | null,
              detail.instrument.unit === "percent",
            );
            return (
              <div key={key} class="ins-return">
                <dt>
                  <span class="ins-long">{label}</span>
                  <span class="ins-short">{short}</span>
                </dt>
                <dd class={tone(c.dir)}>{c.text}</dd>
              </div>
            );
          })}
          <div class="ins-return ins-desk">
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

// what the chart leaves out, in a card per question
export function Stats({ cards }: { cards: readonly StatCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div class="ins-stats">
      {cards.map((c) => (
        <section key={c.title} class="card ins-stat" aria-label={c.title}>
          <span class="label">{c.title}</span>
          {c.span && (
            <div class="ins-span">
              <div class="ins-span-track">
                <span
                  class="ins-span-mark"
                  style={{ left: `${(c.span.at * 100).toFixed(1)}%` }}
                />
              </div>
              <div class="ins-span-ends">
                <span>{c.span.low}</span>
                <span>{c.span.high}</span>
              </div>
            </div>
          )}
          {c.rows.length > 0 && (
            <dl class="ins-stat-rows">
              {c.rows.map((r) => (
                <div
                  key={r.label}
                  class={`ins-stat-row${r.phone ? " ins-phone" : ""}`}
                >
                  <dt>{r.label}</dt>
                  <dd>
                    <span
                      class={
                        r.tone === "up"
                          ? "ins-up"
                          : r.tone === "down"
                            ? "ins-down"
                            : undefined
                      }
                    >
                      {r.value}
                    </span>
                    {r.note && <span class="ins-stat-note">{r.note}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </div>
  );
}

// the page's actions under one button, as 1ctx's More: Refetch data runs
// at once, Delete asks once inside the menu
export const SAID_MS = 2000;

export function InstrumentMenu({
  symbol,
  busy,
  done,
  removing,
  onRefetch,
  onDelete,
}: {
  symbol: string;
  busy: boolean;
  // a refetch just fetched: a green check for SAID_MS
  done: boolean;
  removing: boolean;
  onRefetch: () => void;
  onDelete: () => void;
}) {
  const asking = useSignal(false);
  // Escape leaves the question for the menu before it closes the menu
  const { open, root } = useMenu(() => {
    if (!asking.value) return false;
    asking.value = false;
    return true;
  });
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: boolean) => {
    ev.stopPropagation();
    asking.value = to;
  };
  return (
    <div class="ins-more" ref={root}>
      <button
        type="button"
        class="btn ins-more-btn"
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open.value}
        disabled={busy || removing}
        onClick={() => {
          asking.value = false;
          open.value = !open.value;
        }}
      >
        {busy ? (
          <span
            class="home-spinner ins-spin"
            role="img"
            aria-label="Fetching"
          />
        ) : done ? (
          <Icon name="check" size={16} class="ins-done" />
        ) : (
          <Icon name="more" size={16} />
        )}
      </button>
      {open.value && (
        <div class="menu ins-menu" role="menu">
          {asking.value ? (
            <div class="ins-ask">
              <p class="ins-ask-title">Delete {symbol}?</p>
              <p class="ins-ask-line">{deleteLine}</p>
              <div class="ins-ask-foot">
                <button
                  type="button"
                  class="btn btn-small"
                  onClick={(ev) => swap(ev, false)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  class="btn btn-small btn-danger"
                  onClick={() => {
                    open.value = false;
                    asking.value = false;
                    onDelete();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  open.value = false;
                  onRefetch();
                }}
              >
                <Icon name="redo" size={14} />
                Refetch data
              </button>
              <button
                type="button"
                class="menu-item ins-menu-delete"
                role="menuitem"
                onClick={(ev) => swap(ev, true)}
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            </>
          )}
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
      failed={didNotLoad(
        detail !== null,
        markets.detailError.value,
        markets.detailCode.value,
        () => void load(),
      )}
      stale={detail === null ? null : markets.detailError.value}
      staleCount={markets.detailFailures.value}
      error={
        (said.value?.bad || said.value?.text === "Not available"
          ? said.value.text
          : null) ??
        refused.value ??
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
        <>
          <HeadSearch />
          {detail !== null && (
            <InstrumentMenu
              symbol={symbol}
              busy={fetching.value}
              done={said.value?.text === "Updated"}
              removing={removing.value}
              onRefetch={() => void run(options[0]!)}
              onDelete={() => void remove()}
            />
          )}
        </>
      }
    >
      {detail !== null && (
        <>
          <Head detail={detail} now={Date.now()} />
          <Chart id={id} />
          <Stats cards={stats(detail)} />
        </>
      )}
    </Page>
  );
}
