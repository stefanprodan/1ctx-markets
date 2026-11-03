// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A person lets chosen people see all their portfolios, read only, in the
// web UI alone: an agent reads another's portfolios only with a key they
// made, so a key neither shares nor reads a share.

import { ArgError } from "../operations/args.ts";
import type { Markets } from "../operations/markets.ts";
import type { Who } from "../operations/who.ts";
import { recheck } from "../server/caller.ts";
import type { Db } from "../storage/db/index.ts";
import { json, problem } from "./http.ts";

const ID = /^[a-z0-9]{1,40}$/;

export const canView = (db: Db, owner: string, viewer: string): boolean =>
  db
    .query("select 1 from portfolio_viewers where owner = ? and viewer = ?")
    .get(owner, viewer) !== null;

const webOnly = () =>
  problem("forbidden", "sharing is set and read in the web UI only");

// the person whose portfolios a read answers: the caller's own, or with
// owner, one who shares with the caller. Anyone else answers as missing,
// so an id never tells whether its person exists
export function readOwner(db: Db, url: URL, who: Who): string | Response {
  const asked = url.searchParams.getAll("owner");
  if (asked.length === 0) return who.user;
  if (asked.length > 1) throw new ArgError('"owner" must be given once');
  url.searchParams.delete("owner");
  if (who.credential.kind !== "login") return webOnly();
  const owner = asked[0]!;
  if (owner === who.user || canView(db, owner, who.user)) return owner;
  return problem("not_found", "no portfolios shared with you by this person");
}

type Person = { id: string; name: string; shared: number };

function answer(db: Db, user: string): Response {
  const people = db
    .query<Person, [string, string]>(
      `select u.id, u.name, exists (select 1 from portfolio_viewers v
         where v.owner = ?1 and v.viewer = u.id) as shared
       from users u where u.id != ?2 order by u.name collate nocase, u.id`,
    )
    .all(user, user);
  const sharers = db
    .query<{ id: string; name: string }, [string]>(
      `select u.id, u.name from portfolio_viewers v
       join users u on u.id = v.owner
       where v.viewer = ? order by u.name collate nocase, u.id`,
    )
    .all(user);
  return json({
    people: people.map((p) => ({ id: p.id, name: p.name, shared: !!p.shared })),
    sharers,
  });
}

export function sharingAnswer(m: Markets, who: Who): Response {
  if (who.credential.kind !== "login") return webOnly();
  return answer(m.db, who.user);
}

class NoPerson extends Error {}

// idempotent both ways: the answer is the whole list after it
export async function setSharing(
  m: Markets,
  who: Who,
  raw: string,
  on: boolean,
): Promise<Response> {
  if (who.credential.kind !== "login") return webOnly();
  if (raw === who.user) {
    throw new ArgError("your portfolios are yours to see already");
  }
  if (!ID.test(raw)) return problem("not_found", "no such user");
  try {
    await m.writer.write((db) => {
      recheck(db);
      if (db.query("select 1 from users where id = ?").get(raw) === null) {
        throw new NoPerson();
      }
      if (on) {
        db.query(
          `insert into portfolio_viewers (owner, viewer, created_at)
           values (?, ?, ?) on conflict do nothing`,
        ).run(who.user, raw, m.clock.now());
      } else {
        db.query(
          "delete from portfolio_viewers where owner = ? and viewer = ?",
        ).run(who.user, raw);
      }
    });
  } catch (error) {
    if (error instanceof NoPerson) return problem("not_found", "no such user");
    throw error;
  }
  m.log.info(on ? "portfolios shared" : "portfolios unshared", {
    owner: who.user,
    viewer: raw,
  });
  return answer(m.db, who.user);
}
