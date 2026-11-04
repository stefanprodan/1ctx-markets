// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "preact/hooks";
import { symbolHref } from "../app/paths.ts";
import {
  type Board,
  type BoardItem,
  type BoardSection,
  type Earning,
  type Extended,
  type Listed,
  markets,
  type Spark as SparkData,
} from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { nameOf, symbolOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { amountsHidden, hiddenClass } from "../ui/Amounts.tsx";
import { Card, SectionHead } from "../ui/Card.tsx";
import { Change, Num } from "../ui/Figures.tsx";
import { MenuButton, type MenuItem } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Placeholder, WaitWords } from "../ui/Placeholder.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Spark } from "../ui/Spark.tsx";
import { SymbolName, SymbolWaiting } from "../ui/Symbol.tsx";
import { seedSearch } from "../ui/SymbolSearch.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  addRefusal,
  addSection,
  addTo,
  afterSave,
  bySort,
  type CardEntry,
  cardOf,
  crossedToday,
  DEFAULT_SORT,
  dropSection,
  type EarningRow,
  type Editing,
  type ExtMove,
  earningRows,
  editOf,
  entryOf,
  extMove,
  GLANCE_TABS,
  type GlanceTab,
  gapText,
  glanceCount,
  glanceTab,
  glanceTabs,
  idsOf,
  isSort,
  MAX_NAME,
  moversOf,
  moveTo,
  priceText,
  removeFrom,
  renameOf,
  type Side,
  type Sort,
  type SortKey,
  saveOf,
  shortName,
  sparkOf,
  swap,
  type Trend,
  tileColumns,
  trendsOf,
  waiting,
  wealthShown,
  withView,
} from "./Dashboard.model.ts";
import { wealthOf } from "./NetWorth.model.ts";
import { NetWorthPanel } from "./NetWorth.tsx";
import "./dashboard.css";
import "./portfolio-growth.css";

type Items = ReadonlyMap<string, BoardItem>;
type Save = (next: BoardSection[] | null) => Promise<void>;

