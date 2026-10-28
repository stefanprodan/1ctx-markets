// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Apart from main.ts so a test runs it with a fake clock, log and fetch.

import type { HTMLBundle } from "bun";
import type { SourceState } from "./admin/http.ts";
import { alertsHandler } from "./api/alerts.ts";
import { routes } from "./api/routes.ts";
import { TRACK_DAYS, type Tracking, trackedIds } from "./market/tracking.ts";
import { type Markets, markets } from "./operations/markets.ts";
import { seed, type Tracker, tracker } from "./operations/track.ts";
import { ruleEngine } from "./rules/evaluate.ts";
import { pruneAlerts } from "./rules/store.ts";
import { type Clock, DAY_MS } from "./runtime/clock.ts";
import { errorFields, type LogFactory, type LogFields } from "./runtime/log.ts";
import { type Scheduler, scheduler } from "./runtime/scheduler.ts";
import { router, serve } from "./server/http.ts";
import { mcpHandler } from "./server/mcp.ts";
import { sessions } from "./server/session.ts";
import { type Bvb, bvb } from "./sources/bvb/client.ts";
import { type BvbJobs, bvbJobs } from "./sources/bvb/jobs.ts";
import {
  priceSources,
  type SourceSwitch,
  sourceSwitch,
  writeSources,
} from "./sources/bvb/switch.ts";
import { type Finnhub, finnhub } from "./sources/finnhub/client.ts";
import { type FinnhubJobs, finnhubJobs } from "./sources/finnhub/jobs.ts";
import { type Hooks, pruneResearch } from "./sources/finnhub/store.ts";
import { type Fred, fred } from "./sources/fred/client.ts";
import { type FredJobs, fredJobs } from "./sources/fred/jobs.ts";
import { type Massive, massive } from "./sources/massive/client.ts";
import { type MassiveJobs, massiveJobs } from "./sources/massive/jobs.ts";
import { pruneNews } from "./sources/massive/store.ts";
import { type Backoff, type Fetch, queue } from "./sources/source.ts";
import { type Yahoo, yahoo } from "./sources/yahoo/client.ts";
import { type YahooJobs, yahooJobs } from "./sources/yahoo/jobs.ts";
import type { Db } from "./storage/db/index.ts";
import { failInterrupted, pruneRuns } from "./storage/runs.ts";
import { type Writer, writer } from "./storage/writer.ts";

// Yahoo calls in flight at once, shared by jobs and tools
const YAHOO_CONCURRENCY = 2;

type Paced = { backoff(): Backoff | null };

export type AppOptions = {
  hostname: string;
  port: number;
  bearer: string;
  // /api/v1/admin/* answers only while there is one
  adminKey?: string | null;
  // the web UI's sign-in, which needs the admin key; off with --no-ui
  ui?: boolean;
  // the page served at the UI's paths while ui is on
  page?: HTMLBundle | null;
  // Bun bundles the page on request and again after an edit
  pageDev?: boolean;
  clock: Clock;
  log: LogFactory;
  version: string;
  // the one writable connection; main closes it after stop()
  db: Db;
  quoteEveryMs: number;
  // an instrument read within this many days stays tracked
  trackDays?: number;
  // --track: tracked whether read or not
  track?: readonly string[];
  // a source is on while its key file holds a key
  fredKey?: string | null;
  finnhubKey?: string | null;
  massiveKey?: string | null;
  // the Bucharest exchange's feed, on with --source bvb
  bvb?: boolean;
  // what the research jobs ask of the rules, the rules' own by default
  hooks?: Hooks;
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
  markets: Markets;
  tracker: Tracker;
  sources: LogFields;
  stop(): Promise<void>;
};

export function start(options: AppOptions): App {
  const { clock, db } = options;
  const flagged = new Set<string>();
  const owed = new Set<string>();
  const tracking: Tracking = {
    readMs: (options.trackDays ?? TRACK_DAYS) * DAY_MS,
    flagged,
    owed,
  };
  // before the startup write, whose prune reads what is tracked
  const trackStates = seed({
    db,
    values: options.track ?? [],
    on: { bvb: options.bvb === true, fred: (options.fredKey ?? null) !== null },
    flagged,
    owed,
    now: clock.now(),
  });
  const write = writer(db);
  const rules = ruleEngine({
    quoteEveryMs: options.quoteEveryMs,
    log: options.log("rules"),
  });
  const hooks = options.hooks ?? rules.finnhub;
  const prune = (db: Db) => {
    const now = clock.now();
    pruneRuns(db, now);
    pruneResearch(db, now, hooks.waited(db, now));
    pruneNews(db, now, trackedIds(db, now, tracking));
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
    tracking,
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
          tracking,
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
          tracking,
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
          tracking,
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
          tracking,
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
    tracking,
    quoteEveryMs: options.quoteEveryMs,
  });
  const track = tracker({
    m: reads,
    states: trackStates,
    flagged,
    owed,
    periodMs: options.quoteEveryMs,
    log: options.log("track"),
  });
  void track.run();
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
  const ui = options.ui === true;
  const server = serve({
    hostname: options.hostname,
    port: options.port,
    page: ui ? (options.page ?? null) : null,
    pageDev: options.pageDev === true,
    handle: router({
      bearer: options.bearer,
      mcp,
      api: routes({
        m: reads,
        alerts: alertsHandler({ db, log: options.log("alerts") }),
        admin:
          adminKey === null
            ? null
            : {
                m: { ...reads, log: options.log("admin") },
                version: options.version,
                sources: states,
                track: track.status,
              },
        log: options.log("api"),
      }),
      adminKey,
      sessions: ui ? sessions(adminKey) : null,
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
  track.schedule(jobs);
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
    tracker: track,
    sources: Object.fromEntries(
      states.map((s) => [
        s.name,
        s.name === "yahoo" ? "on" : `${s.on ? "on" : "off"} (${s.why})`,
      ]),
    ),
    async stop() {
      // no new run or request starts, no job waits out a back-off, runs settle,
      // then queued writes drain before main closes the database
      track.stop();
      const settled = jobs.stop();
      yahooQueue.close();
      fredClient?.close();
      finnhubClient?.close();
      massiveClient?.close();
      bvbClient?.close();
      await server.stop();
      await settled;
      await switcher.settled();
      await track.settled();
      // a fetch past its caller's deadline still runs: no answer after close
      await Promise.allSettled(
        [...reads.inflight.values()].map((f) => f.promise),
      );
      await mcp.close();
      await write.close();
    },
  };
}
