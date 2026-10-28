// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { JobStatus, SourceStatus, TrackStatus } from "../data/store.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

// the viewer's own zone, since it says when they last asked
export const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

export const count = (n: number): string => n.toLocaleString("en-US");

// the server's times are UTC; an operator reads them as a distance from now
export function ago(at: string | null, now: number): string {
  if (at === null) return "never";
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

export function until(at: string | null, now: number): string {
  if (at === null) return "for now";
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "for now";
  if (ms < HOUR) return `for ${Math.ceil(ms / MINUTE)} min`;
  return `for ${Math.ceil(ms / HOUR)} h`;
}

export type Tone = "done" | "failed" | "running" | "stopped";

export const jobTone = (j: JobStatus): Tone =>
  j.last.status === "ok"
    ? j.failing_scopes > 0
      ? "failed"
      : "done"
    : j.last.status === "failed"
      ? "failed"
      : "running";

export const sourceTone = (s: SourceStatus): Tone =>
  s.state === "off" ? "stopped" : s.backing_off !== null ? "failed" : "done";

export function sourceLine(s: SourceStatus, now: number): string {
  if (s.state === "off") return `off: ${s.why}`;
  if (s.backing_off === null) return `on: ${s.why}`;
  return `backing off ${until(s.backing_off.until, now)} after ${s.backing_off.after}`;
}

// a scope is a market or an instrument, named by the run it took
export function jobLine(j: JobStatus, now: number): string {
  const l = j.last;
  const when =
    l.status === "running"
      ? `running since ${ago(l.started_at, now)}`
      : `${l.status === "ok" ? "ok" : "failed"} ${ago(l.ended_at ?? l.started_at, now)}`;
  const parts = [when];
  if (l.scope !== null) parts.push(l.scope);
  if (l.status !== "running") {
    parts.push(`${count(l.rows)} ${l.rows === 1 ? "row" : "rows"}`);
  }
  return parts.join(" · ");
}

export const failingLine = (j: JobStatus): string | null =>
  j.failing_scopes === 0
    ? null
    : `${j.failing_scopes} ${j.failing_scopes === 1 ? "scope" : "scopes"} failing`;

export const trackTone = (t: TrackStatus): Tone =>
  t.state === "tracked" ? "done" : t.state === "pending" ? "running" : "failed";

export const trackLine = (t: TrackStatus): string =>
  t.state === "tracked"
    ? `tracked as ${t.id}`
    : t.state === "pending"
      ? "pending"
      : t.state.replaceAll("_", " ");

export const sourcesOn = (list: readonly SourceStatus[]): number =>
  list.filter((s) => s.state === "on").length;
