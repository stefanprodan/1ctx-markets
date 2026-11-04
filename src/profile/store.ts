// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's profile: one Markdown document per person, on the rules every
// document shares (src/document/).

import type { Revision } from "../document/read.ts";
import {
  type Kind,
  type RevisionInfo,
  type Save,
  type Saved,
  saveIn,
} from "../document/store.ts";
import type { Failure } from "../operations/answer.ts";
import { recheck } from "../server/caller.ts";
import type { Db } from "../storage/db/index.ts";
import type { Writer } from "../storage/writer.ts";
import { profileRead } from "./read.ts";

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
    .map((raw) => {
      const { text: _, ...info } = rowOf({ ...raw, text: "" });
      return info;
    });

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

const PROFILE: Kind = {
  noun: "profile",
  notHere:
    "the profile holds goals, risk, trading style, rules and analysis defaults; trades, holdings, cash, scorecards, per-symbol calls and dated logs belong elsewhere",
  read: profileRead,
  reserve: 0,
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
    return saveIn(
      db,
      PROFILE,
      {
        table: "profile_versions",
        column: "owner",
        value: owner,
        live: (db) => readProfile(db, owner),
        insert: (db, next) => {
          db.query(
            `insert into profile_versions (owner, revision, text, bytes,
               author, created_at)
             values (?, ?, ?, ?, ?, ?)`,
          ).run(
            owner,
            next.revision,
            next.text,
            next.bytes,
            next.author,
            next.createdAt,
          );
        },
      },
      save,
      author,
      now,
    );
  });
}
