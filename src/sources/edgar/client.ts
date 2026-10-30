// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// the contact line only in the User-Agent; nothing of an answer but checked
// codes, dates and numbers is kept, so no text can carry it back

import type { Clock } from "../../runtime/clock.ts";
import { EDGAR } from "../ids.ts";
import {
  type Backoff,
  type Fetch,
  limiter,
  type RunOptions,
  SourceError,
  Unreadable,
} from "../source.ts";

export const SOURCE = EDGAR;
export const WWW = "https://www.sec.gov";
export const DATA = "https://data.sec.gov";
export const TICKERS_PATH = "/files/company_tickers.json";
// half SEC's stated 10 a second, so a burst of tool calls never earns a block
export const SPACING_MS = 200;
const TIMEOUT_MS = 30_000;

// new securities registered or offered, shares or debt; 424B2 and 424B3
// are left out: banks file thousands a year for structured notes
export const OFFERING_FORMS = [
  "S-1",
  "S-1/A",
  "S-3",
  "S-3/A",
  "S-3ASR",
  "424B1",
  "424B4",
  "424B5",
] as const;
export const LATE_FORMS = ["NT 10-K", "NT 10-Q"] as const;
export const KEPT_FORMS: ReadonlySet<string> = new Set([
  "10-K",
  "10-K/A",
  "10-Q",
  "10-Q/A",
  "8-K",
  "8-K/A",
  ...LATE_FORMS,
  ...OFFERING_FORMS,
]);

// the newest periodic report says which regime a company files under now
const US_REPORTS = /^10-[KQ]T?(\/A)?$/;
const FOREIGN_REPORTS = /^(20-F|40-F|6-K)(\/A)?$/;

export type Filing = {
  accession: string;
  form: string;
  acceptedAt: number;
  filed: string;
  period: string | null;
  items: string[];
};

export type Submissions = {
  cik: number;
  // files 20-F, 40-F or 6-K rather than 10-K and 10-Q
  foreign: boolean;
  // the kept forms only, newest first
  filings: Filing[];
  fetchedAt: number;
};

export type Tickers = { ciks: Map<string, number>; fetchedAt: number };

// a header value must be printable ASCII, or every call fails as a
// network error while the source reads on
export const usableContact = (line: string): boolean =>
  /^[\x20-\x7e]+$/.test(line) && line.includes("@");

// why a key file that holds no usable contact line leaves EDGAR off
export const BAD_CONTACT = "bad contact line";

export type Edgar = {
  tickers(): Promise<Tickers>;
  submissions(cik: number): Promise<Submissions>;
  failFast(): Edgar;
  within(live: () => boolean): Edgar;
  close(): void;
  due(): number | null;
  backoff(): Backoff | null;
};

export type EdgarOptions = {
  clock: Clock;
  // a name and an email, as SEC asks every client to declare
  contact: string;
  fetch?: Fetch;
  www?: string;
  data?: string;
};

const malformed = (detail: string) =>
  new SourceError("malformed answer", detail);

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const ITEM = /^\d{1,2}\.\d{2}$/;
// SEC lists a few per 8-K; a cap keeps any answer's filing within a page
export const MAX_ITEMS = 20;
// Yahoo's form of a class share, BRK-B, is SEC's too
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
// SEC's time is UTC to the second; the filing index shows it in Eastern
const ACCEPTED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const cikPath = (cik: number): string =>
  `/submissions/CIK${String(cik).padStart(10, "0")}.json`;

// the filing's index page, which links every document in it
export const filingUrl = (cik: number, accession: string): string =>
  `${WWW}/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${accession}-index.htm`;

// an odd entry is skipped, but an answer with none would empty the map
export function parseTickers(body: unknown): Map<string, number> {
  if (!isObj(body)) throw malformed("no tickers");
  const ciks = new Map<string, number>();
  for (const v of Object.values(body)) {
    if (!isObj(v)) continue;
    const { ticker, cik_str: cik } = v;
    if (typeof ticker !== "string" || !TICKER.test(ticker)) continue;
    if (typeof cik !== "number" || !Number.isSafeInteger(cik) || cik <= 0) {
      continue;
    }
    // SEC lists a ticker once; a second CIK for it could be either
    if (ciks.has(ticker) && ciks.get(ticker) !== cik) ciks.set(ticker, -1);
    else ciks.set(ticker, cik);
  }
  for (const [t, c] of ciks) if (c < 0) ciks.delete(t);
  if (ciks.size === 0) throw malformed("no tickers");
  return ciks;
}

function column(recent: Obj, name: string, length?: number): unknown[] {
  const v = recent[name];
  if (!Array.isArray(v) || (length !== undefined && v.length !== length)) {
    throw malformed(`no ${name}`);
  }
  return v;
}

