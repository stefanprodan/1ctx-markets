// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Detail } from "../data/store.ts";
import { about } from "../lib/names.ts";
import { Change, Hero, Num } from "../ui/Figures.tsx";
import {
  afterHours,
  headline,
  moveLabel,
  priceState,
} from "./Instrument.model.ts";

// the price alone: returns pushed the chart off a phone's first screen
export function Head({ detail, now }: { detail: Detail; now: number }) {
  const h = headline(detail);
  const x = afterHours(detail);
  return (
    <Hero
      name={
        <>
          {about(detail.instrument)}
          <span class="faint"> · {priceState(detail, now)}</span>
        </>
      }
      value={h.value}
      currency={h.currency ?? undefined}
      moves={[
        {
          money: h.move.text ? h.move : undefined,
          percent: h.change,
          label: moveLabel(detail),
        },
      ]}
      lines={
        x === null
          ? undefined
          : [
              <>
                <span class="faint">{x.word}</span> <Num>{x.value}</Num>{" "}
                <Change s={x.change} /> <span class="faint">· {x.at}</span>
              </>,
            ]
      }
    />
  );
}
