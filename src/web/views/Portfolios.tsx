// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios: the portfolios as tabs, the value band, the holdings by
// group, the activity by month; every form in the one drawer.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Params } from "../app/routes.ts";
import type {
  Close,
  Holding,
  Holdings,
  PortfolioStore,
  TradeRow,
} from "../data/portfolios.ts";
import { NOT_SHARED } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { day, money, percent, quantity, signedMoney } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { nameOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { amountsHidden, hiddenClass } from "../ui/Amounts.tsx";
import { Card, GroupLabel, PeriodLabel } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import {
  Change,
  Facts,
  Hero,
  HeroWaiting,
  type Move,
  Num,
} from "../ui/Figures.tsx";
import {
  MenuButton,
  MenuHead,
  type MenuItem,
  MenuItems,
  MenuLine,
} from "../ui/Menu.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Search } from "../ui/Search.tsx";
import { Spark } from "../ui/Spark.tsx";
import { SymbolName, SymbolWaiting } from "../ui/Symbol.tsx";
import {
  type Column,
  type SortDir,
  Table,
  type TableGroup,
} from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  AddSheet,
  type AddStart,
  FundPriceEdit,
  ImportPanel,
  PositionEdit,
  Purchases,
  SettingsPanel,
  StartCard,
  Welcome,
} from "./PortfolioForms.tsx";
import { hasGrowth, shortMoney } from "./PortfolioGrowth.model.ts";
import {
  GrowthLine,
  HeroFigure,
  useGrowth,
  useHeroFit,
} from "./PortfolioGrowth.tsx";
import {
  activityOf,
  barOf,
  bondPhoneLine,
  cashLine,
  columnsFor,
  currencies,
  type EditWhat,
  enteredBy,
  groupShare,
  groupsOf,
  heroOf,
  holdingMatches,
  holdingName,
  holdingTicker,
  homeOf,
  isFundId,
  isReserve,
  isReward,
  matured,
  missingWords,
  mixed,
  orderOf,
  pageOf,
  priceLine,
  type Remembered,
  type RowAction,
  rateLine,
  rowActions as rowActionsOf,
  SHUT_KEY,
  type SortKey,
  shownGain,
  shownGainPercent,
  shownValue,
  shownWeight,
  shutOf,
  sideTag,
  sideWord,
  sortRows,
  staleWords,
  sums,
  toggleShut,
  tradeAmount,
  tradeName,
  tradePage,
  unitPrice,
  weightBar,
} from "./Portfolios.model.ts";
import "./portfolios.css";

export type Panel = "add" | "import" | "settings" | null;

// read once per holding and day for the page's life
const barCache = new Map<string, Close[]>();
async function loadBars(
  store: PortfolioStore,
  id: string,
  from: string,
): Promise<Close[]> {
  const key = `${id} ${from}`;
  const hit = barCache.get(key);
  if (hit) return hit;
  const out = await store.bars(id, from);
  if (out.length > 0) barCache.set(key, out);
  return out;
}

const daysAgo = (n: number): string =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function useSparks(
  store: PortfolioStore,
  h: Holdings | null,
): Record<string, Close[]> {
  const [got, setGot] = useState<Record<string, Close[]>>({});
  const ids = useMemo(
    () =>
      (h?.holdings ?? [])
        .map((x) => (pageOf(x) ? x.id : null))
        .filter((id): id is string => id !== null),
    [h],
  );
  useEffect(() => {
    let live = true;
    const from = daysAgo(92);
    void Promise.all(
      ids.map(async (id) => [id, await loadBars(store, id, from)] as const),
    ).then((all) => {
      if (live) setGot(Object.fromEntries(all));
    });
    return () => {
      live = false;
    };
  }, [ids.join(",")]);
  return got;
}

// ---- the page ----

export const keyOf = (h: Holding): string =>
  h.id ?? `pos:${h.position ?? h.name ?? ""}`;

// a stored instant read on the owner's calendar: a trade entered at
// 01:00 in Bucharest is dated that day, not the UTC day before
function ownerDay(iso: string, zone: string | null | undefined): string {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: zone ?? undefined,
    });
  } catch {
    return day(iso.slice(0, 10));
  }
}

export function Portfolios() {
  const store = markets.portfolios;
  useRefresh(store.load);
  return <PortfoliosBody store={store} />;
}

// another person's portfolios, as they see them, with nothing to change
export function SharedPortfolios({ params }: { params: Params }) {
  const store = markets.shared;
  useRefresh(store.load);
  const owner =
    markets.sharers.value.find((s) => s.id === params.user)?.name ?? null;
  return <PortfoliosBody store={store} owner={owner} />;
}

