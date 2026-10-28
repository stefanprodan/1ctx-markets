// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./rows.css";

export function Rows({ children }: { children: ComponentChildren }) {
  return <div class="rows">{children}</div>;
}

export function RowsCard({
  label,
  search,
  tabs,
  action,
  hint,
  live,
  count,
  hintBelow,
  menus,
  class: extra,
  children,
}: {
  label: string;
  search?: ComponentChildren;
  tabs?: ComponentChildren;
  action?: ComponentChildren;
  hint?: string;
  live?: boolean;
  count?: string;
  // on a phone the hint takes its own line under the label, held even
  // while empty, so a hint that follows the pointer never moves the card
  hintBelow?: boolean;
  // its rows open menus, which drop past the card's edge
  menus?: boolean;
  class?: string;
  children?: ComponentChildren;
}) {
  const id = useId();
  const slot = search ?? tabs;
  return (
    <section
      class={`card rows-card${menus ? " rows-card-menus" : ""}${
        extra ? ` ${extra}` : ""
      }`}
      aria-label={slot ? label : undefined}
      aria-labelledby={slot ? undefined : id}
    >
      <div
        class={`rows-head${search ? " rows-head-search" : ""}${
          tabs ? " rows-head-tabs" : ""
        }${hintBelow ? " rows-head-below" : ""}`}
      >
        {slot ?? (
          <span class="label" id={id}>
            {label}
          </span>
        )}
        {(hint || hintBelow) && (
          <span class="rows-hint cut" aria-live={live ? "polite" : undefined}>
            {hint}
          </span>
        )}
        {count !== undefined && (
          <span class="rows-count" aria-live="polite">
            {count}
          </span>
        )}
        {action}
      </div>
      {children}
    </section>
  );
}

export function RowsNote({ children }: { children: ComponentChildren }) {
  return <p class="rows-note">{children}</p>;
}

export function RowsLine({
  as = "div",
  flush,
  off,
  children,
}: {
  as?: "div" | "label";
  flush?: boolean;
  off?: boolean;
  children: ComponentChildren;
}) {
  const Tag = as;
  return (
    <div class={`rows-item${off ? " rows-item-off" : ""}`}>
      <Tag
        class={`rows-line${flush ? "" : " rows-line-static"}${
          as === "label" ? " rows-line-pick" : ""
        }`}
      >
        {children}
      </Tag>
    </div>
  );
}

export function RowsGo({
  href,
  end,
  under,
  off,
  side,
  compact,
  children,
}: {
  href: string;
  end?: ComponentChildren;
  under?: ComponentChildren;
  off?: boolean;
  // on a phone the meta stays beside the title, as the feed's time
  // does, and the arrow waits for the width where the row fits
  side?: boolean;
  // as tall as its lines, for a long list of one or two short lines
  compact?: boolean;
  children: ComponentChildren;
}) {
  // a row with a button at its end leaves the arrow out, or it would
  // sit between the words and the button
  const link = (line: boolean) => (
    <a
      class={`${line ? "rows-line rows-go" : "rows-go rows-go-part"}${
        side ? " rows-go-side" : ""
      }${compact ? " rows-go-compact" : ""}`}
      href={href}
    >
      {children}
      {line && <Icon name="chevron-right" size={14} class="rows-go-arrow" />}
    </a>
  );
  return (
    <div class={`rows-item${off ? " rows-item-off" : ""}`}>
      {end === undefined ? (
        link(true)
      ) : (
        <div class="rows-line rows-line-end">
          {link(false)}
          {end}
        </div>
      )}
      {under}
    </div>
  );
}

export function RowsMore({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="rows-item rows-more">
      <button type="button" class="btn-text" onClick={onClick}>
        {children}
      </button>
    </div>
  );
}

export function RowsTitle({
  name,
  sub,
  mono,
  bad,
  subWide,
  lines,
  wrap,
  prose,
}: {
  name: ComponentChildren;
  sub?: ComponentChildren;
  mono?: boolean;
  bad?: boolean;
  subWide?: boolean;
  // more lines under the sub, each its own fact
  lines?: { text: ComponentChildren; bad?: boolean }[];
  // the sub lines wrap whole rather than ellipsize, for details that
  // mean nothing cut
  wrap?: boolean;
  // a sub of words someone wrote, in the body font
  prose?: boolean;
}) {
  const subClass = `rows-sub${wrap ? " rows-sub-wrap" : ""}`;
  return (
    <span class="rows-title">
      <span class={`rows-name${mono ? " rows-name-mono" : ""}`}>
        {/* the name is a flex row for a tag beside it, and a flex box
            never ellipsizes its own text, so plain words get a box */}
        {typeof name === "string" ? <span class="cut">{name}</span> : name}
      </span>
      {sub !== undefined && (
        <span
          class={`${subClass}${bad ? " rows-bad" : ""}${subWide ? " rows-sub-wide" : ""}${prose ? " rows-sub-prose" : ""}`}
        >
          {sub}
        </span>
      )}
      {lines?.map((line, i) => (
        <span key={i} class={`${subClass}${line.bad ? " rows-bad" : ""}`}>
          {line.text}
        </span>
      ))}
    </span>
  );
}

export function RowsMeta({
  bad,
  brand,
  short,
  keep,
  under,
  children,
}: {
  bad?: boolean;
  brand?: boolean;
  // a meta that cannot ellipsize (boxes, a meter): the title gives way
  keep?: boolean;
  // a phone's meta; empty hides it there
  short?: string;
  under?: ComponentChildren;
  children: ComponentChildren;
}) {
  const cls = `rows-meta${bad ? " rows-meta-bad" : ""}${
    brand ? " rows-meta-brand" : ""
  }${keep ? " rows-meta-keep" : ""}${short === "" ? " rows-meta-wide" : ""}`;
  return (
    <span class={cls}>
      {under !== undefined ? (
        <span class="rows-meta-two">
          <span>{children}</span>
          <span class="rows-meta-under">{under}</span>
        </span>
      ) : short === undefined ? (
        children
      ) : (
        <>
          <span class="rows-meta-long">{children}</span>
          <span class="rows-meta-short">{short}</span>
        </>
      )}
    </span>
  );
}
