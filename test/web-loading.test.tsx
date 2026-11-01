// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { tabTitle } from "../src/web/app/title.ts";
import type { Fetch } from "../src/web/data/api.ts";
import {
  type Board,
  DASHBOARD_PATH,
  instrumentPath,
  type Listed,
  layoutOf,
  store,
  unread,
} from "../src/web/data/store.ts";
import { kindOf } from "../src/web/lib/names.ts";
import { type Later, SLOW_MS, slowFlag } from "../src/web/lib/slow.ts";
import { pointerAt, type Rest } from "../src/web/views/Chart.model.ts";
import { ConnectBody } from "../src/web/views/Connect.tsx";
import { HomeWaiting, SectionView } from "../src/web/views/Dashboard.tsx";
import { InstrumentWaiting } from "../src/web/views/Instrument.tsx";
import { InstrumentsList } from "../src/web/views/Instruments.tsx";
import { PortfoliosBody } from "../src/web/views/Portfolios.tsx";
import { StatusWaiting } from "../src/web/views/Status.tsx";
import { fakeClock } from "./helpers/clock.ts";

const NOW = Date.parse("2026-11-02T10:00:00Z");

const laterOf =
  (clock: ReturnType<typeof fakeClock>): Later =>
  (ms, fire) =>
    clock.at(clock.now() + ms, fire);

// answers held until released, by method and path
function held() {
  const waits = new Map<string, ((r: Response) => void)[]>();
  const asked: string[] = [];
  const fetch: Fetch = (path, init) =>
    new Promise<Response>((resolve) => {
      const key = `${init?.method ?? "GET"} ${path}`;
      asked.push(key);
      waits.set(key, [...(waits.get(key) ?? []), resolve]);
    });
  const answer = async (key: string, res: Response) => {
    while (!(waits.get(key)?.length ?? 0)) await Bun.sleep(0);
    waits.get(key)!.shift()!(res);
    await Bun.sleep(0);
  };
  return { fetch, answer, asked };
}

const listed = (id: string): Listed => ({
  id,
  name: `${id} name`,
  market: id.split(":")[0]!,
  currency: "USD",
  kind: "EQUITY",
  unit: "per_share",
  source: "yahoo",
  tracked: true,
  tracked_by: ["read"],
  read_until: null,
  price: 50,
  change: 1,
  change_percent: 2,
  fetched_at: "2026-11-02T09:59:00Z",
});

const detailOf = (id: string) => ({
  credit: null,
  instrument: listed(id),
  intraday: false,
  error: null,
  quote: null,
});

// ETFs, so the page asks no earnings
const item = (id: string, intraday: boolean) => ({
  id,
  instrument: { ...listed(id), kind: "ETF" },
  session: null,
  intraday,
  averages: { daily_sma50: null, daily_sma200: null, weekly_sma200: null },
});

const BOARD: Board = {
  revision: 1,
  created: true,
  sections: [
    {
      name: "Shares",
      view: "cards",
      items: [item("US:AAA", true), item("US:BBB", true)],
    },
  ],
};

const day = (id: string) =>
  `GET ${instrumentPath(id)}/bars?${new URLSearchParams({ interval: "5m" })}`;
const DAY_ANSWER = {
  instrument: { id: "US:AAA" },
  interval: "5m",
  points: [{ at: "2026-11-02T09:55:00Z", session: "regular", close: 51 }],
  sessions: [],
  previous_close: 50,
};
const problem = (status: number, code: string, detail: string) =>
  Response.json({ status, code, detail }, { status });

describe("a wait's words", () => {
  test("show only once the clock passes a second with the work still out", async () => {
    const clock = fakeClock(NOW);
    const flag = slowFlag(laterOf(clock));
    let done = () => {};
    const work = new Promise<void>((resolve) => {
      done = resolve;
    });
    void flag.track(work);
    await clock.advance(SLOW_MS - 1);
    expect(flag.slow.value).toBe(false);
    await clock.advance(1);
    expect(flag.slow.value).toBe(true);
    // a fast one alongside never clears the slow one's words
    void flag.track(Promise.resolve());
    await clock.advance(SLOW_MS);
    expect(flag.slow.value).toBe(true);
    done();
    await work;
    await clock.advance(0);
    expect(flag.slow.value).toBe(false);
    // a read answered in time never shows them
    void flag.track(Promise.resolve());
    await clock.advance(SLOW_MS);
    expect(flag.slow.value).toBe(false);
  });

  test("the shimmer stops under reduced motion", async () => {
    const css = await Bun.file(
      new URL("../src/web/ui/placeholder.css", import.meta.url),
    ).text();
    expect(css).toContain("animation: pulse");
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*\.placeholder\s*\{\s*animation: none;/,
    );
  });
});

