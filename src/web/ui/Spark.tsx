// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A sparkline: green above its dotted base, red below.

import { useId } from "preact/hooks";
import "./spark.css";

const W = 96;
const H = 28;
// room for the stroke at the top and bottom
const PAD = 2;

export type SparkLine = { points: string; base: number };

// the base is the period's start, or a given value such as the previous
// close; from the start the box spans at least 10% of it, so a bond that
// moved 1% stays near flat while a 30% fall still fills it
export function sparkLine(
  closes: readonly number[],
  base: "start" | number,
  w = W,
  h = H,
  // the points the width stands for, so a session still trading fills
  // only its share; the closes take the first of them
  slots?: number,
): SparkLine | null {
  if (closes.length === 0) return null;
  const ref = base === "start" ? closes[0]! : base;
  let lo = Math.min(...closes, ref);
  let hi = Math.max(...closes, ref);
  if (base === "start") {
    const floor = Math.abs(ref) * 0.1;
    if (hi - lo < floor) {
      const pad = (floor - (hi - lo)) / 2;
      lo -= pad;
      hi += pad;
    }
  }
  const span = hi - lo || 1;
  const y = (v: number) =>
    hi === lo ? h / 2 : h - PAD - ((v - lo) / span) * (h - 2 * PAD);
  const n = closes.length;
  const steps = Math.max(n, slots ?? 0) - 1;
  const xy = closes.map(
    (v, i) =>
      `${(steps === 0 ? 0 : (i / steps) * w).toFixed(1)},${y(v).toFixed(1)}`,
  );
  // one close is a level line across the box, or a dot in its slot
  if (n === 1) xy.push(`${steps === 0 ? w : 0},${y(closes[0]!).toFixed(1)}`);
  return { points: xy.join(" "), base: Number(y(ref).toFixed(1)) };
}

export function Spark({
  closes,
  base = "start",
  width = W,
  height = H,
  slots,
}: {
  closes: readonly number[];
  base?: "start" | number;
  // the points the width stands for (sparkLine's slots)
  slots?: number;
  // fluid fills its box's width, stretched, its strokes kept thin
  width?: number | "fluid";
  height?: number;
}) {
  const id = useId();
  const fluid = width === "fluid";
  const w = fluid ? 120 : width;
  const line = sparkLine(closes, base, w, height, slots);
  if (line === null)
    return (
      <span
        class={`spark${fluid ? " spark-fluid" : ""}`}
        style={{ height: `${height}px` }}
        aria-hidden="true"
      />
    );
  return (
    <svg
      class={`spark${fluid ? " spark-fluid" : ""}`}
      viewBox={`0 0 ${w} ${height}`}
      width={fluid ? undefined : w}
      height={height}
      preserveAspectRatio={fluid ? "none" : undefined}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${id}u`}>
          <rect x="0" y="0" width={w} height={line.base} />
        </clipPath>
        <clipPath id={`${id}d`}>
          <rect x="0" y={line.base} width={w} height={height - line.base} />
        </clipPath>
      </defs>
      <line class="spark-base" x1="0" x2={w} y1={line.base} y2={line.base} />
      <polyline
        class="spark-line spark-up"
        clip-path={`url(#${id}u)`}
        points={line.points}
      />
      <polyline
        class="spark-line spark-down"
        clip-path={`url(#${id}d)`}
        points={line.points}
      />
    </svg>
  );
}
