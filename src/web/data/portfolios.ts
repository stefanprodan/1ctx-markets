// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Portfolios page's calls and signals. A write answers the refusal's
// sentence, or null once saved, and reloads what it changed.

import { batch, signal } from "@preact/signals";
import { inCirculation } from "../../shared/currencies.ts";
import { navigate } from "../app/router.ts";
import { ApiError, type Call, codeOf, says } from "./api.ts";

export const PORTFOLIOS_PATH = "/api/v1/portfolios";
export const PORTFOLIOS_PAGE = "/portfolios";

export type View = {
  portfolio: number | null;
  currency: string | null;
};

// the view lives in the page's address, so a reload or a link opens on it:
// the portfolio in the path, the currency in the query. A list's broker
// and search narrow that list alone, so they stay out of it
export function addressOf(v: View): string {
  const q = new URLSearchParams();
  if (v.currency !== null) q.set("currency", v.currency);
  const path =
    v.portfolio === null
      ? PORTFOLIOS_PAGE
      : `${PORTFOLIOS_PAGE}/${v.portfolio}`;
  return q.size > 0 ? `${path}?${q}` : path;
}

// anything but an id in the path is all; a portfolio gone elsewhere
// falls back on load, as a pick on the page would
export function viewOf(id: string | undefined, search: string): View {
  const q = new URLSearchParams(search);
  const currency = q.get("currency")?.toUpperCase() ?? null;
  return {
    portfolio: id !== undefined && /^\d+$/.test(id) ? Number(id) : null,
    currency: currency !== null && inCirculation(currency) ? currency : null,
  };
}

const onPage = (): boolean =>
  typeof location !== "undefined" &&
  (location.pathname === PORTFOLIOS_PAGE ||
    location.pathname.startsWith(`${PORTFOLIOS_PAGE}/`));

export type PortfolioRow = {
  id: number;
  name: string;
  trades: number;
  positions: number;
};

export type BrokerRow = { id: number; name: string };

// a fund the owner prices, with its latest price and that price's day
export type FundRow = {
  id: string;
  isin: string;
  name: string;
  currency: string;
  market: string | null;
  price: number | null;
  as_of: string | null;
};

export type Overview = {
  display_currency: string | null;
  // the owner's IANA zone, none until they name one
  time_zone?: string | null;
  // what cash or a fund can name as the market its money is in
  markets?: string[];
  funds?: FundRow[];
  portfolios: PortfolioRow[];
  brokers: BrokerRow[];
};

export type Part = {
  portfolio: string;
  broker: string | null;
  quantity: number | null;
  average_cost: number | null;
  cost: number | null;
  value: number | null;
  // a position's own row, its date, and cash's or a bond's stored amount
  position?: number;
  as_of?: string;
  amount?: number | null;
};

export type Converted = {
  currency: string;
  rate: number | null;
  rate_at: string | null;
  value: number | null;
  cost: number | null;
  pl: number | null;
  pl_percent: number | null;
  weight: number | null;
};

export type Holding = {
  kind: "holding" | "cash" | "fund" | "bond";
  id: string | null;
  position: number | null;
  name: string | null;
  type: string;
  market: string | null;
  // a fund's
  isin?: string;
  currency: string;
  unit?: string | null;
  quantity: number | null;
  average_cost: number | null;
  cost: number | null;
  price: number | null;
  priced: "quote" | "hand" | "listing" | "face" | "amount";
  as_of: string | null;
  value: number | null;
  pl: number | null;
  pl_percent: number | null;
  day_change: number | null;
  change_percent: number | null;
  // of the value in its own currency
  currency_weight: number | null;
  paid?: { currency: string; amount: number | null }[];
  converted?: Converted;
  coupon?: number | null;
  maturity?: string | null;
  dry_powder?: boolean;
  sold_today?: boolean;
  note?: string | null;
  stale: string[];
  parts: Part[];
};

export type Total = {
  currency: string;
  value: number | null;
  cost: number | null;
  pl: number | null;
  pl_percent: number | null;
  day_change: number | null;
  invested: number | null;
  cash: number | null;
  dry_powder: number | null;
  invested_weight: number | null;
  cash_weight: number | null;
  dry_powder_weight: number | null;
};

export type Share = { key: string | null; value: number; weight: number };

export type Exposure = {
  currency: string;
  currency_weights: Share[] | null;
  market: Share[];
  type: Share[];
  portfolio: Share[];
  broker: Share[];
};