describe("Home while it reads", () => {
  test("shows the page's shape, and its words only once slow", () => {
    const quick = render(<HomeWaiting slow={false} />);
    expect(quick).toContain("Today's movers");
    expect(quick).toContain('class="placeholder"');
    expect(quick.match(/class="card dash-tile"/g)).toHaveLength(4);
    expect(quick).not.toContain("Loading prices");
    expect(quick).not.toContain("spinner");
    expect(render(<HomeWaiting slow />)).toContain("Loading prices");
  });

  test("draws a line whose read answered while another is still out", async () => {
    const h = held();
    const clock = fakeClock(NOW);
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
      () => {},
      laterOf(clock),
    );
    const load = s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    expect([...s.lining.value]).toEqual(["US:AAA", "US:BBB"]);
    await h.answer(day("US:BBB"), Response.json(DAY_ANSWER));
    expect([...s.sparks.value.keys()]).toEqual(["US:BBB"]);
    expect([...s.lining.value]).toEqual(["US:AAA"]);
    expect(s.linesSlow.value).toBe(false);
    await clock.advance(SLOW_MS);
    expect(s.linesSlow.value).toBe(true);
    const props = {
      index: 0,
      layout: layoutOf(BOARD),
      editing: false,
      locked: false,
      items: s.items.value,
      sparks: s.sparks.value,
      drag: null,
      setDrag: () => {},
      save: () => Promise.resolve(),
    };
    const waiting = render(
      <SectionView {...props} lining={s.lining.value} slow />,
    );
    expect(waiting).toContain("Loading charts");
    // the live region sits beside the heading, never in it
    expect(waiting).toMatch(
      /<\/h2><span class="wait-words[^"]*" role="status">/,
    );
    expect(waiting.match(/placeholder-band/g)).toHaveLength(1);
    // a failed line leaves an empty one, never a placeholder for good
    await h.answer(day("US:AAA"), problem(503, "source_error", "failed"));
    await load;
    expect(s.lining.value.size).toBe(0);
    expect(s.linesSlow.value).toBe(false);
    const drawn = render(
      <SectionView {...props} lining={s.lining.value} slow={false} />,
    );
    expect(drawn).not.toContain("Loading charts");
    expect(drawn).not.toContain("placeholder-band");
  });

  test("the minute's refresh never puts a placeholder over a drawn line", async () => {
    const h = held();
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
    );
    const first = s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    await h.answer(day("US:AAA"), Response.json(DAY_ANSWER));
    await h.answer(day("US:BBB"), Response.json(DAY_ANSWER));
    await first;
    const again = s.loadDashboard();
    await h.answer(`GET ${DASHBOARD_PATH}`, Response.json(BOARD));
    while (h.asked.filter((k) => k === day("US:BBB")).length < 2) {
      await Bun.sleep(0);
    }
    expect(s.lining.value.size).toBe(0);
    expect(s.sparks.value.size).toBe(2);
    await h.answer(day("US:AAA"), Response.json(DAY_ANSWER));
    await h.answer(day("US:BBB"), Response.json(DAY_ANSWER));
    await again;
  });
});

