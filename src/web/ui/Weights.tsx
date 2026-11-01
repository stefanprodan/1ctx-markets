// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Grey bars, since green and red mean a price move.

import { Num } from "./Figures.tsx";
import "./symbol.css";
import "./weights.css";

export type Weight = {
  key: string;
  label: string;
  name?: string;
  href?: string | null;
  weight: number;
};

// a share too small to see keeps a sliver
export const barWidth = (weight: number, largest: number): number =>
  largest > 0 ? Math.max(1, Math.min(100, (weight / largest) * 100)) : 0;

export function Weights({ rows }: { rows: readonly Weight[] }) {
  const largest = Math.max(0, ...rows.map((r) => r.weight));
  const links = rows.some((r) => r.href);
  return (
    <dl class={`weights${links ? " weights-links" : ""}`}>
      {rows.map((r) => (
        <div key={r.key} class="weights-row">
          <dt title={r.name}>
            {r.href ? (
              <a
                class="sym-ticker sym-link"
                href={r.href}
                aria-label={r.name ?? r.label}
              >
                {r.label}
              </a>
            ) : (
              r.label
            )}
          </dt>
          <dd class="weights-bar" aria-hidden="true">
            <i style={{ width: `${barWidth(r.weight, largest)}%` }} />
          </dd>
          <dd>
            <Num>{r.weight.toFixed(1)}%</Num>
          </dd>
        </div>
      ))}
    </dl>
  );
}