export function PortfoliosBody({
  store,
  owner,
}: {
  store: PortfolioStore;
  // whose portfolios these are, when they are another person's: drawn
  // view only. null: theirs, the name not known yet
  owner?: string | null;
}) {
  const viewOnly = owner !== undefined;
  const h = store.holdings.value;
  const ov = store.overview.value;
  const trades = store.trades.value;
  const held = h !== null;
  // an ended share is an answer, not a failure: nothing to retry
  const notShared = viewOnly && !held && store.error.value === NOT_SHARED;
  const hide = amountsHidden.value;
  const sparks = useSparks(store, h);
  const panel = useSignal<Panel>(null);
  // a row's Buy or Sell opens the add drawer on it
  const start = useSignal<AddStart | null>(null);
  // the start card's choice of what to add
  const opened = useSignal<Remembered["kind"]>("trade");
  const edit = useSignal<{ key: string; what: EditWhat } | null>(null);
  // the fills of one order, read fresh so a removal shows at once
  const tradeIds = useSignal<number[] | null>(null);
  const fills =
    tradeIds.value === null
      ? []
      : (trades ?? []).filter((t) => tradeIds.value!.includes(t.id));
  const edited =
    edit.value === null
      ? null
      : (h?.holdings.find((x) => keyOf(x) === edit.value!.key) ?? null);
  const onTrade = (s: AddStart) => {
    start.value = s;
    panel.value = "add";
  };
  const close = () => {
    panel.value = null;
    start.value = null;
  };
  const empty = (ov?.portfolios.length ?? 0) === 0 || !ov?.display_currency;
  // nothing in any portfolio yet; a removed trade counts, so the activity
  // keeps its Restore in reach
  const blank =
    !empty &&
    store.portfolio.value === null &&
    h !== null &&
    h.holdings.length === 0 &&
    (trades ?? []).length === 0;
  const all = store.portfolio.value === null;
  return (
    <Page
      title={
        !viewOnly
          ? "Portfolios"
          : owner === null
            ? "Shared portfolios"
            : `${owner}'s portfolios`
      }
      titleCut={viewOnly}
      meta={viewOnly ? "View only" : undefined}
      amounts={held && !empty && !blank}
      actions={
        held && !empty && !viewOnly ? (
          <>
            {!blank && (
              <button
                type="button"
                class="btn btn-primary"
                aria-label="Add"
                onClick={() => {
                  start.value = null;
                  panel.value = "add";
                }}
              >
                <Icon name="plus" size={14} />
                <span class="hide-phone">Add</span>
              </button>
            )}
            <PageMenu store={store} panel={panel} />
          </>
        ) : undefined
      }
      stale={held ? store.error.value : null}
      staleCount={store.failures.value}
      failed={didNotLoad(
        held || notShared,
        store.error.value,
        store.code.value,
        () => void store.load(),
      )}
    >
      <div class={`pf-root ${hiddenClass(hide)}`}>
        {panel.value === "add" && (
          <AddSheet
            key={
              start.value ? `${start.value.symbol}/${start.value.side}` : "new"
            }
            store={store}
            start={start.value}
            kind={blank ? opened.value : undefined}
            onDone={close}
          />
        )}
        {panel.value === "import" && (
          <ImportPanel store={store} onDone={close} />
        )}
        {panel.value === "settings" && (
          <SettingsPanel store={store} onDone={close} />
        )}
        {edit.value !== null && edited !== null && (
          <EditSheet
            key={`${edit.value.key}/${edit.value.what}`}
            store={store}
            h={edited}
            what={edit.value.what}
            onDone={() => {
              edit.value = null;
            }}
          />
        )}
        {fills.length > 0 && (
          <TradeSheet
            key={fills[0]!.id}
            store={store}
            fills={fills}
            all={all}
            viewOnly={viewOnly}
            onTrade={(x) => {
              tradeIds.value = null;
              onTrade(x);
            }}
            onDone={() => {
              tradeIds.value = null;
            }}
          />
        )}
        {held &&
          (viewOnly && (empty || blank) ? (
            <Card>
              <p class="faint">Nothing held yet.</p>
            </Card>
          ) : empty ? (
            <Welcome store={store} />
          ) : blank ? (
            <StartCard
              store={store}
              open={(p) => {
                if (p === "import") {
                  panel.value = "import";
                  return;
                }
                opened.value = p;
                start.value = null;
                panel.value = "add";
              }}
            />
          ) : (
            <>
              <Switcher store={store} />
              <ValueBand store={store} h={h} trades={trades ?? []} />
              <HoldingsCard
                key={store.portfolio.value ?? "all"}
                view={String(store.portfolio.value ?? "all")}
                order={(store.overview.value?.portfolios ?? []).map(
                  (p) => p.name,
                )}
                h={h}
                all={all}
                sparks={sparks}
                viewOnly={viewOnly}
                onTrade={onTrade}
                onEdit={(x, what) => {
                  edit.value = { key: keyOf(x), what };
                }}
              />
              <Activity
                key={store.portfolio.value ?? "all"}
                trades={trades ?? []}
                onOpen={(ids) => {
                  tradeIds.value = ids;
                }}
              />
            </>
          ))}
        {!held &&
          (notShared ? (
            <Card>
              <p class="faint">{NOT_SHARED}</p>
            </Card>
          ) : (
            <PortfoliosWaiting store={store} />
          ))}
      </div>
    </Page>
  );
}

