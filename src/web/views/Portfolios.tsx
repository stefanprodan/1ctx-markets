// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios: totals per currency, holdings with their brokers, exposure
// and trades, an add form short enough for a phone, import and settings.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useId, useMemo, useRef } from "preact/hooks";
import type {
  BrokerRow,
  Exposure,
  Holding,
  Holdings,
  Imported,
  PortfolioStore,
  Total,
  TradeRow,
} from "../data/portfolios.ts";
import { type Candidate, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import { useRefresh } from "../lib/refresh.ts";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Rows, RowsCard, RowsLine, RowsNote, RowsTitle } from "../ui/Rows.tsx";
import { RowsOpen } from "../ui/RowsOpen.tsx";
import { searcher } from "./Dashboard.model.ts";
import { symbolOf } from "./Instruments.model.ts";
import {
  ADD_KEY,
  amount,
  brokerName,
  change,
  costLine,
  currencies,
  day,
  EXPOSURE_TABS,
  type ExposureTab,
  holdingSub,
  holdingTitle,
  IMPORT_KINDS,
  importLine,
  importStatus,
  listingWords,
  missingWords,
  percent,
  price,
  quantity,
  type Remembered,
  rateLine,
  readRemembered,
  shareLabel,
  splitOf,
  staleWords,
  today,
  tradeLine,
  tradeSub,
  tradeTitle,
  typed,
} from "./Portfolios.model.ts";
import "./instruments.css";
import "./portfolios.css";

const tone = (dir: -1 | 0 | 1) =>
  dir > 0 ? "ins-up" : dir < 0 ? "ins-down" : undefined;

function remembered(): Remembered {
  try {
    return readRemembered(localStorage.getItem(ADD_KEY));
  } catch {
    return readRemembered(null);
  }
}

function remember(r: Remembered): void {
  try {
    localStorage.setItem(ADD_KEY, JSON.stringify(r));
  } catch {}
}

// ---- totals ---------------------------------------------------------------

