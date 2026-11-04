// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// One versioned Markdown document's calls and signals: the profile, or a
// symbol's analysis. A save answers the refusal's sentence, or null once
// saved, and reloads the document.

import { batch, signal } from "@preact/signals";
import { ApiError, type Call, codeOf, says } from "./api.ts";

type Stamped = { updated_at?: string | null; written_at?: string | null };

// as the server answers it; the profile stamps a save updated_at, an
// analysis written_at
export type DocumentWire = Stamped & {
  text: string | null;
  html: string | null;
  revision: number | null;
  author: string | null;
  bytes: number | null;
};

// with one stamp for both
export type Loaded<W extends DocumentWire = DocumentWire> = W & {
  at: string | null;
};

export type RevisionRow = {
  revision: number;
  author: string;
  bytes: number;
  at: string;
};

// a save refused because another one landed first keeps the typed text
export const STALE =
  "Changed since you opened it. Copy your text, then reload.";

// a restore refused for a newer save: the document is read again first
export const RESTORE_STALE =
  "Changed since you opened it. Restore again to put this one back.";

const stampOf = (a: Stamped): string | null =>
  a.updated_at ?? a.written_at ?? null;

export type DocumentStore<W extends DocumentWire = DocumentWire> = ReturnType<
  typeof documentStore<W>
>;

// session: the store's sign-in count, so no answer from before a sign-out
// puts the document back on a signed-out page
export function documentStore<W extends DocumentWire = DocumentWire>(
  call: Call,
  session: () => number,
  path: string,
) {
  const doc = signal<Loaded<W> | null>(null);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);

  const answerOf = (raw: W): Loaded<W> => ({ ...raw, at: stampOf(raw) });

  // a later load supersedes one in flight
  let loads = 0;
  async function load(): Promise<boolean> {
    const mine = ++loads;
    const at = session();
    const stale = () => mine !== loads || at !== session();
    try {
      const answer = await call<W>(path);
      if (stale()) return false;
      batch(() => {
        doc.value = answerOf(answer);
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
      await call(path, "PUT", { revision, text });
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
    call<{ html: string }>(`${path}/preview`, "POST", { text }).then(
      (a) => a.html,
    );

  const versions = () =>
    call<{ revisions: (Omit<RevisionRow, "at"> & Stamped)[] }>(
      `${path}/versions`,
    ).then((a) =>
      a.revisions.map(
        (r): RevisionRow => ({
          revision: r.revision,
          author: r.author,
          bytes: r.bytes,
          at: stampOf(r) ?? "",
        }),
      ),
    );

  const version = (n: number) =>
    call<W>(`${path}/versions/${n}`).then(answerOf);

  function clear(): void {
    batch(() => {
      doc.value = null;
      error.value = null;
      code.value = null;
    });
  }

  return {
    doc,
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
