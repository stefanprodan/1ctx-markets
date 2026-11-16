// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { BoardSection } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { deleteLine } from "./Instrument.model.ts";

export const SAID_MS = 2000;

export type HomeChoice = {
  // null until Home's layout is read, and while it is filling in
  sections: readonly BoardSection[] | null;
  // the section holding the symbol, or -1
  at: number;
  onAdd: (section: number) => void;
  onRemove: () => void;
};

export function InstrumentMenu({
  symbol,
  admin,
  busy,
  done,
  removing,
  home,
  onWrite,
  onPrice,
  onRefetch,
  onDelete,
}: {
  symbol: string;
  // refetch and delete are an admin's
  admin: boolean;
  busy: boolean;
  done: boolean;
  removing: boolean;
  // Home holds market symbols, never a fund the owner prices
  home?: HomeChoice;
  // only while the symbol has no analysis yet
  onWrite?: () => void;
  // a fund the owner prices, while held
  onPrice?: () => void;
  onRefetch?: () => void;
  onDelete?: () => void;
}) {
  const pane = useSignal<"delete" | "home" | null>(null);
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: "delete" | "home" | null) => {
    ev.stopPropagation();
    pane.value = to;
  };
  const sections = home?.sections ?? null;
  return (
    <MenuButton
      head
      label="More"
      disabled={busy || removing}
      menuClass="ins-menu"
      onOpen={() => {
        pane.value = null;
      }}
      // Escape leaves the pane for the menu before it closes the menu
      back={() => {
        if (pane.value === null) return false;
        pane.value = null;
        return true;
      }}
      face={
        busy ? (
          <span class="spinner ins-spin" role="img" aria-label="Fetching" />
        ) : done ? (
          <Icon name="check" size={16} class="status-done" />
        ) : undefined
      }
    >
      {(close) =>
        pane.value === "delete" ? (
          <div class="ins-ask">
            <p class="ins-ask-title">Delete {symbol}?</p>
            <p class="ins-ask-line small faint">{deleteLine}</p>
            <div class="ins-ask-foot">
              <button
                type="button"
                class="btn btn-small"
                onClick={(ev) => swap(ev, null)}
              >
                Keep
              </button>
              <button
                type="button"
                class="btn btn-small btn-danger"
                onClick={() => {
                  close();
                  pane.value = null;
                  onDelete?.();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : pane.value === "home" && home && sections !== null ? (
          <>
            <p class="ins-pick small faint">Add to</p>
            {sections.map((s, i) => (
              <button
                key={i}
                type="button"
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  pane.value = null;
                  home.onAdd(i);
                }}
              >
                <span class="cut">{s.name}</span>
              </button>
            ))}
          </>
        ) : (
          <>
            {home === undefined ? null : home.at >= 0 ? (
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  home.onRemove();
                }}
              >
                <Icon name="home" size={14} />
                Remove from Home
              </button>
            ) : (
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                disabled={sections === null}
                onClick={(ev) => {
                  if (sections !== null && sections.length > 1) {
                    swap(ev, "home");
                    return;
                  }
                  close();
                  home.onAdd(0);
                }}
              >
                <Icon name="home" size={14} />
                Add to Home
              </button>
            )}
            {onWrite && (
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  onWrite();
                }}
              >
                <Icon name="pencil" size={14} />
                Write analysis
              </button>
            )}
            {onPrice && (
              <button
                type="button"
                class="menu-item"
                role="menuitem"
                onClick={() => {
                  close();
                  onPrice();
                }}
              >
                <Icon name="pencil" size={14} />
                Set price
              </button>
            )}
            {admin && onRefetch && onDelete && (
              <>
                <button
                  type="button"
                  class="menu-item"
                  role="menuitem"
                  onClick={() => {
                    close();
                    onRefetch();
                  }}
                >
                  <Icon name="redo" size={14} />
                  Refetch data
                </button>
                <button
                  type="button"
                  class="menu-item menu-item-danger"
                  role="menuitem"
                  onClick={(ev) => swap(ev, "delete")}
                >
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              </>
            )}
          </>
        )
      }
    </MenuButton>
  );
}
