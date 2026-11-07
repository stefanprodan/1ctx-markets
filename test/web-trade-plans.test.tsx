// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Trade plans page and the instrument page's card, from fixed, made-up
// answers: no DOM, no network.

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { tradePlanHref } from "../src/web/app/paths.ts";
import { onPhone } from "../src/web/app/shell.ts";
import { client, type Fetch } from "../src/web/data/api.ts";
import { STALE } from "../src/web/data/document.ts";
import {
  FIELDS_SAVED_STALE,
  fieldsChanged,
  type PlanItem,
  type PlanRead,
  symbolsOf,
  TRADE_PLANS_PATH,
  tradePlansStore,
} from "../src/web/data/trade-plans.ts";
import { TradePlansSection } from "../src/web/views/InstrumentTradePlans.tsx";
import {
  cardPlans,
  filterCount,
  hasArchived,
  shownPlans,
  symbolChoices,
} from "../src/web/views/TradePlans.model.ts";
import {
  PlanDrawer,
  TradePlanBody,
  TradePlansBody,
} from "../src/web/views/TradePlans.tsx";

const L = TRADE_PLANS_PATH;
const ALL = `GET ${L}?status=all`;

const plan = (over: Partial<PlanItem>): PlanItem => ({
  id: 1,
  name: "Made-up ladder",
  status: "active",
  symbols: ["US:ACME"],
  review_by: null,
  review_due: false,
  revision: 2,
  updated_at: "2026-11-01T10:00:00Z",
  author: "Sam (made-up-agent)",
  bytes: 40,
  ...over,
});

const tickers = (n: number) =>
  Array.from({ length: n }, (_, k) => `US:S${k + 1}`);

const LADDER = plan({
  id: 1,
  name: "Made-up ladder",
  symbols: ["US:ACME", "XETRA:WIDG"],
  review_by: "2026-10-01",
  review_due: true,
});
const POWDER = plan({
  id: 2,
  name: "Made-up dry powder",
  symbols: ["US:BOLT"],
  review_by: "2027-03-01",
});
const SHELVED = plan({
  id: 3,
  name: "Made-up old idea",
  status: "archived",
  symbols: ["US:ACME"],
});
const BINNED = plan({ id: 4, name: "Made-up binned", status: "removed" });

const READ: PlanRead = {
  ...LADDER,
  created_at: "2026-10-20T09:00:00Z",
  text: "# Made-up\n\n### ACME ladder\n\n| 1 | $10 |\n",
  html: '<h1 class="md-h1" id="md-made-up">Made-up</h1><h3 class="md-h3" id="md-acme-ladder">ACME ladder</h3>',
  symbol: "US:ACME",
  sections: [
    { heading: "ACME ladder", level: 3, line: 3, anchor: "md-acme-ladder" },
  ],
};

const problem = (
  status: number,
  code: string,
  detail: string,
  more: object = {},
) => Response.json({ status, code, detail, ...more }, { status });

