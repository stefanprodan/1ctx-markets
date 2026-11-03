// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { markets } from "../data/store.ts";
import { useRefresh } from "../lib/refresh.ts";
import { troubled } from "../views/Status.model.ts";

// whether the status page shows anything failing, read every refresh
// for the rail's or the strip's status icon; an admin's only, since the
// status is theirs and the shell shows for a signed-out page too
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
