// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { symbolHref } from "../app/paths.ts";
import {
  markets,
  type ScreenAsk,
  type Screened,
  type Screener as Screened_,
} from "../data/store.ts";
import { change, priceParts } from "../lib/format.ts";
import { nameOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Change, Num } from "../ui/Figures.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { SymbolName, SymbolWaiting } from "../ui/Symbol.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  type Own,
  returnOf,
  SCREEN_TEXT,
  type ScreenText,
  screenText,
  TREND,
  tabOf,
  typeTabs,
} from "./Screener.model.ts";
import "./instruments.css";

const faint = <span class="faint">–</span>;

function ownCell(own: Own, row: Screened) {
  const v = row[own.key];
  return v === null ? faint : <span class="num">{own.text(v)}</span>;
}

function priceCell(row: Screened, own: Own | undefined) {
  const p = priceParts(row);
  return (
    <>
      <Num currency={p.currency}>{p.value}</Num>
      {/* a phone drops the figure columns: the screen's own figure, else
          the day's move, sits under the price */}
      {own === undefined ? (
        <Change s={change(row)} class="small show-phone" />
      ) : (
        <span class="small num show-phone">
          {row[own.key] === null ? "–" : own.text(row[own.key]!)}
        </span>
      )}
    </>
  );
}

const returnColumn = (
  key: "return_1m" | "return_1y",
  head: string,
): Column<Screened> => ({
  key,
  head,
  width: "minmax(0, 0.6fr)",
  align: "end",
  sortable: true,
  hide: "phone",
  cell: (r) => (r[key] === null ? faint : <Change s={returnOf(r, r[key])} />),
});

function columnsFor(s: ScreenText): Column<Screened>[] {
  const own = s.own;
  return [
    {
      key: "symbol",
      head: "Instrument",
      width: { base: "minmax(0, 2.2fr)", phone: "minmax(0, 1fr)" },
      sortable: true,
      sortFirst: "asc",
      wait: <SymbolWaiting />,
      cell: (r) => (
        <SymbolName
          ticker={tickerOf(r.id, r.kind)}
          name={nameOf(r.name, r.kind, r.id)}
        />
      ),
    },
    {
      key: "price",
      head: "Price",
      width: { base: "minmax(0, 1fr)", phone: "112px" },
      align: "end",
      cell: (r) => priceCell(r, own),
    },
    // beside the price, where the eye lands
    ...(own === undefined
      ? []
      : [
          {
            key: own.key,
            head: own.head,
            width: "minmax(0, 0.8fr)",
            align: "end",
            sortable: true,
            sortFirst: s.order,
            hide: "phone",
            cell: (r: Screened) => ownCell(own, r),
          } satisfies Column<Screened>,
        ]),
    {
      key: "change",
      head: "Day",
      width: "minmax(0, 0.6fr)",
      align: "end",
      sortable: true,
      hide: "phone",
      cell: (r) => <Change s={change(r)} />,
    },
    returnColumn("return_1m", "1M"),
    returnColumn("return_1y", "1Y"),
    {
      key: "trend",
      head: "Trend",
      width: "minmax(0, 0.7fr)",
      align: "end",
      sortable: true,
      hide: "phone",
      cell: (r) =>
        r.trend === null ? (
          faint
        ) : (
          <span
            class={`tag${r.trend === "up" ? " tag-up" : r.trend === "down" ? " tag-down" : ""}`}
          >
            {TREND[r.trend]}
          </span>
        ),
    },
  ];
}

const WAITING_ROWS = 8;

export function ScreenerList({
  held,
  ask,
  more,
  onAsk,
  onMore,
}: {
  held: Screened_ | null;
  ask: ScreenAsk;
  // Show more's page is reading
  more: boolean;
  onAsk: (ask: ScreenAsk) => void;
  onMore: () => void;
}) {
  const s = screenText(ask.screen);
  // the answer on screen until the next ask's lands
  const shown = held === null ? null : screenText(held.ask.screen);
  const tabs = typeTabs(held?.kinds ?? []);
  return (
    <>
      <Tabs
        label="Types"
        value={tabOf(ask.types)}
        onPick={(key) =>
          onAsk({
            ...ask,
            types: tabs.find((t) => t.key === key)?.types ?? [],
          })
        }
        tabs={tabs.map((t) => ({ key: t.key, label: t.label }))}
      />
      {/* a fieldset only names the group: an inner div lays it out */}
      <fieldset class="scr-set" aria-label="Screens">
        <div class="scr-tiles">
          {SCREEN_TEXT.map((x) => {
            const on = x.key === s.key;
            return (
              <button
                key={x.key}
                type="button"
                class={`scr-tile${on ? " scr-tile-on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  if (!on)
                    onAsk({ ...ask, screen: x.key, sort: null, order: null });
                }}
              >
                <span class="scr-n num">{held?.counts[x.key] ?? "–"}</span>
                <span class="scr-name">{x.name}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <Card title={(shown ?? s).name} label="Instruments">
        <p class="scr-why">{(shown ?? s).why}</p>
        <Table
          label="Instruments"
          columns={columnsFor(shown ?? s)}
          rows={held?.rows ?? []}
          rowKey={(r) => r.id}
          open={(r) => ({ href: symbolHref(r.id) })}
          rowLabel={(r) => tickerOf(r.id, r.kind)}
          sort={held?.sort.field}
          dir={held?.sort.order}
          onSort={(sort, order) => onAsk({ ...ask, sort, order })}
          empty={(shown ?? s).empty}
          waiting={held === null ? WAITING_ROWS : undefined}
        />
        {held?.next != null && (
          <button
            type="button"
            class="btn-text faint scr-more"
            disabled={more}
            onClick={onMore}
          >
            Show more
          </button>
        )}
      </Card>
    </>
  );
}

export function Screener() {
  useRefresh(markets.loadScreener);
  const held = markets.screener.value !== null;
  return (
    <Page
      title="Screener"
      stale={held ? markets.screenerError.value : null}
      staleCount={markets.screenerFailures.value}
      failed={didNotLoad(
        held,
        markets.screenerError.value,
        markets.screenerCode.value,
        () => void markets.loadScreener(),
      )}
    >
      <ScreenerList
        held={markets.screener.value}
        ask={markets.screenAsk.value}
        more={markets.screenerMore.value}
        onAsk={(ask) => void markets.loadScreener(ask)}
        onMore={() => void markets.moreScreener()}
      />
    </Page>
  );
}
