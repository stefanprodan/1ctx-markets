// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Admin page's calls and signals: the people and the SMTP settings.
// A change answers the refusal's sentence, or null once done.

import { batch, signal } from "@preact/signals";
import { type Later, paced, timer } from "../lib/slow.ts";
import { ApiError, type Call, codeOf, says } from "./api.ts";

export const USERS_PATH = "/api/v1/users";
export const SMTP_PATH = "/api/v1/smtp";

export type Role = "admin" | "member";

export type Person = {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  operator: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  keys: number;
};

export type Security = "tls" | "starttls";

export type SmtpSettings = {
  host: string;
  port: number;
  security: Security;
  username: string | null;
  key_name: string | null;
  from: string;
  public_url: string;
  updated_at?: string;
  updated_by?: string;
};

export type SmtpAnswer = {
  settings: SmtpSettings | null;
  key_names: string[];
  email_on: boolean;
  key_missing: boolean;
};

// whether an email went, and the failure word when it did not
export type Sent = { sent: true } | { sent: false; reason: string };

// what removing a person deletes, per kind
export type Counts = Record<string, number>;

const userPath = (id: string) => `${USERS_PATH}/${encodeURIComponent(id)}`;

const sentOf = (a: { invite?: string; reason?: string }): Sent =>
  a.invite === "sent"
    ? { sent: true }
    : { sent: false, reason: a.reason ?? "other" };

export type AdminStore = ReturnType<typeof adminStore>;

