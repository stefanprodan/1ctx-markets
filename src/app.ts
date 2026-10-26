// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wiring main.ts starts, kept apart so a test runs the same with a
// fake clock, a captured log and a fake fetch.

import { adminHandler, type SourceState } from "./admin/http.ts";
import { type Bvb, bvb } from "./bvb/client.ts";
import { type BvbJobs, bvbJobs } from "./bvb/jobs.ts";
import {
  priceSources,
  type SourceSwitch,
  sourceSwitch,
  writeSources,
} from "./bvb/switch.ts";
import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { type Finnhub, finnhub } from "./finnhub/client.ts";
import { type FinnhubJobs, finnhubJobs } from "./finnhub/jobs.ts";
import { type Hooks, pruneResearch } from "./finnhub/store.ts";
import { type Fred, fred } from "./fred/client.ts";
import { type FredJobs, fredJobs } from "./fred/jobs.ts";
import { router, serve } from "./http.ts";
import { errorFields, type LogFactory, type LogFields } from "./log.ts";
import { type Massive, massive } from "./massive/client.ts";
import { type MassiveJobs, massiveJobs } from "./massive/jobs.ts";
import { pruneNews } from "./massive/store.ts";
import { mcpHandler } from "./mcp.ts";
import { ruleEngine } from "./rules/evaluate.ts";
import { pruneAlerts } from "./rules/store.ts";
import { failInterrupted, pruneRuns } from "./runs.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { type Backoff, type Fetch, queue } from "./source.ts";
import { alertsHandler } from "./tools/alerts.ts";
import { quotesHandler } from "./tools/http.ts";
import { researchHandler } from "./tools/research.ts";
import { type Markets, markets } from "./tools/targets.ts";
import { TRACK_DAYS, trackedIds } from "./tracking.ts";
import { type Writer, writer } from "./writer.ts";
import { type Yahoo, yahoo } from "./yahoo/client.ts";
import { type YahooJobs, yahooJobs } from "./yahoo/jobs.ts";

// Yahoo calls in flight at once, jobs and tools together
const YAHOO_CONCURRENCY = 2;

type Paced = { backoff(): Backoff | null };

export type AppOptions = {
  hostname: string;
  port: number;
  bearer: string;
  // /admin/* answers only while there is one
  adminKey?: string | null;
  clock: Clock;
  log: LogFactory;
  version: string;
  // the one writable connection; main closes it after stop()
  db: Db;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays?: number;
  // a source is on while its key file holds a key
  fredKey?: string | null;
  finnhubKey?: string | null;
  massiveKey?: string | null;
  // the Bucharest exchange's feed, on with --source bvb
  bvb?: boolean;
  // what the research jobs ask of the rules, the rules' own by default
  hooks?: Hooks;
  // tests answer every source call from recordings
  fetch?: Fetch;
};

export type App = {
  server: Bun.Server<undefined>;
  jobs: Scheduler;
  writer: Writer;
  // the one client and queue jobs and tools share
  yahoo: Yahoo;
  yahooJobs: YahooJobs;
  // null while the source is off
  fred: Fred | null;
  fredJobs: FredJobs | null;
  finnhub: Finnhub | null;
  finnhubJobs: FinnhubJobs | null;
  massive: Massive | null;
  massiveJobs: MassiveJobs | null;
  bvb: Bvb | null;
  bvbJobs: BvbJobs | null;
  // moves the Bucharest market between Yahoo and the feed
  sourceSwitch: SourceSwitch;
  // what the tools and GET /quotes read through
  markets: Markets;
  // one field per source with its state and why, for the start log
  sources: LogFields;
  stop(): Promise<void>;
};

