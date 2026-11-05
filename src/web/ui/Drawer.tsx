// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The one frame for every form and every detail: a title, a close, a
// body that scrolls, a foot with its buttons. From the right, a sheet
// from the bottom on a phone; Escape, the close or the dimmed page
// closes it, after it slides back.

import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./drawer.css";

// the slide out, as drawer.css has it
const SLIDE_MS = 180;

// a drawer slides back to its edge before it leaves the page; the
// answer stops a slide still running
export function slideOut(
  wrap: HTMLElement | null,
  then: () => void,
): () => void {
  const still =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (wrap === null || still) {
    then();
    return () => {};
  }
  wrap.classList.add("drawer-closing");
  const timer = setTimeout(then, SLIDE_MS);
  return () => clearTimeout(timer);
}

// a search with words takes Escape to clear them before the drawer closes
export function clearsFirst(el: EventTarget | null): boolean {
  const field = el as HTMLInputElement | null;
  return (
    field?.tagName === "INPUT" && field.type === "search" && field.value !== ""
  );
}

// where the focus goes back to: the element it left, or, when that went
// with a menu that closed, the button that opened the menu
export function returnTo(
  left: HTMLElement | null,
  opener: HTMLElement | null,
): HTMLElement | null {
  if (left?.isConnected) return left;
  return opener?.isConnected ? opener : null;
}

// a menu or a list still open inside takes Escape first
const OPEN_INSIDE =
  '[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]';

type Slot = ComponentChildren | ((close: () => void) => ComponentChildren);
const fill = (s: Slot, close: () => void) =>
  typeof s === "function" ? s(close) : s;

export function Drawer({
  title,
  label,
  onClose,
  busy,
  foot,
  footStart,
  bare,
  tall,
  swaps,
  children,
}: {
  title: ComponentChildren;
  // its name for a screen reader when the title is not words
  label?: string;
  // runs once it has slid out
  onClose: () => void;
  // a save on its way finishes in sight: nothing closes it meanwhile
  busy?: boolean;
  // the foot's buttons, on its right
  foot?: Slot;
  // on the foot's left, such as Remove or a question
  footStart?: Slot;
  // the children are the body and foot themselves, such as a form that
  // holds both
  bare?: boolean;
  // a sheet on a phone at its full height from the start, for a body
  // whose details arrive after it opens
  tall?: boolean;
  // a click on a list's row behind it opens that row, as a list of
  // records read one after another wants, rather than only closing
  swaps?: boolean;
  // given the drawer's close, which slides it out first
  children?: Slot;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // the latest ones, so a parent's inline function never rebinds the keys
  const done = useRef(onClose);
  done.current = onClose;
  const held = useRef(busy);
  held.current = busy;
  // a second close while the first slides (the backdrop, then Escape)
  // does nothing, and a slide still running at unmount never lands
  const closing = useRef(false);
  const stop = useRef<() => void>(() => {});
  const close = () => {
    if (held.current || closing.current) return;
    closing.current = true;
    stop.current = slideOut(wrap.current, () => done.current());
  };
  // where the focus was before it opened, read before a field inside
  // takes it, and the menu button it came from
  const left = useRef(
    typeof document === "undefined"
      ? null
      : (document.activeElement as HTMLElement | null),
  );
  const opener = useRef(
    left.current
      ?.closest(".menu-at")
      ?.querySelector<HTMLElement>("[aria-haspopup]") ?? null,
  );
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) {
      panel.current?.focus();
    }
    // capture sees a menu still open before its own handler closes it
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (panel.current?.querySelector(OPEN_INSIDE)) return;
      if (clearsFirst(ev.target)) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stop.current();
      returnTo(left.current, opener.current)?.focus();
    };
  }, []);
  const start = footStart === undefined ? null : fill(footStart, close);
  const end = foot === undefined ? null : fill(foot, close);
  return (
    <div class="drawer-wrap" ref={wrap}>
      <button
        type="button"
        class="drawer-back"
        aria-label="Close"
        tabIndex={-1}
        onClick={(ev) => {
          const row = swaps ? rowUnder(wrap.current, ev) : null;
          if (row) row.click();
          else close();
        }}
      />
      <div
        class={tall ? "drawer drawer-tall" : "drawer"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={label === undefined ? titleId : undefined}
        tabIndex={-1}
        ref={panel}
      >
        <div class="drawer-head">
          <h2 class="drawer-title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            class="btn-icon"
            aria-label="Close"
            onClick={close}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        {bare ? (
          fill(children, close)
        ) : (
          <div class="drawer-body">{fill(children, close)}</div>
        )}
        {(start !== null || end !== null) && (
          <div class="drawer-foot">
            {start !== null && <div class="drawer-foot-start">{start}</div>}
            {end}
          </div>
        )}
      </div>
    </div>
  );
}

// the row's open control under a click on the backdrop, the drawer let
// through for the one lookup
function rowUnder(
  wrap: HTMLElement | null,
  ev: MouseEvent,
): HTMLElement | null {
  if (wrap === null) return null;
  wrap.style.pointerEvents = "none";
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  wrap.style.pointerEvents = "";
  return (
    el?.closest(".table-row-open")?.querySelector<HTMLElement>(".table-open") ??
    null
  );
}
