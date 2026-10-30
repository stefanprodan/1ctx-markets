// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { spec } from "../src/api/openapi.ts";
import { recordSession, session } from "../src/market/calendars.ts";
import { markRead } from "../src/market/tracking.ts";
import { fits } from "../src/operations/answer.ts";
import { CALL_MS, markets } from "../src/operations/markets.ts";
import {
  eventItem,
  FILINGS_PAGE_ROWS,
  FILINGS_RECENT,
  researchList,
} from "../src/operations/research.ts";
import { DAY_MS, MINUTE_MS } from "../src/runtime/clock.ts";
import { silent } from "../src/runtime/log.ts";
import {
  edgar,
  KEPT_FORMS,
  parseSubmissions,
  parseTickers,
} from "../src/sources/edgar/client.ts";
import { edgarJobs } from "../src/sources/edgar/jobs.ts";
import {
  filerState,
  flags,
  KEPT_MS,
  NO_DATA,
  NOT_COVERED,
  pruneFilings,
  REASONS,
  readFilings,
  STALE_FILINGS,
  storeFilings,
} from "../src/sources/edgar/store.ts";
import { refreshFilings } from "../src/sources/edgar/sync.ts";
import { readEvent } from "../src/sources/finnhub/read.ts";
import { Paused, SourceError } from "../src/sources/source.ts";
import { yahoo } from "../src/sources/yahoo/client.ts";
import { type Db, open } from "../src/storage/db/index.ts";
import { writer } from "../src/storage/writer.ts";
import { parseResearch, researchAnswer } from "../src/tools/research.ts";
import { api, READ_KEY } from "./helpers/api.ts";
import { withApp } from "./helpers/app.ts";
import { fakeClock } from "./helpers/clock.ts";
import { drive } from "./helpers/drive.ts";
import {
  CIKS,
  EDGAR_CONTACT,
  edgarAnswer,
  edgarFixture,
  RECORDED,
  share,
} from "./helpers/edgar.ts";
import { answerSchema, validate } from "./helpers/schema.ts";
import { gate } from "./helpers/sources.ts";
import { clone, fakeFetch, type Recorded } from "./helpers/yahoo.ts";

type Hold = (url: URL) => Recorded | Promise<Recorded | undefined> | undefined;

function setup(options: { off?: boolean; hold?: Hold; start?: number } = {}) {
  const clock = fakeClock(options.start ?? RECORDED);
  const { db } = open(":memory:", clock);
  const f = fakeFetch(
    async (url) => (await options.hold?.(url)) ?? edgarAnswer(url),
  );
  const write = writer(db);
  const client = options.off
    ? null
    : edgar({ clock, contact: EDGAR_CONTACT, fetch: f.fetch });
  const m = markets({
    db,
    clock,
    writer: write,
    yahoo: yahoo({ clock, fetch: f.fetch }),
    fred: null,
    edgar: client,
    log: silent,
  });
  const ctx = { db, clock, writer: write, edgar: client };
  const tickerCalls = () =>
    f.urls.filter((u) => u.pathname === "/files/company_tickers.json");
  const submissionCalls = () =>
    f.urls.filter((u) => u.hostname === "data.sec.gov");
  const paced = client === null ? [] : [client];
  return {
    clock,
    db,
    m,
    client,
    ctx,
    f,
    tickerCalls,
    submissionCalls,
    paced,
  };
}

const body = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0]!.text);

const count = (db: Db, table: string) =>
  (db.query(`select count(*) as n from ${table}`).get() as { n: number }).n;

const recent = async (name: string) =>
  (await edgarFixture(`submissions-${name}`)).body;

const status = (code: number): Recorded => ({
  recordedAt: "",
  status: code,
  headers: {},
  body: "",
});

