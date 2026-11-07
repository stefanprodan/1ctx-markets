// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// research's options: fetched inside the call, kept in memory for the quote
// period as quote's extended is, so a summary read twice costs no call.

import { iso } from "../market/format.ts";
import type { Instrument } from "../market/instruments.ts";
import { localDate } from "../market/zone.ts";
import { upcomingEvent } from "../sources/finnhub/read.ts";
import type { OptionChain } from "../sources/yahoo/client.ts";
import {
  type Chain,
  chainRows,
  daysTo,
  earningsExpiry,
  expiryDate,
  NEAREST_LISTED,
  NO_OPTIONS,
  NOT_OPTIONABLE,
  nearestListed,
  optionable,
  summaryExpiries,
  summaryRow,
} from "../sources/yahoo/options.ts";
import { ArgError } from "./args.ts";
import { type Markets, shared } from "./markets.ts";
import { itemError, timeout } from "./targets.ts";

const keyOf = (id: string, expiry: number | undefined) =>
  `${id}:${expiry ?? "listed"}`;

async function chainOf(
  m: Markets,
  instrument: Instrument,
  expiry: number | undefined,
  deadline: number,
): Promise<OptionChain> {
  const key = keyOf(instrument.id, expiry);
  const cached = m.options.get(key);
  if (cached !== undefined && m.clock.now() < cached.until) {
    return cached.answer;
  }
  const answer = await shared(m, `options:${key}`, deadline, (live) =>
    m.yahoo.within(live).options(instrument.sourceSymbol, expiry),
  );
  const now = m.clock.now();
  // what a past period kept is never read again
  for (const [k, v] of m.options) if (v.until <= now) m.options.delete(k);
  const period = m.quoteEveryMs;
  const until = (Math.floor(answer.fetchedAt / period) + 1) * period;
  m.options.set(key, { until, answer });
  // the listing's answer is its nearest expiry's chain too
  if (expiry === undefined && answer.chain !== null) {
    m.options.set(keyOf(instrument.id, answer.chain.expiry), { until, answer });
  }
  return answer;
}

const EXPIRED = Symbol("expired");

export type OptionsSection = Record<string, unknown>;

// Without expiry, the summary; with it, that expiry's chain near the money.
// An expiry not listed is refused once the listing is read.
export async function readOptions(
  m: Markets,
  instrument: Instrument,
  expiry: string | null,
  deadline: number,
): Promise<OptionsSection> {
  if (!optionable(instrument)) {
    return { source: "yahoo", message: NOT_OPTIONABLE };
  }
  let cancel = () => {};
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    cancel = m.clock.at(deadline, () => resolve(EXPIRED));
  });
  const within = <T>(p: Promise<T>) => Promise.race([p, expired]);
  try {
    const first = await within(chainOf(m, instrument, undefined, deadline));
    if (first === EXPIRED) return { source: "yahoo", ...timeout(m) };
    if (first.chain === null) {
      return {
        source: "yahoo",
        message: NO_OPTIONS,
        fetched_at: iso(first.fetchedAt),
      };
    }
    const today = localDate(instrument.zone, m.clock.now());
    const head = (a: OptionChain) => ({
      source: "yahoo",
      price: a.price,
      price_at: iso(a.priceAt),
      currency: a.currency,
      fetched_at: iso(a.fetchedAt),
      stale: [],
    });
    const listed = first.chain;
    const ask = (at: number): Promise<OptionChain | typeof EXPIRED> =>
      at === listed.expiry
        ? Promise.resolve(first)
        : within(chainOf(m, instrument, at, deadline));
    if (expiry !== null) {
      const at = first.expiries.find((e) => expiryDate(e) === expiry);
      if (at === undefined) {
        throw new ArgError(
          `expiry ${expiry} is not listed; the nearest ${NEAREST_LISTED} listed: ${nearestListed(first.expiries, expiry).join(", ")}`,
        );
      }
      const got = await ask(at);
      if (got === EXPIRED) return { source: "yahoo", ...timeout(m) };
      return {
        ...head(got),
        expiry,
        days: daysTo(at, today),
        strikes: chainRows(got.chain as Chain, got.price),
      };
    }
    // one reported or past has moved the price already
    const event = upcomingEvent(m.db, instrument, m.clock.now());
    const rows = summaryExpiries(
      first.expiries,
      today,
      earningsExpiry(first.expiries, event),
    );
    const summary = await Promise.all(
      rows.map(async (r) => {
        const row = {
          expiry: expiryDate(r.expiry),
          days: daysTo(r.expiry, today),
          earnings: r.earnings,
        };
        try {
          const got = await ask(r.expiry);
          if (got === EXPIRED) return { ...row, ...timeout(m) };
          // every figure from the one price the answer names
          return { ...row, ...summaryRow(got.chain as Chain, first.price) };
        } catch (error) {
          return { ...row, ...itemError(m, error) };
        }
      }),
    );
    return {
      ...head(first),
      expiries: first.expiries.map(expiryDate),
      summary,
    };
  } catch (error) {
    if (error instanceof ArgError) throw error;
    return { source: "yahoo", ...itemError(m, error) };
  } finally {
    cancel();
  }
}
