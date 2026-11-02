// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import type { BoardSection, Candidate } from "../src/web/data/store.ts";
import { kindOf, nameOf, tickerOf } from "../src/web/lib/names.ts";
import { Card, GroupLabel } from "../src/web/ui/Card.tsx";
import { clearsFirst, Drawer, returnTo } from "../src/web/ui/Drawer.tsx";
import { Change, Facts, Hero } from "../src/web/ui/Figures.tsx";
import { MenuButton, MenuItems } from "../src/web/ui/Menu.tsx";
import { Page } from "../src/web/ui/Page.tsx";
import { Search } from "../src/web/ui/Search.tsx";
import { sparkLine } from "../src/web/ui/Spark.tsx";
import {
  escapeFrom,
  type Search as Find,
  SHOWN,
  searcher,
  showsResults,
  UPSTREAM_WAIT_MS,
} from "../src/web/ui/SymbolSearch.model.ts";
import {
  type SearchAdds,
  SymbolResults,
  SymbolSearch,
} from "../src/web/ui/SymbolSearch.tsx";
import {
  type Column,
  nextSort,
  shownAt,
  showsEmpty,
  Table,
  tracks,
} from "../src/web/ui/Table.tsx";
import { Tabs } from "../src/web/ui/Tabs.tsx";

type Row = { id: string; name: string; value: number };

const COLUMNS: Column<Row>[] = [
  {
    key: "name",
    head: "Holding",
    width: { base: "2fr", tablet: "1.5fr", phone: "1fr" },
    cell: (r) => r.name,
  },
  {
    key: "spark",
    head: "3M",
    width: "104px",
    hide: "tablet",
    cell: () => "~",
  },
  {
    key: "change",
    head: "Change",
    width: "1fr",
    hide: "phone",
    sortable: true,
    cell: () => "+1%",
  },
  {
    key: "value",
    head: "Value",
    width: { base: "1fr", phone: "96px" },
    align: "end",
    sortable: true,
    cell: (r) => String(r.value),
  },
  {
    key: "gain",
    head: "Gain",
    width: "1fr",
    show: false,
    cell: () => "gain",
  },
];

const ROWS: Row[] = [
  { id: "US:AAA", name: "Casey Corp", value: 120 },
  { id: "US:BBB", name: "Doe Ltd", value: 80 },
];