// session: the store's sign-in count, so no answer from before a sign-out
// lands; onEmail: email turned on or off, which the sign-in page reads
export function adminStore(
  call: Call,
  session: () => number,
  onEmail: (on: boolean) => void,
  later: Later = timer,
) {
  const people = signal<Person[] | null>(null);
  const emailOn = signal<boolean | null>(null);
  const peopleError = signal<string | null>(null);
  const peopleCode = signal<number | null>(null);
  const peopleFailures = signal(0);
  const smtp = signal<SmtpAnswer | null>(null);
  const smtpError = signal<string | null>(null);
  const smtpCode = signal<number | null>(null);
  const smtpFailures = signal(0);

  const landed = (on: boolean) => {
    emailOn.value = on;
    onEmail(on);
  };

  // a later load supersedes one in flight, and a change makes it stale
  let peopleLoad = 0;
  async function loadPeople(): Promise<void> {
    const mine = ++peopleLoad;
    const at = session();
    const stale = () => mine !== peopleLoad || at !== session();
    try {
      const a = await paced(
        call<{ users: Person[]; email_on: boolean }>(USERS_PATH),
        later,
      );
      if (stale()) return;
      batch(() => {
        people.value = a.users;
        landed(a.email_on);
        peopleError.value = null;
        peopleCode.value = null;
      });
    } catch (e) {
      if (stale() || (e instanceof ApiError && e.status === 401)) return;
      batch(() => {
        peopleError.value = says(e);
        peopleCode.value = codeOf(e);
        peopleFailures.value++;
      });
    }
  }

  const put = (p: Person) => {
    peopleLoad++;
    const list = people.value ?? [];
    people.value = list.some((q) => q.id === p.id)
      ? list.map((q) => (q.id === p.id ? p : q))
      : [...list, p];
  };

  // the person added either way; the invite may still have failed
  async function addPerson(
    name: string,
    email: string,
    role: Role,
  ): Promise<{ sent: Sent } | { error: string }> {
    const at = session();
    try {
      const a = await call<{ user: Person; invite: string; reason?: string }>(
        USERS_PATH,
        "POST",
        { name, email, role },
      );
      if (at === session()) put(a.user);
      return { sent: sentOf(a) };
    } catch (e) {
      return { error: says(e) };
    }
  }

  // another person's name, role or both
  async function setPerson(
    id: string,
    change: { name?: string; role?: Role },
  ): Promise<string | null> {
    const at = session();
    try {
      const a = await call<{ user: Person }>(userPath(id), "PATCH", change);
      if (at === session()) put(a.user);
      return null;
    } catch (e) {
      return says(e);
    }
  }

  // the reader renamed themself through /ui/me
  function renamed(id: string, name: string): void {
    const p = people.value?.find((q) => q.id === id);
    if (p !== undefined) put({ ...p, name });
  }

  async function invite(id: string): Promise<Sent | { error: string }> {
    try {
      return sentOf(
        await call<{ invite: string; reason?: string }>(
          `${userPath(id)}/invite`,
          "POST",
        ),
      );
    } catch (e) {
      return { error: says(e) };
    }
  }

  async function signOutPerson(id: string): Promise<string | null> {
    try {
      await call(`${userPath(id)}/sign-out`, "POST");
      return null;
    } catch (e) {
      return says(e);
    }
  }

  // asked before Remove is offered, so the question names what goes
  async function removal(id: string): Promise<Counts | { error: string }> {
    try {
      const a = await call<{ deleted: Counts }>(
        `${userPath(id)}?dry_run=true`,
        "DELETE",
      );
      return a.deleted;
    } catch (e) {
      return { error: says(e) };
    }
  }

  async function removePerson(id: string): Promise<string | null> {
    const at = session();
    try {
      await call(userPath(id), "DELETE");
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "not_found")) return says(e);
    }
    if (at === session()) {
      peopleLoad++;
      people.value = people.value?.filter((p) => p.id !== id) ?? null;
    }
    return null;
  }

  let smtpLoad = 0;
  async function loadSmtp(): Promise<void> {
    const mine = ++smtpLoad;
    const at = session();
    const stale = () => mine !== smtpLoad || at !== session();
    try {
      const a = await paced(call<SmtpAnswer>(SMTP_PATH), later);
      if (stale()) return;
      batch(() => {
        smtp.value = a;
        landed(a.email_on);
        smtpError.value = null;
        smtpCode.value = null;
      });
    } catch (e) {
      if (stale() || (e instanceof ApiError && e.status === 401)) return;
      batch(() => {
        smtpError.value = says(e);
        smtpCode.value = codeOf(e);
        smtpFailures.value++;
      });
    }
  }

  const adopt = (a: SmtpAnswer) => {
    smtpLoad++;
    batch(() => {
      smtp.value = a;
      landed(a.email_on);
    });
  };

  async function saveSmtp(s: SmtpSettings): Promise<string | null> {
    const at = session();
    try {
      const a = await call<SmtpAnswer>(SMTP_PATH, "PUT", {
        host: s.host,
        port: s.port,
        security: s.security,
        username: s.username,
        key_name: s.key_name,
        from: s.from,
        public_url: s.public_url,
      });
      if (at === session()) adopt(a);
      return null;
    } catch (e) {
      return says(e);
    }
  }

  async function removeSmtp(): Promise<string | null> {
    const at = session();
    try {
      await call(SMTP_PATH, "DELETE");
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "not_found")) return says(e);
    }
    if (at === session()) {
      smtpLoad++;
      batch(() => {
        smtp.value =
          smtp.value === null
            ? null
            : {
                ...smtp.value,
                settings: null,
                email_on: false,
                key_missing: false,
              };
        landed(false);
      });
    }
    return null;
  }

  // to the admin's own email; the SMTP server's reply when it refused
  async function testSmtp(): Promise<
    | { sent: true }
    | { sent: false; reason: string; reply: string | null }
    | { error: string }
  > {
    try {
      const a = await call<{
        result: string;
        reason?: string;
        reply?: string | null;
      }>(`${SMTP_PATH}/test`, "POST", {});
      return a.result === "sent"
        ? { sent: true }
        : { sent: false, reason: a.reason ?? "other", reply: a.reply ?? null };
    } catch (e) {
      return { error: says(e) };
    }
  }

  function clear(): void {
    peopleLoad++;
    smtpLoad++;
    batch(() => {
      people.value = null;
      emailOn.value = null;
      peopleError.value = null;
      peopleCode.value = null;
      smtp.value = null;
      smtpError.value = null;
      smtpCode.value = null;
    });
  }

  return {
    people,
    emailOn,
    peopleError,
    peopleCode,
    peopleFailures,
    loadPeople,
    addPerson,
    setPerson,
    renamed,
    invite,
    signOutPerson,
    removal,
    removePerson,
    smtp,
    smtpError,
    smtpCode,
    smtpFailures,
    loadSmtp,
    saveSmtp,
    removeSmtp,
    testSmtp,
    clear,
  };
}