// a kept filing that does not parse fails the answer: skipping it could
// hide the very filing a flag is for
export function parseSubmissions(
  body: unknown,
  cik: number,
): Omit<Submissions, "fetchedAt"> {
  if (!isObj(body)) throw malformed("no body");
  if (Number(body.cik) !== cik) throw malformed("another company's answer");
  const filings = isObj(body.filings) ? body.filings : null;
  const recent =
    filings !== null && isObj(filings.recent) ? filings.recent : null;
  if (recent === null) throw malformed("no filings");
  const forms = column(recent, "form");
  const n = forms.length;
  const accession = column(recent, "accessionNumber", n);
  const filed = column(recent, "filingDate", n);
  const period = column(recent, "reportDate", n);
  const accepted = column(recent, "acceptanceDateTime", n);
  const items = column(recent, "items", n);
  const kept: Filing[] = [];
  let report: { form: string; at: number } | null = null;
  for (let i = 0; i < n; i++) {
    const form = forms[i];
    if (typeof form !== "string") throw malformed("no form");
    const periodic = US_REPORTS.test(form) || FOREIGN_REPORTS.test(form);
    if (!KEPT_FORMS.has(form) && !periodic) continue;
    const at = accepted[i];
    const acceptedAt =
      typeof at === "string" && ACCEPTED.test(at) ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(acceptedAt)) throw malformed("no acceptanceDateTime");
    if (periodic && (report === null || acceptedAt > report.at)) {
      report = { form, at: acceptedAt };
    }
    if (!KEPT_FORMS.has(form)) continue;
    const a = accession[i];
    if (typeof a !== "string" || !ACCESSION.test(a)) {
      throw malformed("no accessionNumber");
    }
    const f = filed[i];
    if (typeof f !== "string" || !DATE.test(f))
      throw malformed("no filingDate");
    const p = period[i];
    if (p !== "" && (typeof p !== "string" || !DATE.test(p))) {
      throw malformed("no reportDate");
    }
    const codes = items[i];
    if (typeof codes !== "string") throw malformed("no items");
    kept.push({
      accession: a,
      form,
      acceptedAt,
      filed: f,
      period: p === "" ? null : (p as string),
      // a code not of SEC's shape is dropped, so no text is ever kept
      items: [
        ...new Set(
          codes
            .split(",")
            .map((c) => c.trim())
            .filter((c) => ITEM.test(c)),
        ),
      ].slice(0, MAX_ITEMS),
    });
  }
  kept.sort(
    (x, y) =>
      y.acceptedAt - x.acceptedAt || y.accession.localeCompare(x.accession),
  );
  return {
    cik,
    foreign: report !== null && FOREIGN_REPORTS.test(report.form),
    filings: kept,
  };
}

export function edgar(options: EdgarOptions): Edgar {
  const { clock, contact } = options;
  const www = options.www ?? WWW;
  const data = options.data ?? DATA;
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const calls = limiter(clock, SPACING_MS);

  const get = <T>(
    url: string,
    run: RunOptions,
    parse: (body: unknown, fetchedAt: number) => T,
  ): Promise<T> =>
    calls.run(async () => {
      const abort = new AbortController();
      let timedOut = false;
      const cancel = clock.at(clock.now() + TIMEOUT_MS, () => {
        timedOut = true;
        abort.abort();
      });
      try {
        let res: Response;
        let raw: string;
        try {
          res = await doFetch(url, {
            headers: { Accept: "application/json", "User-Agent": contact },
            signal: abort.signal,
          });
          raw = await res.text();
        } catch {
          throw new SourceError(timedOut ? "timed out" : "network error");
        }
        const fetchedAt = clock.now();
        // SEC answers a client over its limit or without a contact with 403
        if (res.status === 429 || res.status === 403) {
          throw new SourceError("rate limited");
        }
        if (res.status === 404) throw new SourceError("not found");
        if (res.status === 400) throw new SourceError("bad request");
        if (!res.ok) {
          throw new SourceError("source error", `HTTP ${res.status}`);
        }
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Unreadable();
        }
        return parse(body, fetchedAt);
      } finally {
        cancel();
      }
    }, run);

  const client = (run: RunOptions): Edgar => ({
    tickers: () =>
      get(`${www}${TICKERS_PATH}`, run, (body, fetchedAt) => ({
        ciks: parseTickers(body),
        fetchedAt,
      })),
    submissions: (cik) =>
      get(`${data}${cikPath(cik)}`, run, (body, fetchedAt) => ({
        ...parseSubmissions(body, cik),
        fetchedAt,
      })),
    failFast: () => client({ failFast: true }),
    within: (live) => client({ failFast: true, live }),
    close: () => calls.close(),
    due: () => calls.due(),
    backoff: () => calls.backoff(),
  });
  return client({});
}
