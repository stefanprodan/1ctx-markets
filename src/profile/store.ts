// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's profile: one Markdown document, stored as sent and never
// parsed, every save a revision. A write checks, saves and evicts in one
// closure, so two writers that read the same revision never both land.

import {
  type Failure,
  fits,
  PAGE_BYTES,
  sentBytes,
} from "../operations/answer.ts";
import { ArgError } from "../operations/args.ts";
import { recheck } from "../server/caller.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { applyEdits, type ProfileEdit } from "./edit.ts";
import { profileRead, type Revision } from "./read.ts";

// UTF-8 bytes, about three times a full profile, so a read is one answer
export const MAX_PROFILE_BYTES = 24 * 1024;
export const KEPT_REVISIONS = 100;

export type RevisionInfo = Omit<Revision, "text">;

type Raw = {
  revision: number;
  text: string;
  bytes: number;
  author: string;
  created_at: number;
};

const rowOf = (raw: Raw): Revision => ({
  revision: raw.revision,
  text: raw.text,
  bytes: raw.bytes,
  author: raw.author,
  createdAt: raw.created_at,
});

const infoOf = ({ text: _, ...info }: Revision): RevisionInfo => info;

export function readProfile(db: Db, owner: string): Revision | null {
  const raw = db
    .query<Raw, [string]>(
      `select revision, text, bytes, author, created_at
       from profile_versions where owner = ?
       order by revision desc limit 1`,
    )
    .get(owner);
  return raw === null ? null : rowOf(raw);
}

// newest first
export const profileVersions = (db: Db, owner: string): RevisionInfo[] =>
  db
    .query<Omit<Raw, "text">, [string]>(
      `select revision, bytes, author, created_at
       from profile_versions where owner = ? order by revision desc`,
    )
    .all(owner)
    .map((raw) => infoOf(rowOf({ ...raw, text: "" })));

export function profileVersion(
  db: Db,
  owner: string,
  revision: number,
): Revision | null {
  const raw = db
    .query<Raw, [string, number]>(
      `select revision, text, bytes, author, created_at
       from profile_versions where owner = ? and revision = ?`,
    )
    .get(owner, revision);
  return raw === null ? null : rowOf(raw);
}

export const liveRevision = (db: Db, owner: string): number | null =>
  db
    .query<{ r: number | null }, [string]>(
      "select max(revision) as r from profile_versions where owner = ?",
    )
    .get(owner)?.r ?? null;

// 1ctx's textFromString(): the text as an editor saves it
export function profileText(value: string): string {
  if (!value.isWellFormed() || value.includes("\u0000")) {
    throw new ArgError("text must be well-formed UTF-8 with no NUL");
  }
  return value.startsWith("\ufeff") ? value.slice(1) : value;
}

const NOT_HERE =
  "the profile holds goals, risk, trading style, rules and analysis defaults; trades, holdings, cash, scorecards, per-symbol calls and dated logs belong elsewhere";

// the read answer is what must fit, since JSON escaping grows short lines,
// quotes and control characters past the byte cap's promise
function checked(next: Revision): void {
  if (next.text.trim() === "") {
    throw new ArgError(
      "text is empty; the profile is rewritten, never blanked",
    );
  }
  if (next.bytes > MAX_PROFILE_BYTES) {
    throw new ArgError(
      `the profile would be ${next.bytes} bytes, over ${MAX_PROFILE_BYTES} (24 KiB); ${NOT_HERE}`,
    );
  }
  const read = profileRead(next);
  if (!fits(read)) {
    throw new ArgError(
      `the profile's read answer would be ${sentBytes(read)} bytes as sent, over one ${PAGE_BYTES / 1024} KiB page: its short lines, quotes or control characters grow when escaped; ${NOT_HERE}`,
    );
  }
}

export type Save =
  | { action: "replace"; revision: number | null; text: string }
  | { action: "edit"; revision: number; edits: ProfileEdit[] };

export type Saved = { saved: RevisionInfo; unchanged: boolean };

export const profileConflict = (live: number | null): Failure =>
  live === null
    ? {
        error: "conflict",
        message:
          "there is no profile yet; replace without a revision makes one",
        revision: null,
      }
    : {
        error: "conflict",
        message: `profile is at revision ${live}`,
        revision: live,
      };

export function saveProfile(
  writer: Writer,
  owner: string,
  save: Save,
  author: string,
  now: number,
): Promise<Saved | Failure> {
  return writer.write((db): Saved | Failure => {
    recheck(db);
    const live = readProfile(db, owner);
    // only the first replace names no revision
    const stale =
      save.revision === null
        ? live !== null
        : live === null || live.revision !== save.revision;
    if (stale) return profileConflict(live?.revision ?? null);
    const text = profileText(
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
    checked(next);
    db.query(
      `insert into profile_versions (owner, revision, text, bytes, author,
         created_at)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(
      owner,
      next.revision,
      next.text,
      next.bytes,
      next.author,
      next.createdAt,
    );
    // the live revision is the highest, so it is never evicted
    db.query(
      "delete from profile_versions where owner = ? and revision <= ?",
    ).run(owner, next.revision - KEPT_REVISIONS);
    return { saved: infoOf(next), unchanged: false };
  });
}
