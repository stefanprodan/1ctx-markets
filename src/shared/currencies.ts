// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The ISO 4217 currencies in circulation, codes only: the browser's own
// list differs by browser and holds withdrawn ones, and its names come
// from Intl.DisplayNames in the reader's language.

export const CURRENCIES: readonly string[] = (
  "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB " +
  "BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF " +
  "DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD " +
  "HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF " +
  "KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT " +
  "MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN " +
  "PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP " +
  "SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS " +
  "UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR " +
  "ZMW ZWG"
).split(" ");

const CIRCULATING = new Set(CURRENCIES);

export const inCirculation = (code: string): boolean => CIRCULATING.has(code);

// listings priced in a currency's hundredth, by the code Yahoo gives
// them; a trade keeps it, since the major code would be 100 times it
export const HUNDREDTHS: Readonly<Record<string, [string, number]>> = {
  GBp: ["GBP", 0.01],
  GBX: ["GBP", 0.01],
  ZAc: ["ZAR", 0.01],
  ILA: ["ILS", 0.01],
};

// a currency a person or a file names for money held or paid
export const isCurrencyCode = (code: string): boolean =>
  inCirculation(code) || Object.hasOwn(HUNDREDTHS, code);

let names: Intl.DisplayNames | null | undefined;

// the browser's name for a code, or null where it has none
export function currencyName(code: string): string | null {
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames(undefined, { type: "currency" });
    } catch {
      names = null;
    }
  }
  const name = names?.of(code);
  return name && name !== code ? name : null;
}

// the currencies a query finds: the code typed first, then codes it
// starts, then names that hold it, so "ron" is RON before Danish Krone
export function findCurrencies(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...CURRENCIES];
  const rank = (code: string): number => {
    const c = code.toLowerCase();
    if (c === q) return 0;
    if (c.startsWith(q)) return 1;
    return (currencyName(code) ?? "").toLowerCase().includes(q) ? 2 : -1;
  };
  return CURRENCIES.map((code) => ({ code, r: rank(code) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.code);
}