describe("an instrument while it reads", () => {
  const ID = "BVB:TEL";
  const READ = `GET ${instrumentPath(ID)}`;
  const STORED = `GET ${instrumentPath(ID)}/stored`;

  test("a symbol not stored says it is fetched before its read answers", async () => {
    const h = held();
    const s = store(h.fetch);
    const load = s.loadInstrument(ID);
    expect(h.asked).toEqual([READ, STORED]);
    await h.answer(STORED, Response.json({ input: ID, stored: false }));
    expect(s.firstFetch.value).toBe(ID);
    const page = render(<InstrumentWaiting symbol="TEL" first slow={false} />);
    expect(page).toContain("Fetching TEL for the first time");
    expect(page).toContain('class="spinner"');
    expect(page).toContain("hero");
    expect(page).toContain("chart-canvas");
    expect(page.match(/class="card card-box"/g)).toHaveLength(2);
    await h.answer(READ, Response.json(detailOf(ID)));
    await load;
    expect(s.firstFetch.value).toBeNull();
    expect(s.detail.value?.instrument.id).toBe(ID);
  });

  test("a stored one shows its shape, and the chart's words only once slow", async () => {
    const h = held();
    const clock = fakeClock(NOW);
    const s = store(
      h.fetch,
      () => NOW,
      () => "/",
      () => {},
      laterOf(clock),
    );
    const load = s.loadInstrument(ID);
    await h.answer(STORED, Response.json({ input: ID, stored: true }));
    expect(s.firstFetch.value).toBeNull();
    const quick = render(
      <InstrumentWaiting
        symbol="TEL"
        first={false}
        slow={s.detailSlow.value}
      />,
    );
    expect(quick).not.toContain("Loading the chart");
    expect(quick).not.toContain("spinner");
    await clock.advance(SLOW_MS);
    expect(s.detailSlow.value).toBe(true);
    expect(
      render(
        <InstrumentWaiting
          symbol="TEL"
          first={false}
          slow={s.detailSlow.value}
        />,
      ),
    ).toContain("Loading the chart");
    await h.answer(READ, Response.json(detailOf(ID)));
    await load;
    expect(s.detailSlow.value).toBe(false);
    // a refresh keeps what is drawn and asks no check
    const refresh = s.loadInstrument(ID);
    expect(s.detail.value).not.toBeNull();
    expect(h.asked.filter((k) => k === STORED)).toHaveLength(1);
    await h.answer(READ, Response.json(detailOf(ID)));
    await refresh;
  });

  test("a timeout says the source did not answer, and Try again fetches again", async () => {
    const h = held();
    const s = store(h.fetch);
    const load = s.loadInstrument(ID);
    await h.answer(STORED, Response.json({ input: ID, stored: false }));
    await h.answer(
      READ,
      problem(503, "timeout", "not done within 15 seconds; retry this symbol"),
    );
    await load;
    expect(s.detailError.value).toBe("The source did not answer in time.");
    expect(s.detailCode.value).toBe(503);
    expect(s.firstFetch.value).toBeNull();
    const again = s.loadInstrument(ID, true);
    expect(s.detailError.value).toBeNull();
    await h.answer(STORED, Response.json({ input: ID, stored: false }));
    expect(s.firstFetch.value).toBe(ID);
    await h.answer(READ, Response.json(detailOf(ID)));
    await again;
    expect(h.asked.filter((k) => k === READ)).toHaveLength(2);
    expect(s.detail.value?.instrument.id).toBe(ID);
  });

  test("a source's failure reads in plain words", () => {
    const failed = (code: string, detail: string) => {
      const s = store(async () => problem(503, code, detail));
      return s.loadInstrument(ID).then(() => s.detailError.value);
    };
    return Promise.all([
      failed("rate_limited", "rate limited by the source; retry later"),
      failed(
        "source_error",
        "the source is backing off after network error; retry later",
      ),
      failed("source_error", "source error; retry this symbol later"),
    ]).then((words) => {
      expect(words).toEqual([
        "Too many requests to the source.",
        "The source failed.",
        "The source failed.",
      ]);
      expect(unread(new Error("offline"))).toBe("Offline.");
    });
  });
});

describe("the other pages while they read", () => {
  test("Server status keeps its figures row with placeholders", () => {
    const html = render(<StatusWaiting />);
    for (const label of ["Instruments", "Sources", "Jobs", "Database"]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html).toContain('class="placeholder"');
    expect(html.match(/class="table-row"/g)).toHaveLength(6);
  });

  test("Connect agents draws its setup at once and its keys after", async () => {
    const h = held();
    const s = store(h.fetch);
    const load = s.loadKeys();
    const waiting = render(<ConnectBody store={s} />);
    expect(waiting).toContain("Setup");
    expect(waiting).toContain('class="placeholder"');
    expect(waiting).not.toContain("No keys yet.");
    await h.answer("GET /api/v1/keys", Response.json({ keys: [], limit: 5 }));
    await load;
    const drawn = render(<ConnectBody store={s} />);
    expect(drawn).toContain("No keys yet.");
    expect(drawn).not.toContain('class="placeholder"');
  });

  test("Portfolios and Instruments show rows of placeholders", () => {
    const s = store(held().fetch);
    const pf = render(<PortfoliosBody store={s.portfolios} />);
    expect(pf).toContain(">All<");
    expect(pf).toContain("Holdings");
    expect(pf.match(/<tr class="table-row">/g)).toHaveLength(6);
    const list = render(<InstrumentsList all={null} query={signal("")} />);
    expect(list).not.toContain("card-count");
    expect(list.match(/<tr class="table-row">/g)).toHaveLength(8);
    const drawn = render(
      <InstrumentsList all={[listed("US:AAA")]} query={signal("")} />,
    );
    expect(drawn).not.toContain('class="placeholder"');
  });
});

describe("the chart's legend", () => {
  test("follows the pointer only once it moves over the chart", () => {
    let rest: Rest = null;
    // a redraw under a resting pointer repeats its place
    rest = pointerAt(rest, 40, 60);
    rest = pointerAt(rest, 40, 60);
    expect(rest).toEqual({ x: 40, y: 60 });
    rest = pointerAt(rest, 41, 60);
    expect(rest).toBe("moved");
    expect(pointerAt(rest, 41, 60)).toBe("moved");
  });
});

describe("names", () => {
  test("a coin's tab drops its quote currency; a future's other contract is a future", () => {
    expect(tabTitle("/instruments/CRYPTO%3ABTC-USD", true)).toBe(
      "BTC · 1ctx Markets",
    );
    expect(tabTitle("/instruments/BTC-USD", true, "CRYPTOCURRENCY")).toBe(
      "BTC · 1ctx Markets",
    );
    expect(tabTitle("/instruments/BRK-B", true, "EQUITY")).toBe(
      "BRK-B · 1ctx Markets",
    );
    expect(kindOf("ALTSYMBOL")).toBe("Future");
  });
});
