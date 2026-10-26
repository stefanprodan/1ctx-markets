// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wiring main.ts starts, kept apart so a test runs the same with a
// fake clock, a captured log and a fake fetch.

import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { type Fred, fred } from "./fred/client.ts";
import { type FredJobs, fredJobs } from "./fred/jobs.ts";
import { router, serve } from "./http.ts";
import { errorFields, type LogFactory, type LogFields } from "./log.ts";
import { mcpHandler } from "./mcp.ts";
import { failInterrupted, pruneRuns } from "./runs.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { type Fetch, queue } from "./source.ts";
import { quotesHandler } from "./tools/http.ts";
import { type Markets, markets } from "./tools/targets.ts";
import { TRACK_DAYS } from "./tracking.ts";
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

  const reads = markets({
    db,
    clock,
    writer: write,
    yahoo: client,
    fred: fredClient,
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
      clock,
      log: options.log("http"),
    }),
  });
  const jobs = scheduler(clock, options.log("scheduler"));
  sync.schedule(jobs);
  fredSync?.schedule(jobs);
  jobs.every("retention", DAY_MS, async () => {
    await write.write((db) => pruneRuns(db, clock.now()));
  });
  return {
    server,
    jobs,
    writer: write,
    yahoo: client,
    yahooJobs: sync,
    fred: fredClient,
    fredJobs: fredSync,
    markets: reads,
    sources: {
      yahoo: "on",
      fred: fredKey === null ? "off (no key)" : "on (key file)",
    },
    async stop() {
      // no new run or request starts, no job waits out a back-off, every
      // run settles, then the queued writes drain before main closes the
      // database
      const settled = jobs.stop();
      yahooQueue.close();
      fredClient?.close();
      await server.stop();
      await settled;
      await mcp.close();
      await write.close();
    },
  };
}
