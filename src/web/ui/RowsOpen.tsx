// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// RowsOpen, the row of Rows.tsx that opens in place.

import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import { reveal } from "../lib/scroll.ts";
import "./rows.css";

// a row that opens: the chevron and the head are the toggle, `end`
// sits outside it, and the body indents to where the head's text starts
export function RowsOpen({
  open,
  onToggle,
  head,
  end,
  indent = "avatar",
  off,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  head: ComponentChildren;
  end?: ComponentChildren;
  indent?: "avatar" | "chevron";
  // the row's subject is switched off: the name goes faint
  off?: boolean;
  children?: ComponentChildren;
}) {
  const item = useRef<HTMLDivElement>(null);
  // where the head was when a click opened it
  const clickedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = clickedAt.current;
    clickedAt.current = null;
    if (open && item.current !== null) reveal(item.current, at);
  }, [open]);
  const toggle = (line: boolean) => (
    <button
      type="button"
      class={`rows-toggle${line ? " rows-line" : ""}`}
      aria-expanded={open}
      onClick={() => {
        if (!open) {
          clickedAt.current = item.current?.getBoundingClientRect().top ?? null;
        }
        onToggle();
      }}
    >
      <Icon
        name="chevron"
        size={14}
        class={`rows-chevron${open ? " rows-chevron-open" : ""}`}
      />
      {head}
    </button>
  );
  return (
    <div
      ref={item}
      class={`rows-item${open ? " rows-item-open" : ""}${
        off ? " rows-item-off" : ""
      }`}
    >
      {end === undefined ? (
        toggle(true)
      ) : (
        <div class="rows-line rows-line-end">
          {toggle(false)}
          {end}
        </div>
      )}
      {open && <div class={`rows-body rows-body-${indent}`}>{children}</div>}
    </div>
  );
}
