// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A button and the menu it opens, on lib/menu.ts: a click outside or
// Escape closes it, an item 44px to a finger. Items run an action, open
// a link, or pick one choice of several (checked).

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon, type IconName } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import "./menu.css";

export type MenuItem = {
  label: ComponentChildren;
  // the item's identity when its label is not a string
  key?: string;
  icon?: IconName;
  run?: () => void;
  // a link instead of an action
  href?: string;
  download?: boolean;
  danger?: boolean;
  // one choice of several: true for the one picked, false for the others
  checked?: boolean;
};

export function MenuItems({
  items,
  close,
}: {
  items: readonly MenuItem[];
  close: () => void;
}) {
  return (
    <>
      {items.map((it) => {
        const key = it.key ?? String(it.label);
        const choice = it.checked !== undefined;
        const cls = `menu-item${it.danger ? " menu-item-danger" : ""}${
          it.checked ? " menu-item-on" : ""
        }`;
        const body = (
          <>
            {it.icon && <Icon name={it.icon} size={14} />}
            {choice ? <span class="cut">{it.label}</span> : it.label}
            {it.checked && (
              <Icon name="check" size={14} class="menu-item-check" />
            )}
          </>
        );
        return it.href ? (
          <a
            key={key}
            class={cls}
            role="menuitem"
            href={it.href}
            download={it.download}
            onClick={close}
          >
            {body}
          </a>
        ) : choice ? (
          <button
            key={key}
            type="button"
            class={cls}
            role="menuitemradio"
            aria-checked={it.checked}
            onClick={() => {
              close();
              it.run?.();
            }}
          >
            {body}
          </button>
        ) : (
          <button
            key={key}
            type="button"
            class={cls}
            role="menuitem"
            onClick={() => {
              close();
              it.run?.();
            }}
          >
            {body}
          </button>
        );
      })}
    </>
  );
}

export function MenuButton({
  label,
  items,
  children,
  icon = "more",
  face,
  text,
  field,
  buttonClass,
  menuClass,
  head,
  left,
  disabled,
  back,
  onOpen,
}: {
  // the button's name for a screen reader, such as "Actions for AAPL"
  label: string;
  items?: readonly MenuItem[];
  // a menu of its own making, given its close; used when items are not
  children?: (close: () => void) => ComponentChildren;
  icon?: IconName;
  // the button's face in place of the icon, such as a spinner
  face?: ComponentChildren;
  // a word and a caret in place of the icon, such as a currency picked
  text?: ComponentChildren;
  // with text: a form's field, as wide and as framed as an input, its
  // menu as wide as it
  field?: boolean;
  buttonClass?: string;
  menuClass?: string;
  // a page head's button, framed as the head's others; else a row's
  head?: boolean;
  // the menu opens to the button's left edge, not its right
  left?: boolean;
  disabled?: boolean;
  // takes Escape first while a pane inside is open; true when it did
  back?: () => boolean;
  onOpen?: () => void;
}) {
  const { open, root } = useMenu(back);
  const pop = useRef<HTMLDivElement>(null);
  // a menu low in a drawer's scrolling body opens past its edge: the
  // body scrolls just enough to show it all. Only that body: scrolling
  // into view from a page's sticky head moves the page under it
  useEffect(() => {
    const menu = pop.current;
    const body = menu?.closest<HTMLElement>(".drawer-body");
    if (!open.value || !menu || !body) return;
    const past =
      menu.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
    if (past > 0) body.scrollTop += past;
  }, [open.value]);
  const close = () => {
    open.value = false;
  };
  if (items !== undefined && items.length === 0) return null;
  const look =
    text !== undefined
      ? field
        ? "menu-btn-field"
        : "menu-btn-text"
      : head
        ? "btn menu-btn-head"
        : "btn-icon menu-btn";
  return (
    <span class={`menu-at${field ? " menu-at-field" : ""}`} ref={root}>
      <button
        type="button"
        class={buttonClass ? `${look} ${buttonClass}` : look}
        aria-label={label}
        title={head || text !== undefined ? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open.value}
        disabled={disabled}
        onClick={() => {
          if (!open.value) onOpen?.();
          open.value = !open.value;
        }}
      >
        {text !== undefined ? (
          <>
            {field ? <span class="cut">{text}</span> : text}
            <Icon name="chevron" size={14} />
          </>
        ) : (
          (face ?? <Icon name={icon} size={16} />)
        )}
      </button>
      {open.value && (
        <div
          class={`menu menu-pop${left ? " menu-pop-left" : ""}${
            field ? " menu-pop-field" : ""
          }${menuClass ? ` ${menuClass}` : ""}`}
          role="menu"
          aria-label={label}
          ref={pop}
        >
          {items ? (
            <MenuItems items={items} close={close} />
          ) : (
            children?.(close)
          )}
        </div>
      )}
    </span>
  );
}

// a heading inside a menu, and a line of figures that is not a choice
export function MenuHead({ children }: { children: ComponentChildren }) {
  return <div class="menu-head">{children}</div>;
}

export function MenuLine({
  label,
  value,
  faint,
}: {
  label?: ComponentChildren;
  value: ComponentChildren;
  faint?: boolean;
}) {
  return (
    <div class={`menu-line num${faint ? " faint" : ""}`}>
      {label !== undefined && <span class="faint">{label}</span>}
      <span>{value}</span>
    </div>
  );
}