// the viewer's own day, as the earnings were asked
function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// a per-viewer choice; a browser that keeps nothing still works
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const pctText = (p: number) => `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;

const MOVERS = 4;

function MoverList({
  label,
  rows,
  top,
  waiting,
}: {
  label: string;
  rows: readonly Listed[];
  top: number;
  waiting?: boolean;
}) {
  const columns: Column<Listed>[] = [
    {
      key: "name",
      width: "minmax(0, 1fr)",
      wait: <SymbolWaiting compact />,
      cell: (r) => (
        <SymbolName
          compact
          ticker={tickerOf(r.id, r.kind)}
          name={r.kind === "BOND" ? null : nameOf(shortName(r), r.kind, r.id)}
        />
      ),
    },
    {
      key: "bar",
      width: { base: "72px", phone: "48px" },
      cell: (r) => (
        <span
          class={`dash-bar ${r.change_percent! > 0 ? "up" : "down"}`}
          style={{ width: `${(Math.abs(r.change_percent!) / top) * 100}%` }}
          aria-hidden="true"
        />
      ),
    },
    {
      key: "pct",
      width: "72px",
      align: "end",
      cell: (r) => (
        <Change
          s={{
            text: pctText(r.change_percent!),
            dir: r.change_percent! > 0 ? 1 : -1,
          }}
        />
      ),
    },
  ];
  return (
    <div class="dash-movers-col">
      <h3 class="label dash-movers-label">{label}</h3>
      <Table
        label={label}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        open={(r) => ({ href: symbolHref(r.id) })}
        rowLabel={(r) => tickerOf(r.id, r.kind)}
        head={false}
        dense
        empty="None"
        waiting={waiting ? MOVERS : undefined}
      />
    </div>
  );
}

function Movers({
  ids,
  items,
  waiting,
}: {
  ids: readonly string[];
  items: Items;
  waiting?: boolean;
}) {
  const { up, down, top } = moversOf(ids, items);
  return (
    <div class="dash-movers">
      <MoverList label="Up" rows={up} top={top} waiting={waiting} />
      <MoverList label="Down" rows={down} top={top} waiting={waiting} />
    </div>
  );
}

const SORT_KEY = "markets-dashboard-trend-sort";
const AVERAGES: readonly (readonly [SortKey, string])[] = [
  ["sma50", "50SMA"],
  ["sma200", "200SMA"],
  ["wma200", "200WMA"],
];

function loadSort(): Sort {
  try {
    const v: unknown = JSON.parse(remembered(SORT_KEY) ?? "null");
    if (isSort(v)) return v;
  } catch {}
  return DEFAULT_SORT;
}

function Gap({ side, name }: { side: Side | null; name: string }) {
  if (side === null) return <span class="num faint">—</span>;
  const up = side.gap >= 0;
  return (
    <span
      class={`num ${up ? "up" : "down"}`}
      title={`${Math.abs(side.gap).toFixed(2)}% ${up ? "above" : "below"} its ${name}`}
    >
      {gapText(side.gap)}
    </span>
  );
}

// as many as Movers shows a side, so the tabs keep near one height
const SHOWN = MOVERS;

function Trends({ trends, waiting }: { trends: Trend[]; waiting?: boolean }) {
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<Sort>(loadSort);
  if (trends.length === 0 && !waiting) {
    return <Notice>No stock, ETF or coin among your favourites yet.</Notice>;
  }
  const sorted = [...trends].sort(bySort(sort));
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  const columns: Column<Trend>[] = [
    {
      key: "side",
      width: "16px",
      cell: (t) =>
        t.sma50 === null ? null : (
          <span
            class={`dash-arrow ${t.sma50.gap >= 0 ? "up" : "down"}`}
            role="img"
            aria-label={
              t.sma50.gap >= 0 ? "Above its 50SMA" : "Below its 50SMA"
            }
          >
            <Icon
              name={t.sma50.gap >= 0 ? "arrow-up" : "arrow-down"}
              size={14}
            />
          </span>
        ),
    },
    {
      key: "name",
      head: "Instrument",
      width: { base: "minmax(0, 2fr)", phone: "minmax(0, 1fr)" },
      wait: <SymbolWaiting />,
      cell: (t) => (
        <SymbolName
          ticker={
            <>
              {tickerOf(t.id)}
              {crossedToday(t) && (
                <span class="tag dash-crossed hide-phone">Crossed today</span>
              )}
            </>
          }
          name={nameOf(t.name, null, t.id)}
        />
      ),
    },
    {
      key: "price",
      head: "Price",
      width: "minmax(0, 1fr)",
      align: "end",
      hide: "phone",
      cell: (t) => <Num>{priceText(t.price)}</Num>,
    },
    ...AVERAGES.map(
      ([key, label]): Column<Trend> => ({
        key,
        head: label,
        width: { base: "minmax(0, 1fr)", phone: "60px" },
        align: "end",
        sortable: true,
        sortFirst: "asc",
        sortTitle: (on, dir) =>
          !on
            ? `Sort by ${label}`
            : dir === "asc"
              ? "Furthest below first"
              : "Furthest above first",
        cell: (t) => <Gap side={t[key]} name={label} />,
      }),
    ),
  ];
  return (
    <>
      <Table
        label="Trend"
        columns={columns}
        rows={shown}
        rowKey={(t) => t.id}
        open={(t) => ({ href: symbolHref(t.id) })}
        rowLabel={(t) => tickerOf(t.id)}
        sort={sort.key}
        dir={sort.dir === 1 ? "asc" : "desc"}
        onSort={(key, dir) => {
          const next: Sort = {
            key: key as SortKey,
            dir: dir === "asc" ? 1 : -1,
          };
          setSort(next);
          remember(SORT_KEY, JSON.stringify(next));
        }}
        dense
        waiting={waiting ? MOVERS : undefined}
      />
      {sorted.length > SHOWN && (
        <button
          type="button"
          class="btn-text dash-more"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </>
  );
}

const EARNING_COLUMNS: Column<EarningRow>[] = [
  {
    key: "day",
    head: "Day",
    width: { base: "minmax(0, 1fr)", phone: "88px" },
    cell: (e) => <span class={e.today ? undefined : "faint"}>{e.day}</span>,
  },
  {
    key: "name",
    head: "Instrument",
    width: { base: "minmax(0, 1.6fr)", phone: "minmax(0, 1fr)" },
    wait: <SymbolWaiting />,
    cell: (e) => <SymbolName ticker={e.symbol} name={e.name} />,
  },
  {
    key: "time",
    head: "Time",
    width: { base: "minmax(0, 1.2fr)", phone: "72px" },
    cell: (e) => <span class="faint">{e.time}</span>,
  },
  {
    key: "eps",
    head: "EPS est.",
    width: "minmax(0, 1fr)",
    align: "end",
    hide: "phone",
    cell: (e) => <Num>{e.eps}</Num>,
  },
  {
    key: "revenue",
    head: "Revenue est.",
    width: "minmax(0, 1fr)",
    align: "end",
    hide: "phone",
    cell: (e) => <Num>{e.revenue}</Num>,
  },
];

export function Earnings({
  earnings,
  off,
  waiting,
}: {
  earnings: readonly Earning[];
  off: boolean;
  waiting?: boolean;
}) {
  if (waiting) {
    return (
      <Table
        label="Earnings this week"
        columns={EARNING_COLUMNS}
        rowKey={(e) => e.id + e.day}
        dense
        waiting={MOVERS}
      />
    );
  }
  if (earnings.length === 0 && off) {
    return <Notice>Earnings are not available.</Notice>;
  }
  if (earnings.length === 0) {
    return <Notice>None of your stocks reports in the next seven days.</Notice>;
  }
  return (
    <Table
      label="Earnings this week"
      columns={EARNING_COLUMNS}
      rows={earningRows(earnings, today())}
      rowKey={(e) => e.id + e.day}
      open={(e) => ({ href: symbolHref(e.id) })}
      rowLabel={(e) => e.symbol}
      dense
    />
  );
}

const TAB_KEY = "markets-dashboard-tab";
// whether the last answer had Wealth, so a Home without it never draws
// its loader first: a yes or no, never an amount
const WEALTH_KEY = "markets-dashboard-wealth";
const WORDS = new Map(GLANCE_TABS);

export function Glance({
  ids,
  items,
  earnings,
  off = false,
  waiting,
}: {
  ids: readonly string[];
  items: Items;
  earnings: readonly Earning[];
  off?: boolean;
  waiting?: boolean;
}) {
  const store = markets.portfolios;
  const known = wealthOf(store.worth.value);
  const [stored] = useState(() => remembered(WEALTH_KEY));
  const wealth = wealthShown(known, stored);
  useEffect(() => {
    void store.loadWorth();
  }, []);
  useEffect(() => {
    if (known !== null) remember(WEALTH_KEY, known ? "1" : "0");
  }, [known]);
  const [picked, setPicked] = useState<string | null>(() =>
    remembered(TAB_KEY),
  );
  const tab = glanceTab(picked, wealth);
  const trends = trendsOf(ids, items);
  const crossed = trends.filter(crossedToday).length;
  const pick = (t: GlanceTab) => {
    setPicked(t);
    remember(TAB_KEY, t);
  };
  // as Portfolios: the tabs on the page, each tab's content bare under them
  return (
    <div class="dash-glance">
      <Tabs
        label="At a glance"
        value={tab}
        onPick={pick}
        tabs={glanceTabs(wealth).map((t) => ({
          key: t,
          label: WORDS.get(t)!,
          count: glanceCount(t, {
            waiting: waiting === true,
            earnings: earnings.length,
            crossed,
          }),
        }))}
      />
      {tab === "worth" ? (
        <div role="tabpanel" class={hiddenClass(amountsHidden.value)}>
          <NetWorthPanel />
        </div>
      ) : (
        <div role="tabpanel" class="dash-panel">
          {tab === "movers" ? (
            <Movers ids={ids} items={items} waiting={waiting} />
          ) : tab === "trend" ? (
            <Trends trends={trends} waiting={waiting} />
          ) : (
            <Earnings earnings={earnings} off={off} waiting={waiting} />
          )}
        </div>
      )}
    </div>
  );
}

type Seeding = NonNullable<Board["track"]>;

const SEED_CLASS = {
  ready: "tag status-done",
  pending: "tag dash-seed-pending",
} as const;

export function LoadingPanel({ track }: { track: Seeding }) {
  const total = track.length;
  const ready = track.filter((t) => t.state === "ready").length;
  return (
    <Notice
      title={
        <>
          <span class="spinner dash-seed-spin" aria-hidden="true" />
          Getting prices{" "}
          <span class="num faint" role="status">
            {ready} of {total}
          </span>
        </>
      }
      actions={track.map((t) => (
        <span key={t.value} class={SEED_CLASS[t.state]}>
          {t.value}
        </span>
      ))}
    >
      The first time, the server fetches each market's price history. This can
      take a minute.
    </Notice>
  );
}

// while a value is first fetched, the page asks again sooner than its minute
const WAITING_MS = 3_000;

// examples to try, not defaults: nothing is added until the admin picks it
const EXAMPLES: readonly (readonly [string, string])[] = [
  ["^GSPC", "S&P 500"],
  ["AAPL", "Apple"],
  ["VWCE.DE", "Vanguard FTSE All-World"],
  ["BTC-USD", "Bitcoin"],
  ["GC=F", "Gold"],
];

function EmptyPanel() {
  return (
    <Notice
      icon="star"
      title="Build your dashboard"
      actions={
        <>
          <span class="label">Try</span>
          {EXAMPLES.map(([q, name]) => (
            <button
              key={q}
              type="button"
              class="chip"
              title={name}
              onClick={(e) => {
                // the search closes on a click outside it, this one included
                e.stopPropagation();
                seedSearch(q);
              }}
            >
              {q}
            </button>
          ))}
        </>
      }
    >
      Search for a stock, ETF, coin, index or currency and add it. Prices, day
      lines, movers, trends and earnings appear as soon as you do.
    </Notice>
  );
}
type Drag = { from: number; id: string } | null;

const TILE_LINE = 36;
const ROW_LINE = 28;

function Line({
  spark,
  height,
  waiting,
}: {
  spark: SparkData | undefined;
  height: number;
  waiting?: boolean;
}) {
  const s = sparkOf(spark);
  return (
    <Spark
      closes={s?.closes ?? []}
      base={s?.base ?? "start"}
      slots={s?.slots}
      width="fluid"
      height={height}
      waiting={waiting && spark === undefined}
    />
  );
}

const Sun = () => (
  <svg
    class="dash-sun"
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
  </svg>
);

const Moon = () => (
  <svg
    class="dash-moon"
    width="13"
    height="13"
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <path
      fill="currentColor"
      d="M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z"
    />
  </svg>
);

function Ext({ move }: { move: ExtMove | null }) {
  if (move === null) return null;
  return (
    <span class="small dash-ext" title={move.title}>
      {move.session === "pre" ? <Sun /> : <Moon />}
      <span class="dash-ext-word">
        {move.session === "pre" ? "Pre-market" : "After hours"}
      </span>
      <Change s={move.change} />
    </span>
  );
}

function StateOrExt({ move, state }: { move: ExtMove | null; state: string }) {
  if (move !== null) return <Ext move={move} />;
  return state ? <span class="small faint dash-state">{state}</span> : null;
}

// a value still on its way keeps the tile's shape, so nothing moves
// when its figures land
export function Tile({
  entry,
  spark,
  waiting,
  move = null,
}: {
  entry: CardEntry;
  spark: SparkData | undefined;
  waiting?: boolean;
  move?: ExtMove | null;
}) {
  const c = cardOf(entry);
  if (c.type === "pending") {
    return (
      <div class="card dash-tile dash-tile-pending">
        <SymbolName ticker={c.value} name="Pending" />
        <Line spark={undefined} height={TILE_LINE} />
        <Num class="faint">—</Num>
      </div>
    );
  }
  if (c.type === "failed") {
    const body = (
      <>
        <SymbolName
          ticker={c.value}
          name={<span class="error">{c.text}</span>}
        />
        <Line spark={undefined} height={TILE_LINE} />
        <Num class={c.price === undefined ? "faint" : undefined}>
          {c.price ?? "—"}
        </Num>
      </>
    );
    return c.href !== undefined ? (
      <a class="card dash-tile" href={c.href}>
        {body}
      </a>
    ) : (
      <div class="card dash-tile">{body}</div>
    );
  }
  return (
    <a class="card dash-tile" href={c.href}>
      <div class="dash-tile-top">
        <SymbolName ticker={c.symbol} name={c.name} />
        <StateOrExt move={move} state={c.state} />
      </div>
      <Line spark={spark} height={TILE_LINE} waiting={waiting} />
      <div class="dash-tile-figs">
        <Num currency={c.currency}>{c.price}</Num>
        <Change s={{ text: c.percent, dir: c.dir }} class="small" />
      </div>
    </a>
  );
}

function NameInput({
  layout,
  index,
  save,
}: {
  layout: readonly BoardSection[];
  index: number;
  save: Save;
}) {
  const name = layout[index]!.name;
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const r = renameOf(layout, index, draft);
    if (r !== null && "next" in r) {
      setError(null);
      void save(r.next);
      return;
    }
    setDraft(name);
    setError(r === null ? null : r.error);
  };
  return (
    <span class="field dash-name">
      <input
        value={draft}
        aria-label="Section name"
        maxLength={MAX_NAME}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(name);
        }}
      />
      {error !== null && (
        <span class="error small" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

type Entry = {
  id: string;
  entry: CardEntry;
  // whose line it draws: a flipped index draws its futures'
  line: string;
  card: ReturnType<typeof cardOf>;
  spark: SparkData | undefined;
  move: ExtMove | null;
};

const VIEWS = [
  {
    value: "cards" as const,
    text: <Icon name="grid" size={13} />,
    title: "Cards",
  },
  {
    value: "table" as const,
    text: <Icon name="rows" size={13} />,
    title: "Table",
  },
];

// a section's ⋯ while editing: no move past either end
export function sectionTools(
  layout: readonly BoardSection[],
  index: number,
  save: Save,
): MenuItem[] {
  const count = layout.length;
  return [
    ...(index > 0
      ? [
          {
            label: "Move up",
            icon: "arrow-up" as const,
            run: () => void save(swap(layout, index, index - 1)),
          },
        ]
      : []),
    ...(index < count - 1
      ? [
          {
            label: "Move down",
            icon: "arrow-down" as const,
            run: () => void save(swap(layout, index, index + 1)),
          },
        ]
      : []),
    {
      label: "Delete section",
      icon: "trash",
      danger: true,
      run: () => void save(dropSection(layout, index)),
    },
  ];
}

export function SectionView({
  index,
  layout,
  editing,
  items,
  sparks,
  lining = new Set(),
  extended = new Map(),
  slow = false,
  drag,
  setDrag,
  save,
  locked,
}: {
  index: number;
  layout: readonly BoardSection[];
  editing: boolean;
  // nothing is saved while the seed is still filling
  locked: boolean;
  items: Items;
  sparks: ReadonlyMap<string, SparkData>;
  lining?: ReadonlySet<string>;
  extended?: ReadonlyMap<string, Extended>;
  slow?: boolean;
  drag: Drag;
  setDrag: (d: Drag) => void;
  save: Save;
}) {
  const section = layout[index]!;
  const [over, setOver] = useState<string | null>(null);
  const move = (before: string | null) => {
    if (drag === null) return;
    void save(moveTo(layout, drag.from, drag.id, index, before));
    setDrag(null);
    setOver(null);
  };
  const dragOf = (id: string) => {
    if (!editing) return { class: "dash-item" };
    return {
      class: `dash-item${over === id && drag?.id !== id ? " dash-item-over" : ""}${drag?.id === id ? " dash-item-dragging" : ""}`,
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer?.setData("text/plain", id);
        setDrag({ from: index, id });
      },
      onDragEnd: () => {
        setDrag(null);
        setOver(null);
      },
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(id);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        move(id);
      },
    };
  };
  const remove = (id: string) => (
    <button
      type="button"
      class="btn-icon dash-remove table-raise"
      title="Remove"
      aria-label={`Remove ${symbolOf(id)}`}
      onClick={(e) => {
        e.preventDefault();
        void save(removeFrom(layout, index, id));
      }}
    >
      <Icon name="close" size={14} />
    </button>
  );
  const lines: Entry[] = section.ids.map((id) => {
    const item = items.get(id);
    const entry = entryOf(id, item);
    const line = entry.id ?? id;
    return {
      id,
      entry,
      line,
      card: cardOf(entry),
      spark: sparks.get(line),
      // a move kept from before the open, by a failed refresh, is not shown
      move:
        item?.session?.state === "open" || item?.futures !== undefined
          ? null
          : extMove(extended.get(id), item?.instrument ?? null, Date.now()),
    };
  });
  const columns: Column<Entry>[] = [
    {
      key: "name",
      head: "Instrument",
      width: { base: "minmax(0, 2.2fr)", phone: "minmax(0, 1fr)" },
      cell: (l) => {
        const name =
          l.card.type === "ready" ? (
            <SymbolName
              ticker={
                l.move === null ? (
                  l.card.symbol
                ) : (
                  <span class="dash-ticker">
                    {l.card.symbol}
                    <span class="show-phone">
                      <Ext move={l.move} />
                    </span>
                  </span>
                )
              }
              name={l.card.name}
            />
          ) : (
            <SymbolName ticker={symbolOf(l.id)} />
          );
        if (!editing) return name;
        return (
          <div class="dash-grab">
            <Icon name="grip" size={14} class="faint" />
            {name}
          </div>
        );
      },
    },
    {
      key: "line",
      head: "Day",
      width: { base: "minmax(80px, 1fr)", phone: "72px" },
      cell: (l) =>
        l.card.type === "ready" ? (
          <Line
            spark={l.spark}
            height={ROW_LINE}
            waiting={lining.has(l.line)}
          />
        ) : null,
    },
    {
      key: "price",
      head: "Price",
      width: { base: "minmax(0, 1.2fr)", phone: "112px" },
      align: "end",
      cell: (l) =>
        l.card.type === "ready" ? (
          <>
            <Num currency={l.card.currency}>{l.card.price}</Num>
            <span class="show-phone dash-phone-moves">
              <Change s={{ text: l.card.percent, dir: l.card.dir }} />
            </span>
          </>
        ) : (
          <span class="small faint">Loading</span>
        ),
    },
    {
      key: "change",
      head: "Change",
      width: "minmax(0, 1.2fr)",
      align: "end",
      hide: "phone",
      cell: (l) =>
        l.card.type === "ready" ? (
          <>
            <Change s={{ text: l.card.percent, dir: l.card.dir }} />
            <Change s={{ text: l.card.move, dir: l.card.dir }} class="small" />
          </>
        ) : null,
    },
    {
      key: "state",
      head: "Market",
      width: "88px",
      align: "end",
      hide: "phone",
      cell: (l) =>
        l.card.type === "ready" ? (
          <StateOrExt move={l.move} state={l.card.state} />
        ) : null,
    },
    {
      key: "remove",
      width: "32px",
      align: "end",
      show: editing,
      cell: (l) => remove(l.id),
    },
  ];
  const n = section.ids.length;
  return (
    <section
      class={`dash-section${editing ? " dash-editing" : ""}`}
      aria-label={section.name}
      onDragOver={(e) => editing && e.preventDefault()}
      onDrop={(e) => {
        if (!editing) return;
        e.preventDefault();
        move(null);
      }}
    >
      <SectionHead
        title={
          editing ? (
            <NameInput layout={layout} index={index} save={save} />
          ) : (
            section.name
          )
        }
        count={n}
        note={
          <WaitWords show={slow && lines.some((l) => lining.has(l.line))}>
            Loading charts
          </WaitWords>
        }
        actions={
          (!locked || editing) && (
            <div class="dash-section-tools">
              {!locked && (
                <Segmented
                  label="Show as"
                  small
                  options={VIEWS}
                  value={section.view}
                  onPick={(v) => void save(withView(layout, index, v))}
                />
              )}
              {/* a phone picks the view only; editing stays on wider screens */}
              {editing && (
                <span class="hide-phone">
                  <MenuButton
                    label={`Edit ${section.name}`}
                    items={sectionTools(layout, index, save)}
                  />
                </span>
              )}
            </div>
          )
        }
      />
      {n === 0 ? (
        <Notice>
          {editing
            ? "Drag symbols here, or add them from search."
            : "Empty. Add symbols from search."}
        </Notice>
      ) : section.view === "cards" ? (
        <div
          class="dash-tiles"
          style={{
            "--tiles": tileColumns(n, 4),
            "--tiles-tablet": tileColumns(n, 3),
            "--tiles-phone": tileColumns(n, 2),
          }}
        >
          {lines.map((l) => (
            <div key={l.id} {...dragOf(l.id)}>
              <Tile
                entry={l.entry}
                spark={l.spark}
                waiting={lining.has(l.line)}
                move={l.move}
              />
              {editing && remove(l.id)}
            </div>
          ))}
        </div>
      ) : (
        <Card flush>
          <Table
            label={section.name}
            columns={columns}
            rows={lines}
            rowKey={(l) => l.id}
            rowAttrs={editing ? (l) => dragOf(l.id) : undefined}
            open={(l) => (editing ? null : { href: symbolHref(l.line) })}
            rowLabel={(l) => symbolOf(l.line)}
            dense
          />
        </Card>
      )}
    </section>
  );
}

function TileWaiting() {
  return (
    <div class="card dash-tile" aria-hidden="true">
      <div class="dash-tile-top">
        <SymbolWaiting />
      </div>
      <Line spark={undefined} height={TILE_LINE} waiting />
      <div class="dash-tile-figs">
        <Placeholder chars={9} />
        <Placeholder chars={6} />
      </div>
    </div>
  );
}

const WAITING_TILES = 4;

export function HomeWaiting({ slow }: { slow: boolean }) {
  return (
    <>
      <Glance ids={[]} items={new Map()} earnings={[]} waiting />
      <section class="dash-section">
        <SectionHead
          title={<Placeholder chars={9} />}
          note={<WaitWords show={slow}>Loading prices</WaitWords>}
        />
        <div
          class="dash-tiles"
          style={{
            "--tiles": tileColumns(WAITING_TILES, 4),
            "--tiles-tablet": tileColumns(WAITING_TILES, 3),
            "--tiles-phone": tileColumns(WAITING_TILES, 2),
          }}
        >
          {Array.from({ length: WAITING_TILES }, (_, i) => (
            <TileWaiting key={i} />
          ))}
        </div>
      </section>
    </>
  );
}

// an edit that changes nothing sends nothing
const save: Save = async (next) => {
  if (next !== null) await markets.saveLayout(next);
};

export function Dashboard() {
  useRefresh(markets.loadDashboard);
  const layout = markets.layout.value;
  const items = markets.items.value;
  // edits stay on the page until Save sends them in one write
  const [edit, setEdit] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const draft = edit?.draft ?? null;
  const editing = edit !== null;
  const [drag, setDrag] = useState<Drag>(null);
  const shown = draft ?? layout;
  const stage: Save = (next) => {
    if (next !== null) setEdit((e) => (e === null ? e : { ...e, draft: next }));
    return Promise.resolve();
  };
  // a failed save keeps the draft, so it can be tried again or dropped
  const saveEdit = async (e: Editing) => {
    const s = saveOf(e);
    if (s === null) {
      setEdit(null);
      return;
    }
    setSaving(true);
    const end = await markets.saveLayout(s.next, s.revision);
    setSaving(false);
    setEdit((cur) => afterSave(cur, e, end));
  };
  const ids = layout === null ? [] : idsOf(layout);
  const seeding = markets.seeding.value;
  const locked = waiting(seeding);
  useEffect(() => {
    if (!locked) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void markets.loadDashboard();
      }
    }, WAITING_MS);
    return () => clearInterval(timer);
  }, [locked]);
  return (
    <Page
      title="Home"
      brand
      search={
        layout !== null &&
        !locked &&
        !editing && {
          sections: layout,
          onAdd: (section, id) =>
            save(addTo(markets.layout.value ?? [], section, id)),
          refuse: (section, id) =>
            addRefusal(markets.layout.value ?? [], section, id),
        }
      }
      actions={
        layout !== null &&
        !locked &&
        (editing ? (
          <>
            <button
              type="button"
              class="btn"
              disabled={saving}
              onClick={() => setEdit(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              disabled={saving}
              onClick={() => void saveEdit(edit)}
            >
              Save
            </button>
          </>
        ) : (
          <button
            type="button"
            class="btn-icon hide-phone"
            title="Edit"
            aria-label="Edit"
            onClick={() => setEdit(editOf(layout, markets.revision()))}
          >
            <Icon name="pencil" size={14} />
          </button>
        ))
      }
      error={markets.saveError.value}
      stale={layout === null ? null : markets.homeError.value}
      staleCount={markets.homeFailures.value}
      failed={didNotLoad(
        layout !== null,
        markets.homeError.value,
        markets.homeCode.value,
        () => void markets.loadDashboard(),
      )}
      foot={markets.attribution.value ?? undefined}
    >
      {layout === null ? (
        <HomeWaiting slow={markets.homeSlow.value} />
      ) : (
        <>
          {locked ? (
            <LoadingPanel track={seeding!} />
          ) : ids.length === 0 ? (
            <EmptyPanel />
          ) : (
            <Glance
              ids={ids}
              items={items}
              earnings={markets.earnings.value}
              off={markets.earningsOff.value}
            />
          )}
          {shown!.map((_, i) => (
            <SectionView
              key={i}
              index={i}
              layout={shown!}
              editing={editing && !locked}
              items={items}
              sparks={markets.sparks.value}
              lining={markets.lining.value}
              extended={markets.extended.value}
              slow={markets.linesSlow.value}
              drag={drag}
              setDrag={setDrag}
              save={editing ? stage : save}
              locked={locked}
            />
          ))}
          {editing && !locked && (
            <div class="dash-edit-foot">
              <button
                type="button"
                class="btn"
                onClick={() => void stage(addSection(draft!))}
              >
                <Icon name="plus" size={14} /> Add section
              </button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
