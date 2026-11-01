// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// cash rows move with their removed versions, so a restore still finds its chain
export const m0032: Migration = {
  id: "0032-cash-portfolio",
  up(db) {
    db.exec(`
      alter table portfolios add column cash integer not null default 0
        check (cash in (0, 1));
      create unique index portfolios_one_cash on portfolios (cash)
        where cash = 1;
    `);
    const named = db
      .query<{ id: number }, []>(
        "select id from portfolios where name = 'Cash' collate nocase",
      )
      .get();
    let cash: number | null = null;
    if (named !== null) {
      const other = db
        .query<{ n: number }, [number, number]>(
          `select (select count(*) from trades where portfolio = ?1)
            + (select count(*) from positions where portfolio = ?2
              and kind <> 'cash') as n`,
        )
        .get(named.id, named.id)!.n;
      if (other === 0) {
        // its name is fixed, so a lower-case one is set right
        db.query(
          "update portfolios set cash = 1, name = 'Cash' where id = ?",
        ).run(named.id);
        cash = named.id;
      } else {
        const taken = (name: string) =>
          db
            .query<{ id: number }, [string]>(
              "select id from portfolios where name = ? collate nocase",
            )
            .get(name) !== null;
        let name = "Cash (before)";
        for (let n = 2; taken(name); n++) name = `Cash (before ${n})`;
        db.query("update portfolios set name = ? where id = ?").run(
          name,
          named.id,
        );
      }
    }
    const shown =
      db
        .query<{ c: string | null }, []>(
          "select display_currency as c from portfolio_settings where owner = 'admin'",
        )
        .get()?.c ?? null;
    const stray = db
      .query<{ n: number }, []>(
        "select count(*) as n from positions where kind = 'cash'",
      )
      .get()!.n;
    // made with the display currency, or now for the cash already kept
    if (cash === null && (shown !== null || stray > 0 || named !== null)) {
      // no clock here: the settings' or the newest portfolio's time
      const at =
        db
          .query<{ t: number | null }, []>(
            `select coalesce(
               (select updated_at from portfolio_settings where owner = 'admin'),
               (select max(created_at) from portfolios), 0) as t`,
          )
          .get()?.t ?? 0;
      cash = Number(
        db
          .query(
            "insert into portfolios (name, cash, created_at) values ('Cash', 1, ?)",
          )
          .run(at).lastInsertRowid,
      );
    }
    if (cash === null) return;
    const moving = db
      .query<
        {
          id: number;
          name: string;
          broker: number | null;
          live: number;
          from: string;
        },
        [number]
      >(
        `select p.id, p.name, p.broker, p.removed_at is null as live,
           f.name as "from"
         from positions p join portfolios f on f.id = p.portfolio
         where p.kind = 'cash' and p.portfolio <> ? order by p.id`,
      )
      .all(cash);
    const liveAt = (name: string, broker: number | null) =>
      db
        .query<{ id: number }, [number, string, number | null]>(
          `select id from positions where portfolio = ? and kind = 'cash'
           and name = ? collate nocase and broker is ?
           and removed_at is null`,
        )
        .get(cash!, name, broker) !== null;
    // every row of a chain, up and down, so its removed rows match it
    const chain = (id: number) =>
      db
        .query<{ id: number }, [number]>(
          `with recursive up(id, replaces) as (
             select id, replaces from positions where id = ?
             union select p.id, p.replaces from positions p
               join up on p.id = up.replaces
           ),
           down(id) as (
             select id from up where replaces is null
             union select p.id from positions p
               join down on p.replaces = down.id
           )
           select id from down`,
        )
        .all(id)
        .map((x) => x.id);
    const tailed = (name: string, tail: string) =>
      `${name.slice(0, 80 - tail.length)}${tail}`;
    for (const r of moving) {
      if (r.live !== 1) continue;
      // a free name, its chain's rows renamed alike so a restore matches
      // the portfolio's part capped, so the row keeps part of its name
      const from = r.from.slice(0, 30);
      let tail = "";
      for (let n = 1; liveAt(tailed(r.name, tail), r.broker); n++) {
        tail = n === 1 ? ` (${from})` : ` (${from} ${n})`;
      }
      for (const id of chain(r.id)) {
        const own = db
          .query<{ name: string }, [number]>(
            "select name from positions where id = ?",
          )
          .get(id)!.name;
        db.query(
          "update positions set portfolio = ?, name = ? where id = ?",
        ).run(cash, tailed(own, tail), id);
      }
    }
    // removed rows of no live chain keep their names
    db.query(
      "update positions set portfolio = ? where kind = 'cash' and portfolio <> ?",
    ).run(cash, cash);
  },
};