// answers by method and path; anything else fails the test
function answering(answers: Record<string, () => Response>) {
  const asked: { key: string; body: unknown }[] = [];
  const fetch: Fetch = async (path, init) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    asked.push({
      key,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers[key];
    if (answer === undefined) throw new Error(`no answer for ${key}`);
    return answer();
  };
  return {
    store: tradePlansStore(
      client(fetch, () => {}),
      () => 0,
    ),
    asked,
    keys: () => asked.map((a) => a.key),
  };
}

const listed = (plans: PlanItem[]) => () => Response.json({ plans });

describe("the Trade plans page", () => {
  test("lists the active plans with their badge, chips, review and author", async () => {
    const { store } = answering({ [ALL]: listed([LADDER, POWDER, SHELVED]) });
    await store.load();
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up ladder");
    expect(html).toContain("Made-up dry powder");
    expect(html).not.toContain("Made-up old idea");
    expect(html).toContain(">Active</span>");
    // a chip opens its instrument's page
    expect(html).toContain('href="/symbol/US%3AACME"');
    expect(html).toContain(">WIDG</a>");
    expect(html).toContain('href="/trade-plans/1"');
    expect(html).toContain("Review due");
    expect(html).toContain("by Sam (made-up-agent)");
    expect(html).toContain('aria-label="New trade plan"');
  });

  test("a row shows the first symbols and counts the rest", async () => {
    const wide = plan({ id: 5, symbols: tickers(6) });
    const { store } = answering({ [ALL]: listed([wide]) });
    await store.load();
    const html = render(<TradePlansBody store={store} />);
    // six fit the desktop column, since "+1" would take the hidden chip's room
    expect(html).toContain(">S6</a>");
    // the phone row keeps three and counts three
    expect(html).toContain(">+3</span>");
    expect(html).not.toContain(">+1<");
  });

  test("a phone picks the status from a menu and opens a row on any tap", async () => {
    const { store } = answering({ [ALL]: listed([LADDER, POWDER]) });
    await store.load();
    const desk = render(<TradePlansBody store={store} />);
    expect(desk).toContain('aria-label="Status"');
    expect(desk).toContain("seg-option");
    onPhone.value = true;
    try {
      const phone = render(<TradePlansBody store={store} />);
      expect(phone).not.toContain("seg-option");
      expect(phone).toMatch(/aria-label="Status"[^>]*aria-haspopup="menu"/);
      // the picked status and its count on the picker's face
      expect(phone).toMatch(
        /<span>Active<\/span><span class="al-count num">2</,
      );
      // the row's chips are words under its link, not links of their own
      const under = phone
        .split('class="tp-under')[1]!
        .split("</span></span></span>")[0];
      expect(under).toContain('class="tp-chips"');
      expect(under).toContain('<span class="tag tp-chip">WIDG');
      expect(under).not.toContain("<a ");
    } finally {
      onPhone.value = false;
    }
  });

  test("Archived, All and a symbol filter the rows", async () => {
    const { store } = answering({ [ALL]: listed([LADDER, POWDER, SHELVED]) });
    await store.load();
    store.filter.value = "archived";
    let html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up old idea");
    expect(html).not.toContain("Made-up ladder");
    store.filter.value = "all";
    store.symbol.value = "US:ACME";
    html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up ladder");
    expect(html).toContain("Made-up old idea");
    expect(html).not.toContain("Made-up dry powder");
  });

  test("a symbol no plan holds any more can still be cleared", async () => {
    const { store } = answering({ [ALL]: listed([plan({ symbols: [] })]) });
    await store.load();
    store.symbol.value = "US:ACME";
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("None here.");
    expect(html).toContain('aria-label="Symbol"');
  });

  test("a failed refresh says so over the rows still shown", async () => {
    let n = 0;
    const { store } = answering({
      [ALL]: () =>
        n++ === 0 ? listed([LADDER])() : problem(503, "unavailable", "Down."),
    });
    await store.load();
    await store.load();
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up ladder");
    expect(html).toContain("The server failed.");
  });

  test("Deleted reads the removed plans only when picked", async () => {
    const { store, keys } = answering({
      [ALL]: listed([LADDER]),
      [`GET ${L}?status=removed`]: listed([BINNED]),
    });
    await store.load();
    expect(keys()).toEqual([ALL]);
    expect(filterCount(store.plans.value, store.removed.value, "removed")).toBe(
      null,
    );
    store.filter.value = "removed";
    await store.load(true);
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up binned");
    expect(html).toContain(">Deleted</span>");
    expect(html).not.toContain("Made-up ladder");
  });

  test("with none says so and offers a new one", async () => {
    const { store } = answering({ [ALL]: listed([]) });
    await store.load();
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("No trade plans yet");
    expect(html).toContain("New trade plan</button>");
    expect(html).not.toContain('aria-label="Status"');
  });

  test("with only deleted plans the Deleted filter stays reachable", async () => {
    const { store } = answering({
      [ALL]: listed([]),
      [`GET ${L}?status=removed`]: listed([BINNED]),
    });
    await store.load();
    let html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Show deleted</button>");
    store.filter.value = "removed";
    await store.load(true);
    html = render(<TradePlansBody store={store} />);
    expect(html).toContain("Made-up binned");
    // back on Active, the filters stay while a deleted plan is left
    store.filter.value = "active";
    html = render(<TradePlansBody store={store} />);
    expect(html).not.toContain("No trade plans yet");
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain(">Deleted</span>");
  });

  test("with none, after an empty Deleted read, still offers Show deleted", async () => {
    const { store } = answering({
      [ALL]: listed([]),
      [`GET ${L}?status=removed`]: listed([]),
    });
    await store.load(true);
    const html = render(<TradePlansBody store={store} />);
    expect(html).toContain("No trade plans yet");
    expect(html).toContain("Show deleted");
  });

  test("reads every page of the list", async () => {
    const { store, keys } = answering({
      [ALL]: () => Response.json({ plans: [LADDER], next_page_token: "9.1" }),
      [`GET ${L}?status=all&page_token=9.1`]: listed([POWDER]),
    });
    await store.load();
    expect(store.plans.value?.map((p) => p.id)).toEqual([1, 2]);
    expect(keys()).toHaveLength(2);
  });
});

describe("a plan opened", () => {
  test("for a symbol asks its sections and draws the server's HTML", async () => {
    const { store, keys } = answering({
      [`GET ${L}/1?symbol=US%3AACME`]: () => Response.json(READ),
    });
    await store.open(1, "US:ACME");
    expect(keys()).toEqual([`GET ${L}/1?symbol=US%3AACME`]);
    const html = render(<TradePlanBody store={store} id={1} />);
    expect(html).toContain(READ.html);
    expect(html).toContain('id="md-acme-ladder"');
    // History waits in More, so the head keeps the name's room
    expect(html).not.toContain(">History</button>");
    expect(html).toContain("Edit</button>");
    expect(html).toContain('aria-label="More"');
    expect(html).toMatch(/Saved .+ by Sam \(made-up-agent\)/);
    expect(html).toContain("Review due");
  });

  test("its header names status, review date and symbols; a phone folds them", async () => {
    const wide = { ...READ, symbols: tickers(9) };
    const { store } = answering({
      [`GET ${L}/1`]: () => Response.json(wide),
    });
    await store.open(1);
    const desk = render(<TradePlanBody store={store} id={1} />);
    expect(desk).toContain("<dt>Status</dt>");
    expect(desk).toContain("<dt>Review by</dt>");
    expect(desk).toContain(">9</span></dt>");
    expect(desk).toContain(">S9</a>");
    expect(desk).not.toContain("Show all");
    onPhone.value = true;
    try {
      const phone = render(<TradePlanBody store={store} id={1} />);
      expect(phone).toContain(">S6</a>");
      expect(phone).not.toContain(">S7</a>");
      expect(phone).toContain('aria-label="Show all 9 symbols"');
      expect(phone).toContain('aria-label="Edit"');
      expect(phone).not.toContain("Edit</button>");
    } finally {
      onPhone.value = false;
    }
  });

  test("a deleted one offers no Edit", async () => {
    const { store } = answering({
      [`GET ${L}/4`]: () =>
        Response.json({ ...READ, ...BINNED, symbol: undefined }),
    });
    await store.open(4);
    const html = render(<TradePlanBody store={store} id={4} />);
    expect(html).toContain(">Deleted</span>");
    expect(html).not.toContain("Edit</button>");
    expect(html).toContain('aria-label="More"');
  });

  test("delete and restore send the revision read, then read again", async () => {
    const { store, keys } = answering({
      [`GET ${L}/1`]: () => Response.json(READ),
      [`DELETE ${L}/1?revision=2`]: () =>
        Response.json({ ...LADDER, status: "removed" }),
      [`POST ${L}/1/restore`]: () => Response.json(LADDER),
      [ALL]: listed([LADDER]),
    });
    await store.open(1);
    expect(await store.remove(1, 2)).toBeNull();
    expect(await store.restore(1)).toBeNull();
    expect(keys()).toEqual([
      `GET ${L}/1`,
      `DELETE ${L}/1?revision=2`,
      `GET ${L}/1`,
      ALL,
      `POST ${L}/1/restore`,
      `GET ${L}/1`,
      ALL,
    ]);
  });

  test("archive sets the status; a refusal reads as the server words it", async () => {
    const { store, asked } = answering({
      [`GET ${L}/3`]: () => Response.json({ ...READ, ...SHELVED }),
      [`PUT ${L}/3`]: () =>
        problem(409, "conflict", 'an active plan is named "Made-up old idea"'),
      [ALL]: listed([SHELVED]),
    });
    await store.open(3);
    expect(await store.setStatus(3, 2, "active")).toBe(
      'An active plan is named "Made-up old idea".',
    );
    expect(asked[1]).toEqual({
      key: `PUT ${L}/3`,
      body: { revision: 2, status: "active" },
    });
  });
});

describe("the plan's editor", () => {
  test("a stale save keeps the text and says what to do", async () => {
    const { store } = answering({
      [`PUT ${L}/1`]: () =>
        problem(409, "conflict", "trade plan 1 is at revision 3", {
          revision: 3,
        }),
    });
    const fields = { name: "Made-up ladder", symbols: [], review_by: null };
    const editor = store.editor(1, { fields, text: "a\n" }, () => fields);
    expect(await editor.save("b\n", 2)).toBe(STALE);
  });

  test("fields saved before a stale text say so; a retry stays stale until reloaded", async () => {
    let puts = 0;
    const { store, asked } = answering({
      [`PUT ${L}/1`]: () =>
        ++puts === 1
          ? Response.json({ ...LADDER, revision: 3 })
          : puts === 4
            ? Response.json({ ...LADDER, revision: 6 })
            : problem(409, "conflict", "trade plan 1 is at revision 5", {
                revision: 5,
              }),
      [`GET ${L}/1`]: () => Response.json(READ),
      [ALL]: listed([LADDER]),
    });
    const was = { name: "Made-up ladder", symbols: [], review_by: null };
    const now = { ...was, review_by: "2026-12-01" };
    const editor = store.editor(1, { fields: was, text: "a\n" }, () => now);
    expect(await editor.save("b\n", 2)).toBe(FIELDS_SAVED_STALE);
    // the same drawer: the text alone, at the revision it opened with
    expect(await editor.save("b\n", 2)).toBe(STALE);
    // reloaded at the live revision, the save goes through
    expect(await editor.save("b\n", 5)).toBeNull();
    expect(asked.filter((a) => a.key.startsWith("PUT"))).toEqual([
      { key: `PUT ${L}/1`, body: { revision: 2, review_by: "2026-12-01" } },
      { key: `PUT ${L}/1`, body: { revision: 3, text: "b\n" } },
      { key: `PUT ${L}/1`, body: { revision: 2, text: "b\n" } },
      { key: `PUT ${L}/1`, body: { revision: 5, text: "b\n" } },
    ]);
  });

  test("the fields go first; a refused symbol leaves the text unsent", async () => {
    const { store, asked } = answering({
      [`PUT ${L}/1`]: () =>
        problem(404, "candidates", "symbol WIDG: several listings match", {
          candidates: [{ id: "XETRA:WIDG" }, { id: "LSE:WIDG" }],
        }),
    });
    const was = { name: "Made-up ladder", symbols: [], review_by: null };
    const now = { ...was, symbols: ["WIDG"] };
    const editor = store.editor(1, { fields: was, text: "a\n" }, () => now);
    expect(await editor.save("b\n", 2)).toBe(
      "Symbol WIDG: several listings match. Listed as XETRA:WIDG, LSE:WIDG.",
    );
    expect(asked).toEqual([
      {
        key: `PUT ${L}/1`,
        body: { revision: 2, symbols: ["WIDG"] },
      },
    ]);
  });

  test("a save sets the fields, then the text at the revision that left", async () => {
    let n = 2;
    const { store, asked } = answering({
      [`PUT ${L}/1`]: () => Response.json({ ...LADDER, revision: ++n }),
      [`GET ${L}/1`]: () => Response.json(READ),
      [ALL]: listed([LADDER]),
    });
    await store.open(1);
    const was = { name: "Made-up ladder", symbols: [], review_by: null };
    const now = { ...was, review_by: "2026-12-01" };
    const editor = store.editor(1, { fields: was, text: "a\n" }, () => now);
    expect(await editor.save("b\n", 2)).toBeNull();
    expect(asked.filter((a) => a.key.startsWith("PUT"))).toEqual([
      { key: `PUT ${L}/1`, body: { revision: 2, review_by: "2026-12-01" } },
      { key: `PUT ${L}/1`, body: { revision: 3, text: "b\n" } },
    ]);
  });

  test("a new plan sends its fields with the text", async () => {
    const { store, asked } = answering({
      [`POST ${L}`]: () => Response.json({ ...POWDER, id: 7 }, { status: 201 }),
      [ALL]: listed([POWDER]),
    });
    let made = 0;
    const creator = store.creator(
      () => ({
        name: "Made-up dry powder",
        symbols: symbolsOf("BOLT, acme  BOLT"),
        review_by: null,
      }),
      (id) => {
        made = id;
      },
    );
    expect(await creator.save("x\n")).toBeNull();
    expect(made).toBe(7);
    expect(asked[0]).toEqual({
      key: `POST ${L}`,
      body: {
        name: "Made-up dry powder",
        text: "x\n",
        symbols: ["BOLT", "acme"],
        review_by: null,
      },
    });
  });

  test("draws the name, symbols and review date beside the text", () => {
    const { store } = answering({});
    const html = render(
      <PlanDrawer store={store} plan={READ} onClose={() => {}} />,
    );
    expect(html).toContain("Edit trade plan");
    expect(html).toContain('value="Made-up ladder"');
    expect(html).toContain('value="US:ACME XETRA:WIDG"');
    expect(html).toContain('value="2026-10-01"');
    expect(html).toContain('aria-label="Trade plan text"');
  });
});

describe("the instrument page's card", () => {
  const tagged = (plans: PlanItem[]) => {
    const { store } = answering({
      [`GET ${L}?status=all&symbol=US%3AACME`]: listed(plans),
    });
    return store.tagged("US:ACME");
  };

  test("lists the active plans, each opening at the symbol's section", async () => {
    const t = tagged([LADDER, SHELVED]);
    await t.load();
    const html = render(<TradePlansSection store={t} id="US:ACME" />);
    expect(html).toContain("Trade plans");
    expect(html).toContain('href="/trade-plans/1?symbol=US%3AACME"');
    expect(html).toContain("Made-up ladder");
    expect(html).not.toContain("Made-up old idea");
    expect(html).toContain("Show archived");
    expect(html).toContain("Review due");
  });

  test("with none, no card", async () => {
    const t = tagged([]);
    await t.load();
    expect(render(<TradePlansSection store={t} id="US:ACME" />)).toBe("");
  });

  test("with archived ones only, the card offers them", async () => {
    const t = tagged([SHELVED]);
    await t.load();
    const html = render(<TradePlansSection store={t} id="US:ACME" />);
    expect(html).toContain("No active plans.");
    expect(html).toContain("Show archived");
  });

  test("the link names the symbol the plan page asks its sections for", () => {
    expect(tradePlanHref(3)).toBe("/trade-plans/3");
    expect(tradePlanHref(3, "fund:IE00B4L5Y983")).toBe(
      "/trade-plans/3?symbol=fund%3AIE00B4L5Y983",
    );
  });
});

describe("the trade plans model", () => {
  const all = [LADDER, POWDER, SHELVED];

  test("filters and counts as the server's statuses", () => {
    expect(shownPlans(all, null, "active", null).map((p) => p.id)).toEqual([
      1, 2,
    ]);
    expect(shownPlans(all, null, "all", null).map((p) => p.id)).toEqual([
      1, 2, 3,
    ]);
    expect(shownPlans(all, [BINNED], "removed", null).map((p) => p.id)).toEqual(
      [4],
    );
    expect(shownPlans(all, null, "all", "XETRA:WIDG")).toEqual([LADDER]);
    expect(filterCount(all, null, "archived")).toBe(1);
    expect(symbolChoices(all)).toEqual(["US:ACME", "US:BOLT", "XETRA:WIDG"]);
  });

  test("the card shows archived ones only when asked", () => {
    expect(cardPlans(all, false).map((p) => p.id)).toEqual([1, 2]);
    expect(cardPlans(all, true).map((p) => p.id)).toEqual([1, 2, 3]);
    expect(hasArchived([LADDER])).toBe(false);
  });

  test("symbols typed with commas or spaces, each once", () => {
    expect(symbolsOf(" ACME,WIDG.DE  fund:IE00B4L5Y983,,ACME ")).toEqual([
      "ACME",
      "WIDG.DE",
      "fund:IE00B4L5Y983",
    ]);
    expect(symbolsOf("")).toEqual([]);
  });

  test("a save sends only the fields changed", () => {
    const was = { name: "A", symbols: ["US:ACME"], review_by: null };
    expect(fieldsChanged(was, { ...was })).toEqual({});
    expect(
      fieldsChanged(was, { name: "B", symbols: ["US:ACME"], review_by: "x" }),
    ).toEqual({ name: "B", review_by: "x" });
  });
});
