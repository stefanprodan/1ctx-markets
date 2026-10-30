// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Portfolios: totals per currency, holdings with their brokers, exposure
// and trades, an add form short enough for a phone, import and settings.

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useMemo, useRef } from "preact/hooks";
import { currencyName, findCurrencies } from "../../shared/currencies.ts";
import type {
  BrokerRow,
  Exposure,
  Holding,
  Holdings,
  Imported,
  Listing,
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
import { kindOf, symbolOf } from "./Instruments.model.ts";
import {
  ADD_KEY,
  amount,
  brokerName,
  change,
  costLine,
  currencies,
  day,
  dryPowderFor,
  dryPowders,
  EXPOSURE_TABS,
  type ExposureTab,
  heldAt,
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
  ranked,
  rateLine,
  readRemembered,
  shareLabel,
  shownIn,
  splitOf,
  staleWords,
  today,
  tradeLine,
  tradeMoney,
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

function TotalCard({
  t,
  label,
  wide,
  foot,
  noSplit,
}: {
  t: Total;
  label?: string;
  wide?: boolean;
  foot?: string[];
  noSplit?: boolean;
}) {
  const pl = change(t.pl, t.currency);
  const plp = percent(t.pl_percent);
  const day = change(t.day_change, t.currency);
  const split = splitOf(t);
  return (
    <section
      class={`card pf-total${wide ? " pf-total-wide" : ""}`}
      aria-label={`Total in ${t.currency}`}
    >
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
      {!noSplit && split.length > 1 && (
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
      {foot && foot.length > 0 && (
        <p class="pf-rates">
          {foot.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </p>
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
    <>
      {h.converted !== null && (
        <TotalCard
          t={h.converted}
          label={`All in ${h.converted.currency}`}
          wide
          foot={[...rates, ...h.converted.missing.map(missingWords)]}
        />
      )}
      <div class="pf-totals">
        {h.totals.map((t) => (
          // the converted total carries the one split, so it is not
          // repeated per currency
          <TotalCard key={t.currency} t={t} noSplit={h.converted !== null} />
        ))}
      </div>
    </>
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
          {manual ? "NAV" : h.kind === "bond" ? "Face" : "Amount"}
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

function HoldingRow({
  store,
  h,
  onTrade,
}: {
  store: PortfolioStore;
  h: Holding;
  onTrade: (s: AddStart) => void;
}) {
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
                {h.kind === "holding" ? (
                  <>
                    <span class="ins-symbol">{holdingTitle(h)}</span>
                    <span class="ins-name cut">{h.name ?? ""}</span>
                  </>
                ) : (
                  <span class="cut">{holdingTitle(h)}</span>
                )}
                {h.stale.length > 0 && (
                  <span class="tag">{staleWords(h.stale.at(-1)!)}</span>
                )}
              </>
            }
            sub={[
              h.kind === "holding"
                ? h.type
                  ? kindOf(h.type)
                  : null
                : holdingSub(h),
              line,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <span class="pf-row-end">
            <span class="pf-value">{amount(h.value, h.currency)}</span>
            <span class="pf-row-under">
              {shown &&
                shown.value !== null &&
                shown.currency !== h.currency && (
                  <span class="pf-dim pf-row-shown">
                    {amount(shown.value, shown.currency)}
                  </span>
                )}
              {pl.text && <span class={tone(pl.dir)}>{pl.text}</span>}
            </span>
          </span>
        </span>
      }
    >
      <dl class="pf-facts">
        {h.price !== null && (
          <div>
            <dt>{h.priced === "hand" ? "NAV" : "Price"}</dt>
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
      {h.kind === "holding" && h.id !== null && (
        <div class="pf-row-actions">
          {(["buy", "sell"] as const).map((side) => (
            <button
              key={side}
              type="button"
              class="btn btn-small"
              onClick={() =>
                onTrade({
                  symbol: h.id!,
                  side,
                  ...(h.parts.length === 1
                    ? {
                        portfolio: h.parts[0]!.portfolio,
                        broker: h.parts[0]!.broker,
                      }
                    : {}),
                })
              }
            >
              {side === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
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

function HoldingsCard({
  store,
  h,
  onTrade,
}: {
  store: PortfolioStore;
  h: Holdings;
  onTrade: (s: AddStart) => void;
}) {
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
            onTrade={onTrade}
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
      menus
      action={
        h.exposure.length > 1 ? (
          <Dropdown
            label="Currency"
            value={String(which.value)}
            options={h.exposure.map((x, k) => ({
              value: String(k),
              text: x.currency,
            }))}
            onPick={(v) => {
              which.value = Number(v);
            }}
          />
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
            <span
              class={`pf-side-word ${t.side === "buy" ? "pf-buy" : "pf-sell"}`}
            >
              {t.side === "buy" ? "Buy" : "Sell"}
            </span>
            <span class="ins-symbol">{symbolOf(t.symbol)}</span>
            {removed && <span class="tag">Removed</span>}
          </>
        }
        sub={
          <>
            <span class="pf-trade-size-sub">{tradeLine(t)} · </span>
            {tradeSub(t)}
          </>
        }
      />
      <span class="pf-trade-size">{tradeLine(t)}</span>
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
            class="btn-icon pf-trade-remove"
            aria-label={`Remove ${tradeTitle(t)}`}
            title="Remove"
            onClick={() => {
              asking.value = true;
            }}
          >
            <Icon name="trash" size={14} />
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
    <ul class="menu pf-found" id="pf-symbol-found">
      {ranked(found)
        .slice(0, 8)
        .map((c) => (
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
  autoFocus,
}: {
  value: Signal<string>;
  onPick: (c: Candidate) => void;
  // typed over a pick: the picked listing no longer applies
  onEdit: () => void;
  autoFocus?: boolean;
}) {
  const found = useSignal<Candidate[] | null>(null);
  const open = useSignal(false);
  // the symbol shown; value holds the picked listing's id, sent as is
  const text = useSignal(value.value === "" ? "" : symbolOf(value.value));
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
        placeholder="Symbol or name"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="pf-symbol-found"
        aria-expanded={open.value && (found.value ?? []).length > 0}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") open.value = false;
        }}
        ref={(el) => {
          if (autoFocus && el && !el.dataset.focused) {
            el.dataset.focused = "1";
            el.focus({ preventScroll: true });
          }
        }}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          value.value = text.value;
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
      {open.value && (found.value ?? []).length > 0 && (
        <FoundList
          found={found.value!}
          onPick={(c) => {
            value.value = c.id;
            text.value = symbolOf(c.id);
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
  after,
  onEdit,
}: {
  label: string;
  value: Signal<string>;
  placeholder?: string;
  type?: "text" | "date";
  decimal?: boolean;
  onEdit?: () => void;
  // a control beside the label, such as All on a sell
  after?: ComponentChildren;
}) {
  const id = useId();
  return (
    <div class="field">
      <span class="pf-field-head">
        <label class="label" for={id}>
          {label}
        </label>
        {after}
      </span>
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
            onEdit?.();
          }}
        />
      )}
    </div>
  );
}

// a labelled menu for a form, the app's own rather than a native select
function FormPick({
  label,
  value,
  options,
}: {
  label: string;
  value: Signal<string>;
  options: { value: string; text: string }[];
}) {
  return (
    <div class="field pf-form-pick">
      <span class="label">{label}</span>
      <Dropdown
        label={label}
        value={value.value}
        options={options}
        onPick={(v) => {
          value.value = v ?? "";
        }}
      />
    </div>
  );
}

const inCurrency = (label: string, c: string | null): string =>
  c ? `${label} (${c})` : label;

// the currencies a trade may be paid in: the listing's, those held, the
// display one
function paidChoices(store: PortfolioStore, listing: string | null) {
  const codes = new Set(currencies(store.holdings.value));
  const shown = store.overview.value?.display_currency;
  if (shown) codes.add(shown);
  if (listing) codes.delete(listing);
  return [listing ?? "", ...[...codes].sort()];
}

// a trade to start from: Buy or Sell on a holding's row
export type AddStart = {
  symbol: string;
  side: "buy" | "sell";
  portfolio?: string;
  broker?: string | null;
};

export function AddForm({
  store,
  onDone,
  start,
  saving,
}: {
  store: PortfolioStore;
  onDone: () => void;
  start?: AddStart | null;
  // the panel's, so it stays open while a save is on its way
  saving?: Signal<boolean>;
}) {
  const kept = remembered();
  const o = store.overview.value;
  const portfolios = o?.portfolios ?? [];
  const brokers = o?.brokers ?? [];
  const byName = (n: string | undefined) =>
    portfolios.find((p) => p.name === n)?.id;
  // the tab on, else nothing: a wrong portfolio picked silently is worse
  // than one asked for
  const tab = store.portfolio.value;
  const kind = useSignal<Remembered["kind"]>(start ? "trade" : kept.kind);
  const side = useSignal<"buy" | "sell">(start?.side ?? "buy");
  const portfolio = useSignal(String(byName(start?.portfolio) ?? tab ?? ""));
  const broker = useSignal(start?.broker ?? "");
  const symbol = useSignal(start?.symbol ?? "");
  const qty = useSignal("");
  const px = useSignal("");
  // the price came from the live quote, so a new pick may replace it
  const pxLive = useSignal(false);
  const byTotal = useSignal(false);
  const fees = useSignal("");
  const date = useSignal(today());
  const note = useSignal("");
  const name = useSignal("");
  const amountText = useSignal("");
  const currency = useSignal("");
  const picked = useSignal<Listing | null>(null);
  const paid = useSignal("");
  const cost = useSignal("");
  const coupon = useSignal("");
  const maturity = useSignal("");
  const dry = useSignal(false);
  const fromDry = useSignal(false);
  const more = useSignal(false);
  const own = useSignal(false);
  const busy = saving ?? own;
  const error = useSignal<string | null>(null);
  // the trade saved but its dry powder step failed: saving again would
  // record the trade twice, so the form only closes from here
  const half = useSignal(false);
  // the sell's quantity is the All figure: sent as "all", so the server
  // sells what is sellable on the trade's date
  const sellAll = useSignal(false);
  // a price filled from the quote is in the listing's currency: paid in
  // another, the server converts the live price itself
  useEffect(() => {
    if (pxLive.value) {
      px.value = "";
      pxLive.value = false;
    }
  }, [paid.value]);
  // every portfolio's holdings, whatever the page filters on
  const all = useSignal<Holdings | null>(null);
  useEffect(() => {
    void store.everything().then((h) => {
      all.value = h;
    });
  }, [store]);
  const pick = (id: string) => {
    picked.value = null;
    void store.listing(id).then((l) => {
      if (symbol.value !== id || l === null) return;
      picked.value = l;
      if (
        (px.value === "" || pxLive.value) &&
        l.price !== null &&
        !paid.value
      ) {
        px.value = String(l.price);
        pxLive.value = true;
      }
      // where it is held already says where more of it goes
      const parts = heldAt(all.value ?? store.holdings.value, id);
      if (parts.length === 1) {
        const pid = byName(parts[0]!.portfolio);
        if (pid !== undefined) portfolio.value = String(pid);
        if (parts[0]!.broker) broker.value = parts[0]!.broker;
      }
    });
  };
  useEffect(() => {
    if (start?.symbol) pick(start.symbol);
  }, []);
  // the holdings arrive after a start pick: place it once they do
  useEffect(() => {
    if (!all.value || !start?.symbol || start.portfolio) return;
    const parts = heldAt(all.value, start.symbol);
    if (parts.length === 1) {
      const pid = byName(parts[0]!.portfolio);
      if (pid !== undefined) portfolio.value = String(pid);
    }
  }, [all.value]);
  if (portfolios.length === 0) {
    return (
      <div class="pf-panel">
        <RowsNote>Make a portfolio first, in Settings.</RowsNote>
      </div>
    );
  }
  const listingCur = picked.value?.currency ?? null;
  const cur = paid.value || listingCur;
  const portfolioName =
    portfolios.find((p) => String(p.id) === portfolio.value)?.name ?? null;
  const parts =
    kind.value === "trade" && picked.value
      ? heldAt(all.value ?? store.holdings.value, picked.value.id)
      : [];
  const inPortfolio = parts.filter((p) => p.portfolio === portfolioName);
  const heldHere = inPortfolio.filter((p) => (p.broker ?? "") === broker.value);
  const heldQty = heldHere.reduce((s, p) => s + (p.quantity ?? 0), 0);
  // the server's all with no broker sells every broker's part too, so
  // it goes only when the parts shown are all there are
  const allMeansHere = heldHere.length === inPortfolio.length;
  const drys = dryPowders(all.value);
  const dryUse =
    side.value === "buy" ? dryPowderFor(drys, portfolioName, cur) : null;
  // the money the form will save, shown before it is
  const q = typed(qty.value);
  const p = typed(px.value);
  const f = typed(fees.value) ?? 0;
  const money =
    q === null ||
    Number.isNaN(q) ||
    p === null ||
    Number.isNaN(p) ||
    Number.isNaN(f)
      ? null
      : byTotal.value
        ? p
        : tradeMoney(side.value, q, p, f, picked.value?.unit);
  const moneyShown =
    money !== null && cur
      ? shownIn(all.value ?? store.holdings.value, money, cur)
      : null;
  const num = (s: Signal<string>, label: string, required: boolean) => {
    const v = typed(s.value);
    if (v === null && !required) return undefined;
    if (v === null || Number.isNaN(v))
      throw new Error(`${label} is not a number.`);
    return v;
  };
  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy.value || half.value) return;
    error.value = null;
    if (portfolio.value === "") {
      error.value = "Pick a portfolio.";
      return;
    }
    const pid = Number(portfolio.value);
    const b = broker.value === "" ? undefined : broker.value;
    let refused: string | null = null;
    busy.value = true;
    try {
      if (kind.value === "trade") {
        if (symbol.value.trim() === "") throw new Error("Pick a symbol.");
        const r = await store.addTrade({
          portfolio: pid,
          symbol: symbol.value.trim(),
          side: side.value,
          quantity:
            side.value === "sell" &&
            sellAll.value &&
            allMeansHere &&
            qty.value === String(heldQty)
              ? "all"
              : num(qty, "Quantity", true)!,
          ...(byTotal.value
            ? { total: num(px, "Total paid", true) }
            : { price: num(px, "Price", false) }),
          fees: num(fees, "Fees", false),
          ...(paid.value === "" ? {} : { currency: paid.value }),
          date: date.value,
          broker: b,
          ...(note.value.trim() ? { note: note.value.trim() } : {}),
        });
        if ("refused" in r) {
          refused = r.refused;
        } else if (fromDry.value && dryUse) {
          const t = r.trade;
          const spent = tradeMoney("buy", t.quantity, t.price, t.fees, t.unit);
          const left = await store.updatePosition(dryUse.position, {
            by: -spent,
            currency: t.currency,
          });
          if (left !== null) {
            refused = `The buy is saved, but the dry powder was not changed: ${left}`;
            half.value = true;
          }
        }
      } else {
        if (name.value.trim() === "") throw new Error("Name it.");
        const c = currency.value;
        refused = await store.addPosition({
          kind: kind.value,
          portfolio: pid,
          name: name.value.trim(),
          ...(c === "" ? {} : { currency: c }),
          ...(kind.value === "manual"
            ? { units: num(qty, "Units", true), price: num(px, "NAV", true) }
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
    remember({ kind: kind.value });
    onDone();
  };
  const portfolioOptions = [
    ...(portfolio.value === ""
      ? [{ value: "", text: "Pick a portfolio" }]
      : []),
    ...portfolios.map((x) => ({ value: String(x.id), text: x.name })),
  ];
  const brokerPick =
    brokers.length > 0 ? (
      <FormPick
        label="Broker"
        value={broker}
        options={[
          { value: "", text: "No broker" },
          ...brokers.map((x) => ({ value: x.name, text: x.name })),
        ]}
      />
    ) : null;
  const what =
    kind.value !== "trade"
      ? null
      : q === null || Number.isNaN(q) || !picked.value
        ? null
        : `${side.value === "buy" ? "Buy" : "Sell"} ${quantity(q)} ${symbolOf(
            picked.value.id,
          )}${
            byTotal.value
              ? ""
              : p !== null && !Number.isNaN(p)
                ? ` at ${price(p)}`
                : " at the live price"
          }${money !== null && cur ? ` · ${amount(money, cur)}` : ""}${
            moneyShown
              ? ` (≈ ${amount(moneyShown.value, moneyShown.currency)})`
              : ""
          }${portfolioName ? ` · ${portfolioName}` : ""}`;
  return (
    <form class="pf-add" onSubmit={submit} aria-label="Add">
      <div class="pf-add-body">
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
              autoFocus={!start}
              onPick={(c) => pick(c.id)}
              onEdit={() => {
                picked.value = null;
                if (pxLive.value) {
                  px.value = "";
                  pxLive.value = false;
                }
              }}
            />
            {picked.value && (
              <div class="pf-listing">
                <span class="cut">{picked.value.name ?? ""}</span>
                <span class="pf-listing-facts">
                  {picked.value.price !== null &&
                    `${price(picked.value.price, picked.value.currency)} live`}
                  {parts.length > 0 &&
                    ` · you hold ${parts
                      .map(
                        (x) =>
                          `${quantity(x.quantity)} in ${x.portfolio}${
                            x.broker ? ` at ${x.broker}` : ""
                          }`,
                      )
                      .join(", ")}`}
                </span>
              </div>
            )}
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
              <Field
                label="Quantity"
                value={qty}
                onEdit={() => {
                  sellAll.value = false;
                }}
                decimal
                after={
                  side.value === "sell" && heldQty > 0 ? (
                    <button
                      type="button"
                      class="btn-text pf-all"
                      onClick={() => {
                        qty.value = String(heldQty);
                        sellAll.value = true;
                      }}
                    >
                      All {quantity(heldQty)}
                    </button>
                  ) : undefined
                }
              />
              <Field
                label={inCurrency(byTotal.value ? "Total paid" : "Price", cur)}
                value={px}
                placeholder={byTotal.value ? "Fees in" : "Live price"}
                decimal
                onEdit={() => {
                  pxLive.value = false;
                }}
                after={
                  <button
                    type="button"
                    class="btn-text pf-all"
                    onClick={() => {
                      byTotal.value = !byTotal.value;
                      px.value = "";
                      pxLive.value = false;
                    }}
                  >
                    {byTotal.value ? "Use price" : "Use total"}
                  </button>
                }
              />
            </div>
            <Field label="Date" value={date} type="date" />
            <FormPick
              label="Portfolio"
              value={portfolio}
              options={portfolioOptions}
            />
            {dryUse && (
              <label class="pf-switch-line">
                <button
                  type="button"
                  class={`switch${fromDry.value ? " switch-on" : ""}`}
                  role="switch"
                  aria-checked={fromDry.value}
                  aria-label="Pay from dry powder"
                  onClick={() => {
                    fromDry.value = !fromDry.value;
                  }}
                >
                  <span class="switch-knob" />
                </button>
                <span>
                  Pay from dry powder ({dryUse.currency}
                  {dryUse.portfolio ? `, ${dryUse.portfolio}` : ""})
                </span>
              </label>
            )}
            <button
              type="button"
              class="btn-text pf-more"
              aria-expanded={more.value}
              onClick={() => {
                more.value = !more.value;
              }}
            >
              <Icon
                name="chevron"
                size={14}
                class={`rows-chevron${more.value ? " rows-chevron-open" : ""}`}
              />
              Fees, currency{brokers.length > 0 ? ", broker" : ""} and note
            </button>
            {more.value && (
              <>
                <div class="pf-pair">
                  <Field
                    label={inCurrency("Fees", cur)}
                    value={fees}
                    placeholder="0"
                    decimal
                  />
                  <FormPick
                    label="Paid in"
                    value={paid}
                    options={paidChoices(store, listingCur).map((c) => ({
                      value: c === listingCur ? "" : c,
                      text: c === "" ? "Listing's currency" : c,
                    }))}
                  />
                </div>
                {brokerPick}
                <Field label="Note" value={note} placeholder="Optional" />
              </>
            )}
          </>
        ) : (
          <>
            {kind.value === "manual" && (
              <p class="pf-hint">
                Enter its NAV per unit. A fund with a symbol is a trade.
              </p>
            )}
            <Field label="Name" value={name} />
            {kind.value === "manual" ? (
              <div class="pf-pair">
                <Field label="Units" value={qty} decimal />
                <Field label="NAV" value={px} decimal />
              </div>
            ) : (
              <Field
                label={kind.value === "bond" ? "Face" : "Amount"}
                value={amountText}
                decimal
              />
            )}
            <div class="pf-pair">
              <div class="field">
                <span class="label">Currency</span>
                <CurrencyPick
                  value={currency.value || null}
                  onPick={(c) => {
                    currency.value = c;
                  }}
                />
              </div>
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
            <FormPick
              label="Portfolio"
              value={portfolio}
              options={portfolioOptions}
            />
            {brokerPick}
          </>
        )}
      </div>
      <div class="pf-add-foot">
        {what && <p class="pf-summary">{what}</p>}
        {error.value && (
          <p class="pf-error" role="alert">
            {error.value}
          </p>
        )}
        <div class="pf-form-foot">
          {half.value ? (
            <button type="button" class="btn" onClick={onDone}>
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                class="btn"
                onClick={onDone}
                disabled={busy.value}
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                disabled={busy.value}
              >
                {busy.value
                  ? "Saving"
                  : kind.value === "trade"
                    ? side.value === "buy"
                      ? "Add buy"
                      : "Add sell"
                    : "Add"}
              </button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}

// the add form beside the page, a sheet from the bottom on a phone
function AddSheet({
  store,
  start,
  onDone,
}: {
  store: PortfolioStore;
  start: AddStart | null;
  onDone: () => void;
}) {
  const saving = useSignal(false);
  // the latest one, so a parent's inline function never rebinds the keys
  const done = useRef(onDone);
  done.current = onDone;
  // a save on its way finishes in sight, its outcome shown
  const close = () => {
    if (!saving.value) done.current();
  };
  useEffect(() => {
    // capture sees a menu or list still open, before its own handler
    // closes it: Escape closes that first, never the form under it
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      const open = document.querySelector(
        '.pf-sheet [aria-haspopup][aria-expanded="true"], .pf-sheet [role="combobox"][aria-expanded="true"]',
      );
      if (open) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div class="pf-sheet-wrap">
      <button
        type="button"
        class="pf-sheet-back"
        aria-label="Close"
        tabIndex={-1}
        onClick={close}
      />
      <aside class="pf-sheet" aria-label="Add">
        <div class="pf-sheet-head">
          <h2 class="pf-sheet-title">Add</h2>
          <button
            type="button"
            class="btn-icon"
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <AddForm store={store} onDone={onDone} start={start} saving={saving} />
      </aside>
    </div>
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
  // the tab on, else asked: never a silent first one
  const portfolio = useSignal(String(store.portfolio.value ?? ""));
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
    if (portfolio.value === "") {
      error.value = "Pick a portfolio.";
      return;
    }
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
        <FormPick
          label="Portfolio"
          value={portfolio}
          options={[
            ...(portfolio.value === ""
              ? [{ value: "", text: "Pick a portfolio" }]
              : []),
            ...portfolios.map((x) => ({ value: String(x.id), text: x.name })),
          ]}
        />
        <FormPick
          label="Broker for the file"
          value={broker}
          options={[
            { value: "", text: "From the file" },
            ...brokers.map((b) => ({ value: b.name, text: b.name })),
          ]}
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

// the currencies in circulation, found by code or name as typed
function CurrencyPick({
  value,
  onPick,
}: {
  value: string | null;
  onPick: (code: string) => void;
}) {
  const { open, root } = useMenu();
  const query = useSignal("");
  const found = findCurrencies(query.value);
  const named = (c: string) => {
    const n = currencyName(c);
    return n ? `${c} · ${n}` : c;
  };
  const pick = (c: string) => {
    open.value = false;
    query.value = "";
    if (c !== value) onPick(c);
  };
  return (
    <div class="pf-drop pf-currency" ref={root}>
      <button
        type="button"
        class="btn pf-drop-btn"
        aria-label={`Display currency: ${value ?? "none"}`}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
          query.value = "";
        }}
      >
        <span class="cut">{value ? named(value) : "Pick a currency"}</span>
        <Icon name="chevron" size={14} class="pf-drop-chevron" />
      </button>
      {open.value && (
        <div class="menu pf-drop-menu pf-currency-menu">
          <input
            class="pf-currency-find"
            value={query.value}
            placeholder="Code or name"
            aria-label="Find a currency"
            ref={(el) => el?.focus({ preventScroll: true })}
            onInput={(e) => {
              query.value = e.currentTarget.value;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && found[0]) {
                e.preventDefault();
                pick(found[0]);
              }
            }}
          />
          <div class="pf-currency-list" role="menu" aria-label="Currencies">
            {found.length === 0 && (
              <span class="pf-currency-none">No currency matches.</span>
            )}
            {found.map((c) => (
              <button
                key={c}
                type="button"
                class={`menu-item${c === value ? " menu-item-on" : ""}`}
                role="menuitemradio"
                aria-checked={c === value}
                onClick={() => pick(c)}
              >
                <span class="pf-currency-code">{c}</span>
                <span class="cut pf-dim">{currencyName(c) ?? ""}</span>
                {c === value && (
                  <Icon name="check" size={14} class="pf-drop-check" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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
  const error = useSignal<string | null>(null);
  // every total converts into it, so it comes before any portfolio
  const unset = !o?.display_currency;
  return (
    <section class="pf-settings" aria-label="Settings">
      <Rows>
        <RowsCard label="Display currency" menus>
          {unset && (
            <RowsNote>
              Totals are shown in this currency. Set it first.
            </RowsNote>
          )}
          <div class="rows-item pf-inline pf-add-name">
            <CurrencyPick
              value={o?.display_currency ?? null}
              onPick={async (c) => {
                error.value = await store.saveDisplay(c);
              }}
            />
            {error.value && (
              <span class="pf-error" role="alert">
                {error.value}
              </span>
            )}
          </div>
        </RowsCard>
        {!unset && (
          <>
            <RowsCard
              label="Portfolios"
              count={String(o?.portfolios.length ?? 0)}
            >
              {(o?.portfolios ?? []).map((p) => (
                <NameRow
                  key={p.id}
                  name={p.name}
                  onRename={(to) => store.renamePortfolio(p.id, to)}
                  onDelete={() => store.deletePortfolio(p.id)}
                />
              ))}
              <AddName
                placeholder="New portfolio"
                onAdd={store.createPortfolio}
              />
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
          </>
        )}
      </Rows>
      {!unset && (o?.portfolios.length ?? 0) > 0 && (
        <div class="pf-form-foot">
          <button type="button" class="btn" onClick={onDone}>
            Done
          </button>
        </div>
      )}
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

// the app's own menu in place of a native select, whose list the
// system draws
function Dropdown({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string | null;
  options: { value: string | null; text: string }[];
  onPick: (v: string | null) => void;
}) {
  const { open, root } = useMenu();
  const picked = options.find((x) => x.value === value) ?? options[0]!;
  return (
    <div class="pf-drop" ref={root}>
      <button
        type="button"
        class="btn pf-drop-btn"
        aria-label={`${label}: ${picked.text}`}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="cut">{picked.text}</span>
        <Icon name="chevron" size={14} class="pf-drop-chevron" />
      </button>
      {open.value && (
        <div class="menu pf-drop-menu" role="menu" aria-label={label}>
          {options.map((x) => (
            <button
              key={x.value ?? ""}
              type="button"
              class={`menu-item${x === picked ? " menu-item-on" : ""}`}
              role="menuitemradio"
              aria-checked={x === picked}
              onClick={() => {
                open.value = false;
                if (x !== picked) onPick(x.value);
              }}
            >
              <span class="cut">{x.text}</span>
              {x === picked && (
                <Icon name="check" size={14} class="pf-drop-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Filters({ store }: { store: PortfolioStore }) {
  const o = store.overview.value;
  const h = store.holdings.value;
  const codes = currencies(h);
  const brokers = o?.brokers ?? [];
  const fallback = h?.display_currency ?? null;
  const shownIn =
    store.currency.value === fallback ? null : store.currency.value;
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
        {brokers.length > 0 && (
          <Dropdown
            label="Broker"
            value={store.broker.value}
            options={[
              { value: null, text: "All brokers" },
              ...brokers.map((b) => ({ value: b.name, text: b.name })),
            ]}
            onPick={(v) => void store.pick({ broker: v })}
          />
        )}
        {codes.length > 1 && (
          <Dropdown
            label="Show in"
            value={shownIn}
            options={[
              ...(fallback ? [] : [{ value: null, text: "Own currencies" }]),
              ...codes.map((c) => ({
                // the settings' currency is the default, so picking it
                // clears the choice rather than listing it twice
                value: c === fallback ? null : c,
                text: `In ${c}`,
              })),
            ]}
            onPick={(v) => void store.pick({ currency: v })}
          />
        )}
      </div>
    </div>
  );
}

export function PortfoliosBody({ store }: { store: PortfolioStore }) {
  const panel = useSignal<Panel>(null);
  // a holding's Buy or Sell opens the add panel on it
  const start = useSignal<AddStart | null>(null);
  const held = store.holdings.value !== null;
  const h = store.holdings.value;
  // settings stay up until a currency and a portfolio exist
  const empty =
    (store.overview.value?.portfolios.length ?? 0) === 0 ||
    !store.overview.value?.display_currency;
  return (
    <Page
      title="Portfolios"
      actions={
        held && store.overview.value?.display_currency ? (
          <PageMenu store={store} panel={panel} />
        ) : undefined
      }
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
            <AddSheet
              key={
                start.value
                  ? `${start.value.symbol}/${start.value.side}`
                  : "new"
              }
              store={store}
              start={start.value}
              onDone={() => {
                panel.value = null;
                start.value = null;
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
                <HoldingsCard
                  store={store}
                  h={h}
                  onTrade={(s) => {
                    start.value = s;
                    panel.value = "add";
                  }}
                />
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
