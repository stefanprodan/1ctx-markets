// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Profile page's calls and signals. A save answers the refusal's
// sentence, or null once saved, and reloads the profile.

import { batch, signal } from "@preact/signals";
import { ApiError, type Call, codeOf, says } from "./api.ts";

export const PROFILE_PATH = "/api/v1/profile";

export type ProfileAnswer = {
  text: string | null;
  html: string | null;
  revision: number | null;
  author: string | null;
  updated_at: string | null;
  bytes: number | null;
};

export type RevisionRow = {
  revision: number;
  author: string;
  bytes: number;
  updated_at: string;
};

// a save refused because another one landed first keeps the typed text
export const STALE =
  "Changed since you opened it. Copy your text, then reload.";

// a restore refused for a newer save: the profile is read again first
export const RESTORE_STALE =
  "Changed since you opened it. Restore again to put this one back.";

export type ProfileStore = ReturnType<typeof profileStore>;

// session: the store's sign-in count, so no answer from before a sign-out
// puts the profile back on a signed-out page
export function profileStore(call: Call, session: () => number) {
  const profile = signal<ProfileAnswer | null>(null);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);

  // a later load supersedes one in flight
  let loads = 0;
  async function load(): Promise<boolean> {
    const mine = ++loads;
    const at = session();
    const stale = () => mine !== loads || at !== session();
    try {
      const answer = await call<ProfileAnswer>(PROFILE_PATH);
      if (stale()) return false;
      batch(() => {
        profile.value = answer;
        error.value = null;
        code.value = null;
      });
      return true;
    } catch (e) {
      if (stale()) return false;
      batch(() => {
        error.value = says(e);
        code.value = codeOf(e);
      });
      return false;
    }
  }

  // a save answered after a sign-out says nothing and reads nothing
  async function save(
    text: string,
    revision: number | null,
  ): Promise<string | null> {
    const at = session();
    try {
      await call(PROFILE_PATH, "PUT", { revision, text });
    } catch (e) {
      if (at !== session()) return null;
      if (e instanceof ApiError && e.code === "conflict") return STALE;
      return says(e);
    }
    if (at === session()) await load();
    return null;
  }

  // a kept revision's text saved at the live revision, so a newer save
  // refuses it rather than being overwritten; null once restored
  async function restore(text: string, live: number): Promise<string | null> {
    const said = await save(text, live);
    if (said !== STALE) return said;
    await load();
    return RESTORE_STALE;
  }

  // the draft drawn as the server draws a save; nothing is kept
  const preview = (text: string) =>
    call<{ html: string }>(`${PROFILE_PATH}/preview`, "POST", { text }).then(
      (a) => a.html,
    );

  const versions = () =>
    call<{ revisions: RevisionRow[] }>(`${PROFILE_PATH}/versions`).then(
      (a) => a.revisions,
    );

  const version = (n: number) =>
    call<ProfileAnswer>(`${PROFILE_PATH}/versions/${n}`);

  function clear(): void {
    batch(() => {
      profile.value = null;
      error.value = null;
      code.value = null;
    });
  }

  return {
    profile,
    error,
    code,
    load,
    save,
    restore,
    preview,
    versions,
    version,
    clear,
  };
}
