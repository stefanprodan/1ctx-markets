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

// a run's day and time in the viewer's zone, on a 24-hour clock
export const runTime = (at: string | null): string =>
  at === null
    ? "never"
    : new Date(at).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
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
  j.last.status === "running"
    ? "running"
    : j.last.status === "failed" || j.failing_scopes > 0
      ? "failed"
      : "done";

// the state in an on source's card head
export function sourceState(s: SourceStatus, now: number): string {
  if (s.backing_off === null) return "On";
  return `Backing off ${until(s.backing_off.until, now)} · ${s.backing_off.after}`;
}

// what a job covers: its instruments, else the markets it runs per
function covers(j: JobStatus): { n: number; words: string } {
  const instruments = j.instruments > 0;
  const n = instruments ? j.instruments : j.markets;
  const one = instruments ? "instrument" : "market";
  return { n, words: `${count(n)} ${n === 1 ? one : `${one}s`}` };
}

export function jobLine(j: JobStatus): string {
  const { n, words } = covers(j);
  if (n === 0) return "";
  const state =
    j.failing_scopes > 0
      ? `${count(j.failing_scopes)} failing`
      : n === 1
        ? "ok"
        : "all ok";
  return `${words} · ${state}`;
}

export function allOk(j: JobStatus): string {
  const { n, words } = covers(j);
  if (n === 0) return "No runs kept.";
  return n === 1 ? `${words} ok.` : `All ${words} ok.`;
}

// when it last ran; the dot and the lines under the name say how it went
export const jobWhen = (j: JobStatus, now: number): string =>
  ago(j.last.ended_at ?? j.last.started_at, now);

export type SourceGroup = { source: SourceStatus; jobs: JobStatus[] };

// a card per source that is on, in the server's order: one off has
// nothing to fix, and most servers never turn a regional source on;
// failing jobs first, then by label
export function groups(
  sources: readonly SourceStatus[],
  jobs: readonly JobStatus[],
): SourceGroup[] {
  const rank = (j: JobStatus) => (jobTone(j) === "failed" ? 0 : 1);
  return sources
    .filter((s) => s.state === "on")
    .map((source) => ({
      source,
      jobs: jobs
        .filter((j) => j.source === source.name)
        .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    }));
}

// the switch runs once per change of sources, so it shows only failed
export function switchFailure(jobs: readonly JobStatus[]): string | null {
  const j = jobs.find((x) => x.source === "sources" && x.job === "switch");
  if (j === undefined) return null;
  const f =
    j.failing[0] ??
    (j.last.status === "failed"
      ? { scope: j.last.scope, error: j.last.error }
      : null);
  if (f === null) return null;
  const market = f.scope === null ? "a market" : `market ${f.scope}`;
  return `Source change for ${market} failed: ${f.error ?? "failed"}. Its prices stay stale until a retry succeeds.`;
}

export const trackFailed = (t: TrackStatus): boolean =>
  t.state !== "tracked" && t.state !== "pending";

export const trackLine = (t: TrackStatus): string =>
  t.state === "tracked"
    ? (t.id ?? "")
    : t.state === "pending"
      ? "pending"
      : t.state.replaceAll("_", " ");

export const sourcesOn = (list: readonly SourceStatus[]): number =>
  list.filter((s) => s.state === "on").length;