describe("the table", () => {
  test("drops a column nothing fills everywhere, and the tablet's and phone's at their widths", () => {
    expect(shownAt(COLUMNS, "base").map((c) => c.key)).toEqual([
      "name",
      "spark",
      "change",
      "value",
    ]);
    expect(shownAt(COLUMNS, "tablet").map((c) => c.key)).toEqual([
      "name",
      "change",
      "value",
    ]);
    expect(shownAt(COLUMNS, "phone").map((c) => c.key)).toEqual([
      "name",
      "value",
    ]);
    expect(tracks(COLUMNS, "base")).toBe("2fr 104px 1fr 1fr");
    expect(tracks(COLUMNS, "tablet")).toBe("1.5fr 1fr 1fr");
    expect(tracks(COLUMNS, "phone", true)).toBe("1fr 96px var(--table-more)");
  });

  test("a sortable head is a button and says which column sorts", () => {
    const html = render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        sort="value"
        onSort={() => {}}
      />,
    );
    expect(html).not.toContain(">Gain<");
    expect(html).toMatch(
      /<th[^>]*aria-sort="descending"[^>]*><button[^>]*>Value/,
    );
    expect(html).toMatch(/<th[^>]*aria-sort="none"[^>]*><button[^>]*>Change/);
    expect(html).toMatch(/<th[^>]*scope="col"[^>]*>3M<\/th>/);
    expect(html.match(/<tr/g)?.length).toBe(3);
  });

  test("a row takes more attributes, its own class kept, and a sort head its hover words", () => {
    const html = render(
      <Table
        columns={COLUMNS.map((c) =>
          c.key === "value"
            ? { ...c, sortTitle: (on, dir) => (on ? `by ${dir}` : "sort") }
            : c,
        )}
        rows={ROWS}
        rowKey={(r) => r.id}
        rowAttrs={(r) => ({ class: `moving-${r.value}`, draggable: true })}
        sort="value"
        dir="asc"
        onSort={() => {}}
      />,
    );
    expect(html).toMatch(/<tr draggable="true" class="table-row moving-120"/);
    expect(html.match(/draggable="true"/g)).toHaveLength(2);
    expect(html).toContain('title="by asc"');
  });

  test("a row opens its page or its action, its menu named for it", () => {
    const html = render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        open={(r) =>
          r.id === "US:AAA"
            ? { href: "/instruments/US%3AAAA" }
            : { run: () => {} }
        }
        rowLabel={(r) => r.name}
        menu={(r) =>
          r.id === "US:AAA" ? [{ label: "Buy", run: () => {} }] : []
        }
        menuLabel={(r) => `Actions for ${r.name}`}
      />,
    );
    expect(html).toMatch(
      /<a[^>]*href="\/instruments\/US%3AAAA"[^>]*><span[^>]*>Casey Corp<\/span><\/a>/,
    );
    expect(html).toMatch(
      /<button type="button" class="table-open"><span[^>]*>Doe Ltd<\/span><\/button>/,
    );
    expect(html).toContain('aria-label="Actions for Casey Corp"');
    expect(html).not.toContain("Actions for Doe Ltd");
    expect(html).not.toContain("chevron");
  });

  test("a row's open sits in a cell shown at every width", () => {
    const html = render(
      <Table
        columns={[
          { ...COLUMNS[2]!, key: "date", hide: "tablet" },
          COLUMNS[1]!,
          COLUMNS[0]!,
          COLUMNS[3]!,
        ]}
        rows={ROWS.slice(0, 1)}
        rowKey={(r) => r.id}
        open={() => ({ run: () => {} })}
        rowLabel={(r) => r.name}
      />,
    );
    const cells = html.match(/<td[^>]*>.*?<\/td>/g) ?? [];
    expect(cells).toHaveLength(4);
    expect(cells[0]).toContain("table-hide-tablet");
    expect(cells[0]).not.toContain("table-open");
    expect(cells[1]).not.toContain("table-open");
    expect(cells[2]).toContain('class="table-open"');
  });

  test("groups carry their labels, and no rows say the empty words", () => {
    const grouped = render(
      <Table
        columns={COLUMNS}
        groups={[
          {
            key: "a",
            label: (
              <GroupLabel label="Shares" count={2} open onToggle={() => {}} />
            ),
            rows: ROWS,
          },
          { key: "b", label: <GroupLabel label="Bonds" count={0} />, rows: [] },
        ]}
        rowKey={(r) => r.id}
        empty="Nothing matches."
      />,
    );
    expect(grouped.match(/<tbody/g)?.length).toBe(2);
    expect(grouped).toMatch(/aria-expanded="true"[^>]*>.*Shares/);
    expect(grouped).not.toContain("Nothing matches.");
    const none = render(
      <Table
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        empty="Nothing matches."
      />,
    );
    expect(none).toContain("Nothing matches.");
  });
});

describe("the table's choices", () => {
  test("a click turns the sorted column round; another starts its own way", () => {
    expect(nextSort("value", "desc", "value")).toBe("asc");
    expect(nextSort("value", "asc", "value")).toBe("desc");
    expect(nextSort("value", "asc", "gain")).toBe("desc");
    expect(nextSort("value", "desc", "name", "asc")).toBe("asc");
    expect(nextSort(undefined, undefined, "value")).toBe("desc");
  });

  test("the empty words show only when no row and no group's label is left", () => {
    expect(showsEmpty([{ key: "a", rows: [] }])).toBe(true);
    expect(showsEmpty([{ key: "a", rows: [1] }])).toBe(false);
    // every group folded: their labels stay, so nothing is empty
    expect(
      showsEmpty([
        { key: "a", label: "Shares", rows: [] },
        { key: "b", label: "Bonds", rows: [] },
      ]),
    ).toBe(false);
  });

  test("an ascending sort says so and points up; a head can be left out", () => {
    const html = render(
      <Table
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        sort="value"
        dir="asc"
        onSort={() => {}}
        head={false}
      />,
    );
    expect(html).toContain("<thead hidden>");
    expect(html).toMatch(/aria-sort="ascending"/);
    expect(html).not.toMatch(/aria-sort="descending"/);
  });

  test("folded groups keep their labels and say no empty words", () => {
    const html = render(
      <Table
        columns={COLUMNS}
        groups={[
          {
            key: "a",
            label: (
              <GroupLabel label="Shares" open={false} onToggle={() => {}} />
            ),
            rows: [],
          },
        ]}
        rowKey={(r) => r.id}
        empty="No holding matches."
      />,
    );
    expect(html).toContain("Shares");
    expect(html).not.toContain("No holding matches.");
  });
});

