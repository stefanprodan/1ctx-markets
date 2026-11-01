// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Figures: a number, a change, the hero's value band, a row of stats.

import type { ComponentChildren } from "preact";
import type { Signed } from "../lib/format.ts";
import "./figures.css";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

export function Num({
  children,
  currency,
  class: cls,
}: {
  children: ComponentChildren;
  // beside the figure, faint
  currency?: string | null;
  class?: string;
}) {
  return (
    <span class={cx("num", cls)}>
      {children}
      {currency && <span class="num-ccy"> {currency}</span>}
    </span>
  );
}

// green up, red down, the text's own colour unchanged; nothing to show
// draws nothing
export function Change({ s, class: cls }: { s: Signed; class?: string }) {
  if (s.text === "") return null;
  return (
    <span class={cx("num", s.dir > 0 && "up", s.dir < 0 && "down", cls)}>
      {s.text}
    </span>
  );
}

// one move on the hero's line: money and percent, then a faint word
export type Move = {
  money?: Signed;
  percent?: Signed;
  label: string;
  // a class on the money, such as one that hides amounts
  moneyClass?: string;
};

// the value band, no card: a small name line, the one large figure with
// its currency small beside it (or a menu in its place), one line of
// moves, then any lines more in the text's size; never a second large
// figure. compact goes inside a card whose title names it
export function Hero({
  name,
  value,
  currency,
  moves,
  lines,
  valueClass,
  compact,
  children,
}: {
  name?: ComponentChildren;
  value: ComponentChildren;
  currency?: ComponentChildren;
  moves?: readonly Move[];
  // under the moves, each a line, such as the price after hours
  lines?: readonly ComponentChildren[];
  valueClass?: string;
  compact?: boolean;
  // under the line, such as a split bar
  children?: ComponentChildren;
}) {
  const shown = (moves ?? []).filter(
    (m) => (m.money?.text ?? "") !== "" || (m.percent?.text ?? "") !== "",
  );
  return (
    <section class={cx("hero", compact && "hero-compact")}>
      {name !== undefined && <h2 class="hero-name">{name}</h2>}
      <div class={cx("hero-value", valueClass)}>
        {value}
        {currency !== undefined &&
          (typeof currency === "string" ? (
            <span class="hero-ccy">{currency}</span>
          ) : (
            currency
          ))}
      </div>
      {shown.length > 0 && (
        <div class="hero-moves">
          {shown.map((m) => (
            <span key={m.label}>
              {m.money && <Change s={m.money} class={m.moneyClass} />}
              {m.money && m.percent && " "}
              {m.percent && <Change s={m.percent} />}{" "}
              <span class="faint">{m.label}</span>
            </span>
          ))}
        </div>
      )}
      {lines?.map((l, i) => (
        <div key={i} class="hero-line">
          {l}
        </div>
      ))}
      {children}
    </section>
  );
}

// figures in a row, a small label over each, no boxes; wraps on a phone
export function Stats({
  items,
  label,
}: {
  items: readonly {
    label: string;
    value: ComponentChildren;
    // a line under the figure, such as its date
    note?: ComponentChildren;
  }[];
  label?: string;
}) {
  return (
    <dl class="stats" aria-label={label}>
      {items.map((x) => (
        <div key={x.label} class="stat">
          <dt>{x.label}</dt>
          <dd class="num">{x.value}</dd>
          {x.note !== undefined && <dd class="stat-note">{x.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

// a detail's facts, a small label over each value, two to a row (four
// for short figures side by side): a trade's date, quantity and price in
// its drawer
export function Facts({
  items,
  four,
}: {
  items: readonly {
    label: string;
    value: ComponentChildren;
    // a figure, in the mono face
    num?: boolean;
    note?: ComponentChildren;
  }[];
  four?: boolean;
}) {
  const list = (
    <dl class={cx("facts", four && "facts-four")}>
      {items.map((x) => (
        <div key={x.label}>
          <dt>{x.label}</dt>
          <dd class={x.num ? "num" : undefined}>{x.value}</dd>
          {x.note !== undefined && <dd class="facts-note">{x.note}</dd>}
        </div>
      ))}
    </dl>
  );
  return four ? <div class="facts-fit">{list}</div> : list;
}