// every column a holding can fill, so the rows wait in the widest shape
const WAITING_COLUMNS = holdingColumns(
  { spark: true, price: true, priceHead: "Change", gain: true },
  {},
);

function PortfoliosWaiting({ store }: { store: PortfolioStore }) {
  return (
    <>
      <Switcher store={store} />
      <HeroWaiting />
      <Card title="Holdings">
        <Table
          label="Holdings"
          columns={WAITING_COLUMNS}
          rowKey={() => ""}
          waiting={6}
        />
      </Card>
    </>
  );
}

// Import, Export and Settings; export is per portfolio, so it is
// offered on one
export function PageMenu({
  store,
  panel,
}: {
  store: PortfolioStore;
  panel: Signal<Panel>;
}) {
  const id = store.portfolio.value;
  const shown = store.overview.value?.portfolios.find((p) => p.id === id);
  const name = shown?.name ?? "";
  return (
    <MenuButton
      head
      label="More"
      items={[
        {
          label: "Import",
          icon: "upload",
          run: () => {
            panel.value = "import";
          },
        },
        // Cash never holds a trade, so it has none to export
        ...(id !== null && !shown?.cash
          ? [
              {
                label: `Export ${name} trades`,
                icon: "download" as const,
                href: store.exportHref(id),
                download: true,
              },
            ]
          : []),
        {
          label: "Settings",
          icon: "sliders",
          run: () => {
            panel.value = "settings";
          },
        },
      ]}
    />
  );
}

// a portfolio picked is an address, so Back returns to the one before
function Switcher({ store }: { store: PortfolioStore }) {
  const list = store.overview.value?.portfolios ?? [];
  const href = (id: number | null) =>
    store.address({ portfolio: id, currency: store.currency.value });
  return (
    <Tabs
      label="Portfolios"
      tabs={[
        { key: null as number | null, label: "All", href: href(null) },
        ...list.map((p) => ({
          key: p.id as number | null,
          label: p.name,
          href: href(p.id),
        })),
      ]}
      value={store.portfolio.value}
    />
  );
}

// the totals' currency, picked where the total is read; each currency's
// own total, the rates and what the total left out sit under the choices
function CurrencyPick({
  store,
  h,
  cur,
}: {
  store: PortfolioStore;
  h: Holdings;
  cur: string;
}) {
  const codes = currencies(h);
  const rates = h.rates
    .map((r) => rateLine(r))
    .filter((r): r is string => r !== null);
  const missing = (h.converted?.missing ?? []).map(missingWords);
  if (codes.length < 2 && missing.length === 0)
    return <span class="hero-ccy">{cur}</span>;
  return (
    <MenuButton
      label="Show totals in"
      text={cur}
      buttonClass="hero-ccy"
      menuClass="pf-ccy-menu"
      left
    >
      {(close) => (
        <>
          {codes.length > 1 && (
            <>
              <MenuHead>Show totals in</MenuHead>
              <MenuItems
                close={close}
                items={codes.map((c) => ({
                  label: <span class="num">{c}</span>,
                  key: c,
                  checked: c === cur,
                  // the display currency is the default, kept out of the
                  // address
                  run: () =>
                    void store.pick({
                      currency:
                        c === store.overview.value?.display_currency ? null : c,
                    }),
                }))}
              />
            </>
          )}
          {h.totals.length > 1 && (
            <>
              <MenuHead>Held in each currency</MenuHead>
              {h.totals.map((c) => (
                <MenuLine
                  key={c.currency}
                  label={c.currency}
                  value={<span class="amount">{money(c.value, null)}</span>}
                />
              ))}
              {rates.map((r) => (
                <MenuLine key={r} faint value={r} />
              ))}
            </>
          )}
          {missing.length > 0 && (
            <>
              <MenuHead>Left out of the total</MenuHead>
              {missing.map((m) => (
                <MenuLine key={m} faint value={m} />
              ))}
            </>
          )}
        </>
      )}
    </MenuButton>
  );
}

// ---- the value band ----