describe("the tabs", () => {
  test("buttons are a tablist, the picked one selected and the only one in the tab order", () => {
    const html = render(
      <Tabs
        label="Portfolios"
        tabs={[
          { key: null, label: "All" },
          { key: 1, label: "Shares", count: 4 },
        ]}
        value={1}
        onPick={() => {}}
      />,
    );
    expect(html).toContain('role="tablist" aria-label="Portfolios"');
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"[^>]*>All/,
    );
    expect(html).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Shares<span[^>]*>4<\/span>/,
    );
  });

  test("tabs that are addresses are links, the open page marked current", () => {
    const html = render(
      <Tabs
        label="Movers"
        tabs={[
          { key: "up", label: "Up", href: "/?tab=up" },
          { key: "down", label: "Down", href: "/?tab=down" },
        ]}
        value="down"
      />,
    );
    expect(html).not.toContain("role=");
    expect(html).toMatch(/<a[^>]*href="\/\?tab=down"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/href="\/\?tab=up"[^>]*aria-current/);
  });
});

describe("the figures", () => {
  test("a change is green up, red down, plain flat, and nothing when unknown", () => {
    expect(render(<Change s={{ text: "+1.20%", dir: 1 }} />)).toBe(
      '<span class="num up">+1.20%</span>',
    );
    expect(render(<Change s={{ text: "−3.00%", dir: -1 }} />)).toBe(
      '<span class="num down">−3.00%</span>',
    );
    expect(render(<Change s={{ text: "0.00%", dir: 0 }} />)).toBe(
      '<span class="num">0.00%</span>',
    );
    expect(render(<Change s={{ text: "", dir: 0 }} />)).toBe("");
  });

  test("the hero holds one large figure; more lines are in the text's size", () => {
    const html = render(
      <Hero
        name="All portfolios"
        value="1,234"
        currency="EUR"
        moves={[
          {
            money: { text: "+12 EUR", dir: 1 },
            percent: { text: "+1.0%", dir: 1 },
            label: "today",
          },
          { money: { text: "", dir: 0 }, label: "all time" },
        ]}
        lines={["After hours 205.25"]}
      />,
    );
    expect(html.match(/hero-value/g)?.length).toBe(1);
    expect(html).toContain("today");
    expect(html).not.toContain("all time");
    expect(html).toContain('<div class="hero-line">After hours 205.25</div>');
  });
});

describe("the sparkline", () => {
  test("from the period's start its box spans at least 10% of the start", () => {
    // 100 → 101 is 1%: the box is 95.5 to 105.5, the start just under the middle
    const flat = sparkLine([100, 101], "start", 96, 28)!;
    expect(flat.base).toBe(15.2);
    // a 30% fall fills the box: the start on top, the end at the bottom
    const fall = sparkLine([100, 70], "start", 96, 28)!;
    expect(fall.base).toBe(2);
    expect(fall.points).toBe("0.0,2.0 96.0,26.0");
  });

  test("a given base, such as the previous close, is drawn inside the box", () => {
    const line = sparkLine([10, 11], 12, 96, 28)!;
    expect(line.base).toBe(2);
    expect(sparkLine([], "start")).toBeNull();
  });

  test("slots keep a session still trading to its share of the width", () => {
    // two closes of a 79-slot session sit at its start
    const morning = sparkLine([10, 11], 10, 78, 28, 79)!;
    expect(morning.points).toBe("0.0,26.0 1.0,2.0");
    // slots fewer than the closes change nothing
    expect(sparkLine([10, 11], 10, 96, 28, 1)!.points).toBe(
      sparkLine([10, 11], 10, 96, 28)!.points,
    );
  });
});

