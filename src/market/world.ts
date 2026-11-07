// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// World markets: the one built-in list, always tracked, a new person's Home.

export type WorldEntry = {
  group: string;
  name: string;
  // as the quote tool takes it
  symbol: string;
  // shown in the index's place while its market is closed
  futures?: { symbol: string; label: string };
  // only while the Bucharest source is on
  bvb?: true;
  // the CFTC market tracking the entry directly, its futures symbol too;
  // never a market quoted the other way round (the yen, the franc)
  cftc?: string;
};

// a new person's Home shows this many of each group
export const HOME_PER_GROUP = 4;

export const WORLD_MARKETS: readonly WorldEntry[] = [
  {
    group: "Americas",
    name: "S&P 500",
    symbol: "^GSPC",
    cftc: "13874+",
    futures: { symbol: "ES=F", label: "S&P Futures" },
  },
  {
    group: "Americas",
    name: "Nasdaq 100",
    symbol: "^NDX",
    cftc: "20974+",
    futures: { symbol: "NQ=F", label: "Nasdaq Futures" },
  },
  {
    group: "Americas",
    name: "Dow 30",
    symbol: "^DJI",
    cftc: "12460+",
    futures: { symbol: "YM=F", label: "Dow Futures" },
  },
  {
    group: "Americas",
    name: "Russell 2000",
    symbol: "^RUT",
    cftc: "239742",
    futures: { symbol: "RTY=F", label: "Russell 2000 Futures" },
  },
  { group: "Americas", name: "S&P/TSX Composite", symbol: "^GSPTSE" },
  { group: "Europe", name: "BET", symbol: "BVB:BET", bvb: true },
  { group: "Europe", name: "DAX", symbol: "^GDAXI" },
  { group: "Europe", name: "FTSE 100", symbol: "^FTSE" },
  { group: "Europe", name: "CAC 40", symbol: "^FCHI" },
  { group: "Europe", name: "Euro Stoxx 50", symbol: "^STOXX50E" },
  { group: "Europe", name: "SMI", symbol: "^SSMI" },
  {
    group: "Asia",
    name: "Nikkei 225",
    symbol: "^N225",
    cftc: "240743",
    futures: { symbol: "NIY=F", label: "Nikkei Futures" },
  },
  { group: "Asia", name: "Hang Seng", symbol: "^HSI" },
  { group: "Asia", name: "TAIEX", symbol: "^TWII" },
  { group: "Asia", name: "KOSPI", symbol: "^KS11" },
  { group: "Asia", name: "S&P/ASX 200", symbol: "^AXJO" },
  { group: "Commodities", name: "Gold", symbol: "GC=F", cftc: "088691" },
  { group: "Commodities", name: "Silver", symbol: "SI=F", cftc: "084691" },
  { group: "Commodities", name: "Copper", symbol: "HG=F", cftc: "085692" },
  { group: "Commodities", name: "Crude Oil", symbol: "CL=F", cftc: "067651" },
  { group: "Commodities", name: "Natural Gas", symbol: "NG=F", cftc: "023651" },
  { group: "Currencies", name: "EUR/RON", symbol: "EURRON=X", bvb: true },
  { group: "Currencies", name: "EUR/USD", symbol: "EURUSD=X", cftc: "099741" },
  { group: "Currencies", name: "USD/JPY", symbol: "JPY=X" },
  { group: "Currencies", name: "GBP/USD", symbol: "GBPUSD=X", cftc: "096742" },
  { group: "Currencies", name: "USD/CNY", symbol: "CNY=X" },
  { group: "Currencies", name: "USD/CHF", symbol: "CHF=X" },
  { group: "Crypto", name: "Bitcoin", symbol: "BTC-USD", cftc: "133741" },
  { group: "Crypto", name: "Ether", symbol: "ETH-USD", cftc: "146021" },
  { group: "Crypto", name: "BNB", symbol: "BNB-USD" },
  { group: "Crypto", name: "XRP", symbol: "XRP-USD" },
  { group: "Crypto", name: "Solana", symbol: "SOL-USD" },
];

export const worldOn = (
  list: readonly WorldEntry[],
  bvb: boolean,
): WorldEntry[] => list.filter((e) => bvb || e.bvb !== true);

// the CFTC market of a World markets symbol or its futures, by Yahoo symbol
export function cftcPair(
  symbol: string,
  list: readonly WorldEntry[] = WORLD_MARKETS,
): { entry: WorldEntry; code: string } | null {
  const upper = symbol.toUpperCase();
  for (const entry of list) {
    if (entry.cftc === undefined) continue;
    if (entry.symbol === upper || entry.futures?.symbol === upper) {
      return { entry, code: entry.cftc };
    }
  }
  return null;
}

// every entry before any pair, so a new Home fills before the futures
export const worldSymbols = (list: readonly WorldEntry[]): string[] => [
  ...new Set([
    ...list.map((e) => e.symbol),
    ...list.flatMap((e) => (e.futures === undefined ? [] : [e.futures.symbol])),
  ]),
];
