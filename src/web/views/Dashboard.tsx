// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  type Board,
  type BoardItem,
  type BoardSection,
  type Candidate,
  type Earning,
  type Listed,
  markets,
  type Spark,
} from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { didNotLoad, Page } from "../ui/Page.tsx";
import {
  addRefusal,
  addSection,
  addTo,
  afterSave,
  bySort,
  clipOf,
  crossedToday,
  DEFAULT_SORT,
  dropSection,
  type Editing,
  earningRows,
  editOf,
  entryOf,
  escapeFrom,
  gapText,
  idsOf,
  isSort,
  MAX_NAME,
  moversOf,
  moveTo,
  nextSort,
  priceText,
  removeFrom,
  renameOf,
  type Side,
  type Sort,
  type SortKey,
  saveOf,
  searcher,
  shortName,
  swap,
  type Trend,
  trendsOf,
  waiting,
  withView,
} from "./Dashboard.model.ts";
import { cardOf, sparkOf } from "./Home.model.ts";
import { Card, Sparkline } from "./Home.tsx";
import { kindOf, symbolOf } from "./Instruments.model.ts";
import "./home.css";
import "./dashboard.css";

type Items = ReadonlyMap<string, BoardItem>;
type Save = (next: BoardSection[] | null) => Promise<void>;

const hrefOf = (id: string) => `/instruments/${encodeURIComponent(id)}`;

const tone = (dir: -1 | 0 | 1) =>
  dir > 0 ? " home-up" : dir < 0 ? " home-down" : "";

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

function Movers({ ids, items }: { ids: readonly string[]; items: Items }) {
  const { up, down, top } = moversOf(ids, items);
  const line = (r: Listed) => (
    <a key={r.id} class="dash-mover" href={hrefOf(r.id)}>
      <span class="dash-mover-name cut">
        {r.kind !== "BOND" && (
          <span class="dash-mover-label">{shortName(r)}</span>
        )}
        <span
          class={`dash-mover-symbol${r.kind === "BOND" ? " dash-mover-only" : ""}`}
        >
          {symbolOf(r.id)}
        </span>
      </span>
      <span class="dash-mover-bar" aria-hidden="true">
        <span
          class={r.change_percent! > 0 ? "dash-bar-up" : "dash-bar-down"}
          style={{ width: `${(Math.abs(r.change_percent!) / top) * 100}%` }}
        />
      </span>
      <span
        class={`dash-mover-pct${r.change_percent! > 0 ? " home-up" : " home-down"}`}
      >
        {r.change_percent! > 0 ? "+" : "−"}
        {Math.abs(r.change_percent!).toFixed(2)}%
      </span>
    </a>
  );
  return (
    <div class="dash-movers">
      <div class="dash-movers-col">
        <span class="label">Up</span>
        {up.length === 0 ? <span class="dash-none">None</span> : up.map(line)}
      </div>
      <div class="dash-movers-col">
        <span class="label">Down</span>
        {down.length === 0 ? (
          <span class="dash-none">None</span>
        ) : (
          down.map(line)
        )}
      </div>
    </div>
  );
}

const SORT_KEY = "markets-dashboard-trend-sort";
const COLUMNS: readonly (readonly [SortKey, string])[] = [
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
  if (side === null) return <span class="dash-cell-num dash-faint">—</span>;
  const up = side.gap >= 0;
  return (
    <span
      class={`dash-cell-num dash-mono${up ? " home-up" : " home-down"}`}
      title={`${Math.abs(side.gap).toFixed(2)}% ${up ? "above" : "below"} its ${name}`}
    >
      {gapText(side.gap)}
    </span>
  );
}

const SHOWN = 8;

