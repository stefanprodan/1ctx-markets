// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A symbol's analysis on its page, from fixed, made-up answers: no DOM, no
// network.

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import {
  type AnalysisAnswer,
  analysisPath,
  analysisStore,
} from "../src/web/data/analysis.ts";
import { client, type Fetch } from "../src/web/data/api.ts";
import { STALE } from "../src/web/data/document.ts";
import {
  analysisAuthor,
  moreMenu,
  OUTLINE,
  sinceLine,
} from "../src/web/views/InstrumentAnalysis.model.ts";
import { AnalysisSection } from "../src/web/views/InstrumentAnalysis.tsx";
import { FundMenu } from "../src/web/views/InstrumentTrade.tsx";

const ID = "US:ACME";
const PATH = analysisPath(ID);

const NONE: AnalysisAnswer = {
  text: null,
  html: null,
  revision: null,
  author: null,
  written_at: null,
  bytes: null,
  since_written: null,
};

const MADE: AnalysisAnswer = {
  text: "## Trend\nUp since the last report.\n",
  html: '<h2 class="md-h2">Trend</h2><p class="md-p">Up since the last report.</p>',
  revision: 2,
  author: "Jordan (research-agent)",
  written_at: "2026-11-01T10:00:00Z",
  bytes: 36,
  since_written: { change_percent: 3.4, earnings: [] },
};

// answers by method and path; anything else fails the test
function answering(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch: Fetch = async (path, init) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    asked.push(key);
    const answer = answers[key];
    if (answer === undefined) throw new Error(`no answer for ${key}`);
    return answer();
  };
  return {
    store: analysisStore(
      client(fetch, () => {}),
      () => 0,
      ID,
    ),
    asked,
  };
}

const section = (store: ReturnType<typeof analysisStore>) =>
  render(
    <AnalysisSection store={store} symbol="ACME" writing={signal(false)} />,
  );

describe("the analysis card", () => {
  test("with no analysis draws nothing", async () => {
    const { store } = answering({ [`GET ${PATH}`]: () => Response.json(NONE) });
    await store.load();
    expect(section(store)).toBe("");
  });

  test("draws the server's HTML, who wrote it, the move since, History and Edit", async () => {
    const { store } = answering({ [`GET ${PATH}`]: () => Response.json(MADE) });
    await store.load();
    const html = section(store);
    expect(html).toContain("Analysis");
    expect(html).toContain(MADE.html!);
    expect(html).toMatch(/Written .+ by Jordan \(research-agent\)/);
    expect(html).toContain("+3.40%");
    expect(html).toContain(" since");
    expect(html).toContain(">History</button>");
    expect(html).toContain("Edit</button>");
    expect(html).not.toContain("earnings reported since");
  });

  test("says earnings came out only when one was reported", async () => {
    const reported = {
      ...MADE,
      since_written: {
        change_percent: null,
        earnings: [{ date: "2026-11-03", status: "reported" }],
      },
    };
    const { store } = answering({
      [`GET ${PATH}`]: () => Response.json(reported),
    });
    await store.load();
    const html = section(store);
    expect(html).toContain("earnings reported since");
    expect(html).not.toContain("%");
  });
});

describe("the analysis store", () => {
  test("reads a symbol's analysis at its own path, the id escaped", () => {
    expect(PATH).toBe("/api/v1/instruments/US%3AACME/analysis");
  });

  test("a stale save keeps the text and says what to do", async () => {
    const { store, asked } = answering({
      [`PUT ${PATH}`]: () =>
        Response.json(
          {
            status: 409,
            code: "conflict",
            detail: "analysis is at revision 3",
            revision: 3,
          },
          { status: 409 },
        ),
    });
    expect(await store.save("## Trend\n", 2)).toBe(STALE);
    expect(asked).toEqual([`PUT ${PATH}`]);
  });

  test("a save reads the analysis again", async () => {
    const { store, asked } = answering({
      [`PUT ${PATH}`]: () =>
        Response.json({ revision: 3, author: "you", bytes: 9 }),
      [`GET ${PATH}`]: () => Response.json({ ...MADE, revision: 3 }),
    });
    expect(await store.save("## Trend\n", 2)).toBeNull();
    expect(asked).toEqual([`PUT ${PATH}`, `GET ${PATH}`]);
    expect(store.doc.value?.revision).toBe(3);
    expect(store.doc.value?.at).toBe(MADE.written_at);
  });

  test("the history's rows carry the time each revision was written", async () => {
    const { store } = answering({
      [`GET ${PATH}/versions`]: () =>
        Response.json({
          revisions: [
            {
              revision: 2,
              author: "Jordan (research-agent)",
              bytes: 36,
              written_at: "2026-11-01T10:00:00Z",
            },
          ],
        }),
    });
    expect(await store.versions()).toEqual([
      {
        revision: 2,
        author: "Jordan (research-agent)",
        bytes: 36,
        at: "2026-11-01T10:00:00Z",
      },
    ]);
  });
});

describe("the analysis model", () => {
  test("the reader's own saves read as you, anyone else's by name", () => {
    expect(analysisAuthor("Sam", "Sam")).toBe("you");
    expect(analysisAuthor("Jordan", "Sam")).toBe("Jordan");
    expect(analysisAuthor("Sam (research-agent)", "Sam")).toBe(
      "Sam (research-agent)",
    );
    expect(analysisAuthor("admin", "Sam")).toBe("the admin");
  });

  test("the line since reads the move and a reported earnings only", () => {
    expect(sinceLine(null)).toEqual({ change: null, reported: false });
    expect(
      sinceLine({
        change_percent: -1.2,
        earnings: [{ date: "2026-11-20", status: "scheduled" }],
      }),
    ).toEqual({ change: -1.2, reported: false });
  });

  test("More shows to an admin always, to anyone else only to write one", () => {
    expect(moreMenu(true, false)).toBe(true);
    expect(moreMenu(true, true)).toBe(true);
    expect(moreMenu(false, true)).toBe(true);
    expect(moreMenu(false, false)).toBe(false);
  });

  test("a first analysis starts from four sections", () => {
    expect(OUTLINE.match(/^## .+$/gm)).toEqual([
      "## Trend",
      "## Earnings",
      "## Risks",
      "## Watch",
    ]);
  });
});

describe("a fund's menu", () => {
  test("offers to write an analysis, and a price only while held", () => {
    const open = signal(null);
    expect(render(<FundMenu open={open} held={false} />)).toBe("");
    expect(
      render(<FundMenu open={open} held={false} onWrite={() => {}} />),
    ).toContain('aria-label="More"');
    expect(render(<FundMenu open={open} held />)).toContain(
      'aria-label="More"',
    );
  });
});
