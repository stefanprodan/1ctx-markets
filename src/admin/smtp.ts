// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The SMTP tab's routes, for admins: the settings row, the email- key file
// names to pick from, and a test email. The password is the file's, put
// there by hand; no answer or log line holds it.

import { json, NO_STORE, problem } from "../api/http.ts";
import { iso } from "../market/format.ts";
import { ArgError, fields } from "../operations/args.ts";
import { OPERATOR, type Who } from "../operations/who.ts";
import { recheck } from "../server/caller.ts";
import {
  emailOf,
  parseSmtp,
  readSmtp,
  removeSmtp,
  type SmtpSettings,
  saveSmtp,
} from "../server/email/settings.ts";
import { deadline, SEND_DEADLINE_MS } from "../server/links.ts";
import type { PeopleDeps } from "./users.ts";

// whoever sets the SMTP server reads every link it carries, so only the
// operator changes it or sends through it; other admins read it
const notOperator = (who: Who): Response | null =>
  who.user === OPERATOR
    ? null
    : problem("forbidden", "only the operator changes email");

const settingsItem = (s: SmtpSettings) => ({
  host: s.host,
  port: s.port,
  security: s.security,
  username: s.username,
  key_name: s.keyName,
  from: s.from,
  public_url: s.publicUrl,
  updated_at: iso(s.updatedAt),
  updated_by: s.updatedBy,
});

export function smtpAnswer(d: PeopleDeps): Response {
  const s = readSmtp(d.m.db);
  const names = d.email.keyNames();
  return json({
    settings: s === null ? null : settingsItem(s),
    key_names: names,
    email_on: d.email.on(d.m.db),
    // saved, naming a file that is not in secrets/ (or cannot be read)
    key_missing: s !== null && s.keyName !== null && !d.email.on(d.m.db),
  });
}

// a save never sends; the next email goes through the new settings
export async function putSmtp(
  d: PeopleDeps,
  who: Who,
  body: unknown,
): Promise<Response> {
  const refused = notOperator(who);
  if (refused !== null) return refused;
  const args = parseSmtp(body);
  await d.m.writer.write((db) => {
    recheck(db, "admin");
    // a password never follows a new server unpicked: the login is
    // picked again for it
    const before = readSmtp(db);
    const moved =
      before !== null &&
      (before.host !== args.host || before.port !== args.port) &&
      args.keyName === before.keyName;
    saveSmtp(
      db,
      moved ? { ...args, username: null, keyName: null } : args,
      who.user,
      d.m.clock.now(),
    );
  });
  d.m.log.info("smtp saved", { by: who.user });
  return smtpAnswer(d);
}

// email goes off; the key file, people and their logins stay
export async function deleteSmtp(d: PeopleDeps, who: Who): Promise<Response> {
  const refused = notOperator(who);
  if (refused !== null) return refused;
  const gone = await d.m.writer.write((db) => {
    recheck(db, "admin");
    return removeSmtp(db);
  });
  if (!gone) return problem("not_found", "email is not set up");
  d.m.log.info("smtp removed", { by: who.user });
  return new Response(null, { status: 204, headers: NO_STORE });
}

const TEST_SUBJECT = "Test email from markets";
const TEST_TEXT = "Email works: markets can send sign-in links.\n";

// sent at once, the SMTP reply answered to the admin alone and never
// logged, as it can carry addresses
export async function testSmtp(
  d: PeopleDeps,
  who: Who,
  body: unknown,
): Promise<Response> {
  const refused = notOperator(who);
  if (refused !== null) return refused;
  const b = fields(body, ["to"]);
  const own = d.m.db
    .query<{ email: string | null }, [string]>(
      "select email from users where id = ?",
    )
    .get(who.user)?.email;
  const to = b.to === undefined ? (own ?? null) : emailOf(b.to);
  if (to === null) {
    throw new ArgError(
      b.to === undefined
        ? "to is required: you have no email of your own"
        : "to is an email address",
    );
  }
  if (!d.email.on(d.m.db)) return problem("conflict", "email is not set up");
  await d.m.writer.write((db) => recheck(db, "admin"));
  const result = await deadline(
    d.m.clock,
    d.email.send(d.m.db, { name: "", address: to }, TEST_SUBJECT, TEST_TEXT),
    SEND_DEADLINE_MS,
    { ok: false, failure: "timeout", reply: null },
  );
  if (result === null) return problem("conflict", "email is not set up");
  if (result.ok) {
    d.m.log.info("test email sent", { by: who.user });
    return json({ result: "sent" });
  }
  d.m.log.warn("test email failed", {
    by: who.user,
    failure: result.failure,
  });
  return json({
    result: "failed",
    reason: result.failure,
    reply: result.reply,
  });
}
