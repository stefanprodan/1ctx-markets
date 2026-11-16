// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Sign-in links driven directly: a fake email records each message, and
// every challenge is made up, as a browser without a cookie gets a new one.

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
const BO = "bo@example.com";

function harness(origin: () => string | null = () => "https://m.example") {
  const w = world();
  const sent: { to: string; text: string }[] = [];
  const email: Email = {
    keyNames: () => [],
    on: () => true,
    origin: () => origin(),
    async send(_db, to, _subject, text) {
      sent.push({ to: to.address, text });
      return { ok: true };
    },
  };
  for (const [id, address] of [
    ["ana", ANA],
    ["bo", BO],
  ]) {
    w.db
      .query(
        "insert into users (id, name, email, role, created_at) values (?, ?, ?, 'member', 0)",
      )
      .run(id, id, address);
  }
  const l = links({
    db: w.db,
    writer: w.m.writer,
    email,
    clock: w.clock,
    log: silent,
  });
  const mail = (to: string) => {
    const m = [...sent].reverse().find((s) => s.to === to)!;
    return {
      token: /\/ui\/link\/([A-Za-z0-9_-]{43})/.exec(m.text)![1]!,
      code: /enter (\d{6})/.exec(m.text)![1]!,
    };
  };
  return { ...w, l, sent, mail };
}

const challenge = (n: number) => `c${n}`.padEnd(43, "x");

test("an invite's wrong codes count across browsers and refuse its code, never its link", async () => {
  const t = harness();
  expect(await t.l.invite("ana", ANA)).toEqual({ sent: true });
  const { token, code } = t.mail(ANA);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let c = 0; c < 20; c++) {
    for (let k = 0; k < MAX_CODE_TRIES - 1; k++) {
      await t.l.useCode(ANA, wrong, challenge(c), null);
    }
  }
  expect(await t.l.useCode(ANA, code, challenge(99), null)).toBeNull();
  expect(t.db.query("select code_tries, used_at from links").get()).toEqual({
    code_tries: MAX_CODE_TRIES,
    used_at: null,
  });
  const used = await t.l.useLink(token, null);
  expect(used?.purpose).toBe("invite");
});

test("one person's inbox is sent a capped number of links a day across browsers", async () => {
  const t = harness();
  for (let n = 0; n < 60; n++) t.l.ask(ANA, challenge(n));
  await t.l.settled();
  expect(t.sent.filter((s) => s.to === ANA)).toHaveLength(ASKS_PER_INBOX_DAY);
  t.l.ask(BO, challenge(100));
  await t.l.settled();
  expect(t.sent.filter((s) => s.to === BO)).toHaveLength(1);
});

test("an invite whose email cannot be made leaves no unhandled rejection", async () => {
  const t = harness(() => {
    throw new Error("made-up settings failure");
  });
  const stray: unknown[] = [];
  const onStray = (reason: unknown) => stray.push(reason);
  process.on("unhandledRejection", onStray);
  try {
    await expect(t.l.invite("ana", ANA)).rejects.toThrow(
      "made-up settings failure",
    );
    await expect(t.l.confirm("ana", "ana2@example.com")).rejects.toThrow(
      "made-up settings failure",
    );
    await t.l.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onStray);
  }
  expect(stray).toEqual([]);
});

test("a stranger's asks never close the inbox to a browser that signed its person in", async () => {
  const t = harness();
  const own = challenge(500);
  t.l.ask(ANA, own);
  await t.l.settled();
  expect(await t.l.useCode(ANA, t.mail(ANA).code, own, null)).not.toBeNull();
  for (let n = 0; n < ASKS_PER_INBOX_DAY; n++) t.l.ask(ANA, challenge(n));
  await t.l.settled();
  const before = t.sent.length;
  t.l.ask(ANA, own);
  await t.l.settled();
  expect(t.sent).toHaveLength(before + 1);
});