describe("names", () => {
  test("a coin is named without its quote currency; a share as listed", () => {
    expect(tickerOf("CRYPTO:BTC-USD")).toBe("BTC");
    expect(tickerOf("BTC-USD", "CRYPTOCURRENCY")).toBe("BTC");
    expect(tickerOf("US:AAPL", "EQUITY")).toBe("AAPL");
    expect(tickerOf("EURUSD=X")).toBe("EURUSD=X");
    expect(nameOf("Bitcoin USD", "CRYPTOCURRENCY")).toBe("Bitcoin");
    expect(nameOf("Ether EUR", null, "CRYPTO:ETH-EUR")).toBe("Ether");
    expect(nameOf("Casey Corp USD", "EQUITY")).toBe("Casey Corp USD");
    expect(nameOf(null, "EQUITY")).toBe("");
  });
});

describe("the drawer", () => {
  test("is a dialog named by its title, with a close, a body and a foot", () => {
    const html = render(
      <Drawer
        title="Edit"
        onClose={() => {}}
        footStart={<button type="button">Remove</button>}
        foot={(close) => (
          <button type="button" onClick={close}>
            Save
          </button>
        )}
      >
        <p>Casey Doe</p>
      </Drawer>,
    );
    const id = html.match(
      /<h2 class="drawer-title" id="([^"]+)">Edit<\/h2>/,
    )?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(
      `role="dialog" aria-modal="true" aria-labelledby="${id}"`,
    );
    expect(html.match(/aria-label="Close"/g)?.length).toBe(2);
    expect(html).toContain('<div class="drawer-body"><p>Casey Doe</p></div>');
    expect(html).toMatch(
      /drawer-foot-start"><button[^>]*>Remove<\/button><\/div><button[^>]*>Save/,
    );
  });

  test("a bare drawer takes its children as body and foot, with no foot of its own", () => {
    const html = render(
      <Drawer title="Add" label="Add a trade" onClose={() => {}} bare>
        <form class="casey-form" />
      </Drawer>,
    );
    expect(html).toContain('aria-label="Add a trade"');
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toContain("drawer-body");
    expect(html).not.toContain("drawer-foot");
    expect(html).toContain('<form class="casey-form"></form>');
  });
});

describe("the drawer's keys and focus", () => {
  test("Escape in a search with words clears it before the drawer closes", () => {
    const field = (type: string, value: string) =>
      ({ tagName: "INPUT", type, value }) as unknown as EventTarget;
    expect(clearsFirst(field("search", "cas"))).toBe(true);
    expect(clearsFirst(field("search", ""))).toBe(false);
    expect(clearsFirst(field("text", "cas"))).toBe(false);
    expect(clearsFirst(null)).toBe(false);
  });

  test("the focus returns where it was, else to the menu button it came from", () => {
    const el = (isConnected: boolean) =>
      ({ isConnected }) as unknown as HTMLElement;
    const item = el(false);
    const button = el(true);
    expect(returnTo(item, button)).toBe(button);
    const kept = el(true);
    expect(returnTo(kept, button)).toBe(kept);
    expect(returnTo(item, el(false))).toBeNull();
    expect(returnTo(null, null)).toBeNull();
  });
});

describe("the facts", () => {
  test("each fact is a label over its value", () => {
    const html = render(
      <Facts
        items={[
          { label: "Date", value: "30 Oct 2026" },
          { label: "Quantity", value: "3", num: true },
        ]}
      />,
    );
    expect(html).toBe(
      '<dl class="facts"><div><dt>Date</dt><dd>30 Oct 2026</dd></div><div><dt>Quantity</dt><dd class="num">3</dd></div></dl>',
    );
  });
});

