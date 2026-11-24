// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// a passkey is bound to the origin it was added at, port included, so
// each row keeps it beside its rp_id; an add's challenge goes with the
// login that asked, so a sign-out leaves none to answer
export const m0052: Migration = {
  id: "0052-passkeys",
  up(db) {
    db.exec(`
      create table passkeys (
        id text primary key,
        user_id text not null references users (id) on delete cascade,
        rp_id text not null,
        origin text not null,
        credential_id text not null unique,
        -- SPKI, as the browser's getPublicKey() gives it
        public_key blob not null,
        alg integer not null check (alg in (-7, -257)),
        sign_count integer not null,
        transports text not null,
        device text not null,
        -- added from an admin-key login: that login's digest, so a new key
        -- ends the passkey too
        admin_digest text,
        created_at integer not null,
        last_used_at integer
      ) strict;
      create index passkeys_by_user on passkeys (user_id);

      create table passkey_challenges (
        id text primary key,
        challenge_hash text not null unique,
        purpose text not null check (purpose in ('add', 'sign_in')),
        login_id text references logins (id) on delete cascade,
        rp_id text not null,
        origin text not null,
        expires_at integer not null,
        check ((purpose = 'add') = (login_id is not null))
      ) strict;
      create index passkey_challenges_by_expiry on passkey_challenges (expires_at);
      create index passkey_challenges_by_login on passkey_challenges (login_id);
    `);
  },
};
