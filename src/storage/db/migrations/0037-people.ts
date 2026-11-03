// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// people sign in by an emailed link: a login and a link hold only the
// sha256 of their token, a link's code only its sha256 too. A key's name
// becomes unique per person, a rebuild nothing points at, so foreign keys
// stay on.
export const m0037: Migration = {
  id: "0037-people",
  up(db) {
    db.exec(`
      create table logins (
        id text primary key,
        user_id text not null references users (id) on delete cascade,
        -- the operator's login by user-admin.key: the sha256 of that key,
        -- so a new key ends it
        admin_digest text,
        token_hash text not null unique,
        created_at integer not null,
        last_seen_at integer not null,
        expires_at integer not null
      ) strict;
      create index logins_by_user on logins (user_id);

      create table links (
        id text primary key,
        user_id text not null references users (id) on delete cascade,
        purpose text not null check (purpose in ('invite', 'sign_in')),
        token_hash text not null unique,
        code_hash text not null,
        -- the sha256 of the asking browser's challenge; null for an
        -- invite, which no browser asked for
        challenge_hash text,
        code_tries integer not null default 0,
        -- the address it sets once used, for a person adding one
        email text check (email is null or email = lower(email)),
        created_at integer not null,
        expires_at integer not null,
        used_at integer
      ) strict;
      create index links_by_user on links (user_id);

      -- every ask that made a link, kept a day whatever its link became,
      -- so the caps count it; a removed person's stay counted. Counted per
      -- asking browser too, so a stranger's asks never use up a person's
      create table link_asks (
        id integer primary key,
        user_id text references users (id) on delete set null,
        challenge_hash text not null,
        asked_at integer not null
      ) strict;
      create index link_asks_by_time on link_asks (asked_at);
      create index link_asks_by_user on link_asks (user_id, challenge_hash, asked_at);
      create index link_asks_by_challenge on link_asks (challenge_hash, asked_at);

      -- wrong codes against a link no browser asked for (an invite),
      -- counted per trying browser, so a stranger's guesses never kill it
      create table link_misses (
        link_id text not null references links (id) on delete cascade,
        challenge_hash text not null,
        misses integer not null,
        primary key (link_id, challenge_hash)
      ) strict, without rowid;

      -- one row or none: email is on while it is saved and its key file
      -- is there; the password is that file, never a column
      create table smtp_settings (
        id integer primary key check (id = 1),
        host text not null,
        port integer not null check (port between 1 and 65535),
        security text not null check (security in ('tls', 'starttls')),
        username text,
        key_name text,
        from_address text not null,
        public_url text not null,
        updated_at integer not null,
        updated_by text not null,
        check ((username is null) = (key_name is null))
      ) strict;

      create table keys_next (
        id text primary key,
        user_id text not null references users (id),
        name text not null,
        token_hash text not null unique,
        created_at integer not null,
        expires_at integer,
        last_used_at integer,
        portfolio text not null default 'none'
          check (portfolio in ('none', 'read', 'write')),
        rules text not null default 'none'
          check (rules in ('none', 'read', 'write')),
        profile text not null default 'none'
          check (profile in ('none', 'read', 'write')),
        unique (user_id, name)
      ) strict;
      insert into keys_next (id, user_id, name, token_hash, created_at,
          expires_at, last_used_at, portfolio, rules, profile)
        select id, user_id, name, token_hash, created_at, expires_at,
          last_used_at, portfolio, rules, profile from keys;
      drop table keys;
      alter table keys_next rename to keys;
    `);
  },
};