describe("the menu", () => {
  test("a choice menu marks the picked one; a word face carries its caret", () => {
    const html = render(
      <MenuItems
        close={() => {}}
        items={[
          { label: "EUR", checked: true, run: () => {} },
          { label: "USD", checked: false, run: () => {} },
        ]}
      />,
    );
    expect(html).toMatch(/role="menuitemradio" aria-checked="true"[^>]*>.*EUR/);
    expect(html).toMatch(
      /role="menuitemradio" aria-checked="false"[^>]*>.*USD/,
    );
    const face = render(
      <MenuButton
        label="Show totals in"
        text="EUR"
        items={[{ label: "USD", checked: false }]}
      />,
    );
    expect(face).toMatch(/aria-label="Show totals in"[^>]*>EUR<svg/);
  });

  test("a form's field face is framed and full width, its value cut", () => {
    const html = render(
      <MenuButton
        field
        label="Portfolio: Shares"
        text="Shares"
        items={[{ label: "Shares", checked: true, run: () => {} }]}
      />,
    );
    expect(html).toContain('class="menu-at menu-at-field"');
    expect(html).toMatch(
      /class="menu-btn-field" aria-label="Portfolio: Shares"[^>]*><span class="cut">Shares<\/span><svg/,
    );
  });

  test("a closed menu is its button alone; no items, no button", () => {
    const html = render(
      <MenuButton
        label="Actions for Casey"
        items={[{ label: "Buy", run: () => {} }]}
      />,
    );
    expect(html).toContain('aria-label="Actions for Casey"');
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(html).not.toContain("menuitem");
    expect(render(<MenuButton label="Actions" items={[]} />)).toBe("");
  });

  test("items are buttons or links, each a menuitem", () => {
    const html = render(
      <MenuItems
        close={() => {}}
        items={[
          { label: "Buy", run: () => {} },
          { label: "Instrument page", href: "/instruments/US%3AAAA" },
          { label: "Remove", run: () => {}, danger: true },
        ]}
      />,
    );
    expect(html.match(/role="menuitem"/g)?.length).toBe(3);
    expect(html).toMatch(/<button[^>]*role="menuitem"[^>]*>Buy<\/button>/);
    expect(html).toMatch(
      /<a[^>]*role="menuitem"[^>]*href="\/instruments\/US%3AAAA"[^>]*>Instrument page<\/a>/,
    );
  });
});

describe("the card and the search", () => {
  test("a card's head is its sans title with a faint count and its actions", () => {
    const html = render(
      <Card
        title="Holdings"
        count={3}
        actions={
          <Search value="" onChange={() => {}} placeholder="Search holdings" />
        }
      >
        <p>rows</p>
      </Card>,
    );
    expect(html).toMatch(
      /<h2 class="card-title">Holdings<span[^>]*aria-live="polite">3<\/span><\/h2>/,
    );
    expect(html).not.toContain('class="label"');
    expect(html).toContain('aria-label="Search holdings"');
  });

  test("an empty search is folded and offers no clear; one with words clears", () => {
    const empty = render(
      <Search value="" onChange={() => {}} placeholder="Search" />,
    );
    expect(empty).toContain("search-shut");
    expect(empty).not.toContain("Clear search");
    const typed = render(
      <Search value="cas" onChange={() => {}} placeholder="Search" />,
    );
    expect(typed).not.toContain("search-shut");
    expect(typed).toContain('aria-label="Clear search"');
  });
});