function Trends({ trends }: { trends: Trend[] }) {
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState<Sort>(loadSort);
  const pick = (key: SortKey) => {
    const next = nextSort(sort, key);
    setSort(next);
    remember(SORT_KEY, JSON.stringify(next));
  };
  if (trends.length === 0) {
    return (
      <span class="dash-none">
        No stock, ETF or coin among your favourites yet.
      </span>
    );
  }
  const sorted = [...trends].sort(bySort(sort));
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  return (
    <div class="dash-trend">
      <div class="dash-trend-head label">
        <span />
        <span>Ticker</span>
        <span class="dash-cell-num">Price</span>
        {COLUMNS.map(([key, label]) => {
          const on = sort.key === key;
          return (
            <button
              key={key}
              type="button"
              class={`dash-sort${on ? " dash-sort-on" : ""}`}
              aria-pressed={on}
              title={
                !on
                  ? `Sort by ${label}`
                  : sort.dir === 1
                    ? "Furthest below first"
                    : "Furthest above first"
              }
              onClick={() => pick(key)}
            >
              {on && (
                <Icon
                  name={sort.dir === 1 ? "arrow-up" : "arrow-down"}
                  size={11}
                />
              )}
              {label}
            </button>
          );
        })}
      </div>
      {shown.map((t) => (
        <a
          key={t.id}
          class="dash-trend-row"
          title={t.name ?? undefined}
          href={hrefOf(t.id)}
        >
          {t.sma50 === null ? (
            <span />
          ) : (
            <span
              class={`dash-cross-arrow${t.sma50.gap >= 0 ? " home-up" : " home-down"}`}
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
          )}
          <span class="dash-ticker">
            {symbolOf(t.id)}
            {crossedToday(t) && <span class="dash-crossed">Crossed today</span>}
          </span>
          <span class="dash-cell-num dash-mono">{priceText(t.price)}</span>
          <Gap side={t.sma50} name="50SMA" />
          <Gap side={t.sma200} name="200SMA" />
          <Gap side={t.wma200} name="200WMA" />
        </a>
      ))}
      {sorted.length > SHOWN && (
        <button
          type="button"
          class="btn-text dash-more"
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

export function Earnings({
  earnings,
  off,
}: {
  earnings: readonly Earning[];
  off: boolean;
}) {
  if (earnings.length === 0 && off) {
    return <span class="dash-none">Earnings are not available.</span>;
  }
  if (earnings.length === 0) {
    return (
      <span class="dash-none">
        None of your stocks reports in the next seven days.
      </span>
    );
  }
  return (
    <div class="dash-earn">
      <div class="dash-earn-head label">
        <span>Day</span>
        <span>Ticker</span>
        <span>Time</span>
        <span class="dash-cell-num">EPS est.</span>
        <span class="dash-cell-num">Revenue est.</span>
      </div>
      {earningRows(earnings, today()).map((e) => (
        <a
          key={e.id + e.day}
          class="dash-earn-row"
          href={hrefOf(e.id)}
          title={e.name ?? undefined}
        >
          <span class={`dash-day${e.today ? " dash-today" : ""}`}>{e.day}</span>
          <span class="dash-ticker">{e.symbol}</span>
          <span class="dash-earn-time">{e.time}</span>
          <span class="dash-cell-num dash-mono">{e.eps}</span>
          <span class="dash-cell-num dash-mono">{e.revenue}</span>
        </a>
      ))}
    </div>
  );
}

type Tab = "movers" | "trend" | "earnings";
const TAB_KEY = "markets-dashboard-tab";
const TABS: readonly (readonly [Tab, string, string])[] = [
  ["movers", "Today's movers", "Movers"],
  ["trend", "Trend", "Trend"],
  ["earnings", "Earnings this week", "Earnings"],
];

export function Glance({
  ids,
  items,
  earnings,
  off = false,
}: {
  ids: readonly string[];
  items: Items;
  earnings: readonly Earning[];
  off?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = remembered(TAB_KEY);
    return t === "earnings" || t === "trend" ? t : "movers";
  });
  const trends = trendsOf(ids, items);
  const crossed = trends.filter(crossedToday).length;
  const pick = (t: Tab) => {
    setTab(t);
    remember(TAB_KEY, t);
  };
  return (
    <section class="card dash-widget">
      <div class="dash-tabs" role="tablist">
        {TABS.map(([t, label, short]) => {
          const n =
            t === "earnings"
              ? earnings.length === 0 && off
                ? null
                : earnings.length
              : t === "trend" && crossed > 0
                ? crossed
                : null;
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              class={`dash-tab${tab === t ? " dash-tab-on" : ""}`}
              onClick={() => pick(t)}
            >
              <span class="dash-tab-long">{label}</span>
              <span class="dash-tab-short">{short}</span>
              {n !== null && (
                <span
                  class={`dash-tab-count${n === 0 ? " dash-tab-zero" : ""}`}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">
        {tab === "movers" ? (
          <Movers ids={ids} items={items} />
        ) : tab === "trend" ? (
          <Trends trends={trends} />
        ) : (
          <Earnings earnings={earnings} off={off} />
        )}
      </div>
    </section>
  );
}

type Seeding = NonNullable<Board["track"]>;

export function LoadingPanel({ track }: { track: Seeding }) {
  const total = track.length;
  const ready = track.filter((t) => t.state === "ready").length;
  return (
    <section class="card home-panel home-loading">
      <div class="home-loading-head">
        <span class="home-spinner" aria-hidden="true" />
        <h2 class="home-panel-title">Getting prices</h2>
        <span class="home-loading-count" role="status">
          {ready} of {total}
        </span>
      </div>
      <div class="home-progress" aria-hidden="true">
        <div style={{ width: `${(ready / total) * 100}%` }} />
      </div>
      <ul class="home-legend">
        {track.map((t) => (
          <li key={t.value} class={`home-chip-${t.state}`}>
            <span class="home-legend-symbol">{t.value}</span>
          </li>
        ))}
      </ul>
      <p class="home-panel-note">
        The first time, the server fetches each market's price history. This can
        take a minute.
      </p>
    </section>
  );
}

// while a value is first fetched, the page asks again sooner than its minute
const WAITING_MS = 3_000;

const SEARCH_EVENT = "dash-search";
const searchFor = (q: string) =>
  window.dispatchEvent(new CustomEvent(SEARCH_EVENT, { detail: q }));

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
    <section class="card dash-empty-panel">
      <div class="dash-empty-icon" aria-hidden="true">
        <Icon name="star" size={20} />
      </div>
      <h2 class="dash-empty-title">Build your dashboard</h2>
      <p class="dash-empty-text">
        Search for a stock, ETF, coin, index or currency and add it. Prices, day
        lines, movers, trends and earnings appear as soon as you do.
      </p>
      <div class="dash-empty-try">
        <span class="label">Try</span>
        {EXAMPLES.map(([q, name]) => (
          <button
            key={q}
            type="button"
            class="dash-chip"
            title={name}
            onClick={(e) => {
              // the search closes on a click outside it, this one included
              e.stopPropagation();
              searchFor(q);
            }}
          >
            {q}
          </button>
        ))}
      </div>
    </section>
  );
}

type Adds = {
  sections: readonly BoardSection[];
  onAdd: (section: number, id: string) => Promise<void>;
  refuse: (section: number, id: string) => string | null;
};

// without adds, results only open their page: Add is Home's alone
function SearchBox({ adds }: { adds?: Adds }) {
  const sections = adds?.sections ?? [];
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const pickingRef = useRef<string | null>(null);
  pickingRef.current = picking;
  const [refused, setRefused] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onSeed = (ev: Event) => {
      const q = (ev as CustomEvent<string>).detail;
      setQuery(q);
      // a phone's search shows only as the sheet
      setSheet(true);
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener(SEARCH_EVENT, onSeed);
    return () => window.removeEventListener(SEARCH_EVENT, onSeed);
  }, []);
  const finder = useMemo(() => searcher(markets.search, setFound, setBusy), []);
  useEffect(() => finder.stop, [finder]);
  useEffect(() => finder.ask(query), [finder, query]);
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      if (!root.current?.contains(ev.target as Node)) setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (escapeFrom(pickingRef.current) === "picker") setPicking(null);
      else setOpen(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const where = (id: string) => sections.find((s) => s.ids.includes(id))?.name;
  const add = async (section: number, id: string) => {
    setPicking(null);
    if (adds === undefined) return;
    const why = adds.refuse(section, id);
    setRefused(why);
    if (why !== null) return;
    setAdding(id);
    await adds.onAdd(section, id);
    setAdding(null);
    setQuery("");
    setOpen(false);
  };
  return (
    <div class={`dash-search${sheet ? " dash-sheet" : ""}`} ref={root}>
      <button
        type="button"
        class="btn-icon dash-search-icon"
        aria-label="Search"
        onClick={() => {
          // iOS opens the keyboard only for a focus inside the tap, so the
          // field shows before the render does
          root.current?.classList.add("dash-sheet");
          input.current?.focus();
          setSheet(true);
          setOpen(true);
        }}
      >
        <Icon name="search" size={14} />
        <span>Search</span>
      </button>
      <div class="dash-sheet-bar">
        <label class="dash-search-box">
          <Icon name="search" size={15} />
          <input
            ref={input}
            type="search"
            placeholder="Search a symbol or name"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setRefused(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
          />
          {busy && (
            <span class="home-spinner dash-search-spin" aria-hidden="true" />
          )}
        </label>
        <button
          type="button"
          class="btn dash-sheet-cancel"
          onClick={() => {
            setSheet(false);
            setOpen(false);
            setQuery("");
          }}
        >
          Cancel
        </button>
      </div>
      {open &&
        found !== null &&
        (found.length > 0 || !busy || refused !== null) && (
          <div class="menu dash-results">
            {found.length === 0 && !busy && (
              <span class="dash-none dash-results-none">Nothing found.</span>
            )}
            {refused !== null && (
              <span class="dash-none dash-results-none" role="alert">
                {refused}
              </span>
            )}
            {found.map((c) => {
              const on = where(c.id);
              return (
                <Fragment key={c.id}>
                  <div class="dash-result">
                    <a
                      class="dash-result-main"
                      href={hrefOf(c.id)}
                      onClick={() => {
                        setOpen(false);
                        setSheet(false);
                        setQuery("");
                      }}
                    >
                      <span class="dash-result-name cut">
                        {c.name ?? symbolOf(c.id)}
                      </span>
                      <span class="dash-result-meta">
                        <span class="dash-mover-symbol">{symbolOf(c.id)}</span>
                        {c.type && <span>{kindOf(c.type)}</span>}
                        <span>{c.exchange}</span>
                        {!c.stored && <span class="tag dash-new">New</span>}
                      </span>
                    </a>
                    {adds === undefined ? null : on !== undefined ? (
                      <span class="dash-result-on" title={`On ${on}`}>
                        <Icon name="check" size={14} /> {on}
                      </span>
                    ) : adding === c.id ? (
                      <span class="dash-result-on">Fetching…</span>
                    ) : (
                      <div class="dash-pick">
                        <button
                          type="button"
                          class="btn btn-small"
                          onClick={() => {
                            if (sections.length > 0) {
                              setPicking(picking === c.id ? null : c.id);
                              return;
                            }
                            void add(0, c.id);
                          }}
                        >
                          <Icon name="plus" size={14} /> Add
                        </button>
                      </div>
                    )}
                  </div>
                  {/* in the list, not floating: the list scrolls and would cut it */}
                  {picking === c.id && on === undefined && adding !== c.id && (
                    <div class="dash-pick-menu">
                      <span class="label dash-pick-label">Add to</span>
                      {sections.map((s, i) => (
                        <button
                          key={s.name}
                          type="button"
                          class="menu-item"
                          onClick={() => void add(i, c.id)}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
    </div>
  );
}

type Drag = { from: number; id: string } | null;

function Row({
  id,
  item,
  spark,
  clip,
}: {
  id: string;
  item: BoardItem | undefined;
  spark: Spark | undefined;
  clip: string;
}) {
  const c = cardOf(entryOf(id, item));
  if (c.type !== "ready") {
    return (
      <>
        <span class="dash-cell-name">
          <span class="home-symbol">{symbolOf(id)}</span>
        </span>
        <span />
        <span class="dash-cell-num home-note">Loading</span>
        <span />
        <span />
      </>
    );
  }
  return (
    <>
      <span class="dash-cell-name">
        <span class="home-name cut">{c.name}</span>
        <span class="home-symbol cut">{c.symbol}</span>
      </span>
      <span class="dash-cell-spark">
        <Sparkline line={sparkOf(spark)} id={clip} />
      </span>
      <span class="dash-cell-num home-price">{c.price}</span>
      <span class={`dash-cell-num home-move${tone(c.dir)}`}>
        <span class="dash-pct-main">{c.percent}</span>
        <span class="dash-pct">{c.move}</span>
      </span>
      <span class="dash-cell-state home-state">{c.state}</span>
    </>
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
    <>
      <input
        class="dash-name-input"
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
        <span class="dash-name-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function SectionView({
  index,
  layout,
  editing,
  items,
  sparks,
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
  sparks: ReadonlyMap<string, Spark>;
  drag: Drag;
  setDrag: (d: Drag) => void;
  save: Save;
}) {
  const section = layout[index]!;
  const count = layout.length;
  const [over, setOver] = useState<string | null>(null);
  const move = (before: string | null) => {
    if (drag === null) return;
    void save(moveTo(layout, drag.from, drag.id, index, before));
    setDrag(null);
    setOver(null);
  };
  const item = (id: string) => {
    const dragProps = editing
      ? {
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
        }
      : {};
    const cls = `dash-item${over === id && drag?.id !== id ? " dash-item-over" : ""}${drag?.id === id ? " dash-item-dragging" : ""}`;
    const x = editing && (
      <button
        type="button"
        class="btn-icon dash-remove"
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
    if (section.view === "cards") {
      return (
        <div key={id} class={cls} {...dragProps}>
          <Card
            entry={entryOf(id, items.get(id))}
            spark={sparks.get(id)}
            id={clipOf(index, id)}
            percentOnly
          />
          {x}
        </div>
      );
    }
    return (
      <a
        key={id}
        class={`dash-row ${cls}`}
        href={hrefOf(id)}
        onClick={(e) => editing && e.preventDefault()}
        {...dragProps}
      >
        {editing && <Icon name="grip" size={14} class="dash-grip" />}
        <Row
          id={id}
          item={items.get(id)}
          spark={sparks.get(id)}
          clip={clipOf(index, id)}
        />
        {x}
      </a>
    );
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only a drop target for a mouse drag
    <section
      class={`dash-section${editing ? " dash-editing" : ""}`}
      onDragOver={(e) => editing && e.preventDefault()}
      onDrop={(e) => {
        if (!editing) return;
        e.preventDefault();
        move(null);
      }}
    >
      <div class="dash-section-head">
        {editing ? (
          <NameInput layout={layout} index={index} save={save} />
        ) : (
          <h2 class="label dash-section-name">{section.name}</h2>
        )}
        <span class="dash-count">{section.ids.length}</span>
        <div class="dash-section-tools">
          {!locked && (
            <fieldset class="seg seg-small" aria-label="Show as">
              <button
                type="button"
                class={`seg-option${section.view === "cards" ? " seg-on" : ""}`}
                title="Cards"
                aria-label="Cards"
                onClick={() =>
                  section.view !== "cards" &&
                  void save(withView(layout, index, "cards"))
                }
              >
                <Icon name="grid" size={13} />
              </button>
              <button
                type="button"
                class={`seg-option${section.view === "table" ? " seg-on" : ""}`}
                title="Table"
                aria-label="Table"
                onClick={() =>
                  section.view !== "table" &&
                  void save(withView(layout, index, "table"))
                }
              >
                <Icon name="rows" size={13} />
              </button>
            </fieldset>
          )}
          {editing && (
            <>
              <button
                type="button"
                class="btn-icon"
                title="Move up"
                disabled={index === 0}
                onClick={() => void save(swap(layout, index, index - 1))}
              >
                <Icon name="arrow-up" size={14} />
              </button>
              <button
                type="button"
                class="btn-icon"
                title="Move down"
                disabled={index === count - 1}
                onClick={() => void save(swap(layout, index, index + 1))}
              >
                <Icon name="arrow-down" size={14} />
              </button>
              <button
                type="button"
                class="btn-icon dash-delete"
                title="Delete section"
                onClick={() => void save(dropSection(layout, index))}
              >
                <Icon name="trash" size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      {section.ids.length === 0 ? (
        <div class="dash-empty">
          {editing
            ? "Drag symbols here, or add them from search."
            : "Empty. Add symbols from search."}
        </div>
      ) : section.view === "cards" ? (
        <div class="home-grid">{section.ids.map(item)}</div>
      ) : (
        <div class="card dash-table">{section.ids.map(item)}</div>
      )}
    </section>
  );
}

// an edit that changes nothing sends nothing
const save: Save = async (next) => {
  if (next !== null) await markets.saveLayout(next);
};

export function HeadSearch() {
  return <SearchBox />;
}

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
      actions={
        layout !== null &&
        !locked &&
        (editing ? (
          <>
            <button
              type="button"
              class="btn dash-edit-action"
              disabled={saving}
              onClick={() => setEdit(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary dash-edit-action"
              disabled={saving}
              onClick={() => void saveEdit(edit)}
            >
              Save
            </button>
          </>
        ) : (
          <>
            <SearchBox
              adds={{
                sections: layout,
                onAdd: (section, id) =>
                  save(addTo(markets.layout.value ?? [], section, id)),
                refuse: (section, id) =>
                  addRefusal(markets.layout.value ?? [], section, id),
              }}
            />
            <button
              type="button"
              class="btn dash-edit"
              title="Edit"
              aria-label="Edit"
              onClick={() => setEdit(editOf(layout, markets.revision()))}
            >
              <Icon name="pencil" size={14} />
            </button>
          </>
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
        <p class="page-state">Loading</p>
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