// the selection's name, its value and how it moved: nothing the list
// below already says. It follows the view its figures were read for, so
// a tab picked never shows its name or bar over the last tab's figures
function ValueBand({
  store,
  h,
  trades,
}: {
  store: PortfolioStore;
  h: Holdings;
  trades: readonly TradeRow[];
}) {
  const view = store.shown.value ?? {
    portfolio: store.portfolio.value,
    currency: store.currency.value,
  };
  const id = view.portfolio;
  const row = store.overview.value?.portfolios.find((p) => p.id === id);
  const name = id === null ? "All portfolios" : (row?.name ?? "");
  const hero = heroOf(h);
  const value = hero?.total.value ?? null;
  const wanted = hero !== null && hasGrowth(h, row?.cash === true);
  const growth = useGrowth(store, view, trades, h, wanted);
  // a failed read or under two days draws nothing and needs no room
  const line = wanted && !growth.none;
  const box = useRef<HTMLDivElement>(null);
  const fit = useHeroFit(box, money(value, null), shortMoney(value), line);
  if (hero === null) return null;
  const t = hero.total;
  const bar = barOf(t, id === null);
  const moveList: Move[] = [
    ...(hero.today
      ? [
          {
            money: signedMoney(t.day_change, t.currency),
            percent: percent(hero.dayPercent),
            label: "today",
            moneyClass: "amount",
          },
        ]
      : []),
    ...(hero.allTime
      ? [
          {
            money: signedMoney(t.pl, t.currency),
            percent: percent(t.pl_percent),
            label: "all time",
            moneyClass: "amount",
          },
        ]
      : []),
  ];
  return (
    <div
      ref={box}
      class={[
        "pf-hero",
        line && fit.line === "beside" ? "pf-hero-beside" : "",
        fit.line === "under" ? "pf-hero-under" : "",
        fit.size !== null ? "pf-hero-fitted" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={fit.size !== null ? { "--hero-size": `${fit.size}px` } : undefined}
    >
      <Hero
        name={name}
        value={
          <HeroFigure value={value} currency={t.currency} short={fit.short} />
        }
        valueClass="amount"
        currency={<CurrencyPick store={store} h={h} cur={t.currency} />}
        moves={moveList}
        lines={hero.others.map((o) => (
          <span key={o.currency}>
            <span class="num amount">{money(o.value, o.currency)}</span>{" "}
            <Change s={percent(o.pl_percent)} />
          </span>
        ))}
      >
        {line && <GrowthLine growth={growth} />}
        {bar && (
          <div class="pf-ivc">
            <div
              class="pf-ivc-bar"
              role="img"
              aria-label={bar.map((x) => `${x.label} ${x.pct}%`).join(", ")}
            >
              {bar.map((x) => (
                <span
                  key={x.key}
                  class={`pf-ivc-${x.key}`}
                  style={{ flexGrow: x.value }}
                />
              ))}
            </div>
            <div class="small pf-ivc-legend">
              {bar.map((x) => (
                <span key={x.key}>
                  <i class={`pf-ivc-${x.key}`} />
                  <span class="faint">{x.label}</span>{" "}
                  <span class="num amount">{money(x.value, t.currency)}</span>{" "}
                  <span class="num faint">{x.pct}%</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Hero>
    </div>
  );
}

// ---- holdings ----

const ACTION_WORDS: Record<RowAction, string> = {
  buy: "Buy",
  sell: "Sell",
  price: "Set price",
  edit: "Edit",
  purchases: "Purchases",
  page: "Instrument page",
};

// a row's ⋯ as menu items: Buy and Sell open the add drawer on it, in its
// one portfolio and broker when it has one
export function rowMenu(
  x: Holding,
  onTrade: (s: AddStart) => void,
  open: (w: EditWhat) => void,
): MenuItem[] {
  const where =
    x.parts.length === 1
      ? { portfolio: x.parts[0]!.portfolio, broker: x.parts[0]!.broker }
      : {};
  const fund =
    x.kind === "fund" && x.isin
      ? { fund: { isin: x.isin, name: x.name ?? x.isin, market: x.market } }
      : {};
  const trade = (side: "buy" | "sell") => () =>
    onTrade({ symbol: x.id!, side, ...fund, ...where });
  const run: Record<RowAction, MenuItem> = {
    buy: { label: ACTION_WORDS.buy, run: trade("buy") },
    sell: { label: ACTION_WORDS.sell, run: trade("sell") },
    price: { label: ACTION_WORDS.price, run: () => open("price") },
    edit: { label: ACTION_WORDS.edit, run: () => open("edit") },
    purchases: { label: ACTION_WORDS.purchases, run: () => open("purchases") },
    page: { label: ACTION_WORDS.page, href: pageOf(x) ?? undefined },
  };
  return rowActionsOf(x).map((a) => run[a]);
}

// a label already says Dry powder or Reserve; a phone on All has room for that word only
function rowName(x: Holding, all: boolean, labelled: boolean) {
  if (x.kind === "bond") {
    return (
      <>
        <span class="hide-phone">{holdingName(x)}</span>
        <span class="show-phone">{bondPhoneLine(x)}</span>
      </>
    );
  }
  if (x.kind !== "cash") return holdingName(x);
  const c = cashLine(x);
  if (all) {
    return (
      <>
        {c.what}
        <span class="hide-phone">
          {c.broker && ` · ${c.broker}`}
          {c.date && ` · ${c.date}`}
        </span>
      </>
    );
  }
  return labelled
    ? [c.broker, c.date].filter(Boolean).join(" · ") || c.what
    : holdingName(x);
}

export function holdingColumns(
  cols: ReturnType<typeof columnsFor>,
  sparks: Record<string, Close[]>,
  all = false,
  labelled = false,
): Column<Holding>[] {
  return [
    {
      key: "name",
      head: "Holding",
      wait: <SymbolWaiting />,
      width: {
        base: "minmax(0, 2.4fr)",
        tablet: "minmax(0, 2fr)",
        phone: "minmax(0, 1fr)",
      },
      cell: (x) => {
        const m = matured(x);
        return (
          <SymbolName
            ticker={holdingTicker(x)}
            name={
              m || x.stale.length > 0 ? (
                <>
                  {m ? (
                    <span class="tag tag-side pf-matured-tag">Matured</span>
                  ) : (
                    <span class="tag">{staleWords(x.stale.at(-1)!)}</span>
                  )}{" "}
                  {rowName(x, all, labelled)}
                </>
              ) : (
                rowName(x, all, labelled)
              )
            }
          />
        );
      },
    },
    {
      key: "spark",
      head: "3M",
      width: "104px",
      align: "end",
      headAlign: "start",
      hide: "tablet",
      show: cols.spark,
      cell: (x) => {
        const b = x.id ? sparks[x.id] : undefined;
        return b && b.length > 1 ? (
          <Spark closes={b.map((p) => p.close)} />
        ) : null;
      },
    },
    {
      key: "today",
      head: cols.priceHead,
      width: "minmax(0, 1.1fr)",
      align: "end",
      sortable: true,
      hide: "tablet",
      show: cols.price,
      cell: (x) => (
        <>
          <span class="num faint pf-price">{priceLine(x)}</span>
          {x.priced === "hand" ? (
            x.as_of && <Num class="small faint pf-price">{day(x.as_of)}</Num>
          ) : (
            <Change s={percent(x.change_percent)} class="small" />
          )}
        </>
      ),
    },
    {
      key: "value",
      head: "Value",
      width: { base: "minmax(0, 1.1fr)", phone: "88px" },
      align: "end",
      sortable: true,
      cell: (x) =>
        x.sold_today ? (
          // its value is gone; what it moved before the sale is left
          <Change s={signedMoney(x.day_change, x.currency)} class="amount" />
        ) : (
          <>
            <Num class="amount">
              {money(shownValue(x), x.converted?.currency ?? x.currency)}
            </Num>
            {x.converted && x.converted.currency !== x.currency && (
              <Num class="small faint amount">{money(x.value, x.currency)}</Num>
            )}
          </>
        ),
    },
    {
      key: "gain",
      head: "Gain",
      width: { base: "minmax(0, 0.9fr)", phone: "66px" },
      align: "end",
      sortable: true,
      show: cols.gain,
      cell: (x) => (
        <>
          <Change s={percent(shownGainPercent(x))} />
          <Change
            s={signedMoney(shownGain(x), null)}
            class="small amount hide-phone"
          />
        </>
      ),
    },
    {
      key: "weight",
      head: "Weight",
      width: "92px",
      align: "end",
      hide: "tablet",
      cell: (x) => {
        const w = shownWeight(x);
        return (
          <>
            <Num class="small">{w !== null ? `${w.toFixed(1)}%` : ""}</Num>
            <span class="pf-wbar">
              <i style={{ width: `${weightBar(w)}%` }} />
            </span>
          </>
        );
      },
    },
  ];
}

// browser storage is a convenience: a browser that keeps nothing shows all open
const storedShut = (): string | null => {
  try {
    return localStorage.getItem(SHUT_KEY);
  } catch {
    return null;
  }
};

function HoldingsCard({
  view,
  order,
  h,
  all,
  sparks,
  viewOnly,
  onTrade,
  onEdit,
}: {
  view: string;
  order: readonly string[];
  h: Holdings;
  all: boolean;
  sparks: Record<string, Close[]>;
  viewOnly: boolean;
  onTrade: (s: AddStart) => void;
  onEdit: (x: Holding, what: EditWhat) => void;
}) {
  const ccy = h.converted?.currency ?? h.totals[0]?.currency ?? null;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("value");
  const [dir, setDir] = useState<SortDir>("desc");
  const [shutText, setShutText] = useState(storedShut);
  const shut = shutOf(shutText, view);
  const listed = all ? h.holdings.filter((x) => !isReserve(x)) : h.holdings;
  const rows = listed.filter((x) => holdingMatches(x, q));
  const groups = groupsOf(rows, all, order);
  const flat = groups.length <= 1;
  const columns = holdingColumns(columnsFor(rows), sparks, all, !flat);
  const tableGroups: TableGroup<Holding>[] = groups.map((g) => {
    // a lone group has no label to open it again
    const closed = !flat && shut.has(g.key);
    return {
      key: g.key,
      label: flat ? undefined : (
        <GroupLabel
          label={g.key}
          count={g.rows.length}
          open={!closed}
          onToggle={() => {
            // read again so another view's change is kept
            const next = toggleShut(storedShut() ?? shutText, view, g.key);
            setShutText(next);
            try {
              localStorage.setItem(SHUT_KEY, next);
            } catch {}
          }}
          trail={
            // in two currencies with none to convert into, no sum
            mixed(h) ? undefined : (
              <>
                <span class="amount">{money(sums(g.rows).value, ccy)}</span>
                <span class="pf-gdot">·</span>
                <span class="faint">{groupShare(h, g.value)}</span>
              </>
            )
          }
        />
      ),
      rows: closed ? [] : sortRows(g.rows, sort, dir),
    };
  });
  return (
    <Card
      title="Holdings"
      count={rows.length}
      actions={
        <Search
          value={q}
          onChange={setQ}
          placeholder="Search holdings or brokers"
        />
      }
    >
      <Table
        label="Holdings"
        columns={columns}
        groups={tableGroups}
        rowKey={keyOf}
        rowAttrs={(x) => (matured(x) ? { class: "pf-matured" } : {})}
        sort={sort}
        dir={dir}
        onSort={(k, d) => {
          setSort(k as SortKey);
          setDir(d);
        }}
        open={(x) => {
          const page = pageOf(x);
          if (page) return { href: page };
          if (viewOnly) return null;
          const home = homeOf(x);
          return home ? { run: () => onEdit(x, home) } : null;
        }}
        rowLabel={holdingTicker}
        menu={
          viewOnly ? undefined : (x) => rowMenu(x, onTrade, (w) => onEdit(x, w))
        }
        menuLabel={(x) => `Actions for ${holdingTicker(x)}`}
        empty={
          listed.length === 0
            ? "Nothing held yet."
            : `No holding matches “${q}”.`
        }
      />
    </Card>
  );
}

const SHEET_TITLES: Record<EditWhat, string> = {
  edit: "Edit",
  price: "Set price",
  purchases: "Purchases",
};

// a holding with no instrument page: its edit, its price or its purchases
export function EditSheet({
  store,
  h,
  what,
  onDone,
}: {
  store: PortfolioStore;
  h: Holding;
  what: EditWhat;
  onDone: () => void;
}) {
  const asking = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const name = h.name ?? holdingTicker(h);
  const head = <SymbolName ticker={name} name={holdingName(h)} />;
  return (
    <Drawer title={SHEET_TITLES[what]} onClose={onDone} busy={busy.value} bare>
      {(close) =>
        what === "price" ? (
          <FundPriceEdit store={store} h={h} onDone={close} head={head} />
        ) : what === "purchases" ? (
          <div class="drawer-body">
            {head}
            <Purchases store={store} h={h} />
          </div>
        ) : asking.value ? (
          <>
            <div class="drawer-body">
              {head}
              <p>Remove {name}? Its amount stops counting in the totals.</p>
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
                  error.value = await store.removePosition(h.position!);
                  busy.value = false;
                  if (error.value === null) onDone();
                }}
              >
                {busy.value ? "Removing" : "Remove"}
              </button>
            </div>
          </>
        ) : (
          <PositionEdit
            drawer
            store={store}
            h={h}
            onDone={close}
            head={head}
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
        )
      }
    </Drawer>
  );
}

// a fund's trade names its fund by the ISIN in its id, as its Buy needs
function fundOf(store: PortfolioStore, t: TradeRow) {
  const isin = t.symbol.slice("fund:".length);
  const kept = store.overview.value?.funds?.find((f) => f.id === t.symbol);
  return { isin, name: t.name ?? isin, market: kept?.market ?? null };
}

// one order: what the list row cannot fit, and what can be done with it
export function TradeSheet({
  store,
  fills,
  all,
  viewOnly = false,
  onTrade,
  onDone,
}: {
  store: PortfolioStore;
  fills: TradeRow[];
  all: boolean;
  viewOnly?: boolean;
  onTrade: (s: AddStart) => void;
  onDone: () => void;
}) {
  const asking = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const t = fills[0]!;
  const reward = isReward(t);
  const live = fills.filter((x) => x.removed_at === null);
  const removed = live.length === 0;
  const o = orderOf(fills);
  const fund = isFundId(t.symbol);
  const title = sideWord(t);
  const ticker = tradeName(t);
  const name = fund ? "" : nameOf(t.name, null, t.symbol);
  const zone = store.overview.value?.time_zone;
  // on another's page a name is never the reader's "You", whoever shares it
  const self = viewOnly ? null : (markets.me.value?.name ?? null);
  const run = async (
    f: (id: number) => Promise<string | null>,
    ids: number[],
  ) => {
    busy.value = true;
    for (const id of ids) {
      error.value = await f(id);
      if (error.value !== null) break;
    }
    busy.value = false;
    asking.value = false;
  };
  return (
    <Drawer
      title={<span class={sideTag(t)}>{title}</span>}
      label={title}
      onClose={onDone}
      busy={busy.value}
      footStart={
        viewOnly ? undefined : removed ? (
          "Removed from the holdings."
        ) : asking.value ? (
          fills.length > 1 ? (
            `Remove all ${fills.length} fills?`
          ) : (
            "Remove this trade?"
          )
        ) : (
          <button
            type="button"
            class="btn btn-small btn-danger"
            onClick={() => {
              asking.value = true;
            }}
          >
            <Icon name="trash" size={14} /> Remove
          </button>
        )
      }
      foot={
        viewOnly ? undefined : removed ? (
          <button
            type="button"
            class="btn btn-small"
            disabled={busy.value}
            onClick={() =>
              void run(
                store.restoreTrade,
                fills.map((x) => x.id),
              )
            }
          >
            Restore
          </button>
        ) : asking.value ? (
          <>
            <button
              type="button"
              class="btn btn-small"
              onClick={() => {
                asking.value = false;
              }}
            >
              Keep
            </button>
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={busy.value}
              onClick={() =>
                void run(
                  store.removeTrade,
                  live.map((x) => x.id),
                )
              }
            >
              {busy.value ? "Removing" : "Remove"}
            </button>
          </>
        ) : (
          (["buy", "sell"] as const).map((side) => (
            <button
              key={side}
              type="button"
              class="btn btn-small"
              onClick={() =>
                onTrade({
                  symbol: t.symbol,
                  side,
                  ...(t.portfolio ? { portfolio: t.portfolio } : {}),
                  broker: t.broker,
                  ...(fund ? { fund: fundOf(store, t) } : {}),
                })
              }
            >
              {side === "buy" ? "Buy" : "Sell"}
            </button>
          ))
        )
      }
    >
      <Hero
        name={
          <SymbolName
            ticker={ticker}
            href={tradePage(t.symbol)}
            name={name !== "" && name !== ticker ? name : undefined}
          />
        }
        value={reward ? `+${quantity(o.quantity)}` : money(o.amount, null)}
        currency={reward ? undefined : t.currency}
        valueClass="amount"
        lines={removed ? [<span class="tag">Removed</span>] : undefined}
      />
      <Facts
        items={[
          { label: "Date", value: day(t.date) },
          {
            label: "Quantity",
            value: <span class="amount">{quantity(o.quantity)}</span>,
            num: true,
          },
          ...(reward
            ? []
            : [
                {
                  label: fills.length > 1 ? "Average price" : "Price",
                  value: (
                    <span class="amount">
                      {unitPrice(o.price, t.currency, t.unit)}
                    </span>
                  ),
                  num: true,
                },
              ]),
          ...(o.fees > 0
            ? [
                {
                  label: "Fees",
                  value: (
                    <span class="amount">{money(o.fees, t.currency)}</span>
                  ),
                  num: true,
                },
              ]
            : []),
          ...(t.broker ? [{ label: "Broker", value: t.broker }] : []),
          ...(all && t.portfolio
            ? [{ label: "Portfolio", value: t.portfolio }]
            : []),
          {
            label: "Added by",
            value: `${enteredBy(t.entered_by, self)}${
              t.entered_at ? ` · ${ownerDay(t.entered_at, zone)}` : ""
            }`,
          },
          ...(removed && t.removed_at
            ? [
                {
                  label: "Removed",
                  value: `${ownerDay(t.removed_at, zone)}${
                    t.removed_by ? ` · ${enteredBy(t.removed_by, self)}` : ""
                  }`,
                },
              ]
            : []),
        ]}
      />
      {t.note && !viewOnly && (
        <div>
          <div class="label">Note</div>
          <p class="faint pf-note">{t.note}</p>
        </div>
      )}
      {fills.length > 1 && (
        <div class="pf-trade-fills">
          <div class="label">{fills.length} fills</div>
          {fills.map((x) => (
            <div key={x.id} class="num small pf-trade-fill">
              <span class="amount">{quantity(x.quantity)}</span>
              <span class="faint amount">
                × {unitPrice(x.price, x.currency, x.unit)}
              </span>
              <span class="amount">{money(tradeAmount(x), x.currency)}</span>
            </div>
          ))}
        </div>
      )}
      {error.value && (
        <p class="error" role="alert">
          {error.value}
        </p>
      )}
    </Drawer>
  );
}

// ---- activity ----

export function Activity({
  trades,
  onOpen,
  removed: startRemoved = false,
}: {
  trades: TradeRow[];
  onOpen: (ids: number[]) => void;
  // opens on the removed trades
  removed?: boolean;
}) {
  const [q, setQ] = useState("");
  const [months, setMonths] = useState(3);
  const [removed, setRemoved] = useState(startRemoved);
  // a portfolio of cash alone has no trades: no card for nothing
  if (trades.length === 0) return null;
  const view = activityOf(trades, removed, q);
  const pick = (v: boolean) => {
    setRemoved(v);
    setMonths(3);
  };
  const columns: Column<TradeRow[]>[] = [
    {
      key: "date",
      head: "Date",
      width: "64px",
      hide: "tablet",
      cell: (f) => <span class="num faint">{day(f[0]!.date)}</span>,
    },
    {
      key: "side",
      width: { base: "64px", tablet: "60px" },
      cell: (f) => <span class={sideTag(f[0]!)}>{sideWord(f[0]!)}</span>,
    },
    {
      key: "holding",
      head: "Holding",
      width: { base: "minmax(0, 1.6fr)", tablet: "minmax(0, 1fr)" },
      cell: (f) => {
        const t = f[0]!;
        const o = orderOf(f);
        return (
          <SymbolName
            ticker={tradeName(t)}
            name={
              <>
                <span class="hide-tablet">
                  {isFundId(t.symbol) ? "Fund" : nameOf(t.name, null, t.symbol)}
                  {f.length > 1 ? ` · ${f.length} fills` : ""}
                </span>
                <span class="show-tablet">
                  {day(t.date)} ·{" "}
                  <span class="amount">
                    {quantity(o.quantity)}
                    {isReward(t)
                      ? ""
                      : ` × ${unitPrice(o.price, null, t.unit)}`}
                  </span>
                  {t.broker ? ` · ${t.broker}` : ""}
                </span>
              </>
            }
          />
        );
      },
    },
    {
      key: "broker",
      head: "Broker",
      width: "minmax(0, 0.8fr)",
      hide: "tablet",
      cell: (f) => <span class="cut faint">{f[0]!.broker ?? ""}</span>,
    },
    {
      key: "quantity",
      head: "Quantity",
      width: "minmax(0, 0.9fr)",
      align: "end",
      hide: "tablet",
      cell: (f) => <Num class="amount">{quantity(orderOf(f).quantity)}</Num>,
    },
    {
      key: "price",
      head: "Price",
      width: "minmax(0, 0.9fr)",
      align: "end",
      hide: "tablet",
      cell: (f) =>
        isReward(f[0]!) ? null : (
          <Num class="faint amount">
            {unitPrice(orderOf(f).price, f[0]!.currency, f[0]!.unit)}
          </Num>
        ),
    },
    {
      key: "amount",
      head: "Amount",
      width: { base: "minmax(0, 1fr)", tablet: "108px" },
      align: "end",
      cell: (f) =>
        isReward(f[0]!) ? null : (
          <Num class="amount">{money(orderOf(f).amount, f[0]!.currency)}</Num>
        ),
    },
  ];
  const groups: TableGroup<TradeRow[]>[] = view.months
    .slice(0, months)
    .map((m) => ({
      key: m.key,
      label: <PeriodLabel label={m.label} trail={m.trail} />,
      rows: m.rows,
    }));
  return (
    <Card
      title={removed ? "Removed trades" : "Activity"}
      count={view.count}
      actions={
        <Search value={q} onChange={setQ} placeholder="Search activity" />
      }
    >
      <Table
        label="Activity"
        dense
        columns={columns}
        groups={groups}
        rowKey={(f) => f[0]!.id}
        open={(f) => ({ run: () => onOpen(f.map((x) => x.id)) })}
        rowLabel={(f) =>
          `${sideWord(f[0]!)} ${tradeName(f[0]!)}, ${day(f[0]!.date)}`
        }
        empty={
          view.kept > 0
            ? "Nothing matches."
            : removed
              ? "No removed trades."
              : "No trades yet."
        }
      />
      {view.months.length > months && (
        <button
          type="button"
          class="btn-text faint pf-more"
          onClick={() => setMonths(months + 6)}
        >
          Show earlier months
        </button>
      )}
      {/* removed trades are rare: a link at the list's end, not a control
          in its head */}
      {removed ? (
        <button
          type="button"
          class="btn-text faint pf-more"
          onClick={() => pick(false)}
        >
          ← All activity
        </button>
      ) : (
        view.removed > 0 && (
          <button
            type="button"
            class="btn-text faint pf-more"
            onClick={() => pick(true)}
          >
            Removed trades · {view.removed}
          </button>
        )
      )}
    </Card>
  );
}