describe("the symbol search's asks", () => {
  const cand = (id: string, stored: boolean): Candidate => ({
    id,
    name: null,
    type: "EQUITY",
    exchange: id.slice(0, id.indexOf(":")),
    stored,
  });

  // each ask held until the test answers it, timers run by hand
  function rig() {
    const asks: {
      query: string;
      upstream: boolean;
      signal: AbortSignal;
      answer: (c: Candidate[]) => Promise<void>;
    }[] = [];
    const search: Find = (query, upstream, signal) =>
      new Promise((resolve) => {
        asks.push({
          query,
          upstream,
          signal,
          answer: async (c) => {
            resolve(c);
            await Promise.resolve();
            await Promise.resolve();
          },
        });
      });
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const shown: (Candidate[] | null)[] = [];
    const busy: boolean[] = [];
    const s = searcher(
      search,
      (f) => shown.push(f),
      (b) => busy.push(b),
      {
        set: (fn, ms) => {
          const t = { fn, ms, cleared: false };
          timers.push(t);
          return t;
        },
        clear: (t) => {
          (t as { cleared: boolean }).cleared = true;
        },
      },
    );
    const fire = () => {
      for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    };
    return { s, asks, timers, shown, busy, fire };
  }

  test("one letter asks the database only", async () => {
    const r = rig();
    r.s.ask("a");
    expect(r.asks.map((a) => [a.query, a.upstream])).toEqual([["a", false]]);
    expect(r.timers).toEqual([]);
    expect(r.busy).toEqual([false]);
    await r.asks[0]!.answer([cand("US:AAA", true)]);
    expect(r.shown).toEqual([[cand("US:AAA", true)]]);
  });

  test("stored matches draw at once and upstream's join under them, once each", async () => {
    const r = rig();
    r.s.ask(" cas ");
    expect(r.busy).toEqual([true]);
    await r.asks[0]!.answer([cand("US:CAS", true)]);
    expect(r.shown).toEqual([[cand("US:CAS", true)]]);
    expect(r.asks).toHaveLength(1);
    expect(r.timers.map((t) => t.ms)).toEqual([UPSTREAM_WAIT_MS]);
    r.fire();
    expect(r.asks.map((a) => [a.query, a.upstream])).toEqual([
      ["cas", false],
      ["cas", true],
    ]);
    await r.asks[1]!.answer([cand("US:CAS", true), cand("MEX:CAS", false)]);
    expect(r.shown.at(-1)).toEqual([
      cand("US:CAS", true),
      cand("MEX:CAS", false),
    ]);
    expect(r.busy).toEqual([true, false]);
  });

  test("no more than a menu's worth of results", async () => {
    const r = rig();
    r.s.ask("c");
    await r.asks[0]!.answer(
      Array.from({ length: SHOWN + 3 }, (_, i) => cand(`US:C${i}`, true)),
    );
    expect(r.shown.at(-1)).toHaveLength(SHOWN);
  });

  test("a newer query aborts the older, whose late answers draw nothing", async () => {
    const r = rig();
    r.s.ask("ca");
    r.fire();
    r.s.ask("cas");
    const [oldStored, oldUpstream, newStored] = r.asks;
    expect(oldStored!.signal.aborted).toBe(true);
    expect(oldUpstream!.signal.aborted).toBe(true);
    expect(newStored!.signal.aborted).toBe(false);
    await oldUpstream!.answer([cand("US:CA", false)]);
    await oldStored!.answer([cand("US:CAB", true)]);
    expect(r.shown).toEqual([]);
    await newStored!.answer([cand("US:CAS", true)]);
    expect(r.shown).toEqual([[cand("US:CAS", true)]]);
  });

  test("an emptied box clears the results and stops what is in flight", () => {
    const r = rig();
    r.s.ask("cas");
    r.s.ask("  ");
    expect(r.asks[0]!.signal.aborted).toBe(true);
    expect(r.shown).toEqual([null]);
    expect(r.busy).toEqual([true, false]);
  });

  test("Escape closes the section picker before the results", () => {
    expect(escapeFrom("US:CAS")).toBe("picker");
    expect(escapeFrom(null)).toBe("results");
  });

  test("results show once answered, not while an empty answer waits on upstream", () => {
    expect(showsResults(true, null, false, null)).toBe(false);
    expect(showsResults(false, [cand("US:CAS", true)], false, null)).toBe(
      false,
    );
    expect(showsResults(true, [], true, null)).toBe(false);
    expect(showsResults(true, [], false, null)).toBe(true);
    expect(showsResults(true, [], true, "This section is full.")).toBe(true);
    expect(showsResults(true, [cand("US:CAS", true)], true, null)).toBe(true);
  });

  test("a kind reads as a word", () => {
    expect(kindOf("EQUITY")).toBe("Stock");
    expect(kindOf("CRYPTOCURRENCY")).toBe("Crypto");
    expect(kindOf("MUTUALFUND")).toBe("Mutualfund");
  });
});

