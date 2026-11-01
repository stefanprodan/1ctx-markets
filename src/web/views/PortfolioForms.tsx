// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios forms, each in the one drawer: add, edit, a fund's
// price, a bond's purchases, import and settings; and the first cards.

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useId, useMemo, useRef } from "preact/hooks";
import { currencyName, findCurrencies } from "../../shared/currencies.ts";
import type {
  BrokerRow,
  FundTradeIn,
  Holding,
  Holdings,
  Imported,
  Listing,
  PortfolioStore,
  PositionIn,
  TradeIn,
} from "../data/portfolios.ts";
import { JUST_SAVED } from "../data/portfolios.ts";
import { type Candidate, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Card, SectionHead } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { SymbolName } from "../ui/Symbol.tsx";
import { searcher } from "../ui/SymbolSearch.model.ts";
import { Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import { symbolOf } from "./Instruments.model.ts";
import {
  ADD_KEY,
  amount,
  browserZone,
  currencies,
  day,
  dryPowderFor,
  dryPowders,
  findZones,
  heldAt,
  IMPORT_KINDS,
  importLine,
  importReason,
  importStatus,
  listingWords,
  price,
  quantity,
  type Remembered,
  ranked,
  readRemembered,
  shownIn,
  today,
  tradeMoney,
  typed,
  zoneWords,
} from "./Portfolios.model.ts";
import "./portfolios.css";

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

// an edit form: in a drawer its fields are the body and its buttons the
// foot; in a list it stands inline with its buttons under it
function EditFrame({
  drawer,
  head,
  lead,
  error,
  busy,
  onSubmit,
  onCancel,
  children,
}: {
  drawer?: boolean;
  // over the fields in a drawer, such as what is being edited
  head?: ComponentChildren;
  // at the foot's start, such as Remove
  lead?: ComponentChildren;
  error: string | null;
  busy: boolean;
  onSubmit: (ev: Event) => void;
  onCancel: () => void;
  children: ComponentChildren;
}) {
  const buttons = (
    <>
      <button
        type="button"
        class="btn btn-small"
        onClick={onCancel}
        disabled={busy}
      >
        Cancel
      </button>
      <button type="submit" class="btn btn-small btn-primary" disabled={busy}>
        {busy ? "Saving" : "Save"}
      </button>
    </>
  );
  const refusal = error && (
    <p class="error pf-refusal" role="alert">
      {error}
    </p>
  );
  if (!drawer) {
    return (
      <form class="pf-edit" onSubmit={onSubmit}>
        {children}
        <div class="pf-form-foot">
          {lead}
          {refusal}
          {buttons}
        </div>
      </form>
    );
  }
  return (
    <form class="pf-form" onSubmit={onSubmit}>
      <div class="drawer-body">
        {head}
        <div class="pf-fields">{children}</div>
      </div>
      <div class="drawer-foot">
        {refusal}
        {lead && <div class="drawer-foot-start">{lead}</div>}
        {buttons}
      </div>
    </form>
  );
}

export function PositionEdit({
  store,
  h,
  onDone,
  lead,
  head,
  drawer,
}: {
  store: PortfolioStore;
  h: Holding;
  onDone: () => void;
  lead?: ComponentChildren;
  head?: ComponentChildren;
  drawer?: boolean;
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
    <EditFrame
      drawer={drawer}
      head={head}
      lead={lead}
      error={error.value}
      busy={busy.value}
      onSubmit={save}
      onCancel={onDone}
    >
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
    </EditFrame>
  );
}

// a fund's price for a day (a day already priced takes the new one), and
// its name set right
export function FundPriceEdit({
  store,
  h,
  onDone,
  head,
}: {
  store: PortfolioStore;
  h: Holding;
  onDone: () => void;
  head?: ComponentChildren;
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
    <EditFrame
      drawer
      head={head}
      error={error.value}
      busy={busy.value}
      onSubmit={save}
      onCancel={onDone}
    >
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
    </EditFrame>
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
          <span class="faint">Remove {what ?? h.name}?</span>
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
        <span class="error" role="alert">
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
            <span class="num pf-purchase">
              {[
                p.as_of ? `Bought ${day(p.as_of)}` : null,
                `Face ${amount(p.amount ?? null, h.currency)}`,
                p.broker ?? "No broker",
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
    <ul class="menu menu-pop pf-found" id="pf-symbol-found">
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
              <SymbolName
                compact
                ticker={symbolOf(c.id)}
                name={c.name ?? undefined}
              />
              <span class="faint small pf-found-where">{listingWords(c)}</span>
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
    <div class="field">
      <span class="pf-field-head">
        <span class="label">{label}</span>
      </span>
      <FieldPick
        label={label}
        value={value.value}
        options={options}
        onPick={(v) => {
          value.value = v;
          onPick?.();
        }}
      />
    </div>
  );
}

// one choice of a few, the first when the value is none of them
function FieldPick({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: { value: string; text: string }[];
  onPick: (v: string) => void;
}) {
  const picked = options.find((o) => o.value === value) ?? options[0]!;
  return (
    <MenuButton
      field
      label={`${label}: ${picked.text}`}
      text={picked.text}
      items={options.map((o) => ({
        label: o.text,
        key: o.value,
        checked: o === picked,
        run: () => {
          if (o !== picked) onPick(o.value);
        },
      }))}
    />
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
    <p class="error pf-refusal" role="alert">
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
          class={`seg-option${side.value === s ? " seg-on" : ""}`}
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
    <form
      class="pf-form"
      onSubmit={submit}
      aria-label={KIND_TITLES[kind.value]}
    >
      <div class="drawer-body">
        <Tabs
          label="What to add"
          tabs={KIND_LABELS}
          value={kind.value}
          onPick={(k) => {
            // a trade's listing and a bond's share the symbol field
            unpick();
            again.value = false;
            kind.value = k;
            error.value = null;
          }}
        />
        {kind.value === "trade" ? (
          <>
            {chosen.value ? (
              <div class="field">
                <span class="pf-field-head">
                  <span class="label">Symbol</span>
                </span>
                <div class="menu-btn-field pf-chosen">
                  <span class="pf-chosen-main">
                    <SymbolName
                      compact
                      ticker={symbolOf(symbol.value)}
                      name={picked.value?.name ?? undefined}
                    />
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
                    <span class="faint small">
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
                    <MenuButton
                      label="Paid in"
                      text={<span class="num small">{cur}</span>}
                      left
                      items={paidChoices(store, listingCur).map((c) => {
                        const v = c === listingCur ? "" : c;
                        return {
                          label: <span class="num">{c}</span>,
                          key: c,
                          checked: v === paid.value,
                          run: () => {
                            paid.value = v;
                          },
                        };
                      })}
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
                  <div class="menu-btn-field pf-chosen">
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
      <div class="drawer-foot">
        {what && <p class="num small pf-summary">{what}</p>}
        {error.value && (
          <Refusal
            text={error.value}
            busy={busy.value}
            onAgain={(ev) => void submit(ev, true)}
          />
        )}
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
            <button type="submit" class="btn btn-primary" disabled={busy.value}>
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
    </form>
  );
}

// the add form in the drawer
export function AddSheet({
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
  return (
    <Drawer title={title.value} onClose={onDone} busy={saving.value} bare>
      <AddForm
        store={store}
        onDone={onDone}
        start={start}
        saving={saving}
        title={title}
        kind={kind}
      />
    </Drawer>
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
      <Drawer title="Import a CSV" onClose={onDone}>
        <Notice>Make a portfolio first, in Settings.</Notice>
      </Drawer>
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
    <Drawer
      title="Import a CSV"
      onClose={onDone}
      busy={busy.value}
      foot={(close) => (
        <>
          {error.value && (
            <p class="error pf-refusal" role="alert">
              {error.value}
            </p>
          )}
          <button
            type="button"
            class="btn"
            onClick={close}
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
        </>
      )}
    >
      <div class="pf-fields">
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
          <span class="cut faint">{file.value}</span>
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
          <p class="faint">
            {IMPORT_KINDS[p.kind]} · {p.counts.ok + p.counts.saved} ready
            {p.counts.bad > 0 ? ` · ${p.counts.bad} not read` : ""}
            {p.counts.skipped > 0 ? ` · ${p.counts.skipped} skipped` : ""}
          </p>
          <ul class="small pf-preview">
            {p.rows.map((r) => (
              <li key={r.line} class={`pf-preview-${r.status}`}>
                <span class="faint pf-preview-line">Line {r.line}</span>
                {r.item && <span class="cut">{importLine(r.item)}</span>}
                <span
                  class={`pf-preview-status${r.status === "bad" ? " error" : r.status === "skipped" ? " faint" : ""}`}
                >
                  {importStatus(r.status)}
                  {r.reason ? ` · ${importReason(r.reason)}` : ""}
                  {r.warning ? ` · ${r.warning}` : ""}
                  {r.replaces !== undefined ? " · replaces the kept one" : ""}
                </span>
                {p.kind === "cash" && r.status === "ok" && (
                  <label class="faint pf-dry">
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
    </Drawer>
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
    <li class="pf-name">
      {editing.value ? (
        <form
          class="field pf-inline"
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
        <span class="cut pf-name-text">{name}</span>
      )}
      {/* while renaming, the form's own buttons end the row */}
      {(!editing.value || error.value) && (
        <span class="pf-name-end">
          {error.value && (
            <span class="error small" role="alert">
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
    </li>
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
      class="field pf-inline"
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
        <span class="error small" role="alert">
          {error.value}
        </span>
      )}
    </form>
  );
}

// a pick from a long list, found as typed: the field's menu holds the
// search and the matches
function FindPick({
  label,
  value,
  shown,
  find,
  findLabel,
  none,
  search,
  line,
  onPick,
}: {
  label: string;
  value: string | null;
  // the field's words for the value, or for none
  shown: string;
  find: string;
  findLabel: string;
  none: string;
  search: (q: string) => string[];
  line: (v: string) => [string, string];
  onPick: (v: string) => void;
}) {
  const query = useSignal("");
  return (
    <MenuButton
      field
      label={`${label}: ${value ?? "none"}`}
      text={shown}
      menuClass="pf-find"
      onOpen={() => {
        query.value = "";
      }}
    >
      {(close) => {
        // read only while open: every zone is a long list
        const found = search(query.value);
        const pick = (v: string) => {
          close();
          query.value = "";
          if (v !== value) onPick(v);
        };
        return (
          <>
            <div class="field pf-find-field">
              <input
                value={query.value}
                placeholder={find}
                aria-label={findLabel}
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
            </div>
            {found.length === 0 && (
              <p class="faint small pf-find-none">{none}</p>
            )}
            {found.slice(0, 200).map((v) => {
              const [main, sub] = line(v);
              return (
                <button
                  key={v}
                  type="button"
                  class={`menu-item${v === value ? " menu-item-on" : ""}`}
                  role="menuitemradio"
                  aria-checked={v === value}
                  onClick={() => pick(v)}
                >
                  <span class="pf-find-main">{main}</span>
                  <span class="cut faint">{sub}</span>
                  {v === value && (
                    <Icon name="check" size={14} class="menu-item-check" />
                  )}
                </button>
              );
            })}
          </>
        );
      }}
    </MenuButton>
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
  const n = value ? currencyName(value) : null;
  return (
    <FindPick
      label={label}
      value={value}
      shown={value ? (n ? `${value} · ${n}` : value) : "Pick a currency"}
      find="Code or name"
      findLabel="Find a currency"
      none="No currency matches."
      search={findCurrencies}
      line={(c) => [c, currencyName(c) ?? ""]}
      onPick={onPick}
    />
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
  const w = value ? zoneWords(value) : null;
  return (
    <FindPick
      label={label}
      value={value}
      shown={
        w ? (w.area ? `${w.city} · ${w.area}` : w.city) : "Pick a time zone"
      }
      find="City or region"
      findLabel="Find a time zone"
      none="No time zone matches."
      search={findZones}
      line={(z) => {
        const x = zoneWords(z);
        return [x.city, x.area];
      }}
      onPick={onPick}
    />
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
    <Drawer
      title="Settings"
      onClose={onDone}
      foot={(close) => (
        <button type="button" class="btn" onClick={close}>
          Done
        </button>
      )}
    >
      <section class="pf-section" aria-label="Display currency">
        <SectionHead title="Display currency" />
        <CurrencyPick
          value={o?.display_currency ?? null}
          onPick={async (c) => {
            error.value = await store.saveDisplay(c);
          }}
        />
        {error.value && (
          <p class="error small" role="alert">
            {error.value}
          </p>
        )}
      </section>
      <section class="pf-section" aria-label="Time zone">
        <SectionHead title="Time zone" />
        <ZonePick
          value={o?.time_zone ?? null}
          onPick={async (z) => {
            zoneError.value = await store.saveSettings({ time_zone: z });
          }}
        />
        {zoneError.value && (
          <p class="error small" role="alert">
            {zoneError.value}
          </p>
        )}
      </section>
      <section class="pf-section" aria-label="Portfolios">
        <SectionHead title="Portfolios" count={o?.portfolios.length ?? 0} />
        <ul class="pf-names">
          {(o?.portfolios ?? []).map((p) => (
            <NameRow
              key={p.id}
              name={p.name}
              onRename={(to) => store.renamePortfolio(p.id, to)}
              onDelete={() => store.deletePortfolio(p.id)}
            />
          ))}
        </ul>
        <AddName placeholder="New portfolio" onAdd={store.createPortfolio} />
      </section>
      <section class="pf-section" aria-label="Brokers">
        <SectionHead title="Brokers" count={o?.brokers.length ?? 0} />
        <ul class="pf-names">
          {(o?.brokers ?? []).map((b: BrokerRow) => (
            <NameRow
              key={b.id}
              name={b.name}
              onRename={(to) => store.renameBroker(b.id, to)}
              onDelete={() => store.deleteBroker(b.id)}
            />
          ))}
        </ul>
        <AddName placeholder="New broker" onAdd={store.createBroker} />
      </section>
    </Drawer>
  );
}

// the most traded currencies (BIS triennial survey), one tap each; every
// other one is a search away, so no country is assumed
const COMMON_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"];

export function Welcome({ store }: { store: PortfolioStore }) {
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
    <Card
      class="pf-start"
      label="Start"
      title={has ? "Pick a currency for totals" : "Create your first portfolio"}
    >
      <form class="pf-fields" onSubmit={submit}>
        {!has && <Field label="Name" value={name} placeholder="Long term" />}
        <fieldset class="field pf-chips-field">
          <legend class="label">Totals in</legend>
          <div class="seg pf-chips">
            {COMMON_CURRENCIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={cur.value === c}
                title={currencyName(c) ?? c}
                class={`seg-option num${cur.value === c ? " seg-on" : ""}`}
                onClick={() => pick(c)}
              >
                {c}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={picked}
              aria-expanded={other.value}
              class={`seg-option${picked ? " num" : ""}${picked || other.value ? " seg-on" : ""}`}
              onClick={() => {
                other.value = !other.value;
                query.value = "";
              }}
            >
              {picked ? cur.value : "Other…"}
            </button>
          </div>
          {other.value && (
            <div class="menu pf-other">
              <div class="field pf-find-field">
                <input
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
              </div>
              <div class="pf-find-list" role="listbox" aria-label="Currencies">
                {found.length === 0 && (
                  <p class="faint small pf-find-none">No currency matches.</p>
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
                    <span class="pf-find-main">{c}</span>
                    <span class="cut faint">{currencyName(c) ?? ""}</span>
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
          <p class="error pf-refusal" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="submit"
          class="btn btn-primary pf-go"
          disabled={busy.value}
        >
          {busy.value ? "Saving" : has ? "Save" : "Create"}
        </button>
      </form>
    </Card>
  );
}

export function StartCard({
  store,
  open,
}: {
  store: PortfolioStore;
  open: (p: "trade" | "cash" | "import") => void;
}) {
  const o = store.overview.value;
  const names = (o?.portfolios ?? []).map((p) => p.name).join(" · ");
  const ways: { key: string; title: string; sub: string; href?: string }[] = [
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
    // agents use the portfolio tool, so a key is all they need
    {
      key: "agent",
      title: "Let an agent do it",
      sub: "Connect one, then just ask",
      href: "/connect",
    },
  ];
  return (
    <Card class="pf-start" label="Start" title="Add your holdings">
      <p class="faint">
        {names}
        {o?.display_currency ? ` · totals in ${o.display_currency}` : ""}
      </p>
      <Table
        label="Ways to add holdings"
        head={false}
        columns={[
          {
            key: "way",
            width: "minmax(0, 1fr)",
            cell: (w) => <SymbolName ticker={w.title} name={w.sub} />,
          },
        ]}
        rows={ways}
        rowKey={(w) => w.key}
        rowLabel={(w) => w.title}
        open={(w) =>
          w.href
            ? { href: w.href }
            : { run: () => open(w.key as "trade" | "cash" | "import") }
        }
      />
    </Card>
  );
}
