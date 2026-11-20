// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { BoardSection } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { deleteLine, isinInput } from "./Instrument.model.ts";

export const SAID_MS = 2000;

type Pane = "delete" | "home" | "isin" | null;

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
  isin,
  onIsin,
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
  // a listing's ISIN, an admin's to set; null while none is
  isin?: string | null;
  // null once saved, else what to say
  onIsin?: (isin: string | null) => Promise<string | null>;
}) {
  const pane = useSignal<Pane>(null);
  const draft = useSignal("");
  const said = useSignal<string | null>(null);
  const saving = useSignal(false);
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: Pane) => {
    ev.stopPropagation();
    pane.value = to;
    if (to === "isin") {
      draft.value = isin ?? "";
      said.value = null;
    }
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
        ) : pane.value === "isin" && onIsin ? (
          <IsinPane
            draft={draft}
            said={said}
            saving={saving}
            onBack={(ev) => swap(ev, null)}
            onSave={async (value) => {
              saving.value = true;
              const error = await onIsin(value);
              saving.value = false;
              if (error !== null) {
                said.value = error;
                return;
              }
              close();
              pane.value = null;
            }}
          />
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
                {onIsin && (
                  <button
                    type="button"
                    class="menu-item"
                    role="menuitem"
                    onClick={(ev) => swap(ev, "isin")}
                  >
                    <Icon name="pencil" size={14} />
                    Set ISIN
                  </button>
                )}
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

// checked as the server checks it, so a typo is said before a call
function IsinPane({
  draft,
  said,
  saving,
  onBack,
  onSave,
}: {
  draft: Signal<string>;
  said: Signal<string | null>;
  saving: Signal<boolean>;
  onBack: (ev: MouseEvent) => void;
  onSave: (isin: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  // the pane replaces the clicked item, so focus would stay on nothing
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      class="ins-ask"
      onSubmit={(ev) => {
        ev.preventDefault();
        const v = isinInput(draft.value);
        if (v === undefined) said.value = "Not a valid ISIN.";
        else onSave(v);
      }}
    >
      <label class="field">
        <span class="label">ISIN</span>
        <input
          ref={input}
          value={draft.value}
          autocomplete="off"
          spellcheck={false}
          maxLength={12}
          disabled={saving.value}
          onInput={(e) => {
            draft.value = (e.currentTarget as HTMLInputElement).value;
            said.value = null;
          }}
        />
      </label>
      {said.value === null ? (
        <p class="ins-ask-line small faint">Leave empty to remove it.</p>
      ) : (
        <p class="ins-ask-line small error" role="alert">
          {said.value}
        </p>
      )}
      <div class="ins-ask-foot">
        <button
          type="button"
          class="btn btn-small"
          disabled={saving.value}
          onClick={onBack}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="btn btn-small btn-primary"
          disabled={saving.value}
        >
          Save
        </button>
      </div>
    </form>
  );
}
