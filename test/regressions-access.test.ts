// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who may reach what: sign-in caps, authors others may not see, and the
// modes of the files beside the database.

import { expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { h } from "preact";
import { render } from "preact-render-to-string";
import { PREFIX } from "../src/api/http.ts";
import type { Markets } from "../src/operations/markets.ts";
import type { Who } from "../src/operations/who.ts";
import { insertFund } from "../src/portfolios/funds.ts";
import { silent } from "../src/runtime/log.ts";
import type { Email } from "../src/server/email/settings.ts";
import {
  ASKS_PER_INBOX_DAY,
  links,
  MAX_CODE_TRIES,
} from "../src/server/links.ts";
import { call, tools } from "../src/tools/index.ts";
import { analysisPath, analysisStore } from "../src/web/data/analysis.ts";
import { client } from "../src/web/data/api.ts";
import { analysisAuthor } from "../src/web/views/InstrumentAnalysis.model.ts";
import { AnalysisSection } from "../src/web/views/InstrumentAnalysis.tsx";
import { api, cookieFor } from "./helpers/api.ts";
import { instrument, NOW, world } from "./helpers/world.ts";

const ANA = "ana@example.com";

function signIn() {
  const w = world();
  const sent: { to: string; text: string }[] = [];
  const email: Email = {
    keyNames: () => [],
    on: () => true,
    origin: () => "https://m.example",
    async send(_db, to, _subject, text) {
      sent.push({ to: to.address, text });
      return { ok: true };
    },
  };
  w.db
    .query(
      "insert into users (id, name, email, role, created_at) values ('ana', 'ana', ?, 'member', 0)",
    )
    .run(ANA);
  const l = links({
    db: w.db,
    writer: w.m.writer,
    email,
    clock: w.clock,
    log: silent,
  });
  const code = () => /enter (\d{6})/.exec(sent.at(-1)!.text)![1]!;
  const wrong = (right: string) => (right === "000000" ? "000001" : "000000");
  return { l, sent, code, wrong };
}

const challenge = (n: number) => `c${n}`.padEnd(43, "x");

test("a browser that burned its own link is held to the inbox's cap", async () => {
  const t = signIn();
  const stranger = challenge(900);
  t.l.ask(ANA, stranger);
  await t.l.settled();
  const bad = t.wrong(t.code());
  for (let k = 0; k < MAX_CODE_TRIES; k++) {
    expect(await t.l.useCode(ANA, bad, stranger, null)).toBeNull();
  }
  for (let n = 0; n < ASKS_PER_INBOX_DAY - 1; n++) t.l.ask(ANA, challenge(n));
  await t.l.settled();
  expect(t.sent).toHaveLength(ASKS_PER_INBOX_DAY);
  t.l.ask(ANA, stranger);
  await t.l.settled();
  expect(t.sent).toHaveLength(ASKS_PER_INBOX_DAY);
});

test("a browser that signed in after a few wrong codes keeps its own cap", async () => {
  const t = signIn();
  const own = challenge(901);
  t.l.ask(ANA, own);
  await t.l.settled();
  const right = t.code();
  for (let k = 0; k < MAX_CODE_TRIES - 1; k++) {
    expect(await t.l.useCode(ANA, t.wrong(right), own, null)).toBeNull();
  }
  expect(await t.l.useCode(ANA, right, own, null)).not.toBeNull();
  for (let n = 0; n < ASKS_PER_INBOX_DAY; n++) t.l.ask(ANA, challenge(n));
  await t.l.settled();
  const before = t.sent.length;
  t.l.ask(ANA, own);
  await t.l.settled();
  expect(t.sent).toHaveLength(before + 1);
});

// a fund's note is seen by each who holds or priced it; who wrote it is
// only the writer's own, as a fund price's entered_by is
test("a fund's note names its author only to the one who wrote it", async () => {
  const { m, db, clock } = world();
  instrument(db, "US:MADE");
  for (const [id, name] of [
    ["ana", "Ana"],
    ["jo", "Jo"],
  ]) {
    db.query(
      "insert into users (id, name, role, created_at) values (?, ?, 'member', 0)",
    ).run(id, name);
  }
  const fund = insertFund(
    db,
    {
      isin: "ZZ0000000018",
      name: "Made-up fund",
      currency: "EUR",
      market: null,
    },
    "Ana",
    NOW,
  );
  for (const [date, user, name] of [
    ["2026-10-21", "ana", "Ana"],
    ["2026-10-22", "jo", "Jo"],
  ]) {
    db.query(
      `insert into fund_prices (instrument, date, price, user_id, entered_by,
         entered_at) values (?, ?, 10, ?, ?, ?)`,
    ).run(fund.id, date, user, name, NOW);
  }
  const ana = agent("ana", "claude-code");
  const jo = agent("jo", "codex");
  const NOTE = "# Made-up fund\n\nTrend: flat.\n";
  const AUTHOR = "Ana (claude-code)";
  await tool(m, ana, { action: "replace", symbol: fund.id, text: NOTE });
  await tool(m, ana, { action: "replace", symbol: "US:MADE", text: NOTE });
  const route = async (user: string, path: string) => {
    const res = await api(m)(
      new Request(`http://markets.test${PREFIX}${path}`, {
        headers: { cookie: cookieFor(db, clock.now(), user, null) },
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  };
  const P = `/instruments/${encodeURIComponent(fund.id)}/analysis`;
  const reads = async (who: Who) => ({
    read: text(await tool(m, who, { action: "read", symbol: fund.id })),
    version: text(
      await tool(m, who, { action: "version", symbol: fund.id, revision: 1 }),
    ),
    versions: JSON.parse(
      text(await tool(m, who, { action: "versions", symbol: fund.id })),
    ).revisions[0].author,
    listed: JSON.parse(text(await tool(m, who, { action: "list" }))).analyses,
    saved: JSON.parse(
      text(
        await tool(m, who, {
          action: "replace",
          symbol: fund.id,
          revision: 1,
          text: NOTE,
        }),
      ),
    ),
    rest: (await route(who.user, P)).author,
    restVersion: (await route(who.user, `${P}/versions/1`)).author,
    restVersions: (await route(who.user, `${P}/versions`)).revisions[0].author,
    restList: (await route(who.user, "/analysis")).analyses,
  });
  const own = await reads(ana);
  expect(own.read).toContain(`by ${AUTHOR}`);
  expect(own.version).toContain(`by ${AUTHOR}`);
  expect(own.versions).toBe(AUTHOR);
  expect(own.saved).toMatchObject({ unchanged: true, author: AUTHOR });
  expect(own.rest).toBe(AUTHOR);
  expect(own.restVersion).toBe(AUTHOR);
  expect(own.restVersions).toBe(AUTHOR);
  for (const listed of [own.listed, own.restList]) {
    expect(listed.map((a: { author: string }) => a.author)).toEqual([
      AUTHOR,
      AUTHOR,
    ]);
  }
  const other = await reads(jo);
  for (const t of [other.read, other.version]) {
    expect(t).not.toContain("Ana");
    expect(t).toContain(`The analysis of ${fund.id}, revision 1, at `);
  }
  expect(other.versions).toBeNull();
  expect(other.saved).toMatchObject({ unchanged: true, author: null });
  expect(other.rest).toBeNull();
  expect(other.restVersion).toBeNull();
  expect(other.restVersions).toBeNull();
  // a listed share's note still names its author to everyone
  for (const listed of [other.listed, other.restList]) {
    expect(
      Object.fromEntries(
        listed.map((a: { id: string; author: string | null }) => [
          a.id,
          a.author,
        ]),
      ),
    ).toEqual({ [fund.id]: null, "US:MADE": AUTHOR });
  }
});

function agent(user: string, name: string): Who {
  return {
    name,
    user,
    credential: { kind: "key", id: name },
    portfolio: "read",
    alerts: "none",
    profile: "none",
    analysis: "write",
    tradePlans: "none",
  };
}

const tool = (
  m: Markets,
  who: Who,
  args: { action: string } & Record<string, unknown>,
) => {
  const name = args.action === "replace" ? "analysis_edit" : "analysis";
  return call(m, tools(m).find((t) => t.name === name)!, args, who);
};

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

test("the web UI draws a note whose author is hidden without a name", async () => {
  const path = analysisPath("fund:ZZ0000000018");
  const store = analysisStore(
    client(
      async (asked) => {
        if (asked !== path) throw new Error(`no answer for ${asked}`);
        return Response.json({
          text: "## Trend\nFlat.\n",
          html: '<p class="md-p">Flat.</p>',
          revision: 1,
          author: null,
          written_at: "2026-11-01T10:00:00Z",
          bytes: 14,
          since_written: null,
        });
      },
      () => {},
    ),
    () => 0,
    "fund:ZZ0000000018",
  );
  await store.load();
  const html = render(
    h(AnalysisSection, {
      store,
      symbol: "Made-up fund",
      writing: signal(false),
    }),
  );
  expect(html).toMatch(/Written [^<]+ago/);
  expect(html).not.toMatch(/Written [^<]* by/);
  expect(analysisAuthor(null, "Ana")).toBe("");
});
