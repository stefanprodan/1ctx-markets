// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wiring main.ts starts, kept apart so a test runs the same with a
// fake clock, a captured log and a fake fetch.

import { type Clock, DAY_MS } from "./clock.ts";
import type { Db } from "./db/index.ts";
import { router, serve } from "./http.ts";
import { errorFields, type LogFactory } from "./log.ts";
import { mcpHandler } from "./mcp.ts";
import { failInterrupted, pruneRuns } from "./runs.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";
import { type Fetch, queue } from "./source.ts";
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
  stop(): Promise<void>;
};

export function start(options: AppOptions): App {
  const { clock, db } = options;
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
  });

  const mcp = mcpHandler(options.version, options.log("mcp"));
  const server = serve({
    hostname: options.hostname,
    port: options.port,
    handle: router({
      bearer: options.bearer,
      mcp,
      clock,
      log: options.log("http"),
    }),
  });
  const jobs = scheduler(clock, options.log("scheduler"));
  sync.schedule(jobs);
  jobs.every("retention", DAY_MS, async () => {
    await write.write((db) => pruneRuns(db, clock.now()));
  });
  return {
    server,
    jobs,
    writer: write,
    yahoo: client,
    yahooJobs: sync,
    async stop() {
      // no new run or request starts, no job waits out a back-off, every
      // run settles, then the queued writes drain before main closes the
      // database
      const settled = jobs.stop();
      yahooQueue.close();
      await server.stop();
      await settled;
      await mcp.close();
      await write.close();
    },
  };
}
