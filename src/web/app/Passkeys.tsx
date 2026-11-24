// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// This origin's passkeys in a drawer the user menu opens, and the flag that
// opens the sign-in card's passkey step after an emailed sign-in.

import { effect, untracked, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { markets, type Store } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Notice } from "../ui/Notice.tsx";
import { Placeholder } from "../ui/Placeholder.tsx";
import {
  elsewhere,
  type PasskeyItem,
  passkeyLines,
  takeSignedIn,
} from "./Passkeys.model.ts";
import "./passkeys.css";

const zone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

// the address the passkey step's flag rides on
export type Address = { search(): string; replace(search: string): void };

const browserAddress: Address = {
  search: () => location.search,
  replace: (search) =>
    history.replaceState(
      history.state,
      "",
      location.pathname + search + location.hash,
    ),
};

// a key or passkey sign-in asks no step: drop a stale flag
export function dropSignedIn(address: Address = browserAddress): void {
  const t = takeSignedIn(address.search());
  if (t.found) address.replace(t.search);
}

export function watchStep(
  store: Store = markets,
  address: Address = browserAddress,
): () => void {
  return effect(() => {
    const me = store.me.value;
    if (store.signedIn.value !== true || me === null) return;
    untracked(() => {
      const t = takeSignedIn(address.search());
      if (!t.found) return;
      address.replace(t.search);
      void store.passkeys.considerStep();
    });
  });
}

export function PasskeysItem({ onOpen }: { onOpen?: () => void }) {
  if (!markets.passkeys.support.value) return null;
  return (
    <button
      type="button"
      class="menu-item"
      aria-haspopup="dialog"
      onClick={() => {
        onOpen?.();
        markets.passkeys.error.value = null;
        markets.passkeys.open.value = true;
      }}
    >
      <Icon name="key" size={14} />
      <span>Passkeys</span>
    </button>
  );
}

export function PasskeysDrawer({ store = markets }: { store?: Store }) {
  const open = store.passkeys.open;
  if (!open.value || store.signedIn.value !== true) return null;
  return (
    <PasskeysList
      store={store}
      onClose={() => {
        open.value = false;
      }}
    />
  );
}

export function PasskeysList({
  store,
  onClose,
}: {
  store: Store;
  onClose: () => void;
}) {
  const p = store.passkeys;
  useEffect(() => {
    void p.read();
    return p.prime("add");
  }, [p]);
  const all = p.list.value;
  return (
    <Drawer
      title="Passkeys"
      onClose={onClose}
      busy={p.busy.value}
      foot={
        <button
          type="button"
          class="btn btn-small btn-primary"
          disabled={p.busy.value || p.waiting("add")}
          onClick={() => void p.add()}
        >
          {p.busy.value ? "Adding" : "Add a passkey"}
        </button>
      }
    >
      {all === null ? (
        p.error.value === null && <Placeholder band />
      ) : all.length === 0 ? (
        <Notice>No passkeys yet.</Notice>
      ) : (
        <ul class="passkeys">
          {all.map((k) => (
            <PasskeyRow
              key={k.id}
              store={store}
              passkey={k}
              at={elsewhere(k, p.origin())}
            />
          ))}
        </ul>
      )}
      {p.error.value !== null && <Notice error>{p.error.value}</Notice>}
    </Drawer>
  );
}

function PasskeyRow({
  store,
  passkey,
  at,
}: {
  store: Store;
  passkey: PasskeyItem;
  // the other address it signs in at; null for this one
  at: string | null;
}) {
  const asking = useSignal(false);
  const removing = useSignal(false);
  const error = useSignal<string | null>(null);
  const l = passkeyLines(passkey, Date.now(), zone());
  return (
    <li class="passkeys-row">
      <div class="passkeys-words">
        <span>{passkey.device}</span>
        <span class="passkeys-when small faint">
          <span>{l.added}</span>
          {l.used !== null && (
            <>
              {" · "}
              <span>{l.used}</span>
            </>
          )}
          {at !== null && (
            <>
              {" · "}
              <span>{at}</span>
            </>
          )}
        </span>
      </div>
      <div class="passkeys-actions">
        {asking.value ? (
          <>
            <span class="faint">Remove this passkey?</span>
            <button
              type="button"
              class="btn btn-small"
              disabled={removing.value}
              onClick={() => {
                asking.value = false;
              }}
            >
              Keep
            </button>
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={removing.value}
              onClick={async () => {
                if (removing.value) return;
                removing.value = true;
                error.value = await store.passkeys.remove(passkey.id);
                removing.value = false;
                asking.value = false;
              }}
            >
              {removing.value ? "Removing" : "Remove"}
            </button>
          </>
        ) : (
          <button
            type="button"
            class="btn btn-small"
            aria-label={`Remove ${passkey.device}`}
            onClick={() => {
              error.value = null;
              asking.value = true;
            }}
          >
            <Icon name="trash" size={14} /> Remove
          </button>
        )}
      </div>
      {error.value && (
        <span class="error" role="alert">
          {error.value}
        </span>
      )}
    </li>
  );
}
