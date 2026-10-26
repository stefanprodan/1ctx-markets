// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wiring main.ts starts, kept apart so a test runs the same with a
// fake clock, a captured log and a fake fetch.

import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { type Finnhub, finnhub } from "./finnhub/client.ts";
import { type FinnhubJobs, finnhubJobs } from "./finnhub/jobs.ts";
import { type Hooks, NO_HOOKS, pruneResearch } from "./finnhub/store.ts";
import { type Fred, fred } from "./fred/client.ts";
import { type FredJobs, fredJobs } from "./fred/jobs.ts";
import { router, serve } from "./http.ts";
import { errorFields, type LogFactory, type LogFields } from "./log.ts";
import { type Massive, massive } from "./massive/client.ts";
import { type MassiveJobs, massiveJobs } from "./massive/jobs.ts";
import { pruneNews } from "./massive/store.ts";
import { mcpHandler } from "./mcp.ts";
import { failInterrupted, pruneRuns } from "./runs.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { type Fetch, queue } from "./source.ts";
import { quotesHandler } from "./tools/http.ts";
import { researchHandler } from "./tools/research.ts";
import { type Markets, markets } from "./tools/targets.ts";
import { TRACK_DAYS, trackedIds } from "./tracking.ts";
import { type Writer, writer } from "./writer.ts";
import { type Yahoo, yahoo } from "./yahoo/client.ts";
import { type YahooJobs, yahooJobs } from "./yahoo/jobs.ts";

// Yahoo calls in flight at once, jobs and tools together
const YAHOO_CONCURRENCY = 2;

export type AppOptions = {
  hostname: string;
  port: number;
  bearer: string;
  clock: Clock;
  log: LogFactory;
  version: string;
  // the one writable connection; main closes it after stop()
  db: Db;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays?: number;
  // FRED is on while its key file holds one
  fredKey?: string | null;
  // Finnhub is on while its key file holds one
  finnhubKey?: string | null;
  // Massive is on while its key file holds one
  massiveKey?: string | null;
  // what rules answer the research jobs, none until they exist
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
  // queued first, so no job's run is taken for one a crash left running;
  // pruned here too, since a server restarted daily never reaches the
  // daily turn
  void write
    .write((db) => {
      failInterrupted(db, clock.now());
      pruneRuns(db, clock.now());
    })
    .catch((error: unknown) => {
      options
        .log("markets")
        .error("startup cleanup failed", errorFields(error));
    });
  const yahooQueue = queue(clock, YAHOO_CONCURRENCY);
  const client = yahoo({ clock, fetch: options.fetch, queue: yahooQueue });
  const sync = yahooJobs({
    ctx: { db, clock, yahoo: client, writer: write },
    quoteEveryMs: options.quoteEveryMs,
    log: options.log("yahoo"),
    trackMs,
  });

  const fredKey = options.fredKey ?? null;
  const fredClient =
    fredKey === null
      ? null
      : fred({ clock, key: fredKey, fetch: options.fetch });
  const fredSync =
    fredClient === null
      ? null
      : fredJobs({
          ctx: { db, clock, writer: write, fred: fredClient },
          log: options.log("fred"),
          trackMs,
        });

  const hooks = options.hooks ?? NO_HOOKS;
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
    finnhub: finnhubClient,
    massive: massiveClient,
    hooks,
    log: options.log("tools"),
    trackMs,
    quoteEveryMs: options.quoteEveryMs,
  });
  const mcp = mcpHandler(options.version, options.log("mcp"), reads);
  const server = serve({
    hostname: options.hostname,
    port: options.port,
    handle: router({
      bearer: options.bearer,
      mcp,
      quotes: quotesHandler(reads),
      research: researchHandler(reads),
      clock,
      log: options.log("http"),
    }),
  });
  const jobs = scheduler(clock, options.log("scheduler"));
  sync.schedule(jobs);
  fredSync?.schedule(jobs);
  finnhubSync?.schedule(jobs);
  massiveSync?.schedule(jobs);
  jobs.every("retention", DAY_MS, async () => {
    await write.write((db) => {
      pruneRuns(db, clock.now());
      pruneResearch(db, clock.now(), hooks.waited(db, clock.now()));
      pruneNews(db, clock.now(), trackedIds(db, clock.now(), trackMs));
    });
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
    markets: reads,
    sources: {
      yahoo: "on",
      fred: fredKey === null ? "off (no key)" : "on (key file)",
      finnhub: finnhubKey === null ? "off (no key)" : "on (key file)",
      massive: massiveKey === null ? "off (no key)" : "on (key file)",
    },
    async stop() {
      // no new run or request starts, no job waits out a back-off, every
      // run settles, then the queued writes drain before main closes the
      // database
      const settled = jobs.stop();
      yahooQueue.close();
      fredClient?.close();
      finnhubClient?.close();
      massiveClient?.close();
      await server.stop();
      await settled;
      await mcp.close();
      await write.close();
    },
  };
}