function TotalCard({ t, label }: { t: Total; label?: string }) {
  const pl = change(t.pl, t.currency);
  const plp = percent(t.pl_percent);
  const day = change(t.day_change, t.currency);
  const split = splitOf(t);
  return (
    <section class="card pf-total" aria-label={`Total in ${t.currency}`}>
      <span class="label">{label ?? t.currency}</span>
      <span class="pf-big">{amount(t.value, t.currency)}</span>
      <div class="pf-total-lines">
        {(t.cost ?? 0) > 0 && (
          <span>
            <span class="pf-dim">Gain </span>
            <span class={tone(pl.dir)}>
              {pl.text} {plp.text && `(${plp.text})`}
            </span>
          </span>
        )}
        {day.dir !== 0 && (
          <span>
            <span class="pf-dim">Today </span>
            <span class={tone(day.dir)}>{day.text}</span>
          </span>
        )}
      </div>
      {split.length > 1 && (
        <>
          <div
            class="pf-split"
            role="img"
            aria-label="Invested, cash and dry powder"
          >
            {split.map((p) => (
              <span
                key={p.key}
                class={`pf-split-${p.key}`}
                style={{ width: `${p.weight ?? 0}%` }}
              />
            ))}
          </div>
          <ul class="pf-split-keys">
            {split.map((p) => (
              <li key={p.key}>
                <span class={`pf-dot pf-split-${p.key}`} />
                {p.label} {amount(p.value, t.currency, true)} ·{" "}
                {p.weight?.toFixed(0)}%
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Totals({ h }: { h: Holdings }) {
  if (h.holdings.length === 0) return null;
  const rates = h.rates
    .map((r) => rateLine(r))
    .filter((r): r is string => r !== null);
  return (
    <div class="pf-totals">
      {h.converted !== null && (
        <div class="pf-converted">
          <TotalCard t={h.converted} label={`All in ${h.converted.currency}`} />
          {(rates.length > 0 || h.converted.missing.length > 0) && (
            <p class="pf-rates">
              {[...rates, ...h.converted.missing.map(missingWords)].join(" · ")}
            </p>
          )}
        </div>
      )}
      {h.totals.map((t) => (
        <TotalCard key={t.currency} t={t} />
      ))}
    </div>
  );
}

// ---- holdings -------------------------------------------------------------

export function PositionEdit({
  store,
  h,
  onDone,
}: {
  store: PortfolioStore;
  h: Holding;
  onDone: () => void;
}) {
  const manual = h.kind === "manual";
  // the stored amount, never the value rounded for show
  const first = useSignal(
    String(manual ? (h.price ?? "") : (h.parts[0]?.amount ?? "")),
  );
  const units = useSignal(String(h.quantity ?? ""));
  const date = useSignal(h.as_of ?? today());
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const save = async (ev: Event) => {
    ev.preventDefault();
    const n = typed(first.value);
    const u = typed(units.value);
    if (
      n === null ||
      Number.isNaN(n) ||
      (manual && (u === null || Number.isNaN(u)))
    ) {
      error.value = "Not a number.";
      return;
    }
    busy.value = true;
    error.value = await store.updatePosition(h.position!, {
      ...(manual ? { price: n, units: u! } : { amount: n }),
      date: date.value,
    });
    busy.value = false;
    if (error.value === null) onDone();
  };
  return (
    <form class="pf-edit" onSubmit={save}>
      {manual && (
        <label class="field">
          <span class="label">Units</span>
          <input
            inputMode="decimal"
            value={units.value}
            onInput={(e) => {
              units.value = e.currentTarget.value;
            }}
          />
        </label>
      )}
      <label class="field">
        <span class="label">
          {manual ? "Price" : h.kind === "bond" ? "Face" : "Amount"}
        </span>
        <input
          inputMode="decimal"
          value={first.value}
          onInput={(e) => {
            first.value = e.currentTarget.value;
          }}
        />
      </label>
      <label class="field">
        <span class="label">As of</span>
        <input
          type="date"
          value={date.value}
          onInput={(e) => {
            date.value = e.currentTarget.value;
          }}
        />
      </label>
      <div class="pf-form-foot">
        {error.value && (
          <p class="pf-error" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="button"
          class="btn btn-small"
          onClick={onDone}
          disabled={busy.value}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="btn btn-small btn-primary"
          disabled={busy.value}
        >
          {busy.value ? "Saving" : "Save"}
        </button>
      </div>
    </form>
  );
}

// a position's edit and remove; a merged bond's purchases each get one
function PositionActions({
  store,
  h,
  what,
}: {
  store: PortfolioStore;
  h: Holding;
  what?: string;
}) {
  const editing = useSignal(false);
  const asking = useSignal(false);
  const error = useSignal<string | null>(null);
  return (
    <div class="pf-row-actions">
      {editing.value ? (
        <PositionEdit
          store={store}
          h={h}
          onDone={() => {
            editing.value = false;
          }}
        />
      ) : asking.value ? (
        <>
          <span class="rows-end-words">Remove {what ?? h.name}?</span>
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
            onClick={async () => {
              error.value = await store.removePosition(h.position!);
              asking.value = false;
            }}
          >
            Remove
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              editing.value = true;
            }}
          >
            <Icon name="pencil" size={14} /> Edit
          </button>
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              asking.value = true;
            }}
          >
            <Icon name="trash" size={14} /> Remove
          </button>
        </>
      )}
      {error.value && (
        <span class="pf-error" role="alert">
          {error.value}
        </span>
      )}
    </div>
  );
}

// a bond bought several times: each purchase is its own position
export function Purchases({ store, h }: { store: PortfolioStore; h: Holding }) {
  return (
    <ul class="pf-purchases" aria-label="Purchases">
      {h.parts.map((p) =>
        p.position === undefined ? null : (
          <li key={p.position}>
            <span class="pf-purchase">
              {[
                p.as_of ? `Bought ${day(p.as_of)}` : null,
                `Face ${amount(p.amount ?? null, h.currency)}`,
                brokerName(p.broker),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <PositionActions
              store={store}
              h={{
                ...h,
                position: p.position,
                as_of: p.as_of ?? null,
                parts: [p],
              }}
              what="this purchase"
            />
          </li>
        ),
      )}
    </ul>
  );
}

function HoldingRow({ store, h }: { store: PortfolioStore; h: Holding }) {
  const open = useSignal(false);
  const pl = percent(h.pl_percent);
  const line = costLine(h);
  const shown = h.converted;
  return (
    <RowsOpen
      open={open.value}
      onToggle={() => {
        open.value = !open.value;
      }}
      indent="chevron"
      head={
        <span class="pf-row">
          <RowsTitle
            name={
              <>
                <span class={h.kind === "holding" ? "ins-symbol" : "cut"}>
                  {holdingTitle(h)}
                </span>
                {h.stale.length > 0 && (
                  <span class="tag">{staleWords(h.stale.at(-1)!)}</span>
                )}
              </>
            }
            sub={holdingSub(h)}
            lines={line ? [{ text: line }] : undefined}
          />
          <span class="pf-row-end">
            <span class="pf-value">{amount(h.value, h.currency)}</span>
            {shown && shown.value !== null && shown.currency !== h.currency && (
              <span class="pf-dim">{amount(shown.value, shown.currency)}</span>
            )}
            {pl.text && <span class={tone(pl.dir)}>{pl.text}</span>}
          </span>
        </span>
      }
    >
      <dl class="pf-facts">
        {h.price !== null && (
          <div>
            <dt>{h.priced === "hand" ? "Hand price" : "Price"}</dt>
            <dd>
              {price(h.price, h.kind === "bond" ? null : h.currency)}
              {h.kind === "bond" ? "%" : ""}
            </dd>
          </div>
        )}
        {h.cost !== null && h.kind !== "cash" && (
          <div>
            <dt>Cost</dt>
            <dd>{amount(h.cost, h.currency)}</dd>
          </div>
        )}
        {h.pl !== null && (
          <div>
            <dt>Gain</dt>
            <dd class={tone(change(h.pl).dir)}>
              {change(h.pl, h.currency).text}
            </dd>
          </div>
        )}
        {h.paid?.map((p) => (
          <div key={p.currency}>
            <dt>Paid</dt>
            <dd>{amount(p.amount, p.currency)}</dd>
          </div>
        ))}
        {h.weight !== null && (
          <div>
            <dt>Weight</dt>
            <dd>{h.weight.toFixed(1)}%</dd>
          </div>
        )}
      </dl>
      {h.kind === "holding" && h.parts.length > 0 && (
        <table class="pf-parts">
          <thead>
            <tr>
              <th>Broker</th>
              <th>Quantity</th>
              <th>Average cost</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {h.parts.map((p) => (
              <tr key={`${p.portfolio}/${p.broker ?? ""}`}>
                <td>
                  {brokerName(p.broker)}
                  <span class="pf-dim pf-part-portfolio"> · {p.portfolio}</span>
                </td>
                <td>{quantity(p.quantity)}</td>
                <td>{price(p.average_cost)}</td>
                <td>{amount(p.value, h.currency, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {h.kind !== "holding" && h.position !== null && (
        <PositionActions store={store} h={h} />
      )}
      {h.kind === "bond" && h.position === null && (
        <Purchases store={store} h={h} />
      )}
    </RowsOpen>
  );
}

function HoldingsCard({ store, h }: { store: PortfolioStore; h: Holdings }) {
  return (
    <RowsCard label="Holdings" count={String(h.holdings.length)}>
      {h.holdings.length === 0 ? (
        <RowsNote>Nothing held yet.</RowsNote>
      ) : (
        h.holdings.map((x) => (
          <HoldingRow
            key={`${x.kind}/${x.id ?? ""}/${x.position ?? ""}`}
            store={store}
            h={x}
          />
        ))
      )}
    </RowsCard>
  );
}

// ---- exposure -------------------------------------------------------------

function ExposureCard({ h }: { h: Holdings }) {
  const tab = useSignal<ExposureTab>("market");
  const which = useSignal(0);
  if (h.exposure.length === 0 || h.holdings.length === 0) return null;
  const e: Exposure = h.exposure[Math.min(which.value, h.exposure.length - 1)]!;
  const tabs = EXPOSURE_TABS.filter(
    (t) => t.key !== "currency" || e.currency_weights !== null,
  );
  const list =
    tab.value === "currency" ? (e.currency_weights ?? []) : e[tab.value];
  return (
    <RowsCard
      label="Exposure"
      tabs={
        <div class="pf-tabs">
          <span class="label pf-tabs-label">Exposure</span>
          <div class="seg seg-small" role="tablist" aria-label="Exposure by">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab.value === t.key}
                class={`seg-option${tab.value === t.key ? " seg-on" : ""}`}
                onClick={() => {
                  tab.value = t.key;
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      }
      action={
        h.exposure.length > 1 ? (
          <select
            class="pf-select-small"
            aria-label="Currency"
            value={String(which.value)}
            onChange={(ev) => {
              which.value = Number(ev.currentTarget.value);
            }}
          >
            {h.exposure.map((x, k) => (
              <option key={x.currency} value={String(k)}>
                {x.currency}
              </option>
            ))}
          </select>
        ) : undefined
      }
    >
      <ul class="pf-bars">
        {list.map((s) => (
          <li key={s.key ?? ""}>
            <span class="pf-bar-label cut">{shareLabel(tab.value, s.key)}</span>
            <span class="pf-bar">
              <span style={{ width: `${s.weight}%` }} />
            </span>
            <span class="pf-bar-pct">{s.weight.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </RowsCard>
  );
}

// ---- trades ---------------------------------------------------------------

function TradeItem({ store, t }: { store: PortfolioStore; t: TradeRow }) {
  const asking = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const removed = t.removed_at !== null;
  return (
    <RowsLine flush off={removed}>
      <RowsTitle
        name={
          <>
            <span class={t.side === "buy" ? "pf-buy" : "pf-sell"}>
              {tradeTitle(t)}
            </span>
            {removed && <span class="tag">Removed</span>}
          </>
        }
        sub={tradeLine(t)}
        lines={[{ text: tradeSub(t) }]}
      />
      <span class="rows-end">
        {error.value && (
          <span class="rows-end-words rows-bad" role="alert">
            {error.value}
          </span>
        )}
        {removed ? (
          <button
            type="button"
            class="btn btn-small"
            disabled={busy.value}
            onClick={async () => {
              busy.value = true;
              error.value = await store.restoreTrade(t.id);
              busy.value = false;
            }}
          >
            Restore
          </button>
        ) : asking.value ? (
          <>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
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
                error.value = await store.removeTrade(t.id);
                busy.value = false;
                asking.value = false;
              }}
            >
              Remove
            </button>
          </>
        ) : (
          <button
            type="button"
            class="btn btn-small"
            aria-label={`Remove ${tradeTitle(t)}`}
            onClick={() => {
              asking.value = true;
            }}
          >
            Remove
          </button>
        )}
      </span>
    </RowsLine>
  );
}

const SHOWN_TRADES = 20;

function TradesCard({
  store,
  trades,
}: {
  store: PortfolioStore;
  trades: TradeRow[];
}) {
  const removed = useSignal(false);
  const all = useSignal(false);
  const list = trades.filter((t) => removed.value || t.removed_at === null);
  const shown = all.value ? list : list.slice(0, SHOWN_TRADES);
  return (
    <RowsCard
      label="Trades"
      count={String(list.length)}
      action={
        <label class="pf-switch-line">
          <span>Removed</span>
          <button
            type="button"
            class={`switch${removed.value ? " switch-on" : ""}`}
            role="switch"
            aria-checked={removed.value}
            aria-label="Show removed"
            onClick={() => {
              removed.value = !removed.value;
            }}
          >
            <span class="switch-knob" />
          </button>
        </label>
      }
    >
      {list.length === 0 && <RowsNote>No trades yet.</RowsNote>}
      {shown.map((t) => (
        <TradeItem key={t.id} store={store} t={t} />
      ))}
      {!all.value && list.length > SHOWN_TRADES && (
        <div class="rows-item rows-more">
          <button
            type="button"
            class="btn-text"
            onClick={() => {
              all.value = true;
            }}
          >
            Show all {list.length}
          </button>
        </div>
      )}
    </RowsCard>
  );
}

// ---- the add form ---------------------------------------------------------

// one fund trades on several exchanges under one symbol: each result says
// where, so the listing picked is the one meant
export function FoundList({
  found,
  onPick,
}: {
  found: readonly Candidate[];
  onPick: (c: Candidate) => void;
}) {
  return (
    <ul class="menu pf-found">
      {found.slice(0, 8).map((c) => (
        <li key={c.id}>
          <button
            type="button"
            class="menu-item"
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(c)}
          >
            <span class="ins-symbol">{symbolOf(c.id)}</span>
            <span class="cut pf-dim">{c.name ?? ""}</span>
            <span class="pf-found-where">{listingWords(c)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SymbolPick({
  value,
  onPick,
  onEdit,
  currency,
}: {
  value: Signal<string>;
  onPick: (c: Candidate) => void;
  // typed over a pick: the picked listing no longer applies
  onEdit: () => void;
  // the picked listing's, once read
  currency?: string | null;
}) {
  const found = useSignal<Candidate[] | null>(null);
  const picked = useSignal<Candidate | null>(null);
  const open = useSignal(false);
  // the symbol shown; value holds the picked listing's id, sent as is
  const text = useSignal(value.value);
  const finder = useMemo(
    () =>
      searcher(
        markets.search,
        (c) => {
          found.value = c;
        },
        () => {},
      ),
    [],
  );
  useEffect(() => finder.stop, [finder]);
  return (
    <div class="field pf-symbol">
      <label class="label" for="pf-symbol">
        Symbol
      </label>
      <input
        id="pf-symbol"
        value={text.value}
        autocomplete="off"
        spellcheck={false}
        autocapitalize="characters"
        placeholder="AAPL"
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          value.value = text.value;
          picked.value = null;
          onEdit();
          open.value = true;
          finder.ask(text.value);
        }}
        onBlur={() =>
          setTimeout(() => {
            open.value = false;
          }, 150)
        }
      />
      {picked.value && (
        <span class="pf-picked">
          {listingWords({
            ...picked.value,
            currency: picked.value.currency ?? currency,
          })}
        </span>
      )}
      {open.value && (found.value ?? []).length > 0 && (
        <FoundList
          found={found.value!}
          onPick={(c) => {
            value.value = c.id;
            text.value = symbolOf(c.id);
            picked.value = c;
            open.value = false;
            onPick(c);
          }}
        />
      )}
    </div>
  );
}

const KIND_LABELS = [
  { key: "trade", label: "Trade" },
  { key: "cash", label: "Cash" },
  { key: "manual", label: "Fund" },
  { key: "bond", label: "Bond" },
] as const;

function Field({
  label,
  value,
  placeholder,
  type = "text",
  decimal,
}: {
  label: string;
  value: Signal<string>;
  placeholder?: string;
  type?: "text" | "date";
  decimal?: boolean;
}) {
  const id = useId();
  return (
    <div class="field">
      <label class="label" for={id}>
        {label}
      </label>
      {type === "date" ? (
        <input
          id={id}
          type="date"
          value={value.value}
          onInput={(ev) => {
            value.value = ev.currentTarget.value;
          }}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value.value}
          placeholder={placeholder}
          inputMode={decimal ? "decimal" : undefined}
          autocomplete="off"
          onInput={(ev) => {
            value.value = ev.currentTarget.value;
          }}
        />
      )}
    </div>
  );
}

function Pick({
  label,
  value,
  options,
  none,
}: {
  label: string;
  value: Signal<string>;
  options: { value: string; label: string }[];
  none?: string;
}) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      <select
        value={value.value}
        onChange={(ev) => {
          value.value = ev.currentTarget.value;
        }}
      >
        {none !== undefined && <option value="">{none}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const inCurrency = (label: string, c: string | null): string =>
  c ? `${label} (${c})` : label;

// the currencies a trade may be paid in: those held, the display one
function paidChoices(store: PortfolioStore, listing: string | null) {
  const codes = new Set(currencies(store.holdings.value));
  const shown = store.overview.value?.display_currency;
  if (shown) codes.add(shown);
  if (listing) codes.delete(listing);
  return [...codes].sort().map((c) => ({ value: c, label: c }));
}

export function AddForm({
  store,
  onDone,
}: {
  store: PortfolioStore;
  onDone: () => void;
}) {
  const kept = remembered();
  const o = store.overview.value;
  const portfolios = o?.portfolios ?? [];
  const brokers = o?.brokers ?? [];
  const firstPortfolio =
    portfolios.find((p) => p.id === kept.portfolio)?.id ??
    store.portfolio.value ??
    portfolios[0]?.id ??
    null;
  const kind = useSignal<Remembered["kind"]>(kept.kind);
  const side = useSignal<Remembered["side"]>(kept.side);
  const portfolio = useSignal(
    firstPortfolio === null ? "" : String(firstPortfolio),
  );
  const broker = useSignal(
    kept.broker !== null && brokers.some((b) => b.name === kept.broker)
      ? kept.broker
      : "",
  );
  const symbol = useSignal("");
  const qty = useSignal("");
  const px = useSignal("");
  const fees = useSignal("");
  const date = useSignal(today());
  const name = useSignal("");
  const amountText = useSignal("");
  const currency = useSignal("");
  // a trade's: the listing's own unless another is picked
  const listing = useSignal<string | null>(null);
  const paid = useSignal("");
  const cost = useSignal("");
  const coupon = useSignal("");
  const maturity = useSignal("");
  const dry = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  if (portfolios.length === 0) {
    return (
      <div class="card pf-panel">
        <RowsNote>Make a portfolio first, in Settings.</RowsNote>
      </div>
    );
  }
  const num = (s: Signal<string>, label: string, required: boolean) => {
    const v = typed(s.value);
    if (v === null && !required) return undefined;
    if (v === null || Number.isNaN(v))
      throw new Error(`${label} is not a number.`);
    return v;
  };
  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy.value) return;
    error.value = null;
    const pid = Number(portfolio.value);
    const b = broker.value === "" ? undefined : broker.value;
    let refused: string | null;
    busy.value = true;
    try {
      if (kind.value === "trade") {
        if (symbol.value.trim() === "") throw new Error("Pick a symbol.");
        refused = await store.addTrade({
          portfolio: pid,
          symbol: symbol.value.trim(),
          side: side.value,
          quantity: num(qty, "Quantity", true)!,
          price: num(px, "Price", false),
          fees: num(fees, "Fees", false),
          ...(paid.value === "" ? {} : { currency: paid.value }),
          date: date.value,
          broker: b,
        });
      } else {
        if (name.value.trim() === "") throw new Error("Name it.");
        const cur = currency.value.trim().toUpperCase();
        refused = await store.addPosition({
          kind: kind.value,
          portfolio: pid,
          name: name.value.trim(),
          ...(cur === "" ? {} : { currency: cur }),
          ...(kind.value === "manual"
            ? { units: num(qty, "Units", true), price: num(px, "Price", true) }
            : {
                amount: num(
                  amountText,
                  kind.value === "bond" ? "Face" : "Amount",
                  true,
                ),
              }),
          ...(kind.value !== "cash" ? { cost: num(cost, "Cost", false) } : {}),
          ...(kind.value === "bond"
            ? {
                coupon: num(coupon, "Coupon", false),
                ...(maturity.value ? { maturity: maturity.value } : {}),
                ...(symbol.value.trim() ? { symbol: symbol.value.trim() } : {}),
              }
            : {}),
          ...(kind.value === "cash" && dry.value ? { dry_powder: true } : {}),
          date: date.value,
          broker: b,
        });
      }
    } catch (e) {
      refused = (e as Error).message;
    }
    busy.value = false;
    if (refused !== null) {
      error.value = refused;
      return;
    }
    remember({
      kind: kind.value,
      side: side.value,
      portfolio: pid,
      broker: b ?? null,
    });
    onDone();
  };
  return (
    <form class="card pf-panel pf-add" onSubmit={submit} aria-label="Add">
      <div class="seg pf-kinds" role="tablist" aria-label="What to add">
        {KIND_LABELS.map((k) => (
          <button
            key={k.key}
            type="button"
            role="tab"
            aria-selected={kind.value === k.key}
            class={`seg-option${kind.value === k.key ? " seg-on" : ""}`}
            onClick={() => {
              kind.value = k.key;
              error.value = null;
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      {kind.value === "trade" ? (
        <>
          <SymbolPick
            value={symbol}
            onPick={(c) => {
              listing.value = null;
              paid.value = "";
              void store.listingCurrency(c.id).then((cur) => {
                if (symbol.value === c.id) listing.value = cur;
              });
            }}
            onEdit={() => {
              listing.value = null;
            }}
            currency={listing.value}
          />
          <div class="seg pf-side">
            {(["buy", "sell"] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={side.value === s}
                class={`seg-option${side.value === s ? " seg-on" : ""}`}
                onClick={() => {
                  side.value = s;
                }}
              >
                {s === "buy" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>
          <div class="pf-pair">
            <Field label="Quantity" value={qty} decimal />
            <Field
              label={inCurrency("Price", paid.value || listing.value)}
              value={px}
              placeholder="Live price"
              decimal
            />
          </div>
          <div class="pf-pair">
            <Field
              label={inCurrency("Fees", paid.value || listing.value)}
              value={fees}
              placeholder="0"
              decimal
            />
            <Field label="Date" value={date} type="date" />
          </div>
          <Pick
            label="Paid in"
            value={paid}
            none={listing.value ?? "Listing's currency"}
            options={paidChoices(store, listing.value)}
          />
        </>
      ) : (
        <>
          <Field label="Name" value={name} />
          {kind.value === "manual" ? (
            <div class="pf-pair">
              <Field label="Units" value={qty} decimal />
              <Field label="Price" value={px} decimal />
            </div>
          ) : (
            <Field
              label={kind.value === "bond" ? "Face" : "Amount"}
              value={amountText}
              decimal
            />
          )}
          <div class="pf-pair">
            <Field
              label="Currency"
              value={currency}
              placeholder={kind.value === "bond" ? "Listing's" : "Code"}
            />
            <Field label="As of" value={date} type="date" />
          </div>
          {kind.value === "bond" && (
            <>
              <Field label="Symbol" value={symbol} placeholder="Optional" />
              <div class="pf-pair">
                <Field label="Coupon %" value={coupon} decimal />
                <Field label="Maturity" value={maturity} type="date" />
              </div>
            </>
          )}
          {kind.value !== "cash" && (
            <Field label="Cost" value={cost} placeholder="Optional" decimal />
          )}
          {kind.value === "cash" && (
            <label class="pf-switch-line">
              <button
                type="button"
                class={`switch${dry.value ? " switch-on" : ""}`}
                role="switch"
                aria-checked={dry.value}
                aria-label="Dry powder"
                onClick={() => {
                  dry.value = !dry.value;
                }}
              >
                <span class="switch-knob" />
              </button>
              <span>Dry powder</span>
            </label>
          )}
        </>
      )}
      <div class="pf-pair">
        <Pick
          label="Portfolio"
          value={portfolio}
          options={portfolios.map((p) => ({
            value: String(p.id),
            label: p.name,
          }))}
        />
        <Pick
          label="Broker"
          value={broker}
          none="None"
          options={brokers.map((b) => ({ value: b.name, label: b.name }))}
        />
      </div>
      <div class="pf-form-foot">
        {error.value && (
          <p class="pf-error" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="button"
          class="btn"
          onClick={onDone}
          disabled={busy.value}
        >
          Cancel
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy.value}>
          {busy.value
            ? "Saving"
            : kind.value === "trade"
              ? side.value === "buy"
                ? "Add buy"
                : "Add sell"
              : "Add"}
        </button>
      </div>
    </form>
  );
}

// ---- import ---------------------------------------------------------------

export function ImportPanel({
  store,
  onDone,
}: {
  store: PortfolioStore;
  onDone: () => void;
}) {
  const o = store.overview.value;
  const portfolios = o?.portfolios ?? [];
  const brokers = o?.brokers ?? [];
  const portfolio = useSignal(
    String(store.portfolio.value ?? portfolios[0]?.id ?? ""),
  );
  const broker = useSignal("");
  const csv = useSignal<string | null>(null);
  const file = useSignal("");
  const preview = useSignal<Imported | null>(null);
  const dry = useSignal<number[]>([]);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // a preview read for another portfolio or broker would mislead
  useEffect(() => {
    preview.value = null;
    dry.value = [];
    csv.value = null;
    file.value = "";
    if (input.current) input.current.value = "";
  }, [portfolio.value, broker.value]);
  if (portfolios.length === 0) {
    return (
      <div class="card pf-panel">
        <RowsNote>Make a portfolio first, in Settings.</RowsNote>
      </div>
    );
  }
  const run = async (confirm: boolean) => {
    if (csv.value === null) return;
    busy.value = true;
    error.value = null;
    const r = await store.importFile({
      portfolio: Number(portfolio.value),
      csv: csv.value,
      broker: broker.value === "" ? null : broker.value,
      dry_powder: dry.value,
      confirm,
    });
    busy.value = false;
    if ("refused" in r) {
      error.value = r.refused;
      return;
    }
    preview.value = r.done;
  };
  const p = preview.value;
  return (
    <section class="card pf-panel" aria-label="Import">
      <div class="pf-pair">
        <Pick
          label="Portfolio"
          value={portfolio}
          options={portfolios.map((x) => ({
            value: String(x.id),
            label: x.name,
          }))}
        />
        <Pick
          label="Broker for the file"
          value={broker}
          none="From the file"
          options={brokers.map((b) => ({ value: b.name, label: b.name }))}
        />
      </div>
      <div class="field">
        <span class="label">File</span>
        <div class="pf-file">
          <button
            type="button"
            class="btn"
            onClick={() => input.current?.click()}
          >
            <Icon name="upload" size={14} /> Choose CSV
          </button>
          <span class="cut pf-dim">{file.value}</span>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={async (ev) => {
              const f = ev.currentTarget.files?.[0];
              if (!f) return;
              file.value = f.name;
              csv.value = await f.text();
              preview.value = null;
              dry.value = [];
              await run(false);
            }}
          />
        </div>
      </div>
      {p !== null && (
        <>
          <p class="pf-dim">
            {IMPORT_KINDS[p.kind]} · {p.counts.ok + p.counts.saved} ready
            {p.counts.bad > 0 ? ` · ${p.counts.bad} not read` : ""}
            {p.counts.skipped > 0 ? ` · ${p.counts.skipped} skipped` : ""}
          </p>
          <ul class="pf-preview">
            {p.rows.map((r) => (
              <li key={r.line} class={`pf-preview-${r.status}`}>
                <span class="pf-preview-line">Line {r.line}</span>
                <span class="cut">{r.item ? importLine(r.item) : ""}</span>
                <span class="pf-preview-status">
                  {importStatus(r.status)}
                  {r.reason ? ` · ${r.reason}` : ""}
                  {r.warning ? ` · ${r.warning}` : ""}
                  {r.replaces !== undefined ? " · replaces the kept one" : ""}
                </span>
                {p.kind === "cash" && r.status === "ok" && (
                  <label class="pf-dry">
                    <input
                      type="checkbox"
                      checked={dry.value.includes(r.line)}
                      onChange={async (ev) => {
                        dry.value = ev.currentTarget.checked
                          ? [...dry.value, r.line]
                          : dry.value.filter((x) => x !== r.line);
                        await run(false);
                      }}
                    />
                    Dry powder
                  </label>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div class="pf-form-foot">
        {error.value && (
          <p class="pf-error" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="button"
          class="btn"
          onClick={onDone}
          disabled={busy.value}
        >
          {p?.saved ? "Done" : "Cancel"}
        </button>
        {p !== null && !p.saved && (
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy.value || p.counts.ok === 0}
            onClick={() => run(true)}
          >
            {busy.value ? "Importing" : `Import ${p.counts.ok}`}
          </button>
        )}
      </div>
    </section>
  );
}

// ---- settings: portfolios, brokers, the display currency ------------------

function NameRow({
  name,
  onRename,
  onDelete,
}: {
  name: string;
  onRename: (to: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const editing = useSignal(false);
  const text = useSignal(name);
  const asking = useSignal(false);
  const error = useSignal<string | null>(null);
  return (
    <RowsLine flush>
      {editing.value ? (
        <form
          class="pf-inline"
          onSubmit={async (ev) => {
            ev.preventDefault();
            error.value = await onRename(text.value.trim());
            if (error.value === null) editing.value = false;
          }}
        >
          <input
            value={text.value}
            aria-label="Name"
            onInput={(e) => {
              text.value = e.currentTarget.value;
            }}
          />
          <button type="submit" class="btn btn-small btn-primary">
            Save
          </button>
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              editing.value = false;
              text.value = name;
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <RowsTitle name={name} />
      )}
      <span class="rows-end">
        {error.value && (
          <span class="rows-end-words rows-bad" role="alert">
            {error.value}
          </span>
        )}
        {!editing.value &&
          (asking.value ? (
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
                onClick={async () => {
                  error.value = await onDelete();
                  asking.value = false;
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                class="btn-icon"
                aria-label={`Rename ${name}`}
                onClick={() => {
                  editing.value = true;
                }}
              >
                <Icon name="pencil" size={14} />
              </button>
              <button
                type="button"
                class="btn-icon"
                aria-label={`Delete ${name}`}
                onClick={() => {
                  error.value = null;
                  asking.value = true;
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </>
          ))}
      </span>
    </RowsLine>
  );
}

function AddName({
  placeholder,
  onAdd,
}: {
  placeholder: string;
  onAdd: (name: string) => Promise<string | null>;
}) {
  const text = useSignal("");
  const error = useSignal<string | null>(null);
  return (
    <form
      class="rows-item pf-inline pf-add-name"
      onSubmit={async (ev) => {
        ev.preventDefault();
        if (text.value.trim() === "") return;
        error.value = await onAdd(text.value.trim());
        if (error.value === null) text.value = "";
      }}
    >
      <input
        value={text.value}
        placeholder={placeholder}
        aria-label={placeholder}
        onInput={(e) => {
          text.value = e.currentTarget.value;
        }}
      />
      <button type="submit" class="btn btn-small">
        <Icon name="plus" size={14} /> Add
      </button>
      {error.value && (
        <span class="pf-error" role="alert">
          {error.value}
        </span>
      )}
    </form>
  );
}

export function SettingsPanel({
  store,
  onDone,
}: {
  store: PortfolioStore;
  onDone: () => void;
}) {
  const o = store.overview.value;
  const display = useSignal(o?.display_currency ?? "");
  const error = useSignal<string | null>(null);
  const saved = useSignal(false);
  return (
    <section class="pf-settings" aria-label="Settings">
      <Rows>
        <RowsCard label="Portfolios" count={String(o?.portfolios.length ?? 0)}>
          {(o?.portfolios ?? []).map((p) => (
            <NameRow
              key={p.id}
              name={p.name}
              onRename={(to) => store.renamePortfolio(p.id, to)}
              onDelete={() => store.deletePortfolio(p.id)}
            />
          ))}
          <AddName placeholder="New portfolio" onAdd={store.createPortfolio} />
        </RowsCard>
        <RowsCard label="Brokers" count={String(o?.brokers.length ?? 0)}>
          {(o?.brokers ?? []).map((b: BrokerRow) => (
            <NameRow
              key={b.id}
              name={b.name}
              onRename={(to) => store.renameBroker(b.id, to)}
              onDelete={() => store.deleteBroker(b.id)}
            />
          ))}
          <AddName placeholder="New broker" onAdd={store.createBroker} />
        </RowsCard>
        <RowsCard label="Display currency">
          <form
            class="rows-item pf-inline pf-add-name"
            onSubmit={async (ev) => {
              ev.preventDefault();
              const c = display.value.trim().toUpperCase();
              error.value = await store.saveDisplay(c === "" ? null : c);
              saved.value = error.value === null;
            }}
          >
            <input
              value={display.value}
              placeholder="None"
              aria-label="Display currency"
              maxLength={3}
              autocapitalize="characters"
              onInput={(e) => {
                display.value = e.currentTarget.value;
                saved.value = false;
              }}
            />
            <button type="submit" class="btn btn-small">
              {saved.value ? "Saved" : "Save"}
            </button>
            {error.value && (
              <span class="pf-error" role="alert">
                {error.value}
              </span>
            )}
          </form>
        </RowsCard>
      </Rows>
      <div class="pf-form-foot">
        <button type="button" class="btn" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

// ---- the page -------------------------------------------------------------

type Panel = "add" | "import" | "settings" | null;

function PageMenu({
  store,
  panel,
}: {
  store: PortfolioStore;
  panel: Signal<Panel>;
}) {
  const { open, root } = useMenu();
  const id = store.portfolio.value;
  return (
    <div class="ins-more" ref={root}>
      <button
        type="button"
        class="btn btn-primary"
        aria-label="Add"
        onClick={() => {
          panel.value = panel.value === "add" ? null : "add";
        }}
      >
        <Icon name="plus" size={14} />
        <span class="pf-add-words">Add</span>
      </button>
      <button
        type="button"
        class="btn ins-more-btn"
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <Icon name="more" size={16} />
      </button>
      {open.value && (
        <div class="menu ins-menu" role="menu">
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={() => {
              open.value = false;
              panel.value = "import";
            }}
          >
            <Icon name="upload" size={14} /> Import
          </button>
          {id !== null ? (
            <a
              class="menu-item"
              role="menuitem"
              href={store.exportHref(id)}
              download
              onClick={() => {
                open.value = false;
              }}
            >
              <Icon name="download" size={14} /> Export trades
            </a>
          ) : (
            <button type="button" class="menu-item" role="menuitem" disabled>
              <Icon name="download" size={14} /> Export trades
            </button>
          )}
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            onClick={() => {
              open.value = false;
              panel.value = "settings";
            }}
          >
            <Icon name="pencil" size={14} /> Settings
          </button>
        </div>
      )}
    </div>
  );
}

function Filters({ store }: { store: PortfolioStore }) {
  const o = store.overview.value;
  const h = store.holdings.value;
  const codes = currencies(h);
  return (
    <div class="pf-filters">
      <div class="seg pf-portfolios" role="tablist" aria-label="Portfolio">
        {[
          { id: null as number | null, name: "All" },
          ...(o?.portfolios ?? []),
        ].map((p) => (
          <button
            key={p.id ?? "all"}
            type="button"
            role="tab"
            aria-selected={store.portfolio.value === p.id}
            class={`seg-option${store.portfolio.value === p.id ? " seg-on" : ""}`}
            onClick={() => void store.pick({ portfolio: p.id })}
          >
            {p.name}
          </button>
        ))}
      </div>
      <div class="pf-picks">
        <select
          class="pf-select-small"
          aria-label="Broker"
          value={store.broker.value ?? ""}
          onChange={(ev) =>
            void store.pick({ broker: ev.currentTarget.value || null })
          }
        >
          <option value="">All brokers</option>
          {(o?.brokers ?? []).map((b) => (
            <option key={b.id} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
        {codes.length > 1 && (
          <select
            class="pf-select-small"
            aria-label="Show in"
            value={store.currency.value ?? ""}
            onChange={(ev) =>
              void store.pick({ currency: ev.currentTarget.value || null })
            }
          >
            <option value="">
              {h?.display_currency
                ? `In ${h.display_currency}`
                : "Own currencies"}
            </option>
            {codes.map((c) => (
              <option key={c} value={c}>
                In {c}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

export function PortfoliosBody({ store }: { store: PortfolioStore }) {
  const panel = useSignal<Panel>(null);
  const held = store.holdings.value !== null;
  const h = store.holdings.value;
  const empty = (store.overview.value?.portfolios.length ?? 0) === 0;
  return (
    <Page
      title="Portfolios"
      actions={held ? <PageMenu store={store} panel={panel} /> : undefined}
      stale={held ? store.error.value : null}
      staleCount={store.failures.value}
      failed={didNotLoad(
        held,
        store.error.value,
        store.code.value,
        () => void store.load(),
      )}
    >
      {held && h !== null && (
        <div class="pf">
          {panel.value === "add" && (
            <AddForm
              store={store}
              onDone={() => {
                panel.value = null;
              }}
            />
          )}
          {panel.value === "import" && (
            <ImportPanel
              store={store}
              onDone={() => {
                panel.value = null;
              }}
            />
          )}
          {panel.value === "settings" || (empty && panel.value === null) ? (
            <SettingsPanel
              store={store}
              onDone={() => {
                panel.value = null;
              }}
            />
          ) : (
            <>
              <Filters store={store} />
              <Totals h={h} />
              <Rows>
                <HoldingsCard store={store} h={h} />
                <ExposureCard h={h} />
                <TradesCard store={store} trades={store.trades.value ?? []} />
              </Rows>
            </>
          )}
        </div>
      )}
    </Page>
  );
}

export function Portfolios() {
  const store = markets.portfolios;
  useRefresh(store.load);
  return <PortfoliosBody store={store} />;
}