export function start(options: AppOptions): App {
  const { clock, db } = options;
  const trackMs = (options.trackDays ?? TRACK_DAYS) * DAY_MS;
  const write = writer(db);
  const rules = ruleEngine({
    quoteEveryMs: options.quoteEveryMs,
    log: options.log("rules"),
  });
  const hooks = options.hooks ?? rules.finnhub;
  // every table's retention, at start and once a day
  const prune = (db: Db) => {
    const now = clock.now();
    pruneRuns(db, now);
    pruneResearch(db, now, hooks.waited(db, now));
    pruneNews(db, now, trackedIds(db, now, trackMs));
    pruneAlerts(db, now);
  };
  // first, so no run is taken for a crashed one; prunes too, since a
  // server restarted daily never reaches the daily turn
  void write
    .write((db) => {
      failInterrupted(db, clock.now());
      prune(db);
    })
    .catch((error: unknown) => {
      options
        .log("markets")
        .error("startup cleanup failed", errorFields(error));
    });
  const yahooQueue = queue(clock, YAHOO_CONCURRENCY);
  const client = yahoo({ clock, fetch: options.fetch, queue: yahooQueue });
  const yahooCtx = { db, clock, yahoo: client, writer: write, rules };
  const sync = yahooJobs({
    ctx: yahooCtx,
    quoteEveryMs: options.quoteEveryMs,
    log: options.log("yahoo"),
    trackMs,
  });

  const bvbClient =
    options.bvb === true ? bvb({ clock, fetch: options.fetch }) : null;
  const bvbCtx =
    bvbClient === null
      ? null
      : { db, clock, bvb: bvbClient, writer: write, rules };
  const bvbSync =
    bvbCtx === null
      ? null
      : bvbJobs({
          ctx: bvbCtx,
          quoteEveryMs: options.quoteEveryMs,
          log: options.log("bvb"),
          trackMs,
        });
  const switcher = sourceSwitch({
    yahoo: yahooCtx,
    bvb: bvbCtx,
    log: options.log("sources"),
  });
  // after the startup write, so its interrupted runs are failed first
  if (switcher.needed()) void switcher.run();
  else {
    void write
      .write((db) =>
        writeSources(db, priceSources(bvbClient !== null), clock.now()),
      )
      .catch((error: unknown) => {
        options
          .log("sources")
          .error("sources write failed", errorFields(error));
      });
  }

  // the exchange's lists at once, so a new symbol skips its search
  void bvbSync?.warm();

  const fredKey = options.fredKey ?? null;
  const fredClient =
    fredKey === null
      ? null
      : fred({ clock, key: fredKey, fetch: options.fetch });
  const fredSync =
    fredClient === null
      ? null
      : fredJobs({
          ctx: { db, clock, writer: write, fred: fredClient, rules },
          log: options.log("fred"),
          trackMs,
        });

  const finnhubKey = options.finnhubKey ?? null;
  const finnhubClient =
    finnhubKey === null
      ? null
      : finnhub({ clock, key: finnhubKey, fetch: options.fetch });
  const finnhubSync =
    finnhubClient === null
      ? null
      : finnhubJobs({
          ctx: { db, clock, writer: write, finnhub: finnhubClient },
          log: options.log("finnhub"),
          trackMs,
          hooks,
        });

  const massiveKey = options.massiveKey ?? null;
  const massiveClient =
    massiveKey === null
      ? null
      : massive({ clock, key: massiveKey, fetch: options.fetch });
  const massiveSync =
    massiveClient === null
      ? null
      : massiveJobs({
          ctx: { db, clock, writer: write, massive: massiveClient },
          log: options.log("massive"),
          trackMs,
        });

  const reads = markets({
    db,
    clock,
    writer: write,
    yahoo: client,
    fred: fredClient,
    bvb: bvbClient,
    finnhub: finnhubClient,
    massive: massiveClient,
    hooks,
    rules,
    log: options.log("tools"),
    trackMs,
    quoteEveryMs: options.quoteEveryMs,
  });
  const mcp = mcpHandler(options.version, options.log("mcp"), reads);
  const keyed = (name: string, key: string | null, client: Paced | null) => ({
    name,
    on: client !== null,
    why: key === null ? "no key" : "key file",
    backoff: () => client?.backoff() ?? null,
  });
  const states: SourceState[] = [
    {
      name: "yahoo",
      on: true,
      why: "always",
      backoff: () => yahooQueue.backoff(),
    },
    keyed("fred", fredKey, fredClient),
    keyed("finnhub", finnhubKey, finnhubClient),
    keyed("massive", massiveKey, massiveClient),
    {
      name: "bvb",
      on: bvbClient !== null,
      why: bvbClient === null ? "no flag" : "flag",
      backoff: () => bvbClient?.backoff() ?? null,
    },
  ];
  const adminKey = options.adminKey ?? null;
  const server = serve({
    hostname: options.hostname,
    port: options.port,
    handle: router({
      bearer: options.bearer,
      mcp,
      quotes: quotesHandler(reads),
      research: researchHandler(reads),
      alerts: alertsHandler({ db, log: options.log("alerts") }),
      admin:
        adminKey === null
          ? undefined
          : {
              key: adminKey,
              handle: adminHandler({
                m: { ...reads, log: options.log("admin") },
                version: options.version,
                sources: states,
              }),
            },
      clock,
      log: options.log("http"),
    }),
  });
  const jobs = scheduler(clock, options.log("scheduler"));
  sync.schedule(jobs);
  fredSync?.schedule(jobs);
  finnhubSync?.schedule(jobs);
  massiveSync?.schedule(jobs);
  bvbSync?.schedule(jobs);
  switcher.schedule(jobs);
  jobs.every("retention", DAY_MS, async () => {
    await write.write(prune);
  });
  return {
    server,
    jobs,
    writer: write,
    yahoo: client,
    yahooJobs: sync,
    fred: fredClient,
    fredJobs: fredSync,
    finnhub: finnhubClient,
    finnhubJobs: finnhubSync,
    massive: massiveClient,
    massiveJobs: massiveSync,
    bvb: bvbClient,
    bvbJobs: bvbSync,
    sourceSwitch: switcher,
    markets: reads,
    sources: Object.fromEntries(
      states.map((s) => [
        s.name,
        s.name === "yahoo" ? "on" : `${s.on ? "on" : "off"} (${s.why})`,
      ]),
    ),
    async stop() {
      // no new run or request starts, no job waits out a back-off, every
      // run settles, then the queued writes drain before main closes the
      // database
      const settled = jobs.stop();
      yahooQueue.close();
      fredClient?.close();
      finnhubClient?.close();
      massiveClient?.close();
      bvbClient?.close();
      await server.stop();
      await settled;
      await switcher.settled();
      await mcp.close();
      await write.close();
    },
  };
}
