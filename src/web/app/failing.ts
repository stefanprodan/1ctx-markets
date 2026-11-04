// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { markets } from "../data/store.ts";
import { useRefresh } from "../lib/refresh.ts";
import { troubled } from "../views/Status.model.ts";

// whether Server admin's Status shows anything failing, read every
// refresh for its icon in the rail, the strip and More; an admin's
// only, since the status is theirs and the shell shows signed out too
export function useServerFailing(): boolean {
  const signed =
    markets.signedIn.value === true && markets.isAdmin.value === true;
  useEffect(() => {
    if (signed) void markets.checkPulse();
  }, [signed]);
  useRefresh(() => {
    if (markets.signedIn.peek() === true && markets.isAdmin.peek()) {
      return markets.checkPulse();
    }
  }, true);
  const pulse = markets.pulse.value;
  return signed && pulse !== null && troubled(pulse);
}
