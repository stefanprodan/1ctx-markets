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
  j.last.status === "running"
    ? "running"
    : j.last.status === "failed" || j.failing_scopes > 0
      ? "failed"
      : "done";

// jobs of no source (the switch between sources) are the server's own
export const groupName = (g: SourceGroup): string =>
  g.source?.label ?? (g.id === "sources" ? "Server" : g.id);

// the source's state in its card's head
export function sourceState(s: SourceStatus, now: number): string {
  if (s.state === "off") return `Off · ${s.why}`;
  if (s.backing_off === null) return "On";
  return `Backing off ${until(s.backing_off.until, now)} · ${s.backing_off.after}`;
}

// a job runs per market (US, ZRH) or per instrument (US:NVDA)
export function jobLine(j: JobStatus): string {
  if (j.scopes === 0) return "";
  const market = j.last.scope !== null && !j.last.scope.includes(":");
  const unit = market
    ? j.scopes === 1
      ? "market"
      : "markets"
    : j.scopes === 1
      ? "instrument"
      : "instruments";
  const state =
    j.failing_scopes === 0
      ? j.scopes === 1
        ? "ok"
        : "all ok"
      : `${count(j.failing_scopes)} failing`;
  return `${count(j.scopes)} ${unit} · ${state}`;
}

// when it last ran; the dot and the lines under the name say how it went
export const jobWhen = (j: JobStatus, now: number): string =>
  ago(j.last.ended_at ?? j.last.started_at, now);

// the failing scopes the server named, the last run's error when it
// named none, and how many more it counted
export function failures(j: JobStatus): string[] {
  const lines = j.failing.map((f) =>
    [f.scope, f.error ?? "failed"].filter((x) => x !== null).join(": "),
  );
  if (lines.length === 0 && j.last.status === "failed") {
    lines.push(
      [j.last.scope, j.last.error ?? "failed"]
        .filter((x) => x !== null)
        .join(": "),
    );
  }
  const more = j.failing_scopes - j.failing.length;
  if (more > 0) lines.push(`${count(more)} more failing`);
  return lines;
}

export type SourceGroup = {
  id: string;
  source: SourceStatus | null;
  jobs: JobStatus[];
};

// one card per source in the server's order, then the server's own jobs;
// failing jobs first, then by label
export function groups(
  sources: readonly SourceStatus[],
  jobs: readonly JobStatus[],
): SourceGroup[] {
  const ids = [...sources.map((s) => s.name)];
  for (const j of jobs) if (!ids.includes(j.source)) ids.push(j.source);
  const rank = (j: JobStatus) => (jobTone(j) === "failed" ? 0 : 1);
  return ids.map((id) => ({
    id,
    source: sources.find((s) => s.name === id) ?? null,
    jobs: jobs
      .filter((j) => j.source === id)
      .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
  }));
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
