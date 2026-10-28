// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { batch, signal } from "@preact/signals";
import {
  ApiError,
  client,
  type Fetch,
  failure,
  says,
  statusWords,
} from "./api.ts";

export type SourceStatus = {
  name: string;
  state: "on" | "off";
  why: string;
  backing_off: { until: string | null; after: string } | null;
};

export type JobStatus = {
  source: string;
  job: string;
  last: {
    scope: string | null;
    started_at: string | null;
    ended_at: string | null;
    status: "running" | "ok" | "failed";
    rows: number;
    error: string | null;
  };
  failing_scopes: number;
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
  // a later load supersedes one in flight
  let latest = 0;

  async function loadStatus(): Promise<void> {
    const mine = ++latest;
    loading.value = true;
    try {
      const s = await call<Status>(STATUS_PATH);
      if (mine !== latest) return;
      batch(() => {
        signedIn.value = true;
        status.value = s;
        statusAt.value = now();
        statusError.value = null;
      });
    } catch (error) {
      if (mine !== latest) return;
      if (error instanceof ApiError && error.status === 401) return;
      statusError.value = says(error);
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
      await loadStatus();
      // the cookie set but the status refused, so the form says why
      if (signedIn.value !== true) {
        throw new ApiError(0, statusError.value ?? statusWords(401));
      }
    },
    async signOut(): Promise<void> {
      await call(SESSION_PATH, "DELETE");
      signedOut();
    },
  };
}

export type Store = ReturnType<typeof store>;

export const markets: Store = store((input, init) => fetch(input, init));