export type Holdings = {
  currency: string | null;
  display_currency: string | null;
  totals: Total[];
  converted: (Total & { missing: string[] }) | null;
  rates: {
    from: string;
    to: string;
    rate: number | null;
    at: string | null;
    reason?: string;
  }[];
  cost_rates?: {
    from: string;
    to: string;
    count: number;
    first: string;
    last: string;
    reason?: string;
  }[];
  exposure: Exposure[];
  holdings: Holding[];
};

export type TradeRow = {
  id: number;
  portfolio: string | null;
  symbol: string;
  name: string | null;
  side: "buy" | "sell";
  date: string;
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  // percent_of_par: the price is a percent of face
  unit?: string | null;
  broker: string | null;
  note: string | null;
  entered_by: string;
  entered_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
};

export type TradeIn = {
  portfolio: number;
  symbol: string;
  side: "buy" | "sell";
  // "all": what is sellable on the trade's date, the server's reckoning
  quantity: number | "all";
  price?: number;
  // the whole cost, fees in, in place of a price
  total?: number;
  fees?: number;
  // what it was paid in, the listing's when left out
  currency?: string;
  date: string;
  broker?: string;
  note?: string;
  // a second fill equal to one just saved
  again?: boolean;
};

// a buy or sell of a fund, by its ISIN; its first buy names it
export type FundTradeIn = {
  portfolio: number;
  isin: string;
  name?: string;
  side: "buy" | "sell";
  units: number | "all";
  price?: number;
  total?: number;
  currency?: string;
  date: string;
  broker?: string;
  market?: string;
  note?: string;
  again?: boolean;
};

export type FundPriceIn = {
  price?: number;
  // the day the price is for
  date?: string;
  name?: string;
  // null takes it off
  market?: string | null;
};

export type SavedTrade = {
  id: number;
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  unit: string | null;
};

// a picked listing: its currency and live price, as the form shows them
export type Listing = {
  id: string;
  name: string | null;
  currency: string | null;
  unit: string | null;
  price: number | null;
  fetched_at: string | null;
};

export type PositionIn = {
  kind: "cash" | "bond";
  portfolio: number;
  name: string;
  currency?: string;
  amount?: number;
  cost?: number;
  coupon?: number;
  maturity?: string;
  symbol?: string;
  date?: string;
  dry_powder?: boolean;
  broker?: string;
  market?: string;
};

export type PositionChange = {
  amount?: number;
  // a change to the amount, in currency when it is not the position's own
  by?: number;
  currency?: string;
  date?: string;
  // null takes it off
  market?: string | null;
};

export type ImportRow = {
  line: number;
  status: "ok" | "bad" | "skipped" | "saved";
  reason?: string;
  warning?: string;
  replaces?: number;
  item?: Record<string, unknown>;
};

export type Imported = {
  kind: "trades" | "cash" | "bonds";
  portfolio: string;
  broker: string | null;
  saved: boolean;
  counts: Record<ImportRow["status"], number>;
  rows: ImportRow[];
};

export type ImportIn = {
  portfolio: number;
  csv: string;
  broker: string | null;
  dry_powder: number[];
  confirm: boolean;
};

// the server's refusal without ids, as a reader says it
// a retry refused, which a second equal fill saves with again
export const JUST_SAVED = "This trade was just saved.";

