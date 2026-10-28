// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// one row per article and instrument, so each keeps its ticker's sentiment;
// news_walks holds Massive's cursor, so ties at a page edge are never skipped
export const m0008: Migration = {
  id: "0008-news",
  up(db) {
    db.exec(`
      create table news (
        instrument text not null references instruments (id),
        id text not null check (length(id) between 1 and 200),
        published_at integer not null,
        title text not null,
        url text not null,
        publisher text,
        sentiment text check (sentiment in ('positive', 'neutral', 'negative')),
        reasoning text,
        truncated integer not null default 0 check (truncated in (0, 1)),
        fetched_at integer not null,
        primary key (instrument, id),
        check (sentiment is not null or reasoning is null)
      ) strict, without rowid;

      create index news_by_instrument on news (instrument, published_at);
      create index news_by_published on news (published_at);

      create table news_walks (
        instrument text not null references instruments (id),
        walk text not null check (walk in ('top', 'history')),
        -- null starts the walk again from the newest article
        cursor text,
        -- the top walk's floor; the history's is always 30 days back
        after integer,
        primary key (instrument, walk),
        check (walk = 'history' or after is not null)
      ) strict, without rowid;
    `);
  },
};
