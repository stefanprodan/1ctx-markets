// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// Massive's articles, one row per article and instrument, so each keeps
// that ticker's own sentiment, null when Massive gave it none. Kept 30
// days by published time. news_backfill holds, per instrument, the time
// below which its last 30 days are not yet complete, so a first fetch
// or a walk cut short continues on the next runs.
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
        fetched_at integer not null,
        primary key (instrument, id),
        check (sentiment is not null or reasoning is null)
      ) strict, without rowid;

      create index news_by_instrument on news (instrument, published_at);
      create index news_by_published on news (published_at);

      create table news_backfill (
        instrument text primary key references instruments (id),
        before integer not null
      ) strict;
    `);
  },
};
