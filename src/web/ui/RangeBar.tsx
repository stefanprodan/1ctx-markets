// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Num } from "./Figures.tsx";
import "./range-bar.css";

export function RangeBar({
  at,
  low,
  high,
}: {
  // 0 at the low, 1 at the high
  at: number;
  low: string;
  high: string;
}) {
  return (
    <div class="range-bar">
      <div class="range-bar-track">
        <span
          class="range-bar-dot"
          style={{ left: `${(at * 100).toFixed(1)}%` }}
        />
      </div>
      <div class="range-bar-ends small">
        <Num>{low}</Num>
        <Num>{high}</Num>
      </div>
    </div>
  );
}
