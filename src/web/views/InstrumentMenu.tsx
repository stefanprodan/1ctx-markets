// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { Icon } from "../lib/icons.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { deleteLine } from "./Instrument.model.ts";

export const SAID_MS = 2000;

// as 1ctx's More menu
export function InstrumentMenu({
  symbol,
  busy,
  done,
  removing,
  onRefetch,
  onDelete,
}: {
  symbol: string;
  busy: boolean;
  done: boolean;
  removing: boolean;
  onRefetch: () => void;
  onDelete: () => void;
}) {
  const asking = useSignal(false);
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: boolean) => {
    ev.stopPropagation();
    asking.value = to;
  };
  return (
    <MenuButton
      head
      label="More"
      disabled={busy || removing}
      menuClass="ins-menu"
      onOpen={() => {
        asking.value = false;
      }}
      // Escape leaves the question for the menu before it closes the menu
      back={() => {
        if (!asking.value) return false;
        asking.value = false;
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
        asking.value ? (
          <div class="ins-ask">
            <p class="ins-ask-title">Delete {symbol}?</p>
            <p class="ins-ask-line small faint">{deleteLine}</p>
            <div class="ins-ask-foot">
              <button
                type="button"
                class="btn btn-small"
                onClick={(ev) => swap(ev, false)}
              >
                Keep
              </button>
              <button
                type="button"
                class="btn btn-small btn-danger"
                onClick={() => {
                  close();
                  asking.value = false;
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
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
              onClick={(ev) => swap(ev, true)}
            >
              <Icon name="trash" size={14} />
              Delete
            </button>
          </>
        )
      }
    </MenuButton>
  );
}
