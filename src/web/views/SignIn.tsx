// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { says } from "../data/api.ts";
import type { Store } from "../data/store.ts";
import { Logo } from "../lib/icons.tsx";
import "./signin.css";

export function SignIn({ store }: { store: Store }) {
  const key = useSignal("");
  const error = useSignal<string | null>(null);
  const busy = useSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value) return;
    busy.value = true;
    error.value = null;
    try {
      await store.signIn(key.value);
      key.value = "";
    } catch (err) {
      error.value = says(err);
    } finally {
      busy.value = false;
    }
  };

  return (
    <main class="signin">
      <div class="signin-brand">
        <Logo height={80} />
        <p class="signin-line">Markets</p>
      </div>
      <form class="signin-form card" onSubmit={submit}>
        <label class="field">
          <span class="label">Admin key</span>
          <input
            name="key"
            type="password"
            autocomplete="current-password"
            value={key.value}
            onInput={(e) => {
              key.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        {error.value && <p class="signin-error error">{error.value}</p>}
        <button type="submit" class="btn btn-primary" disabled={busy.value}>
          Sign in
        </button>
      </form>
    </main>
  );
}
