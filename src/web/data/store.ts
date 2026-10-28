// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { batch, signal } from "@preact/signals";
import { ApiError, client, type Fetch, failure, says } from "./api.ts";

export type SourceStatus = {
  name: string;
  label: string;
  short: string;
  mark: string;
  // how to turn it on, for a source that needs a key
  key: { file: string; adds: string; signup: string } | null;
  state: "on" | "off";
  why: string;
  backing_off: { until: string | null; after: string } | null;
};

export type JobStatus = {
  source: string;
  job: string;
  label: string;
  about: string | null;
  last: {
    scope: string | null;
    started_at: string | null;
    ended_at: string | null;
    status: "running" | "ok" | "failed";
    rows: number;
    error: string | null;
  };
  instruments: number;
  markets: number;
  failing_scopes: number;
  failing: { scope: string | null; error: string | null; at: string | null }[];
};

export type TrackStatus = { value: string; id: string | null; state: string };

export type Status = {
  version: string;
  sources: SourceStatus[];
  jobs: JobStatus[];
  instruments: number;
  tracked: number;
  track: TrackStatus[];
  database_bytes: number;
};

export const STATUS_PATH = "/api/v1/admin/status";
export const SESSION_PATH = "/ui/session";

export function store(fetchFn: Fetch, now: () => number = Date.now) {
  // undefined until the first answer says whether the cookie holds
  const signedIn = signal<boolean | undefined>(undefined);
  const status = signal<Status | null>(null);
  // when the status on screen was answered, for the head's line
  const statusAt = signal<number | null>(null);
  const statusError = signal<string | null>(null);
  const loading = signal(false);

  const signedOut = () =>
    batch(() => {
      signedIn.value = false;
      status.value = null;
      statusAt.value = null;
      statusError.value = null;
    });
  const call = client(fetchFn, signedOut);
  // a superseded load's 401 must not sign out a newer sign-in, so the
  // status load signs out itself, only while it is the latest
  const quiet = client(fetchFn, () => {});
  // a later load supersedes one in flight, and a superseded one answers
  // with the latest's outcome, so a sign-in never reads a stale result
  let latest = 0;
  let current: Promise<boolean> = Promise.resolve(false);

  function loadStatus(): Promise<boolean> {
    current = load(++latest);
    return current;
  }

  async function load(mine: number): Promise<boolean> {
    loading.value = true;
    try {
      const s = await quiet<Status>(STATUS_PATH);
      if (mine !== latest) return current;
      batch(() => {
        signedIn.value = true;
        status.value = s;
        statusAt.value = now();
        statusError.value = null;
      });
      return true;
    } catch (error) {
      if (mine !== latest) return current;
      if (error instanceof ApiError && error.status === 401) signedOut();
      else statusError.value = says(error);
      return false;
    } finally {
      if (mine === latest) loading.value = false;
    }
  }

  return {
    signedIn,
    status,
    statusAt,
    statusError,
    loading,
    loadStatus,
    // the status answers whether the cookie holds, so one call does both
    check: loadStatus,
    // a wrong key is no session ending, so it skips the 401 hook
    async signIn(key: string): Promise<void> {
      let res: Response;
      try {
        res = await fetchFn(SESSION_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: key.trim() }),
        });
      } catch {
        throw failure(0, null);
      }
      if (res.status === 401) {
        throw new ApiError(401, "wrong admin key");
      }
      if (!res.ok) {
        throw failure(res.status, await res.json().catch(() => null));
      }
      // the cookie set but the status refused, so the form says why; a
      // 401 here is a cookie the browser dropped, never a session ended
      if (!(await loadStatus())) {
        throw new ApiError(0, statusError.value ?? "not signed in");
      }
    },
    async signOut(): Promise<void> {
      await call(SESSION_PATH, "DELETE");
      // a status load still in flight must not sign back in
      latest++;
      current = Promise.resolve(false);
      loading.value = false;
      signedOut();
    },
  };
}

export type Store = ReturnType<typeof store>;

export const markets: Store = store((input, init) => fetch(input, init));
