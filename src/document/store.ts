// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// What the profile and the analysis share, so the two never drift; a save
// runs in its caller's one write, so two that read one revision never land.

import { type Failure, PAGE_BYTES, sentBytes } from "../operations/answer.ts";
import { ArgError } from "../operations/args.ts";
import type { Who } from "../operations/who.ts";
import type { Db } from "../storage/db/index.ts";
import { applyEdits, type Edit } from "./edit.ts";
import type { Revision } from "./read.ts";

// UTF-8 bytes, about three times a full profile, so a read is one answer
export const MAX_DOCUMENT_BYTES = 24 * 1024;
export const KEPT_REVISIONS = 100;

export type RevisionInfo = Omit<Revision, "text">;

export const infoOf = ({
  revision,
  bytes,
  author,
  createdAt,
}: Revision): RevisionInfo => ({ revision, bytes, author, createdAt });

// 1ctx's textFromString(): the text as an editor saves it
export function documentText(value: string): string {
  if (!value.isWellFormed() || value.includes("\u0000")) {
    throw new ArgError("text must be well-formed UTF-8 with no NUL");
  }
  return value.startsWith("\ufeff") ? value.slice(1) : value;
}

export type Kind = {
  // the document's name in a refusal
  noun: string;
  // what belongs elsewhere, said with a size refusal
  notHere: string;
  read: (r: Revision) => string;
  // bytes the read adds beside the text and header, left room for
  reserve: number;
};

// the read answer is what must fit, since JSON escaping grows short lines,
// quotes and control characters past the byte cap's promise
export function checked(kind: Kind, next: Revision): void {
  if (next.text.trim() === "") {
    throw new ArgError(
      `text is empty; the ${kind.noun} is rewritten, never blanked`,
    );
  }
  if (next.bytes > MAX_DOCUMENT_BYTES) {
    throw new ArgError(
      `the ${kind.noun} would be ${next.bytes} bytes, over ${MAX_DOCUMENT_BYTES} (24 KiB); ${kind.notHere}`,
    );
  }
  const sent = sentBytes(kind.read(next)) + kind.reserve;
  if (sent > PAGE_BYTES) {
    throw new ArgError(
      `the ${kind.noun}'s read answer would be ${sent} bytes as sent, over one ${PAGE_BYTES / 1024} KiB page: its short lines, quotes or control characters grow when escaped; ${kind.notHere}`,
    );
  }
}

export type Save =
  | { action: "replace"; revision: number | null; text: string }
  | { action: "edit"; revision: number; edits: Edit[] };

export type Saved = { saved: RevisionInfo; unchanged: boolean };

export const conflict = (noun: string, live: number | null): Failure =>
  live === null
    ? {
        error: "conflict",
        message: `there is no ${noun} yet; replace without a revision makes one`,
        revision: null,
      }
    : {
        error: "conflict",
        message: `${noun} is at revision ${live}`,
        revision: live,
      };

// one document's rows: the column and value that key them in their table
export type Rows = {
  table: string;
  column: string;
  value: string;
  live: (db: Db) => Revision | null;
  insert: (db: Db, next: Revision) => void;
};

// called inside the caller's write, after its recheck()
export function saveIn(
  db: Db,
  kind: Kind,
  rows: Rows,
  save: Save,
  author: string,
  now: number,
): Saved | Failure {
  const live = rows.live(db);
  // only the first replace names no revision
  const stale =
    save.revision === null
      ? live !== null
      : live === null || live.revision !== save.revision;
  if (stale) return conflict(kind.noun, live?.revision ?? null);
  const text = documentText(
    save.action === "edit" ? applyEdits(live!.text, save.edits) : save.text,
  );
  // an unchanged save never uses one of the kept revisions
  if (live !== null && text === live.text) {
    return { saved: infoOf(live), unchanged: true };
  }
  const next: Revision = {
    revision: (live?.revision ?? 0) + 1,
    text,
    bytes: Buffer.byteLength(text),
    author,
    createdAt: now,
  };
  checked(kind, next);
  rows.insert(db, next);
  evict(db, rows, next.revision);
  return { saved: infoOf(next), unchanged: false };
}

// the live revision is the highest, so it is never evicted
export function evict(
  db: Db,
  rows: Pick<Rows, "table" | "column"> & { value: string | number },
  live: number,
): void {
  db.query(
    `delete from ${rows.table} where ${rows.column} = ? and revision <= ?`,
  ).run(rows.value, live - KEPT_REVISIONS);
}

// the person and the key, so a revision says whose agent wrote it
export function authorOf(db: Db, who: Who): string {
  if (who.credential.kind !== "key") return who.name;
  const person = db
    .query<{ name: string }, [string]>("select name from users where id = ?")
    .get(who.user)?.name;
  return person === undefined ? who.name : `${person} (${who.name})`;
}
