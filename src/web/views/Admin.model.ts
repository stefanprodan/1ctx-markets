// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Server admin's words: people's sign-ins, what removing one deletes,
// and the SMTP form's fields as the server takes them.

import type { Counts, Person, SmtpSettings } from "../data/admin.ts";
import { ago } from "../lib/format.ts";

export const INVITE_SENT = "The link works once, for 7 days.";

// a person never signed in is still invited; the operator always exists
export function seenWords(p: Person, now: number, long = false): string {
  if (p.last_sign_in_at === null) {
    if (p.operator) return "Never";
    return long ? "Invited, not signed in yet" : "Invited";
  }
  const words = ago(p.last_sign_in_at, now);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// an invite is sent again only until the first sign-in
export const invitable = (p: Person): boolean =>
  p.email !== null && p.last_sign_in_at === null;

// the kinds Remove's question names, in its order: a profile by itself,
// the rest with their counts; none of a kind is not named
const NAMED: readonly [string, string, boolean][] = [
  ["portfolios", "portfolios", true],
  ["trades", "trades", true],
  ["profile", "profile", false],
  ["rules", "alerts", true],
  ["alerts", "triggered alerts", true],
  ["keys", "keys", true],
];

export function removeLine(counts: Counts): string {
  const parts = NAMED.filter(([k]) => (counts[k] ?? 0) > 0).map(
    ([k, words, counted]) => (counted ? `${words} (${counts[k]})` : words),
  );
  if (parts.length === 0) return "Removes them.";
  const list =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `Removes their ${list}.`;
}

export type SmtpForm = {
  host: string;
  port: string;
  security: "tls" | "starttls";
  username: string;
  keyName: string | null;
  from: string;
  link: string;
};

export const formOf = (s: SmtpSettings | null): SmtpForm => ({
  host: s?.host ?? "",
  port: s === null ? "" : String(s.port),
  security: s?.security ?? "tls",
  username: s?.username ?? "",
  keyName: s?.key_name ?? null,
  from: s?.from ?? "",
  link: s?.public_url ?? "",
});

// as the server takes it: a port typed as a number, no username as null;
// the server names what is missing or wrong
export const settingsOf = (f: SmtpForm): SmtpSettings => ({
  host: f.host.trim(),
  port: /^\d+$/.test(f.port.trim()) ? Number(f.port.trim()) : 0,
  security: f.security,
  username: f.username.trim() === "" ? null : f.username.trim(),
  key_name: f.keyName,
  from: f.from.trim(),
  public_url: f.link.trim(),
});

// a password file named as it sits in secrets/
export const fileOf = (name: string): string => `${name}.key`;

export const missingLine = (name: string): string =>
  `Put the password in secrets/ as ${fileOf(name)}.`;

// the server's failure words, as someone who set up the email reads them
const FAILURES: Record<string, string> = {
  auth: "The mail server refused the login",
  tls: "The secure connection to the mail server failed",
  connect: "Couldn't reach the mail server",
  rejected: "The mail server refused the email",
  timeout: "The mail server didn't answer in time",
  other: "Sending failed",
};

export const failureWords = (reason: string): string =>
  FAILURES[reason] ?? FAILURES.other!;

export const inviteFailed = (reason: string, added = false): string =>
  `${added ? "Added, but the invite wasn't sent" : "Invite not sent"}. ${failureWords(reason)}.`;

// the SMTP server's own reply goes on a faint line of its own
export function testLine(
  r:
    | { sent: true }
    | { sent: false; reason: string; reply: string | null }
    | { error: string },
): { text: string; error: boolean; detail?: string } {
  if ("error" in r) return { text: plainError(r.error), error: true };
  if (r.sent) return { text: "Test email sent to you.", error: false };
  return {
    text: `Not sent. ${failureWords(r.reason)}.`,
    error: true,
    ...(r.reply ? { detail: r.reply } : {}),
  };
}

// the form's names for the API's fields
const LABELS: Record<string, string> = {
  host: "Host",
  port: "Port",
  security: "Security",
  username: "Username",
  key_name: "Password file",
  from: "From",
  public_url: "Link address",
};

const PLAIN: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [
    /^missing (.+?)\.?$/i,
    (m) =>
      `Fill in ${m[1]!
        .split(", ")
        .map((f) => LABELS[f] ?? f)
        .join(", ")}.`,
  ],
  [/^host must/i, "Host is a host name or an IP address."],
  [/^port must/i, "Port is a number from 1 to 65535."],
  [/^username must/i, "Username is one line of at most 255 characters."],
  [/^key_name must/i, "Pick a password file."],
  [/^username is required/i, "Add the username for the password file."],
  [/^key_name is required/i, "Pick a password file for the username."],
  [/^from must/i, "From is an email address."],
  [
    /^public_url must start/i,
    "Link address starts with https://, or http:// on this computer.",
  ],
  [/^public_url must not hold/i, "Link address holds no user or password."],
  [/^public_url must be an origin/i, "Link address has no path."],
  [/^public_url must/i, "Link address is a web address."],
  [/^email is not set up/i, "Email isn't set up yet."],
  [/^another person has this email/i, "Someone else has this email."],
  [/^email is an email address/i, "Enter an email address."],
  [/^name is 1 to/i, "Enter a name on one line."],
  [/^you cannot change your own role/i, "Your own role stays as it is."],
  [/^you cannot remove yourself/i, "You can't remove yourself."],
];

// a refusal named in the form's words, never the API's field names
export function plainError(sentence: string): string {
  for (const [re, said] of PLAIN) {
    const m = sentence.match(re);
    if (m) return typeof said === "string" ? said : said(m);
  }
  return sentence;
}

// a send to one's own email needs one
export const NO_EMAIL = "Add your email to send a test.";

export const CONFIRM = "Check your email to confirm.";
