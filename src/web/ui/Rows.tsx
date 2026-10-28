// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
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