describe("the EDGAR client", () => {
  test("sends the contact line only as its User-Agent", async () => {
    const t = setup();
    const answer = await drive(
      t.clock,
      t.paced,
      t.client!.submissions(CIKS.AAPL!),
    );
    expect(answer.cik).toBe(CIKS.AAPL!);
    expect(t.f.urls.map(String)).toEqual([
      "https://data.sec.gov/submissions/CIK0000320193.json",
    ]);
    expect(t.f.headers[0]!.get("user-agent")).toBe(EDGAR_CONTACT);
    expect(String(t.f.urls[0])).not.toContain("example.invalid");
  });

  test("keeps only the kept forms, newest first, items as codes, times in UTC", async () => {
    const parsed = parseSubmissions(await recent("aapl"), CIKS.AAPL!);
    expect(parsed.foreign).toBe(false);
    expect(parsed.filings.length).toBeGreaterThan(10);
    for (const f of parsed.filings) expect(KEPT_FORMS.has(f.form)).toBe(true);
    const times = parsed.filings.map((f) => f.acceptedAt);
    expect(times).toEqual(times.toSorted((a, b) => b - a));
    const results = parsed.filings.find(
      (f) => f.accession === "0000320193-26-000018",
    );
    // SEC's index page shows this one accepted at 16:30:28 Eastern
    expect(results).toMatchObject({
      form: "8-K",
      acceptedAt: Date.parse("2026-07-30T20:30:28Z"),
      filed: "2026-07-30",
      items: ["2.02", "9.01"],
    });
    const quarterly = parsed.filings.find((f) => f.form === "10-Q")!;
    expect(quarterly.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(quarterly.items).toEqual([]);
  });

  test("leaves out a bank's note prospectuses", async () => {
    const raw = await recent("jpm");
    expect(raw.filings.recent.form).toContain("424B2");
    const parsed = parseSubmissions(raw, CIKS.JPM!);
    expect(parsed.filings.map((f) => f.form)).not.toContain("424B2");
    expect(parsed.filings.map((f) => f.form)).toContain("S-3");
  });

  test("a company whose newest report is a 20-F or 6-K is a foreign filer", async () => {
    expect(parseSubmissions(await recent("tsm"), CIKS.TSM!).foreign).toBe(true);
    expect(parseSubmissions(await recent("jpm"), CIKS.JPM!).foreign).toBe(
      false,
    );
  });

  test("a kept filing that does not parse, or another company's answer, is malformed", async () => {
    const raw = await recent("aapl");
    const at = (raw.filings.recent.form as string[]).indexOf("8-K");
    const bad = clone(raw);
    bad.filings.recent.accessionNumber[at] = "not an accession";
    expect(() => parseSubmissions(bad, CIKS.AAPL!)).toThrow(SourceError);
    const late = clone(raw);
    late.filings.recent.acceptanceDateTime[at] = "2026-07-30 16:30:28";
    expect(() => parseSubmissions(late, CIKS.AAPL!)).toThrow(
      "malformed answer",
    );
    expect(() => parseSubmissions(raw, CIKS.NVDA!)).toThrow(
      "another company's answer",
    );
    const short = clone(raw);
    short.filings.recent.items.pop();
    expect(() => parseSubmissions(short, CIKS.AAPL!)).toThrow("no items");
  });

  test("an item code not of SEC's shape is dropped, so no text is kept", async () => {
    const raw = clone(await recent("aapl"));
    const at = (raw.filings.recent.form as string[]).indexOf("8-K");
    raw.filings.recent.items[at] = "2.02, <b>call us</b>,9.01,2.02";
    const f = parseSubmissions(raw, CIKS.AAPL!).filings.find(
      (x) => x.accession === raw.filings.recent.accessionNumber[at],
    );
    expect(f?.items).toEqual(["2.02", "9.01"]);
  });

  test("the ticker map reads a class share as Yahoo writes it", async () => {
    const ciks = parseTickers((await edgarFixture("company-tickers")).body);
    expect(ciks.get("BRK-B")).toBe(1067983);
    expect(ciks.get("GOOG")).toBe(ciks.get("GOOGL")!);
    expect(ciks.get("AAPL")).toBe(CIKS.AAPL!);
    expect(() => parseTickers({})).toThrow("no tickers");
    expect(() => parseTickers([])).toThrow("no tickers");
  });

  test("a 403 or 429 is rate limited and pauses the source; a 404 does not", async () => {
    for (const code of [403, 429]) {
      const t = setup({ hold: () => status(code) });
      const fast = t.client!.failFast();
      await expect(fast.submissions(CIKS.AAPL!)).rejects.toThrow(
        "rate limited",
      );
      expect(t.client!.backoff()).toMatchObject({ after: "rate limited" });
      await expect(fast.submissions(CIKS.AAPL!)).rejects.toBeInstanceOf(Paused);
    }
    const t = setup();
    await expect(
      drive(t.clock, t.paced, t.client!.submissions(9_999_999_999)),
    ).rejects.toThrow("not found");
    expect(t.client!.backoff()).toBeNull();
  });

  test("calls start at most five a second", async () => {
    const t = setup();
    const starts: number[] = [];
    const client = edgar({
      clock: t.clock,
      contact: EDGAR_CONTACT,
      fetch: async (url, init) => {
        starts.push(t.clock.now());
        return t.f.fetch(url, init);
      },
    });
    await drive(
      t.clock,
      [client],
      Promise.all(Object.values(CIKS).map((cik) => client.submissions(cik))),
    );
    expect(starts).toHaveLength(Object.keys(CIKS).length);
    for (let k = 1; k < starts.length; k++) {
      expect(starts[k]! - starts[k - 1]!).toBeGreaterThanOrEqual(200);
    }
  });
});

describe("filings inside the call", () => {
  test("a share never fetched gets the map and its filings within the deadline, then reads the store", async () => {
    const t = setup();
    share(t.db, "SURG", RECORDED);
    const call = () =>
      drive(
        t.clock,
        t.paced,
        researchAnswer(
          t.m,
          parseResearch({ symbol: "US:SURG", section: "filings" }),
        ),
      );
    const b = body(await call());
    expect(t.tickerCalls()).toHaveLength(1);
    expect(t.submissionCalls()).toHaveLength(1);
    expect(b).toMatchObject({
      id: "US:SURG",
      section: "filings",
      source: "edgar",
      stale: [],
      // an NT 10-Q in August and a 424B5 in October
      late_filing: true,
      restatement: false,
      offering: true,
      next: null,
    });
    expect(b.fetched_at).toBe("2026-10-29T23:58:00Z");
    const forms = b.filings.map((f: { form: string }) => f.form);
    expect(forms).toContain("NT 10-Q");
    expect(forms).toContain("424B5");
    const times = b.filings.map((f: { accepted_at: string }) => f.accepted_at);
    expect(times).toEqual(times.toSorted().reverse());
    const nt = b.filings.find((f: { form: string }) => f.form === "NT 10-Q");
    expect(nt.url).toBe(
      `https://www.sec.gov/Archives/edgar/data/${CIKS.SURG}/${nt.accession.replaceAll("-", "")}/${nt.accession}-index.htm`,
    );
    const eightK = b.filings.find((f: { form: string }) => f.form === "8-K");
    for (const item of eightK.items) {
      expect(item.code).toMatch(/^\d\.\d\d$/);
      expect(item.name).toBeString();
    }
    await call();
    expect(t.tickerCalls()).toHaveLength(1);
    expect(t.submissionCalls()).toHaveLength(1);
  });

  test("the overview carries the five newest filings and the flags", async () => {
    const t = setup();
    share(t.db, "OPTU", RECORDED);
    const b = body(
      await drive(
        t.clock,
        t.paced,
        researchAnswer(t.m, parseResearch({ symbol: "US:OPTU" })),
      ),
    );
    expect(b.filings).toMatchObject({
      source: "edgar",
      late_filing: false,
      restatement: true,
      offering: false,
    });
    expect(b.filings.recent).toHaveLength(FILINGS_RECENT);
    const restated = b.filings.recent.find(
      (f: { accession: string }) => f.accession === "0001702780-26-000057",
    );
    expect(restated.items).toEqual([
      { code: "2.02", name: "results of operations" },
      { code: "4.02", name: "non-reliance on prior statements" },
      { code: "9.01", name: "financial statements and exhibits" },
    ]);
  });

  test("two shares new to the server ask for the map once", async () => {
    const t = setup();
    share(t.db, "AAPL", RECORDED);
    share(t.db, "JPM", RECORDED);
    const items = await drive(
      t.clock,
      t.paced,
      researchList(t.m, {
        symbols: ["US:AAPL", "US:JPM"],
        parts: ["filings"],
        since: null,
      }),
    );
    expect(t.tickerCalls()).toHaveLength(1);
    expect(t.submissionCalls()).toHaveLength(2);
    expect(items.map((i) => Object.keys(i))).toEqual([
      ["input", "id", "filings"],
      ["input", "id", "filings"],
    ]);
    // a bank's daily note prospectuses never set the offering flag
    expect(items[1]).toMatchObject({
      filings: { late_filing: false, restatement: false, offering: false },
    });
    const research = answerSchema(spec, "GET", "/research", 200)!;
    expect(validate({ research: items }, research, spec)).toEqual([]);
  });

  test("a share not in SEC's map answers no data with its reason, never false flags", async () => {
    const t = setup();
    share(t.db, "ZZZZ", RECORDED);
    const b = body(
      await drive(
        t.clock,
        t.paced,
        researchAnswer(
          t.m,
          parseResearch({ symbol: "US:ZZZZ", section: "filings" }),
        ),
      ),
    );
    expect(t.submissionCalls()).toHaveLength(0);
    expect(b).toMatchObject({
      message: NO_DATA,
      reason: REASONS.noCik,
      late_filing: null,
      restatement: null,
      offering: null,
      filings: [],
    });
  });

  test("a 20-F filer answers no data from EDGAR with the reason foreign filer", async () => {
    const t = setup();
    share(t.db, "TSM", RECORDED, { exchange: "NYQ" });
    const b = body(
      await drive(
        t.clock,
        t.paced,
        researchAnswer(t.m, parseResearch({ symbol: "US:TSM" })),
      ),
    );
    expect(b.filings).toEqual({
      source: "edgar",
      message: NO_DATA,
      reason: REASONS.foreign,
      fetched_at: "2026-10-29T23:58:00Z",
      stale: [],
      late_filing: null,
      restatement: null,
      offering: null,
      recent: [],
    });
    expect(count(t.db, "filings")).toBe(0);
  });

  test("EDGAR off answers no data from EDGAR; an ETF is not covered", async () => {
    const off = setup({ off: true });
    share(off.db, "AAPL", RECORDED);
    const b = body(
      await researchAnswer(
        off.m,
        parseResearch({ symbol: "US:AAPL", section: "filings" }),
      ),
    );
    expect(b).toMatchObject({
      source: "edgar",
      message: NO_DATA,
      late_filing: null,
      restatement: null,
      offering: null,
      filings: [],
    });
    const t = setup();
    share(t.db, "SPY", RECORDED, { type: "ETF" });
    const etf = body(
      await researchAnswer(t.m, parseResearch({ symbol: "US:SPY" })),
    );
    expect(etf.filings).toMatchObject({ message: NOT_COVERED, offering: null });
    expect(t.f.urls).toHaveLength(0);
  });

  test("not done by the deadline answers timeout and stores nothing", async () => {
    const held = gate();
    const t = setup({
      hold: (url) =>
        url.hostname === "data.sec.gov" ? held.hold() : undefined,
    });
    share(t.db, "AAPL", RECORDED);
    const answer = researchAnswer(
      t.m,
      parseResearch({ symbol: "US:AAPL", section: "filings" }),
    );
    await drive(t.clock, t.paced, held.arrived);
    await t.clock.advance(CALL_MS);
    const b = body(await answer);
    expect(b).toMatchObject({ error: "timeout", stale: [STALE_FILINGS.none] });
    expect(b.late_filing).toBeNull();
    const flights = [...t.m.inflight.values()].map((f) =>
      f.promise.catch(() => {}),
    );
    held.release();
    await Promise.all(flights);
    expect(count(t.db, "filings")).toBe(0);
    expect(
      t.db.query("select job from sync_runs where source = 'edgar'").all(),
    ).toEqual([{ job: "tickers" }]);
  });

  test("a failed fetch is the answer's error and the section's stale reason", async () => {
    const t = setup({
      hold: (url) =>
        url.hostname === "data.sec.gov" ? status(500) : undefined,
    });
    share(t.db, "AAPL", RECORDED);
    const b = body(
      await drive(
        t.clock,
        t.paced,
        researchAnswer(
          t.m,
          parseResearch({ symbol: "US:AAPL", section: "filings" }),
        ),
      ),
    );
    expect(b).toMatchObject({ error: "source_error", late_filing: null });
    expect(b.stale).toEqual([STALE_FILINGS.none, STALE_FILINGS.failed]);
  });
});

describe("the filings section", () => {
  test("pages newest first under 32 KiB, the flags on the first page only", async () => {
    const t = setup();
    const i = share(t.db, "AAPL", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    // made-up filings, so the share has several pages
    const insert = t.db.query(
      `insert into filings (instrument, accession, form, accepted_at, filed,
         items, url, fetched_at)
       values ('US:AAPL', ?, '8-K', ?, '2026-01-02', '1.01,2.03,7.01,8.01,9.01', ?, ?)`,
    );
    for (let k = 0; k < 150; k++) {
      const accession = `0000000001-26-${String(k).padStart(6, "0")}`;
      insert.run(
        accession,
        RECORDED - (k + 1) * DAY_MS,
        `https://www.sec.gov/Archives/edgar/data/320193/${accession}-index.htm`,
        RECORDED,
      );
    }
    const stored = readFilings(t.db, "US:AAPL", 1_000).length;
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const r = await researchAnswer(
        t.m,
        parseResearch({
          symbol: "US:AAPL",
          section: "filings",
          ...(next === null ? {} : { next }),
        }),
      );
      expect(fits(r.content[0]!.text)).toBe(true);
      const b = body(r);
      expect(b.filings.length).toBeLessThanOrEqual(FILINGS_PAGE_ROWS);
      if (pages === 0) expect(b.offering).toBe(false);
      else expect("offering" in b).toBe(false);
      seen.push(...b.filings.map((f: { accession: string }) => f.accession));
      next = b.next;
      pages++;
    } while (next !== null);
    expect(pages).toBeGreaterThan(2);
    expect(seen).toHaveLength(stored);
    expect(new Set(seen).size).toBe(stored);
    await expect(
      researchAnswer(
        t.m,
        parseResearch({ symbol: "US:AAPL", section: "filings", next: "x" }),
      ),
    ).rejects.toThrow("next does not continue these arguments");
  });
});

describe("the flags", () => {
  test("a restatement counts for a year, then no more", async () => {
    const t = setup();
    const i = share(t.db, "OPTU", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    const at = (now: number) =>
      flags(t.db, i.id, filerState(t.db, i, now), now);
    expect(at(RECORDED)).toEqual({
      late_filing: false,
      restatement: true,
      offering: false,
    });
    // the 8-K with item 4.02 was accepted on 21 September 2026
    const filed = Date.parse("2026-09-21T21:00:26Z");
    expect(at(filed + 364 * DAY_MS).restatement).toBe(true);
    expect(at(filed + 366 * DAY_MS).restatement).toBe(false);
  });

  test("a late filing and an offering count for 90 days", async () => {
    const t = setup();
    const i = share(t.db, "SURG", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    const at = (now: number) =>
      flags(t.db, i.id, filerState(t.db, i, now), now);
    const nt = Date.parse("2026-08-17T21:20:01Z");
    const offer = Date.parse("2026-10-09T20:30:19Z");
    expect(at(nt + 89 * DAY_MS).late_filing).toBe(true);
    expect(at(nt + 91 * DAY_MS).late_filing).toBe(false);
    expect(at(offer + 89 * DAY_MS).offering).toBe(true);
    expect(at(offer + 91 * DAY_MS).offering).toBe(false);
  });
});

describe("events gain filed_at", () => {
  test("an 8-K with results within three days of the date sets it; none, or EDGAR off, is null", async () => {
    const t = setup();
    const i = share(t.db, "OPTU", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    const insert = t.db.query(
      `insert into events (instrument, fiscal_year, fiscal_quarter, date,
         hour, fetched_at) values ('US:OPTU', 2026, ?, ?, 'bmo', ?)`,
    );
    insert.run(2, "2026-08-06", RECORDED);
    // three days from the 8-K accepted on 21 September
    insert.run(3, "2026-09-24", RECORDED);
    insert.run(4, "2026-11-05", RECORDED);
    const item = (q: number, m = t.m) =>
      eventItem(
        m,
        i,
        readEvent(t.db, {
          instrument: i.id,
          fiscalYear: 2026,
          fiscalQuarter: q,
        })!,
      ).filed_at;
    expect(item(2)).toBe("2026-08-06T11:31:53Z");
    expect(item(3)).toBe("2026-09-21T21:00:26Z");
    expect(item(4)).toBeNull();
    const off = markets({ ...t.m, edgar: null, log: silent });
    expect(item(2, off)).toBeNull();
  });
});

describe("the daily pass", () => {
  // Thursday 29 October's regular session, 09:30 to 16:00 in New York
  const thursday = session(
    "America/New_York",
    Date.parse("2026-10-29T13:30:00Z"),
    Date.parse("2026-10-29T20:00:00Z"),
  );
  const friday = session(
    "America/New_York",
    Date.parse("2026-10-30T13:30:00Z"),
    Date.parse("2026-10-30T20:00:00Z"),
  );

  function pass(start = RECORDED, hold?: Hold) {
    const t = setup({ start, hold });
    const jobs = edgarJobs({ ctx: t.ctx, log: silent });
    const tick = () => drive(t.clock, t.paced, jobs.tick());
    return { ...t, tick };
  }

  test("asks each tracked share once after the US close, the map weekly", async () => {
    const t = pass();
    recordSession(t.db, "US", thursday, thursday.start);
    for (const s of ["AAPL", "JPM", "SURG"]) share(t.db, s, RECORDED);
    markRead(t.db, ["US:AAPL"], RECORDED);
    markRead(t.db, ["US:JPM"], RECORDED);
    const first = await t.tick();
    expect(first.tickers).toMatchObject({ rows: 9 });
    expect(first.asked.toSorted()).toEqual(["US:AAPL", "US:JPM"]);
    expect(t.submissionCalls()).toHaveLength(2);
    // the same evening: nothing is due
    await t.clock.advance(MINUTE_MS);
    expect((await t.tick()).asked).toEqual([]);
    // Friday's session: due only once it ended two hours ago
    await t.clock.advance(15 * 60 * MINUTE_MS);
    recordSession(t.db, "US", friday, t.clock.now());
    expect((await t.tick()).asked).toEqual([]);
    await t.clock.advance(friday.end + 2 * 60 * MINUTE_MS - t.clock.now());
    const evening = await t.tick();
    expect(evening.tickers).toBeNull();
    expect(evening.asked.toSorted()).toEqual(["US:AAPL", "US:JPM"]);
    expect(t.tickerCalls()).toHaveLength(1);
    // the weekend shows Friday's session: nothing more is asked
    await t.clock.advance(DAY_MS);
    markRead(t.db, ["US:AAPL"], t.clock.now());
    markRead(t.db, ["US:JPM"], t.clock.now());
    expect((await t.tick()).asked).toEqual([]);
    await t.clock.advance(6 * DAY_MS);
    markRead(t.db, ["US:AAPL"], t.clock.now());
    expect((await t.tick()).tickers).toMatchObject({ rows: 9 });
    expect(t.tickerCalls()).toHaveLength(2);
  });

  test("a share's stale reason says pending once the next close passed", async () => {
    const t = pass();
    recordSession(t.db, "US", thursday, thursday.start);
    const i = share(t.db, "AAPL", RECORDED);
    markRead(t.db, [i.id], RECORDED);
    await t.tick();
    expect(filerState(t.db, i, t.clock.now()).stale).toEqual([]);
    await t.clock.advance(DAY_MS);
    recordSession(t.db, "US", friday, t.clock.now());
    expect(filerState(t.db, i, t.clock.now()).stale).toEqual([
      STALE_FILINGS.pending,
    ]);
  });

  test("a failed share waits an hour before it is asked again", async () => {
    let fail = true;
    const t = pass(RECORDED, (url) =>
      fail && url.hostname === "data.sec.gov" ? status(500) : undefined,
    );
    share(t.db, "AAPL", RECORDED);
    markRead(t.db, ["US:AAPL"], RECORDED);
    const first = await t.tick();
    expect(first.failed).toEqual([
      { instrument: "US:AAPL", error: "source error" },
    ]);
    fail = false;
    await t.clock.advance(30 * MINUTE_MS);
    expect((await t.tick()).asked).toEqual([]);
    await t.clock.advance(31 * MINUTE_MS);
    expect((await t.tick()).asked).toEqual(["US:AAPL"]);
  });

  test("a failed map asks no share and waits an hour", async () => {
    let fail = true;
    const t = pass(RECORDED, (url) =>
      fail && url.hostname === "www.sec.gov" ? status(500) : undefined,
    );
    for (const s of ["AAPL", "JPM"]) {
      share(t.db, s, RECORDED);
      markRead(t.db, [`US:${s}`], RECORDED);
    }
    const first = await t.tick();
    expect(first).toEqual({
      tickers: { error: "source error" },
      asked: [],
      failed: [],
    });
    expect(t.submissionCalls()).toHaveLength(0);
    fail = false;
    await t.clock.advance(30 * MINUTE_MS);
    expect((await t.tick()).tickers).toBeNull();
    expect(t.tickerCalls()).toHaveLength(1);
    await t.clock.advance(31 * MINUTE_MS);
    const later = await t.tick();
    expect(later.tickers).toMatchObject({ rows: 9 });
    expect(later.asked.toSorted()).toEqual(["US:AAPL", "US:JPM"]);
  });

  test("with no tracked US share nothing is asked, the map included", async () => {
    const t = pass();
    share(t.db, "AAPL", RECORDED);
    const r = await t.tick();
    expect(r).toEqual({ tickers: null, asked: [], failed: [] });
    expect(t.f.urls).toHaveLength(0);
  });
});

describe("stored filings", () => {
  test("a ticker that moved to another company keeps none of the old one's", async () => {
    const t = setup();
    const i = share(t.db, "AAPL", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    expect(count(t.db, "filings")).toBeGreaterThan(0);
    const nvda = parseSubmissions(await recent("nvda"), CIKS.NVDA!);
    t.db.transaction(() =>
      storeFilings(
        t.db,
        i.id,
        CIKS.NVDA!,
        { ...nvda, fetchedAt: RECORDED },
        RECORDED,
      ),
    )();
    const urls = readFilings(t.db, i.id, 1_000).map((f) => f.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toContain(`/data/${CIKS.NVDA}/`);
  });

  test("retention drops filings older than two years", async () => {
    const t = setup();
    const i = share(t.db, "AAPL", RECORDED);
    await drive(t.clock, t.paced, refreshFilings(t.ctx, i));
    const before = count(t.db, "filings");
    const oldest = readFilings(t.db, i.id, 1_000).at(-1)!;
    expect(pruneFilings(t.db, RECORDED)).toBe(0);
    expect(pruneFilings(t.db, oldest.acceptedAt + KEPT_MS)).toBe(1);
    expect(count(t.db, "filings")).toBe(before - 1);
  });
});

describe("the contact line", () => {
  test("is never in a log line or an answer, and the start log names the key file", () => {
    const urls: string[] = [];
    let fail = false;
    const f = fakeFetch(async (url) => {
      urls.push(String(url));
      if (fail) return status(403);
      return edgarAnswer(url);
    });
    return withApp(
      async ({ url, app, lines, db, clock, bearer }) => {
        expect(app.sources.edgar).toBe("on (key file)");
        share(db, "SURG", clock.now());
        const res = await drive(
          clock,
          [app.edgar!],
          fetch(`${url}/api/v1/research?symbols=US:SURG&sections=filings`, {
            headers: { authorization: `Bearer ${bearer}` },
          }),
        );
        const text = await res.text();
        expect(res.status).toBe(200);
        expect(JSON.parse(text).research[0].filings.late_filing).toBe(true);
        // a refused call is logged by the job, with its phrase only
        fail = true;
        markRead(db, ["US:SURG"], clock.now());
        await clock.advance(2 * DAY_MS);
        const email = EDGAR_CONTACT.split(" ").at(-1)!;
        for (const s of [text, ...lines, ...urls]) {
          expect(s).not.toContain(EDGAR_CONTACT);
          expect(s).not.toContain(email);
        }
        expect(
          lines.some(
            (l) =>
              l.includes("edgar filings failed") && l.includes("rate limited"),
          ),
        ).toBe(true);
      },
      { edgarKey: EDGAR_CONTACT, fetch: f.fetch, start: RECORDED },
    );
  });
});

describe("the research route", () => {
  test("sections filings answers each share's filings summary", async () => {
    const t = setup();
    share(t.db, "SURG", RECORDED);
    const handle = api(t.m);
    const res = await drive(
      t.clock,
      t.paced,
      handle(
        new Request(
          "http://markets.test/api/v1/research?symbols=US:SURG&sections=filings",
          { headers: { authorization: `Bearer ${READ_KEY}` } },
        ),
      ),
    );
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.research[0]).toMatchObject({
      input: "US:SURG",
      id: "US:SURG",
      filings: { source: "edgar", late_filing: true, offering: true },
    });
    expect(b.research[0].filings.recent).toHaveLength(FILINGS_RECENT);
    expect(
      validate(b, answerSchema(spec, "GET", "/research", 200)!, spec),
    ).toEqual([]);
  });
});
