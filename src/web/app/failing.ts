// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "preact/hooks";
import { markets } from "../data/store.ts";
import { useRefresh } from "../lib/refresh.ts";
import { troubled } from "../views/Status.model.ts";

// whether the status page shows anything failing, read once a minute
// for the rail's or the strip's status icon; signed in only, since the
// shell shows for a signed-out page too
export function useServerFailing(): boolean {
  const signed = markets.signedIn.value === true;
  useEffect(() => {
    if (signed) void markets.checkPulse();
  }, [signed]);
  useRefresh(() => {
    if (markets.signedIn.peek() === true) return markets.checkPulse();
  });
  const pulse = markets.pulse.value;
  return signed && pulse !== null && troubled(pulse);
}
