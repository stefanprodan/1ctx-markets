// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// cascade, so a favourite never blocks deleting an instrument
export const m0017: Migration = {
  id: "0017-dashboard",
  up(db) {
    db.exec(`
      create table dashboards (
        owner text primary key,
        revision integer not null,
        updated_at integer not null
      ) strict;
      create table dashboard_sections (
        owner text not null references dashboards(owner) on delete cascade,
        position integer not null,
        name text not null,
        view text not null check (view in ('cards', 'table')),
        primary key (owner, position)
      ) strict;
      create table dashboard_items (
        owner text not null,
        section integer not null,
        position integer not null,
        instrument text not null references instruments(id) on delete cascade,
        primary key (owner, section, position),
        foreign key (owner, section)
          references dashboard_sections(owner, position) on delete cascade
      ) strict;
      create index dashboard_items_by_instrument on dashboard_items (instrument);
    `);
  },
};
