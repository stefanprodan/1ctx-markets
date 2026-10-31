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
  FundTradeIn,
  Holding,
  Holdings,
  Imported,
  Listing,
  PortfolioStore,
  PositionIn,
  Total,
  TradeIn,
  TradeRow,
} from "../data/portfolios.ts";
import { JUST_SAVED } from "../data/portfolios.ts";
import { type Candidate, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import { useRefresh } from "../lib/refresh.ts";
import { didNotLoad, Page } from "../ui/Page.tsx";
import {
  Rows,
  RowsCard,
  RowsLine,
  RowsMore,
  RowsNote,
  RowsTitle,
} from "../ui/Rows.tsx";
import { RowsOpen } from "../ui/RowsOpen.tsx";
import { searcher } from "./Dashboard.model.ts";
import { kindOf, symbolOf } from "./Instruments.model.ts";
import {
  ADD_KEY,
  amount,
  brokerName,
  browserZone,
  change,
  costLine,
  currencies,
  currencyGain,
  day,
  dryPowderFor,
  dryPowders,
  EXPOSURE_TABS,
  type ExposureTab,
  findZones,
  heldAt,
  holdingSub,
  holdingTitle,
  IMPORT_KINDS,
  importLine,
  importReason,
  importStatus,
  largestFirst,
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
  tradeName,
  tradeSub,
  tradeTitle,
  typed,
  whole,
  zoneWords,
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
  corner,
}: {
  t: Total;
  label?: string;
  wide?: boolean;
  foot?: string[];
  corner?: ComponentChildren;
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
      <span class="pf-total-head">
        <span class="label">{label ?? t.currency}</span>
        {corner}
      </span>
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
            aria-label="Invested, reserve and dry powder"
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

function Totals({ store, h }: { store: PortfolioStore; h: Holdings }) {
  if (h.holdings.length === 0) return null;
  const rates = h.rates
    .map((r) => rateLine(r))
    .filter((r): r is string => r !== null);
  const codes = currencies(h);
  const fallback = h.display_currency ?? null;
  return (
    <>
      {h.converted !== null && (
        <TotalCard
          t={h.converted}
          label="Total"
          wide
          foot={[...rates, ...h.converted.missing.map(missingWords)]}
          corner={
            codes.length > 1 ? (
              <Dropdown
                chip
                label="Show in"
                right
                value={
                  store.currency.value === fallback
                    ? null
                    : store.currency.value
                }
                options={[
                  ...(fallback ? [] : [{ value: null, text: "Own" }]),
                  ...codes.map((c) => ({
                    // the settings' currency is the default, so picking
                    // it clears the choice rather than listing it twice
                    value: c === fallback ? null : c,
                    text: c,
                  })),
                ]}
                onPick={(v) => void store.pick({ currency: v })}
              />
            ) : undefined
          }
        />
      )}
      {/* one total, as a portfolio is read; each currency's own gain is
          in the exposure by currency, so cards per currency only stand in
          when nothing converts */}
      {h.converted === null && (
        <div class="pf-totals">
          {h.totals.map((t) => (
            <TotalCard key={t.currency} t={t} />
          ))}
        </div>
      )}
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
  // the stored amount, never the value rounded for show
  const first = useSignal(String(h.parts[0]?.amount ?? ""));
  // a new figure is true today; a bond's date is its purchase, kept
  const now = today(store.overview.value?.time_zone ?? null);
  const date = useSignal(h.kind === "bond" ? (h.as_of ?? now) : now);
  const markets = store.overview.value?.markets ?? [];
  const market = useSignal(h.market ?? "");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const save = async (ev: Event) => {
    ev.preventDefault();
    const n = typed(first.value);
    if (n === null || Number.isNaN(n)) {
      error.value = "Not a number.";
      return;
    }
    busy.value = true;
    error.value = await store.updatePosition(h.position!, {
      amount: n,
      date: date.value,
      ...(market.value === (h.market ?? "")
        ? {}
        : { market: market.value === "" ? null : market.value }),
    });
    busy.value = false;
    if (error.value === null) onDone();
  };
  return (
    <form class="pf-edit" onSubmit={save}>
      <label class="field">
        <span class="label">{h.kind === "bond" ? "Face" : "Amount"}</span>
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
      {h.kind !== "bond" && markets.length > 0 && (
        <MarketPick value={market} markets={markets} />
      )}
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

// a fund's price for a day (a day already priced takes the new one), and
// its name set right
export function FundPriceEdit({
  store,
  h,
  onDone,
}: {
  store: PortfolioStore;
  h: Holding;
  onDone: () => void;
}) {
  const px = useSignal(String(h.price ?? ""));
  const now = today(store.overview.value?.time_zone ?? null);
  const date = useSignal(now);
  const name = useSignal(h.name ?? "");
  const markets = store.overview.value?.markets ?? [];
  const market = useSignal(h.market ?? "");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const save = async (ev: Event) => {
    ev.preventDefault();
    // only a price typed or a day picked is sent, so a rename or a market
    // alone never turns the shown price into one the owner entered
    const repriced = px.value !== String(h.price ?? "") || date.value !== now;
    const n = typed(px.value);
    if (repriced && (n === null || Number.isNaN(n))) {
      error.value = "Not a number.";
      return;
    }
    const named = name.value.trim();
    if (named === "") {
      error.value = "Name the fund.";
      return;
    }
    const renamed = named !== (h.name ?? "");
    const moved = market.value !== (h.market ?? "");
    if (!repriced && !renamed && !moved) {
      onDone();
      return;
    }
    busy.value = true;
    error.value = await store.setFundPrice(h.isin!, {
      ...(repriced ? { price: n!, date: date.value } : {}),
      ...(renamed ? { name: named } : {}),
      ...(moved ? { market: market.value === "" ? null : market.value } : {}),
    });
    busy.value = false;
    if (error.value === null) onDone();
  };
  return (
    <form class="pf-edit" onSubmit={save}>
      <label class="field">
        <span class="label">Name</span>
        <input
          value={name.value}
          onInput={(e) => {
            name.value = e.currentTarget.value;
          }}
        />
      </label>
      <label class="field">
        <span class="label">Price per unit</span>
        <input
          inputMode="decimal"
          value={px.value}
          onInput={(e) => {
            px.value = e.currentTarget.value;
          }}
        />
      </label>
      <label class="field">
        <span class="label">Date</span>
        <input
          type="date"
          value={date.value}
          onInput={(e) => {
            date.value = e.currentTarget.value;
          }}
        />
      </label>
      {markets.length > 0 && <MarketPick value={market} markets={markets} />}
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

// Buy and Sell as a share's, and its price set by its owner
export function FundActions({
  h,
  store,
  onTrade,
}: {
  h: Holding;
  store: PortfolioStore;
  onTrade: (s: AddStart) => void;
}) {
  const pricing = useSignal(false);
  if (pricing.value) {
    return (
      <div class="pf-row-actions">
        <FundPriceEdit
          store={store}
          h={h}
          onDone={() => {
            pricing.value = false;
          }}
        />
      </div>
    );
  }
  const where =
    h.parts.length === 1
      ? { portfolio: h.parts[0]!.portfolio, broker: h.parts[0]!.broker }
      : {};
  return (
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
              fund: {
                isin: h.isin!,
                name: h.name ?? h.isin!,
                market: h.market,
              },
              ...where,
            })
          }
        >
          {side === "buy" ? "Buy" : "Sell"}
        </button>
      ))}
      <button
        type="button"
        class="btn btn-small"
        onClick={() => {
          pricing.value = true;
        }}
      >
        Set price
      </button>
    </div>
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
  const one = h.parts.length === 1 ? h.parts[0]! : null;
  const sold = h.sold_today === true;
  const today = change(h.day_change, h.currency);
  return (
    <RowsOpen
      open={open.value}
      onToggle={() => {
        open.value = !open.value;
      }}
      indent="chevron"
      head={
        <span class={`pf-row${sold ? " pf-sold" : ""}`}>
          <RowsTitle
            wrap
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
            sub={whole(
              [
                h.kind === "holding"
                  ? h.type
                    ? kindOf(h.type)
                    : null
                  : holdingSub(h),
                sold ? "Sold today" : line,
              ]
                .filter(Boolean)
                .join(" · "),
            )}
          />
          {sold ? (
            <span class="pf-row-end">
              <span class="pf-value">
                <span class={tone(today.dir)}>{today.text}</span>
              </span>
            </span>
          ) : (
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
          )}
        </span>
      }
    >
      <dl class="pf-facts">
        {h.price !== null && (
          <div>
            <dt>{h.priced === "hand" ? "Price per unit" : "Price"}</dt>
            <dd>
              {price(h.price, h.kind === "bond" ? null : h.currency)}
              {h.kind === "bond" ? "%" : ""}
            </dd>
          </div>
        )}
        {sold && (
          <div>
            <dt>Today</dt>
            <dd class={tone(today.dir)}>{today.text}</dd>
          </div>
        )}
        {!sold && h.cost !== null && h.kind !== "cash" && (
          <div>
            <dt>Cost</dt>
            <dd>{amount(h.cost, h.currency)}</dd>
          </div>
        )}
        {!sold && h.pl !== null && (
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
        {!sold && h.currency_weight !== null && (
          <div>
            <dt>Weight</dt>
            <dd>{h.currency_weight.toFixed(1)}%</dd>
          </div>
        )}
        {h.kind === "cash" && h.as_of && (
          <div>
            <dt>As of</dt>
            <dd>{day(h.as_of)}</dd>
          </div>
        )}
        {/* held in one place: where, as two facts rather than a table */}
        {one && (
          <>
            {/* a portfolio's own tab already names it */}
            {store.portfolio.value === null && (
              <div>
                <dt>Portfolio</dt>
                <dd>{one.portfolio}</dd>
              </div>
            )}
            <div>
              <dt>Broker</dt>
              <dd>{brokerName(one.broker)}</dd>
            </div>
          </>
        )}
      </dl>
      {(h.kind === "holding" || h.kind === "fund") && h.parts.length > 1 && (
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
                  <span class="pf-dim pf-part-portfolio">{p.portfolio}</span>
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
          {(sold ? (["buy"] as const) : (["buy", "sell"] as const)).map(
            (side) => (
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
            ),
          )}
        </div>
      )}
      {h.kind === "fund" && h.id !== null && h.isin && (
        <FundActions h={h} store={store} onTrade={onTrade} />
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
        largestFirst(h.holdings).map((x) => (
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
  // a split with one share says nothing: no currency weights, or every
  // holding with no broker
  const tabs = EXPOSURE_TABS.filter(
    (t) =>
      (t.key !== "currency" || e.currency_weights !== null) &&
      (t.key !== "broker" || e.broker.length > 1),
  );
  // a tab hidden by a filter falls back to the first one shown
  const on = tabs.some((t) => t.key === tab.value) ? tab.value : tabs[0]!.key;
  const list = on === "currency" ? (e.currency_weights ?? []) : e[on];
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
                aria-selected={on === t.key}
                class={`seg-option${on === t.key ? " seg-on" : ""}`}
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
      <ul class={`pf-bars${on === "currency" ? " pf-bars-gain" : ""}`}>
        {list.map((s) => {
          const gain = on === "currency" ? currencyGain(h.totals, s.key) : null;
          return (
            <li key={s.key ?? ""}>
              <span class="pf-bar-label cut">{shareLabel(on, s.key)}</span>
              <span class="pf-bar">
                <span style={{ width: `${s.weight}%` }} />
              </span>
              <span class="pf-bar-pct">{s.weight.toFixed(1)}%</span>
              {gain && (
                <span class={`pf-bar-gain ${tone(gain.dir) ?? ""}`}>
                  {gain.text}
                </span>
              )}
            </li>
          );
        })}
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
        wrap
        name={
          <>
            <span
              class={`pf-side-word ${t.side === "buy" ? "pf-buy" : "pf-sell"}`}
            >
              {t.side === "buy" ? "Buy" : "Sell"}
            </span>
            <span class="ins-symbol">{tradeName(t)}</span>
            {removed && <span class="tag">Removed</span>}
          </>
        }
        sub={
          <>
            <span class="pf-trade-size-sub">{whole(tradeLine(t))} · </span>
            {whole(tradeSub(t))}
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
        <RowsMore
          onClick={() => {
            all.value = true;
          }}
        >
          Show all {list.length}
        </RowsMore>
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

const KIND_TITLES = {
  trade: "Add trade",
  cash: "Add cash",
  fund: "Add fund",
  bond: "Add bond",
} as const;

const KIND_LABELS = [
  { key: "trade", label: "Trade" },
  { key: "cash", label: "Cash" },
  { key: "fund", label: "Fund" },
  { key: "bond", label: "Bond" },
] as const;

function Field({
  label,
  value,
  placeholder,
  type = "text",
  decimal,
  after,
  tag,
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
  tag?: ComponentChildren;
}) {
  const id = useId();
  return (
    <div class="field">
      <span class="pf-field-head">
        <span class="pf-field-label">
          <label class="label" for={id}>
            {label}
          </label>
          {tag}
        </span>
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
  onPick,
}: {
  label: string;
  value: Signal<string>;
  options: { value: string; text: string }[];
  onPick?: () => void;
}) {
  return (
    <div class="field pf-form-pick">
      <span class="pf-field-head">
        <span class="label">{label}</span>
      </span>
      <Dropdown
        label={label}
        value={value.value}
        options={options}
        onPick={(v) => {
          value.value = v ?? "";
          onPick?.();
        }}
      />
    </div>
  );
}

// a refused retry offers to save a second equal fill
export function Refusal({
  text,
  busy,
  onAgain,
}: {
  text: string;
  busy: boolean;
  onAgain: (ev: Event) => void;
}) {
  return (
    <p class="pf-error" role="alert">
      {text}
      {text === JUST_SAVED && (
        <>
          {" "}
          <button
            type="button"
            class="btn btn-small"
            disabled={busy}
            onClick={onAgain}
          >
            Save again
          </button>
        </>
      )}
    </p>
  );
}

// the markets instruments are in, so a fund counts in the one it holds
function MarketPick({
  value,
  markets,
}: {
  value: Signal<string>;
  markets: readonly string[];
}) {
  return (
    <FormPick
      label="Market"
      value={value}
      options={[
        { value: "", text: "None" },
        ...markets.map((x) => ({ value: x, text: x })),
      ]}
    />
  );
}

// back: what closing the name field returns to, null with nothing to pick
function PickOrNew({
  label,
  value,
  name,
  placeholder,
  back,
  options,
  onEdit,
}: {
  label: string;
  value: Signal<string>;
  name: Signal<string>;
  placeholder: string;
  back: string | null;
  options: { value: string; text: string }[];
  onEdit: () => void;
}) {
  const id = useId();
  if (value.value !== NEW) {
    return (
      <FormPick label={label} value={value} options={options} onPick={onEdit} />
    );
  }
  return (
    <div class="field">
      <span class="pf-field-head">
        <label class="label" for={id}>
          {label}
        </label>
      </span>
      <span class="pf-new">
        <input
          id={id}
          value={name.value}
          placeholder={placeholder}
          autocomplete="off"
          ref={(el) => {
            // only when picked: a form opening on it keeps the symbol's focus
            if (el && back !== null && !el.dataset.focused) {
              el.dataset.focused = "1";
              el.focus({ preventScroll: true });
            }
          }}
          onInput={(ev) => {
            name.value = ev.currentTarget.value;
            onEdit();
          }}
        />
        {back !== null && (
          <button
            type="button"
            class="btn-icon pf-new-back"
            aria-label={`Pick a ${label.toLowerCase()}`}
            onClick={() => {
              name.value = "";
              value.value = back;
              onEdit();
            }}
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </span>
    </div>
  );
}

// the picker's choice that names a new portfolio or broker in the form
const NEW = "\u0000new";

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

// a trade to start from: Buy or Sell on a holding's row; a fund's opens
// the Fund tab on it
export type AddStart = {
  symbol: string;
  side: "buy" | "sell";
  portfolio?: string;
  broker?: string | null;
  fund?: { isin: string; name: string; market: string | null };
};

export function AddForm({
  store,
  onDone,
  start,
  saving,
  title,
  kind: opened,
}: {
  store: PortfolioStore;
  onDone: () => void;
  start?: AddStart | null;
  // the panel's, so it stays open while a save is on its way
  saving?: Signal<boolean>;
  title?: Signal<string>;
  // opened on this kind: the kind last saved does not apply
  kind?: Remembered["kind"];
}) {
  const kept = remembered();
  const o = store.overview.value;
  const portfolios = o?.portfolios ?? [];
  const brokers = o?.brokers ?? [];
  const byName = (n: string | undefined) =>
    portfolios.find((p) => p.name === n)?.id;
  // the tab on, else the only one, else asked: a wrong portfolio picked
  // silently is worse than one asked for
  const tab = store.portfolio.value;
  const only = portfolios.length === 1 ? portfolios[0]!.id : undefined;
  const kind = useSignal<Remembered["kind"]>(
    start ? (start.fund ? "fund" : "trade") : (opened ?? kept.kind),
  );
  const side = useSignal<"buy" | "sell">(start?.side ?? "buy");
  const portfolio = useSignal(
    portfolios.length === 0
      ? NEW
      : String(byName(start?.portfolio) ?? tab ?? only ?? ""),
  );
  const broker = useSignal(
    start ? (start.broker ?? "") : brokers.length === 1 ? brokers[0]!.name : "",
  );
  const newPortfolio = useSignal("");
  const newBroker = useSignal("");
  const where = useSignal<string | null>(null);
  const chosen = useSignal(Boolean(start?.symbol));
  const again = useSignal(false);
  const symbol = useSignal(start?.symbol ?? "");
  const qty = useSignal("");
  const px = useSignal("");
  // the price came from the live quote, so a new pick may replace it
  const pxLive = useSignal(false);
  const byTotal = useSignal(false);
  const fees = useSignal("");
  const date = useSignal(today(o?.time_zone ?? null));
  const note = useSignal("");
  const name = useSignal("");
  const amountText = useSignal("");
  const currency = useSignal("");
  const picked = useSignal<Listing | null>(null);
  const paid = useSignal("");
  const cost = useSignal("");
  const coupon = useSignal("");
  const maturity = useSignal("");
  // cash set aside for buying is what is added most
  const dry = useSignal(true);
  // the market a fund's shares are in; none unless picked
  const market = useSignal(start?.fund?.market ?? "");
  const isin = useSignal(start?.fund?.isin ?? "");
  const payFrom = useSignal("");
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
        !paid.value &&
        !byTotal.value
      ) {
        px.value = String(l.price);
        pxLive.value = true;
      }
      // where it is held already says where more of it goes
      // a new portfolio or broker being named is the owner's choice
      const parts = heldAt(all.value ?? store.holdings.value, id);
      if (parts.length === 1) {
        const pid = byName(parts[0]!.portfolio);
        if (pid !== undefined && portfolio.value !== NEW) {
          portfolio.value = String(pid);
          error.value = null;
        }
        if (broker.value !== NEW) {
          broker.value = parts[0]!.broker ?? "";
          error.value = null;
        }
      }
    });
  };
  useEffect(() => {
    // a fund has no listing to read
    if (start?.symbol && !start.fund) pick(start.symbol);
  }, []);
  // the holdings arrive after a start pick: place it once they do
  useEffect(() => {
    if (!all.value || !start?.symbol || start.portfolio) return;
    const parts = heldAt(all.value, start.symbol);
    if (parts.length === 1) {
      const pid = byName(parts[0]!.portfolio);
      if (pid !== undefined) {
        portfolio.value = String(pid);
        error.value = null;
      }
    }
  }, [all.value]);
  // by the pickers, not an effect: the save switches them itself
  const clear = () => {
    error.value = null;
  };
  useEffect(() => {
    if (title) title.value = KIND_TITLES[kind.value];
  }, [kind.value]);
  const listingCur = picked.value?.currency ?? null;
  const cur = paid.value || listingCur;
  const portfolioName =
    portfolio.value === NEW
      ? newPortfolio.value.trim() || null
      : (portfolios.find((p) => String(p.id) === portfolio.value)?.name ??
        null);
  // a fund kept, named by the ISIN typed: its name and currency stand
  const code = isin.value.trim().toUpperCase();
  const knownFund =
    code === ""
      ? null
      : ((o?.funds ?? []).find((x) => x.isin === code) ?? null);
  const heldId =
    kind.value === "trade"
      ? picked.value?.id
      : kind.value === "fund"
        ? knownFund?.id
        : undefined;
  const shown = all.value ?? store.holdings.value;
  const parts = heldId ? heldAt(shown, heldId) : [];
  const inPortfolio = parts.filter((p) => p.portfolio === portfolioName);
  const heldHere = inPortfolio.filter((p) => (p.broker ?? "") === broker.value);
  const heldQty = heldHere.reduce((s, p) => s + (p.quantity ?? 0), 0);
  // the server refuses a sell of what is not held; a holding's own Sell
  // is trusted until its listing loads
  const sellable =
    kind.value === "fund"
      ? shown === null
        ? Boolean(start?.fund)
        : (portfolio.value === "" ? parts : inPortfolio).some(
            (x) => (x.quantity ?? 0) > 0,
          )
      : kind.value !== "trade" ||
        (picked.value === null
          ? Boolean(start?.symbol) && chosen.value
          : (portfolio.value === "" ? parts : inPortfolio).some(
              (x) => (x.quantity ?? 0) > 0,
            ));
  useEffect(() => {
    if (!sellable && side.value === "sell") side.value = "buy";
  }, [sellable]);
  // the server's all with no broker sells every broker's part too, so
  // then it goes only when the parts shown are all there are
  const allMeansHere =
    broker.value !== "" || heldHere.length === inPortfolio.length;
  const drys = dryPowders(all.value);
  const dryUse =
    side.value === "buy" && cur ? dryPowderFor(drys, portfolioName, cur) : null;
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
        : kind.value === "fund"
          ? q * p
          : tradeMoney(side.value, q, p, f, picked.value?.unit);
  const moneyShown =
    money !== null && cur
      ? shownIn(all.value ?? store.holdings.value, money, cur)
      : null;
  // the server's own bounds, so a refusal comes before anything is made
  const num = (
    s: Signal<string>,
    label: string,
    required: boolean,
    min: "above" | "zero" | null = "zero",
  ) => {
    const v = typed(s.value);
    if (v === null && !required) return undefined;
    if (v === null || Number.isNaN(v))
      throw new Error(`${label} is not a number.`);
    if (min === "above" && v <= 0) throw new Error(`${label} must be above 0.`);
    if (min === "zero" && v < 0) throw new Error(`${label} can't be negative.`);
    return v;
  };
  // what is saved, read once: fields edited while it saves change nothing
  const body = ():
    | { trade: Omit<TradeIn, "portfolio" | "broker"> }
    | { fund: Omit<FundTradeIn, "portfolio" | "broker"> }
    | { position: Omit<PositionIn, "portfolio" | "broker"> } => {
    if (kind.value === "fund") {
      if (code === "") throw new Error("Give the ISIN.");
      if (!knownFund && name.value.trim() === "") {
        throw new Error("Name the fund.");
      }
      if (!knownFund && currency.value === "") {
        throw new Error("Pick a currency.");
      }
      const all =
        side.value === "sell" &&
        sellAll.value &&
        allMeansHere &&
        qty.value === String(heldQty);
      const units = num(qty, "Units", true, "above")!;
      return {
        fund: {
          isin: code,
          ...(knownFund
            ? {}
            : { name: name.value.trim(), currency: currency.value }),
          side: side.value,
          units: all ? "all" : units,
          ...(byTotal.value
            ? { total: num(px, "Total paid", true) }
            : { price: num(px, "Price per unit", true) }),
          date: date.value,
          ...(market.value !== "" && market.value !== (knownFund?.market ?? "")
            ? { market: market.value }
            : {}),
          ...(note.value.trim() ? { note: note.value.trim() } : {}),
        },
      };
    }
    if (kind.value === "trade") {
      if (symbol.value.trim() === "") throw new Error("Pick a symbol.");
      const all =
        side.value === "sell" &&
        sellAll.value &&
        allMeansHere &&
        qty.value === String(heldQty);
      const quantity = num(qty, "Quantity", true, "above")!;
      return {
        trade: {
          symbol: symbol.value.trim(),
          side: side.value,
          quantity: all ? "all" : quantity,
          ...(byTotal.value
            ? { total: num(px, "Total paid", true) }
            : { price: num(px, "Price", false) }),
          fees: num(fees, "Fees", false),
          ...(paid.value === "" ? {} : { currency: paid.value }),
          date: date.value,
          ...(note.value.trim() ? { note: note.value.trim() } : {}),
        },
      };
    }
    if (name.value.trim() === "") throw new Error("Name it.");
    const c = currency.value;
    if (c === "" && !(kind.value === "bond" && symbol.value.trim()))
      throw new Error("Pick a currency.");
    return {
      position: {
        kind: kind.value,
        name: name.value.trim(),
        ...(c === "" ? {} : { currency: c }),
        amount: num(
          amountText,
          kind.value === "bond" ? "Face" : "Amount",
          true,
          kind.value === "bond" ? "above" : "zero",
        ),
        ...(kind.value !== "cash" ? { cost: num(cost, "Cost", false) } : {}),
        ...(kind.value === "bond"
          ? {
              coupon: num(coupon, "Coupon", false, null),
              ...(maturity.value ? { maturity: maturity.value } : {}),
              ...(symbol.value.trim() ? { symbol: symbol.value.trim() } : {}),
            }
          : {}),
        ...(kind.value === "cash" && dry.value ? { dry_powder: true } : {}),
        ...(kind.value !== "bond" && market.value
          ? { market: market.value }
          : {}),
        date: date.value,
      },
    };
  };
  // twice: the owner said a refused equal trade is a second fill
  const submit = async (ev: Event, twice = false) => {
    ev.preventDefault();
    if (busy.value || half.value) return;
    error.value = null;
    if (portfolio.value === "") {
      error.value = "Pick a portfolio.";
      return;
    }
    if (portfolio.value === NEW && newPortfolio.value.trim() === "") {
      error.value = "Name the portfolio.";
      return;
    }
    if (broker.value === NEW && newBroker.value.trim() === "") {
      error.value = "Name the broker.";
      return;
    }
    let out: ReturnType<typeof body>;
    try {
      out = body();
    } catch (e) {
      error.value = (e as Error).message;
      return;
    }
    const payDry = payFrom.value === "dry" ? dryUse : null;
    let refused: string | null = null;
    busy.value = true;
    try {
      // a new portfolio or broker is made first, so a refused trade
      // leaves it picked for the next try rather than made twice
      if (portfolio.value === NEW) {
        const n = newPortfolio.value.trim();
        const no = await store.createPortfolio(n);
        if (no !== null) throw new Error(no);
        const find = () =>
          store.overview.value?.portfolios.find((p) => p.name === n);
        // a newer load may have answered for the one after the create
        if (!find()) await store.load();
        const made = find();
        if (!made)
          throw new Error("The portfolio was not made. Reload the page.");
        portfolio.value = String(made.id);
        newPortfolio.value = "";
      }
      if (broker.value === NEW) {
        const n = newBroker.value.trim();
        const no = await store.createBroker(n);
        if (no !== null) throw new Error(no);
        broker.value = n;
        newBroker.value = "";
      }
    } catch (e) {
      busy.value = false;
      error.value = (e as Error).message;
      return;
    }
    const pid = Number(portfolio.value);
    const b = broker.value === "" ? undefined : broker.value;
    if ("trade" in out) {
      const r = await store.addTrade({
        ...out.trade,
        portfolio: pid,
        broker: b,
        ...(twice ? { again: true } : {}),
      });
      if ("refused" in r) {
        refused = r.refused;
      } else if (payDry) {
        const t = r.trade;
        const spent = tradeMoney("buy", t.quantity, t.price, t.fees, t.unit);
        const left = await store.updatePosition(payDry.position, {
          by: -spent,
          currency: t.currency,
        });
        if (left !== null) {
          refused = `The buy is saved, but the dry powder was not changed: ${left}`;
          half.value = true;
        }
      }
    } else if ("fund" in out) {
      refused = await store.addFundTrade({
        ...out.fund,
        portfolio: pid,
        broker: b,
        ...(twice ? { again: true } : {}),
      });
    } else {
      refused = await store.addPosition({
        ...out.position,
        portfolio: pid,
        broker: b,
      });
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
    { value: NEW, text: "New portfolio…" },
  ];
  const portfolioBack = only !== undefined ? String(only) : "";
  const marketPick = (o?.markets ?? []).length > 0 && (
    <div class="pf-pair">
      <MarketPick value={market} markets={o?.markets ?? []} />
    </div>
  );
  const placePicks = (
    <div class="pf-pair">
      <PickOrNew
        label="Portfolio"
        value={portfolio}
        name={newPortfolio}
        placeholder="Long term"
        back={portfolios.length === 0 ? null : portfolioBack}
        options={portfolioOptions}
        onEdit={clear}
      />
      <PickOrNew
        label="Broker"
        value={broker}
        name={newBroker}
        placeholder="Name"
        back=""
        options={[
          { value: "", text: "No broker" },
          ...brokers.map((x) => ({ value: x.name, text: x.name })),
          { value: NEW, text: "New broker…" },
        ]}
        onEdit={clear}
      />
    </div>
  );
  const brokerShown =
    broker.value === NEW ? newBroker.value.trim() : broker.value;
  const place = portfolioName
    ? ` · ${portfolioName}${brokerShown ? ` at ${brokerShown}` : ""}`
    : brokerShown
      ? ` · ${brokerShown}`
      : "";
  const n = typed(amountText.value);
  const nOk = n !== null && !Number.isNaN(n);
  const named = name.value.trim();
  const posCur = currency.value;
  const what =
    kind.value === "trade"
      ? q === null || Number.isNaN(q) || !picked.value
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
          }${place}`
      : kind.value === "cash"
        ? nOk && posCur
          ? `${named ? `${named} · ` : ""}${amount(n, posCur)}${
              dry.value ? " dry powder" : " reserve"
            }${place}`
          : null
        : kind.value === "fund"
          ? (knownFund?.name ?? named) && q !== null && !Number.isNaN(q)
            ? `${side.value === "buy" ? "Buy" : "Sell"} ${quantity(q)} ${q === 1 ? "unit" : "units"} of ${
                knownFund?.name ?? named
              }${
                byTotal.value || p === null || Number.isNaN(p)
                  ? ""
                  : ` at ${price(p, knownFund?.currency ?? (posCur || null))}`
              }${
                money !== null && (knownFund?.currency ?? posCur)
                  ? ` · ${amount(money, knownFund?.currency ?? posCur)}`
                  : ""
              }${place}`
            : null
          : named && nOk && posCur
            ? `${named} · ${amount(n, posCur)} face${place}`
            : null;
  const currencyField = (
    <div class="field">
      <span class="pf-field-head">
        <span class="label">Currency</span>
      </span>
      <CurrencyPick
        label="Currency"
        value={currency.value || null}
        onPick={(c) => {
          currency.value = c;
        }}
      />
    </div>
  );
  const sides = (
    <div class="seg pf-side">
      {(["buy", "sell"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={side.value === s}
          disabled={s === "sell" && !sellable}
          class={`seg-option${side.value === s ? ` seg-on pf-side-${s}` : ""}`}
          onClick={() => {
            side.value = s;
          }}
        >
          {s === "buy" ? "Buy" : "Sell"}
        </button>
      ))}
    </div>
  );
  const allButton =
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
    ) : undefined;
  const totalToggle = (
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
  );
  const unpick = () => {
    chosen.value = false;
    again.value = true;
    symbol.value = "";
    picked.value = null;
    where.value = null;
    if (pxLive.value) {
      px.value = "";
      pxLive.value = false;
    }
  };
  return (
    <form class="pf-add" onSubmit={submit} aria-label={KIND_TITLES[kind.value]}>
      <div class="pf-add-body">
        <div class="pf-kind-tabs" role="tablist" aria-label="What to add">
          {KIND_LABELS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="tab"
              aria-selected={kind.value === k.key}
              class={`pf-kind-tab${kind.value === k.key ? " pf-kind-on" : ""}`}
              onClick={() => {
                if (kind.value === k.key) return;
                // a trade's listing and a bond's share the symbol field
                unpick();
                again.value = false;
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
            {chosen.value ? (
              <div class="field">
                <span class="pf-field-head">
                  <span class="label">Symbol</span>
                </span>
                <div class="pf-chosen">
                  <span class="pf-chosen-main">
                    <span class="ins-symbol">{symbolOf(symbol.value)}</span>
                    <span class="cut pf-dim">{picked.value?.name ?? ""}</span>
                    <button
                      type="button"
                      class="btn-icon pf-chosen-x"
                      aria-label="Change symbol"
                      onClick={unpick}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                  {picked.value && (
                    <span class="rows-list-hint">
                      {[
                        where.value,
                        picked.value.price !== null
                          ? `${price(picked.value.price, picked.value.currency)} live`
                          : null,
                        parts.length > 0
                          ? `you hold ${parts
                              .map(
                                (x) =>
                                  `${quantity(x.quantity)} in ${x.portfolio}${
                                    x.broker ? ` at ${x.broker}` : ""
                                  }`,
                              )
                              .join(", ")}`
                          : all.value
                            ? "not held"
                            : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <SymbolPick
                value={symbol}
                autoFocus={!start || again.value}
                onPick={(c) => {
                  chosen.value = true;
                  where.value =
                    listingWords({
                      id: c.id,
                      exchange_name: c.exchange_name,
                    }) || null;
                  pick(c.id);
                }}
                onEdit={() => {
                  picked.value = null;
                  where.value = null;
                  if (pxLive.value) {
                    px.value = "";
                    pxLive.value = false;
                  }
                }}
              />
            )}
            {sides}
            <div class="pf-pair">
              <Field
                label="Quantity"
                value={qty}
                onEdit={() => {
                  sellAll.value = false;
                }}
                decimal
                after={allButton}
              />
              <Field
                label={byTotal.value ? "Total paid" : "Price"}
                tag={
                  listingCur ? (
                    <Dropdown
                      chip
                      label="Paid in"
                      value={paid.value}
                      options={paidChoices(store, listingCur).map((c) => ({
                        value: c === listingCur ? "" : c,
                        text: c === "" ? "?" : c,
                      }))}
                      onPick={(v) => {
                        paid.value = v ?? "";
                      }}
                    />
                  ) : undefined
                }
                value={px}
                placeholder={byTotal.value ? "Fees in" : "Live price"}
                decimal
                onEdit={() => {
                  pxLive.value = false;
                }}
                after={totalToggle}
              />
            </div>
            <div class="pf-pair">
              <Field label="Date" value={date} type="date" />
              <Field
                label={inCurrency("Fees", cur)}
                value={fees}
                placeholder="0"
                decimal
              />
            </div>
            {placePicks}
            {dryUse ? (
              <div class="pf-pair">
                <FormPick
                  label="Dry powder"
                  value={payFrom}
                  options={[
                    { value: "", text: "Not used" },
                    {
                      value: "dry",
                      text: `Pay from ${dryUse.currency}${
                        dryUse.portfolio ? ` · ${dryUse.portfolio}` : ""
                      }`,
                    },
                  ]}
                />
                <Field label="Note" value={note} placeholder="Optional" />
              </div>
            ) : (
              <Field label="Note" value={note} placeholder="Optional" />
            )}
          </>
        ) : kind.value === "cash" ? (
          <>
            <div class="seg pf-side">
              {[true, false].map((d) => (
                <button
                  key={String(d)}
                  type="button"
                  aria-pressed={dry.value === d}
                  class={`seg-option${dry.value === d ? " seg-on" : ""}`}
                  onClick={() => {
                    dry.value = d;
                  }}
                >
                  {d ? "Dry powder" : "Reserve"}
                </button>
              ))}
            </div>
            <div class="pf-pair">
              <Field label="Name" value={name} />
              <Field label="Amount" value={amountText} decimal />
            </div>
            <div class="pf-pair">
              {currencyField}
              <Field label="As of" value={date} type="date" />
            </div>
            {marketPick}
            {placePicks}
          </>
        ) : kind.value === "fund" ? (
          <>
            {sides}
            <div class="pf-pair">
              <Field
                label="ISIN"
                value={isin}
                onEdit={() => {
                  sellAll.value = false;
                  error.value = null;
                }}
              />
              {knownFund ? (
                <div class="field">
                  <span class="pf-field-head">
                    <span class="label">Name</span>
                  </span>
                  <div class="pf-chosen">
                    <span class="pf-chosen-main">
                      <span class="cut">{knownFund.name}</span>
                    </span>
                  </div>
                </div>
              ) : (
                <Field label="Name" value={name} />
              )}
            </div>
            <div class="pf-pair">
              <Field
                label="Units"
                value={qty}
                onEdit={() => {
                  sellAll.value = false;
                }}
                decimal
                after={allButton}
              />
              <Field
                label={inCurrency(
                  byTotal.value ? "Total paid" : "Price per unit",
                  knownFund?.currency ?? (currency.value || null),
                )}
                value={px}
                placeholder={byTotal.value ? "Fees in" : undefined}
                decimal
                after={totalToggle}
              />
            </div>
            <div class="pf-pair">
              <Field label="Date" value={date} type="date" />
              {knownFund ? null : currencyField}
            </div>
            {marketPick}
            {placePicks}
            <Field label="Note" value={note} placeholder="Optional" />
          </>
        ) : (
          <>
            <div class="pf-pair">
              <Field label="Name" value={name} />
              <Field label="Symbol" value={symbol} placeholder="Optional" />
            </div>
            <div class="pf-pair">
              <Field label="Face" value={amountText} decimal />
              {currencyField}
            </div>
            <div class="pf-pair">
              <Field label="Coupon %" value={coupon} decimal />
              <Field label="Maturity" value={maturity} type="date" />
            </div>
            <div class="pf-pair">
              <Field label="As of" value={date} type="date" />
              <Field label="Cost" value={cost} placeholder="Optional" decimal />
            </div>
            {placePicks}
          </>
        )}
      </div>
      <div class="pf-add-foot">
        {what && <p class="pf-summary">{what}</p>}
        {error.value && (
          <Refusal
            text={error.value}
            busy={busy.value}
            onAgain={(ev) => void submit(ev, true)}
          />
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
                    : kind.value === "fund"
                      ? side.value === "buy"
                        ? "Add buy"
                        : "Add sell"
                      : KIND_TITLES[kind.value]}
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
  kind,
}: {
  store: PortfolioStore;
  start: AddStart | null;
  onDone: () => void;
  kind?: Remembered["kind"];
}) {
  const saving = useSignal(false);
  const title = useSignal("Add");
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
      <aside class="pf-sheet" aria-label={title.value}>
        <div class="pf-sheet-head">
          <h2 class="pf-sheet-title">{title.value}</h2>
          <button
            type="button"
            class="btn-icon"
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <AddForm
          store={store}
          onDone={onDone}
          start={start}
          saving={saving}
          title={title}
          kind={kind}
        />
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
  // the tab on, else the only one, else asked: never a silent first one
  const portfolio = useSignal(
    String(
      store.portfolio.value ??
        (portfolios.length === 1 ? portfolios[0]!.id : ""),
    ),
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
    <section class="pf-settings" aria-label="Import">
      <div class="pf-settings-head">
        <h2 class="pf-welcome-title">Import a CSV</h2>
      </div>
      <div class="card pf-panel">
        <div class="pf-pair pf-pair-stack">
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
                  {r.item && <span class="cut">{importLine(r.item)}</span>}
                  <span class="pf-preview-status">
                    {importStatus(r.status)}
                    {r.reason ? ` · ${importReason(r.reason)}` : ""}
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
      {/* while renaming, the form's own buttons end the row */}
      {(!editing.value || error.value) && (
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
      )}
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
  label = "Display currency",
}: {
  value: string | null;
  onPick: (code: string) => void;
  label?: string;
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
        aria-label={`${label}: ${value ?? "none"}`}
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
            ref={(el) => {
              if (!el) return;
              el.focus({ preventScroll: true });
              el.parentElement?.scrollIntoView({ block: "nearest" });
            }}
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

// every zone the browser knows, found by city or area as typed
function ZonePick({
  value,
  onPick,
  label = "Time zone",
}: {
  value: string | null;
  onPick: (zone: string) => void;
  label?: string;
}) {
  const { open, root } = useMenu();
  const query = useSignal("");
  const found = open.value ? findZones(query.value) : [];
  const named = (z: string) => {
    const w = zoneWords(z);
    return w.area ? `${w.city} · ${w.area}` : w.city;
  };
  const pick = (z: string) => {
    open.value = false;
    query.value = "";
    if (z !== value) onPick(z);
  };
  return (
    <div class="pf-drop pf-currency" ref={root}>
      <button
        type="button"
        class="btn pf-drop-btn"
        aria-label={`${label}: ${value ?? "none"}`}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
          query.value = "";
        }}
      >
        <span class="cut">{value ? named(value) : "Pick a time zone"}</span>
        <Icon name="chevron" size={14} class="pf-drop-chevron" />
      </button>
      {open.value && (
        <div class="menu pf-drop-menu pf-currency-menu">
          <input
            class="pf-currency-find"
            value={query.value}
            placeholder="City or region"
            aria-label="Find a time zone"
            ref={(el) => {
              if (!el) return;
              el.focus({ preventScroll: true });
              el.parentElement?.scrollIntoView({ block: "nearest" });
            }}
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
          <div class="pf-currency-list" role="menu" aria-label="Time zones">
            {found.length === 0 && (
              <span class="pf-currency-none">No time zone matches.</span>
            )}
            {found.map((z) => (
              <button
                key={z}
                type="button"
                class={`menu-item${z === value ? " menu-item-on" : ""}`}
                role="menuitemradio"
                aria-checked={z === value}
                onClick={() => pick(z)}
              >
                <span class="cut">{zoneWords(z).city}</span>
                <span class="cut pf-dim">{zoneWords(z).area}</span>
                {z === value && (
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
  const zoneError = useSignal<string | null>(null);
  return (
    <section class="pf-settings" aria-label="Settings">
      <div class="pf-settings-head">
        <h2 class="pf-welcome-title">Settings</h2>
        <button type="button" class="btn" onClick={onDone}>
          Done
        </button>
      </div>
      <Rows>
        <RowsCard label="Display currency" menus>
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
        <RowsCard label="Time zone" menus>
          <div class="rows-item pf-inline pf-add-name">
            <ZonePick
              value={o?.time_zone ?? null}
              onPick={async (z) => {
                zoneError.value = await store.saveSettings({ time_zone: z });
              }}
            />
            {zoneError.value && (
              <span class="pf-error" role="alert">
                {zoneError.value}
              </span>
            )}
          </div>
        </RowsCard>
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
      </Rows>
    </section>
  );
}

// the most traded currencies (BIS triennial survey), one tap each; every
// other one is a search away, so no country is assumed
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"];

function Welcome({ store }: { store: PortfolioStore }) {
  const o = store.overview.value;
  // portfolios made before a currency was required need only the currency
  const has = (o?.portfolios.length ?? 0) > 0;
  const cur = useSignal(o?.display_currency ?? "");
  // the browser's zone is a suggestion the owner sees before saving
  const zone = useSignal(o?.time_zone ?? browserZone() ?? "");
  const name = useSignal("");
  const other = useSignal(false);
  const query = useSignal("");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const pick = (c: string) => {
    cur.value = c;
    other.value = false;
    query.value = "";
    error.value = null;
  };
  const found = other.value ? findCurrencies(query.value) : [];
  const picked = cur.value !== "" && !COMMON_CURRENCIES.includes(cur.value);
  const submit = async (ev: Event) => {
    ev.preventDefault();
    if (busy.value) return;
    if (!has && name.value.trim() === "") {
      error.value = "Name the portfolio.";
      return;
    }
    if (cur.value === "") {
      error.value = "Pick a currency.";
      return;
    }
    if (zone.value === "") {
      error.value = "Pick a time zone.";
      return;
    }
    busy.value = true;
    // a portfolio is refused until the display currency is set
    const changed = {
      ...(cur.value === o?.display_currency
        ? {}
        : { display_currency: cur.value }),
      ...(zone.value === o?.time_zone ? {} : { time_zone: zone.value }),
    };
    error.value =
      Object.keys(changed).length === 0
        ? null
        : await store.saveSettings(changed);
    if (error.value === null && !has) {
      error.value = await store.createPortfolio(name.value.trim());
    }
    busy.value = false;
  };
  return (
    <section class="card pf-welcome" aria-label="Start">
      <h2 class="pf-welcome-title">
        {has ? "Pick a currency for totals" : "Create your first portfolio"}
      </h2>
      <form class="pf-welcome-form" onSubmit={submit}>
        {!has && <Field label="Name" value={name} placeholder="Long term" />}
        <fieldset class="field pf-chips-field">
          <legend class="label">Totals in</legend>
          <div class="pf-chips">
            {COMMON_CURRENCIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cur.value === c}
                title={currencyName(c) ?? c}
                class={`pf-chip${cur.value === c ? " pf-chip-on" : ""}`}
                onClick={() => pick(c)}
              >
                {c}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={picked}
              aria-expanded={other.value}
              class={`pf-chip${picked ? "" : " pf-chip-word"}${picked || other.value ? " pf-chip-on" : ""}`}
              onClick={() => {
                other.value = !other.value;
                query.value = "";
              }}
            >
              {picked ? cur.value : "Other…"}
            </button>
          </div>
          {other.value && (
            <div class="pf-other">
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
              <div
                class="pf-currency-list"
                role="listbox"
                aria-label="Currencies"
              >
                {found.length === 0 && (
                  <span class="pf-currency-none">No currency matches.</span>
                )}
                {found.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="option"
                    aria-selected={c === cur.value}
                    class={`menu-item${c === cur.value ? " menu-item-on" : ""}`}
                    onClick={() => pick(c)}
                  >
                    <span class="pf-currency-code">{c}</span>
                    <span class="cut pf-dim">{currencyName(c) ?? ""}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </fieldset>
        <div class="field">
          <span class="label">Time zone</span>
          <ZonePick
            value={zone.value === "" ? null : zone.value}
            onPick={(z) => {
              zone.value = z;
              error.value = null;
            }}
          />
        </div>
        {error.value && (
          <p class="pf-error" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="submit"
          class="btn btn-primary pf-welcome-go"
          disabled={busy.value}
        >
          {busy.value ? "Saving" : has ? "Save" : "Create"}
        </button>
      </form>
    </section>
  );
}

function StartCard({
  store,
  open,
}: {
  store: PortfolioStore;
  open: (p: "trade" | "cash" | "import") => void;
}) {
  const o = store.overview.value;
  const names = (o?.portfolios ?? []).map((p) => p.name).join(" · ");
  const ways = [
    { key: "trade", title: "Add a trade", sub: "Shares, ETFs, crypto" },
    {
      key: "cash",
      title: "Add cash, a fund or a bond",
      sub: "What has no live price",
    },
    {
      key: "import",
      title: "Import a CSV",
      sub: "Trades from a portfolio export",
    },
  ] as const;
  return (
    <section class="card pf-welcome pf-start" aria-label="Start">
      <span class="pf-dim">
        {names}
        {o?.display_currency ? ` · totals in ${o.display_currency}` : ""}
      </span>
      <h2 class="pf-welcome-title">Add your holdings</h2>
      <div class="pf-ways">
        {ways.map((w) => (
          <button
            key={w.key}
            type="button"
            class="pf-way"
            onClick={() => open(w.key)}
          >
            <span class="pf-way-title">{w.title}</span>
            <span class="pf-way-sub">{w.sub}</span>
            <Icon name="chevron" size={14} class="pf-way-go" />
          </button>
        ))}
        {/* agents use the portfolio tool, so a key is all they need */}
        <a class="pf-way" href="/connect">
          <span class="pf-way-title">Let an agent do it</span>
          <span class="pf-way-sub">Connect one, then just ask</span>
          <Icon name="chevron" size={14} class="pf-way-go" />
        </a>
      </div>
    </section>
  );
}

// ---- the page -------------------------------------------------------------

type Panel = "add" | "import" | "settings" | null;

function PageMenu({
  store,
  panel,
  noAdd,
}: {
  store: PortfolioStore;
  panel: Signal<Panel>;
  // the start card's own Add a trade stands in for it
  noAdd?: boolean;
}) {
  const { open, root } = useMenu();
  const id = store.portfolio.value;
  const name =
    store.overview.value?.portfolios.find((p) => p.id === id)?.name ?? "";
  return (
    <div class="ins-more" ref={root}>
      {!noAdd && (
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
      )}
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
          {/* export is per portfolio, so it is offered on one */}
          {id !== null && (
            <a
              class="menu-item"
              role="menuitem"
              href={store.exportHref(id)}
              download
              onClick={() => {
                open.value = false;
              }}
            >
              <Icon name="download" size={14} /> Export {name} trades
            </a>
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
            <Icon name="sliders" size={14} /> Settings
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
  chip,
  right,
}: {
  label: string;
  value: string | null;
  options: { value: string | null; text: string }[];
  onPick: (v: string | null) => void;
  // small, on the line it changes: a price's currency, the total's
  chip?: boolean;
  right?: boolean;
}) {
  const { open, root } = useMenu();
  const picked = options.find((x) => x.value === value) ?? options[0]!;
  const menu = chip
    ? `pf-paid-menu${right ? " pf-paid-menu-right" : ""}`
    : "pf-drop-menu";
  return (
    <div class={chip ? "pf-paid" : "pf-drop"} ref={root}>
      <button
        type="button"
        class={chip ? "pf-paid-btn" : "btn pf-drop-btn"}
        aria-label={`${label}: ${picked.text}`}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="cut">{picked.text}</span>
        {chip ? (
          <Icon name="chevron" size={12} />
        ) : (
          <Icon name="chevron" size={14} class="pf-drop-chevron" />
        )}
      </button>
      {open.value && (
        <div class={`menu ${menu}`} role="menu" aria-label={label}>
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
  const brokers = o?.brokers ?? [];
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
        {/* a phone picks the portfolio from a menu, its tabs too wide */}
        <span class="pf-portfolio-pick">
          <Dropdown
            label="Portfolio"
            value={
              store.portfolio.value === null
                ? null
                : String(store.portfolio.value)
            }
            options={[
              { value: null, text: "All portfolios" },
              ...(o?.portfolios ?? []).map((p) => ({
                value: String(p.id),
                text: p.name,
              })),
            ]}
            onPick={(v) =>
              void store.pick({ portfolio: v === null ? null : Number(v) })
            }
          />
        </span>
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
      </div>
    </div>
  );
}

export function PortfoliosBody({ store }: { store: PortfolioStore }) {
  const panel = useSignal<Panel>(null);
  // a holding's Buy or Sell opens the add panel on it
  const start = useSignal<AddStart | null>(null);
  // the start card's choice of what to add
  const opened = useSignal<Remembered["kind"]>("trade");
  const held = store.holdings.value !== null;
  const h = store.holdings.value;
  const empty =
    (store.overview.value?.portfolios.length ?? 0) === 0 ||
    !store.overview.value?.display_currency;
  // nothing in any portfolio yet; a removed trade counts, so the Trades
  // card keeps its Restore in reach
  const blank =
    !empty &&
    store.portfolio.value === null &&
    store.broker.value === null &&
    h !== null &&
    h.holdings.length === 0 &&
    (store.trades.value ?? []).length === 0;
  return (
    <Page
      title="Portfolios"
      actions={
        held && !empty ? (
          <PageMenu store={store} panel={panel} noAdd={blank} />
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
        <Rows>
          {panel.value === "add" && (
            <AddSheet
              key={
                start.value
                  ? `${start.value.symbol}/${start.value.side}`
                  : "new"
              }
              store={store}
              start={start.value}
              kind={blank ? opened.value : undefined}
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
          {empty ? (
            <Welcome store={store} />
          ) : panel.value === "settings" ? (
            <SettingsPanel
              store={store}
              onDone={() => {
                panel.value = null;
              }}
            />
          ) : panel.value === "import" ? null : blank ? (
            <StartCard
              store={store}
              open={(p) => {
                if (p === "import") {
                  panel.value = "import";
                  return;
                }
                opened.value = p;
                panel.value = "add";
              }}
            />
          ) : (
            <>
              <Filters store={store} />
              <Totals store={store} h={h} />
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
        </Rows>
      )}
    </Page>
  );
}

export function Portfolios() {
  const store = markets.portfolios;
  useRefresh(store.load);
  return <PortfoliosBody store={store} />;
}
