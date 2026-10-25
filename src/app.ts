// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The wiring main.ts starts, kept apart so a test runs the same with a
// fake clock and a captured log.

import type { Clock } from "./clock.ts";
import { router, serve } from "./http.ts";
import type { LogFactory } from "./log.ts";
import { mcpHandler } from "./mcp.ts";
import { type Scheduler, scheduler } from "./scheduler.ts";

export type AppOptions = {
  hostname: string;
  port: number;
  bearer: string;
  clock: Clock;
  log: LogFactory;
  version: string;
};

export type App = {
  server: Bun.Server<undefined>;
  jobs: Scheduler;
  stop(): Promise<void>;
};

export function start(options: AppOptions): App {
  const mcp = mcpHandler(options.version, options.log("mcp"));
  const server = serve({
    hostname: options.hostname,
    port: options.port,
    handle: router({
      bearer: options.bearer,
      mcp,
      clock: options.clock,
      log: options.log("http"),
    }),
  });
  const jobs = scheduler(options.clock, options.log("scheduler"));
  return {
    server,
    jobs,
    async stop() {
      jobs.stop();
      await server.stop();
      await mcp.close();
    },
  };
}