export function plainError(said: string): string {
  const t = said.replace(/^[A-Z0-9]+:[^\s:]+: /, "");
  if (/was removed or updated; restore it first/.test(t)) {
    return "Already changed or removed. Reload the page.";
  }
  if (/^No (trade|position|portfolio|broker) \d+\.?$/.test(t)) {
    return "No longer there. Reload the page.";
  }
  const sale =
    /later sale at that broker would sell more than it holds: remove sale \d+ \((\d{4}-\d{2}-\d{2})\) first/.exec(
      t,
    );
  if (sale)
    return `A later sale would sell more than is held. Remove the sale of ${sale[1]} first.`;
  if (/sells more than that broker held then/.test(t)) {
    return "More than that broker held then.";
  }
  if (/^more than is held with no broker; held at/i.test(t)) {
    return "Pick the broker, or sell all.";
  }
  if (/^sells more than that broker holds/i.test(t)) {
    return "More than that broker holds.";
  }
  if (/is listed in .*a bond takes its listing's currency/.test(t)) {
    return "Use the bond's own currency.";
  }
  if (/^the same trade was saved as trade \d+ in the last/i.test(t)) {
    return JUST_SAVED;
  }
  if (/^isin must be an ISIN/i.test(t)) return "Not a valid ISIN.";
  if (/^the fund \S+ has this name/i.test(t)) {
    return "Another fund has this name.";
  }
  if (/^no fund \S+ yet; its first buy names it$/i.test(t)) {
    return "Name the fund.";
  }
  if (/^no fund \S+ yet; its first buy names its currency$/i.test(t)) {
    return "Pick a currency.";
  }
  if (/^no fund \S+; its first trade is a buy$/i.test(t)) {
    return "Nothing of this fund is held.";
  }
  if (/a fund has no live price/i.test(t)) return "Give the price or total.";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// session: the store's sign-in count, so an answer from before a sign-in
// or sign-out never lands
export function portfolioStore(call: Call, session: () => number) {
  const overview = signal<Overview | null>(null);
  const holdings = signal<Holdings | null>(null);
  // the holdings list's broker: the server splits a holding by broker,
  // so the list reads its share there while the totals stay whole
  const atBroker = signal<Holdings | null>(null);
  const trades = signal<TradeRow[] | null>(null);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);
  const failures = signal(0);
  // what the page shows: a portfolio or all, the holdings list's broker
  // or all, and a currency to convert into, none built in
  const portfolio = signal<number | null>(null);
  const broker = signal<string | null>(null);
  const currency = signal<string | null>(null);

  let loads = 0;
  async function load(): Promise<void> {
    const mine = ++loads;
    // a currency pick or a fallback to all corrects the address in
    // place: only a portfolio picked is a step to go back from
    if (onPage()) {
      const here = addressOf({
        portfolio: portfolio.value,
        currency: currency.value,
      });
      if (here !== location.pathname + location.search) navigate(here, true);
    }
    const at = session();
    const stale = () => mine !== loads || at !== session();
    const q = new URLSearchParams();
    if (currency.value !== null) q.set("currency", currency.value);
    const bq = new URLSearchParams(q);
    if (broker.value !== null) bq.set("broker", broker.value);
    const where =
      portfolio.value === null
        ? "/api/v1/holdings"
        : `${PORTFOLIOS_PATH}/${portfolio.value}/holdings`;
    const tq = new URLSearchParams({ removed: "true" });
    if (portfolio.value !== null) tq.set("portfolio", String(portfolio.value));
    try {
      const [o, h, t, b] = await Promise.all([
        call<Overview>(PORTFOLIOS_PATH),
        call<Holdings>(`${where}${q.size > 0 ? `?${q}` : ""}`),
        call<{ trades: TradeRow[] }>(`/api/v1/trades?${tq}`),
        broker.value === null
          ? Promise.resolve(null)
          : call<Holdings>(`${where}?${bq}`),
      ]);
      if (stale()) return;
      batch(() => {
        overview.value = o;
        holdings.value = h;
        atBroker.value = b;
        trades.value = t.trades;
        error.value = null;
        code.value = null;
      });
    } catch (e) {
      if (stale()) return;
      if (e instanceof ApiError && e.status === 401) return;
      // a portfolio or broker picked here and gone elsewhere: show all
      if (e instanceof ApiError && e.code === "not_found") {
        if (portfolio.value !== null || broker.value !== null) {
          batch(() => {
            portfolio.value = null;
            broker.value = null;
          });
          return load();
        }
      }
      batch(() => {
        error.value = says(e);
        code.value = codeOf(e);
        failures.value++;
      });
    }
  }

  // the refusal's sentence, or null once done and reloaded
  async function write<T>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<{ done: T } | { refused: string }> {
    try {
      const done = await call<T>(path, method, body);
      await load();
      return { done };
    } catch (e) {
      return { refused: plainError(says(e)) };
    }
  }

  const refusal = (r: { refused: string } | object): string | null =>
    "refused" in r ? r.refused : null;

  return {
    overview,
    holdings,
    atBroker,
    trades,
    error,
    code,
    failures,
    portfolio,
    broker,
    currency,
    load,
    // the view the address names, on arrival, a reload or a step back
    open(v: View) {
      batch(() => {
        portfolio.value = v.portfolio;
        broker.value = null;
        currency.value = v.currency;
      });
      return load();
    },
    pick(next: {
      portfolio?: number | null;
      broker?: string | null;
      currency?: string | null;
    }) {
      batch(() => {
        if (next.portfolio !== undefined) portfolio.value = next.portfolio;
        if (next.broker !== undefined) broker.value = next.broker;
        if (next.currency !== undefined) currency.value = next.currency;
      });
      return load();
    },
    // the saved trade, for a step that follows it
    addTrade: async (
      t: TradeIn,
    ): Promise<{ trade: SavedTrade } | { refused: string }> => {
      const r = await write<{ trade: SavedTrade }>("/api/v1/trades", "POST", t);
      return "refused" in r ? r : { trade: r.done.trade };
    },
    addFundTrade: async (t: FundTradeIn) =>
      refusal(await write("/api/v1/funds/trades", "POST", t)),
    setFundPrice: async (isin: string, p: FundPriceIn) =>
      refusal(
        await write(`/api/v1/funds/${encodeURIComponent(isin)}`, "PATCH", p),
      ),
    addPosition: async (p: PositionIn) =>
      refusal(await write("/api/v1/positions", "POST", p)),
    updatePosition: async (id: number, change: PositionChange) =>
      refusal(await write(`/api/v1/positions/${id}`, "PATCH", change)),
    removeTrade: async (id: number) =>
      refusal(await write(`/api/v1/trades/${id}`, "DELETE")),
    restoreTrade: async (id: number) =>
      refusal(await write(`/api/v1/trades/${id}/restore`, "POST")),
    removePosition: async (id: number) =>
      refusal(await write(`/api/v1/positions/${id}`, "DELETE")),
    createPortfolio: async (name: string) =>
      refusal(await write(PORTFOLIOS_PATH, "POST", { name })),
    renamePortfolio: async (id: number, name: string) =>
      refusal(await write(`${PORTFOLIOS_PATH}/${id}`, "PATCH", { name })),
    deletePortfolio: async (id: number) => {
      const r = await write(`${PORTFOLIOS_PATH}/${id}`, "DELETE");
      if (!("refused" in r) && portfolio.value === id) {
        portfolio.value = null;
        await load();
      }
      return refusal(r);
    },
    createBroker: async (name: string) =>
      refusal(await write("/api/v1/brokers", "POST", { name })),
    renameBroker: async (id: number, name: string) =>
      refusal(await write(`/api/v1/brokers/${id}`, "PATCH", { name })),
    deleteBroker: async (id: number) =>
      refusal(await write(`/api/v1/brokers/${id}`, "DELETE")),
    saveDisplay: async (display: string) =>
      refusal(
        await write("/api/v1/portfolio-settings", "PUT", {
          display_currency: display,
        }),
      ),
    // one left out is kept
    saveSettings: async (s: {
      display_currency?: string;
      time_zone?: string;
    }) => refusal(await write("/api/v1/portfolio-settings", "PUT", s)),
    // a preview saves nothing; a confirm saves the good rows
    importFile: async (
      args: ImportIn,
    ): Promise<{ done: Imported } | { refused: string }> => {
      const { portfolio: id, ...body } = args;
      const r = args.confirm
        ? await write<Imported>(`${PORTFOLIOS_PATH}/${id}/import`, "POST", body)
        : await call<Imported>(`${PORTFOLIOS_PATH}/${id}/import`, "POST", body)
            .then((done) => ({ done }))
            .catch((e: unknown) => ({ refused: plainError(says(e)) }));
      return r;
    },
    exportHref: (id: number) => `${PORTFOLIOS_PATH}/${id}/export`,
    // the currency a picked listing trades in, for the form's label
    // every portfolio and broker at once, whatever the page filters on:
    // where a listing is held and the dry powder a buy may pay from
    everything: (): Promise<Holdings | null> =>
      call<Holdings>("/api/v1/holdings").catch(() => null),
    listing: (id: string): Promise<Listing | null> =>
      call<{ instrument: Listing }>(
        `/api/v1/instruments/${encodeURIComponent(id)}`,
      )
        .then((r) => r.instrument)
        .catch(() => null),
    clear() {
      loads++;
      batch(() => {
        overview.value = null;
        holdings.value = null;
        atBroker.value = null;
        trades.value = null;
        error.value = null;
        code.value = null;
        portfolio.value = null;
        broker.value = null;
        currency.value = null;
      });
    },
  };
}

export type PortfolioStore = ReturnType<typeof portfolioStore>;
