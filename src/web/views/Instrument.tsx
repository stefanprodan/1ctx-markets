// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import { navigate } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { says } from "../data/api.ts";
import { type Detail, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { nameOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Change, Facts, Hero, Num, Stats } from "../ui/Figures.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { CHART_CREDIT, Chart } from "./Chart.tsx";
import {
  afterHours,
  type Choice,
  choices,
  deleteLine,
  headline,
  moveLabel,
  priceState,
  RETURNS,
  returnCell,
  type StatCard,
  stats,
  summary,
  UNREAD,
  weekly200,
} from "./Instrument.model.ts";
import { about } from "./Instruments.model.ts";
import "./instruments.css";

export function Head({ detail, now }: { detail: Detail; now: number }) {
  const h = headline(detail);
  const x = afterHours(detail);
  const r = detail.quote?.returns ?? null;
  const w200 = weekly200(detail);
  const points = detail.instrument.unit === "percent";
  const hero = (
    <Hero
      name={
        <>
          {about(detail.instrument)}
          <span class="faint"> · {priceState(detail, now)}</span>
        </>
      }
      value={h.value}
      currency={h.currency ?? undefined}
      moves={[
        {
          money: h.move.text ? h.move : undefined,
          percent: h.change,
          label: moveLabel(detail),
        },
      ]}
      lines={
        x === null
          ? undefined
          : [
              <>
                <span class="faint">{x.word}</span> <Num>{x.value}</Num>{" "}
                <Change s={x.change} /> <span class="faint">· {x.at}</span>
              </>,
            ]
      }
    />
  );
  if (r === null) return hero;
  const items = (short: boolean) => [
    ...RETURNS.map((x) => ({
      label: short ? x.short : x.label,
      value: <Change s={returnCell(r[x.key] as number | null, points)} />,
    })),
    {
      label: short ? "200W" : "200-week average",
      value: w200 ? <Change s={w200} /> : "—",
    },
  ];
  return (
    <div class="ins-top">
      {hero}
      {/* a phone's row in the chart ranges' short words, to fit */}
      <div class="ins-returns hide-phone">
        <Stats label="Returns" items={items(false)} />
      </div>
      <div class="ins-returns show-phone">
        <Stats label="Returns" items={items(true)} />
      </div>
    </div>
  );
}

const toneClass = (t: StatCard["rows"][number]["tone"]) =>
  t === "up" ? "num up" : t === "down" ? "num down" : "num";

// what the chart leaves out, in a card per question
export function SignalCards({ cards }: { cards: readonly StatCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div class="ins-cards">
      {cards.map((c) => (
        <Card key={c.title} title={c.title} label={c.title}>
          {c.span && (
            <div class="ins-span">
              <div class="ins-span-track">
                <span
                  class="ins-span-mark"
                  style={{ left: `${(c.span.at * 100).toFixed(1)}%` }}
                />
              </div>
              <div class="ins-span-ends small">
                <Num>{c.span.low}</Num>
                <Num>{c.span.high}</Num>
              </div>
            </div>
          )}
          {c.rows.length > 0 && (
            <Facts
              items={c.rows.map((r) => ({
                label: r.label,
                value: (
                  <>
                    <span class={toneClass(r.tone)}>{r.value}</span>
                    {r.note && (
                      <span class="ins-note small faint">{r.note}</span>
                    )}
                  </>
                ),
              }))}
            />
          )}
        </Card>
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
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: boolean) => {
    ev.stopPropagation();
    asking.value = to;
  };
  return (
    <MenuButton
      head
      label="More"
      disabled={busy || removing}
      menuClass="ins-menu"
      onOpen={() => {
        asking.value = false;
      }}
      // Escape leaves the question for the menu before it closes the menu
      back={() => {
        if (!asking.value) return false;
        asking.value = false;
        return true;
      }}
      face={
        busy ? (
          <span class="spinner ins-spin" role="img" aria-label="Fetching" />
        ) : done ? (
          <Icon name="check" size={16} class="status-done" />
        ) : undefined
      }
    >
      {(close) =>
        asking.value ? (
          <div class="ins-ask">
            <p class="ins-ask-title">Delete {symbol}?</p>
            <p class="ins-ask-line small faint">{deleteLine}</p>
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
                  close();
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
                close();
                onRefetch();
              }}
            >
              <Icon name="redo" size={14} />
              Refetch data
            </button>
            <button
              type="button"
              class="menu-item menu-item-danger"
              role="menuitem"
              onClick={(ev) => swap(ev, true)}
            >
              <Icon name="trash" size={14} />
              Delete
            </button>
          </>
        )
      }
    </MenuButton>
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
  const kind = detail?.instrument.kind;
  const symbol = tickerOf(id, kind);
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
      meta={
        detail?.instrument.name
          ? nameOf(detail.instrument.name, kind, id)
          : undefined
      }
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
        detail !== null && (
          <InstrumentMenu
            symbol={symbol}
            busy={fetching.value}
            done={said.value?.text === "Updated"}
            removing={removing.value}
            onRefetch={() => void run(options[0]!)}
            onDelete={() => void remove()}
          />
        )
      }
    >
      {detail !== null && (
        <>
          <Head detail={detail} now={Date.now()} />
          <Chart id={id} />
          <SignalCards cards={stats(detail)} />
        </>
      )}
    </Page>
  );
}
