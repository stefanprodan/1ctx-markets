// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Who may reach what: sign-in caps, authors others may not see, and the
// modes of the files beside the database.

import { expect, test } from "bun:test";
import { silent } from "../src/runtime/log.ts";
import type { Email } from "../src/server/email/settings.ts";
import {
  ASKS_PER_INBOX_DAY,
  links,
  MAX_CODE_TRIES,
} from "../src/server/links.ts";
import { world } from "./helpers/world.ts";

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
