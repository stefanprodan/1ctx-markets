// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A card around a list, a table or a form, and the head it opens with.

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import "./card.css";

export function Card({
  title,
  count,
  actions,
  flush,
  label,
  class: cls,
  children,
}: {
  // a card without a title has no head
  title?: ComponentChildren;
  count?: number | string | null;
  // search and buttons on the head's right
  actions?: ComponentChildren;
  // no padding: rows that pad themselves run edge to edge
  flush?: boolean;
  // the section's name for a screen reader when the title is not words
  label?: string;
  class?: string;
  children?: ComponentChildren;
}) {
  return (
    <section
      class={`card card-box${flush ? " card-flush" : ""}${cls ? ` ${cls}` : ""}`}
      aria-label={label}
    >
      {title !== undefined && (
        <CardHead title={title} count={count} actions={actions} />
      )}
      {children}
    </section>
  );
}

// a section of tiles opens with the same head, without the card
export function CardHead({
  title,
  count,
  actions,
  section,
}: {
  title: ComponentChildren;
  count?: number | string | null;
  actions?: ComponentChildren;
  section?: boolean;
}) {
  return (
    <div class={`card-head${section ? " card-head-section" : ""}`}>
      <h2 class="card-title">
        {title}
        {count !== undefined && count !== null && (
          <span class="card-count num" aria-live="polite">
            {count}
          </span>
        )}
      </h2>
      {actions}
    </div>
  );
}

export function SectionHead(props: {
  title: ComponentChildren;
  count?: number | string | null;
  actions?: ComponentChildren;
}) {
  return <CardHead {...props} section />;
}

// a group inside a list: the app's mono label, folding when it can
export function GroupLabel({
  label,
  count,
  trail,
  open,
  onToggle,
}: {
  label: ComponentChildren;
  count?: number | null;
  // after the name, such as the group's total and share
  trail?: ComponentChildren;
  open?: boolean;
  onToggle?: () => void;
}) {
  const inner = (
    <>
      <span class="group-name">
        {onToggle && (
          <Icon
            name="chevron-right"
            size={12}
            class={`group-caret${open ? " group-caret-open" : ""}`}
          />
        )}
        {label}
        {count !== undefined && count !== null && (
          <span class="group-count num">{count}</span>
        )}
      </span>
      {trail !== undefined && <span class="group-trail num">{trail}</span>}
    </>
  );
  return onToggle ? (
    <button
      type="button"
      class="group-label group-fold"
      aria-expanded={open}
      onClick={onToggle}
    >
      {inner}
    </button>
  ) : (
    <div class="group-label">{inner}</div>
  );
}

// a period inside a list, such as a month of trades: its name, and what
// it holds on the right; it stays in sight while its rows scroll
export function PeriodLabel({
  label,
  trail,
}: {
  label: ComponentChildren;
  trail?: ComponentChildren;
}) {
  return (
    <div class="period-label">
      <span>{label}</span>
      {trail !== undefined && <span class="faint">{trail}</span>}
    </div>
  );
}