describe("the symbol search", () => {
  const casey: Candidate = {
    id: "US:CAS",
    name: "Casey Corp",
    type: "EQUITY",
    exchange: "NASDAQ",
    stored: true,
  };
  const doe: Candidate = {
    id: "CRYPTO:DOE-USD",
    name: "Doe Coin USD",
    type: "CRYPTOCURRENCY",
    exchange: "CCC",
    stored: false,
  };
  const sections: BoardSection[] = [
    { name: "Favourites", view: "cards", ids: ["US:CAS"] },
    { name: "Coins", view: "table", ids: [] },
  ];
  const adds: SearchAdds = {
    sections,
    onAdd: () => Promise.resolve(),
    refuse: () => null,
  };
  const results = (
    p: Partial<Parameters<typeof SymbolResults>[0]> = {},
  ): string =>
    render(
      <SymbolResults
        found={[casey, doe]}
        busy={false}
        refused={null}
        picking={null}
        adding={null}
        onGo={() => {}}
        onPick={() => {}}
        onAdd={() => {}}
        {...p}
      />,
    );

  test("a result is the ticker over its name and opens its instrument page", () => {
    const html = results();
    expect(html).toContain('href="/instruments/US%3ACAS"');
    expect(html).toContain('href="/instruments/CRYPTO%3ADOE-USD"');
    expect(html).toMatch(
      /<span class="sym-ticker">CAS<\/span><span class="sym-name">Casey Corp<\/span>/,
    );
    // a pick between quote currencies keeps them
    expect(html).toContain(">DOE-USD<");
    expect(html).toContain("<span>Stock</span><span>NASDAQ</span>");
    expect(html).toContain("<span>Crypto</span>");
    // only a symbol the server has never stored is new
    expect(html.match(/>New</g)).toHaveLength(1);
    expect(html).not.toContain("Add");
  });

  test("no results say so, and a refused add says why", () => {
    expect(results({ found: [] })).toContain("Nothing found.");
    // still asking upstream: no verdict yet
    expect(results({ found: [], busy: true })).not.toContain("Nothing found.");
    const refused = results({ refused: "This section is full." });
    expect(refused).toContain('role="alert">This section is full.');
  });

  test("with Home's sections a result offers Add, or says where it is", () => {
    const html = results({ adds });
    expect(html).toContain('title="On Favourites"');
    expect(html.match(/> Add</g)).toHaveLength(1);
    expect(html).not.toContain("Add to");
    const picking = results({ adds, picking: doe.id });
    expect(picking).toContain('aria-expanded="true"');
    expect(picking).toContain("Add to");
    expect(picking).toContain(">Favourites</button>");
    expect(picking).toContain(">Coins</button>");
    expect(results({ adds, adding: doe.id })).toContain("Fetching…");
  });

  test("the field, the phone's icon and its sheet's Cancel, no results until asked", () => {
    const html = render(<SymbolSearch />);
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('placeholder="Search a symbol or name"');
    expect(html).toContain('type="search"');
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain("ssearch-sheet");
    expect(html).not.toContain("ssearch-results");
  });

  test("every page's head holds the search before the page's actions", () => {
    const html = render(
      <Page title="Status" actions={<button type="button">Edit</button>}>
        <p>body</p>
      </Page>,
    );
    expect(html).toMatch(
      /class="page-actions"><div class="ssearch">[\s\S]*<button type="button">Edit<\/button><\/div>/,
    );
    expect(render(<Page title="Status" />)).toContain("Search a symbol");
    const off = render(<Page title="Home" search={false} />);
    expect(off).not.toContain("ssearch");
  });

  test("the eye sits after the search on a page with amounts only", () => {
    const html = render(
      <Page title="AAA" amounts actions={<button type="button">More</button>}>
        <p>body</p>
      </Page>,
    );
    expect(html).toMatch(
      /class="ssearch">[\s\S]*aria-label="Hide amounts"[\s\S]*>More<\/button>/,
    );
    expect(render(<Page title="Home" />)).not.toContain("Hide amounts");
  });
});

describe("the bundled styles", () => {
  // the bundler lowers a :not() or :is() selector list to :-webkit-any()
  // and :-moz-any() copies; inside Safari's forgiving :where() the one it
  // cannot read matches every element, so no rule may need lowering
  test("hold no lowered :-webkit-any() or :-moz-any() selectors", async () => {
    const out = await Bun.build({
      entrypoints: ["src/web/index.html"],
      minify: true,
    });
    expect(out.success).toBe(true);
    const css = out.outputs.filter((o) => o.path.endsWith(".css"));
    expect(css.length).toBeGreaterThan(0);
    for (const o of css) {
      expect((await o.text()).match(/:-(moz|webkit)-any\(/g)).toBeNull();
    }
  });
});
