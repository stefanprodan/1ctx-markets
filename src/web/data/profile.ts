// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The Profile page's calls and signals.

import type { Call } from "./api.ts";
import { documentStore } from "./document.ts";

export {
  RESTORE_STALE,
  type RevisionRow,
  STALE,
} from "./document.ts";

export const PROFILE_PATH = "/api/v1/profile";

export type ProfileAnswer = {
  text: string | null;
  html: string | null;
  revision: number | null;
  author: string | null;
  updated_at: string | null;
  bytes: number | null;
};

export type ProfileStore = ReturnType<typeof profileStore>;

export function profileStore(call: Call, session: () => number) {
  const store = documentStore<ProfileAnswer>(call, session, PROFILE_PATH);
  return { ...store, profile: store.doc };
}
