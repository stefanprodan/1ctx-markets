// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Connect agents, as 1ctx's: the keys with Revoke and New key, then a setup
// tab per agent. A made key's token lives in this view alone, so Done or
// leaving the page drops it.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
  type AgentKey,
  type KeyAccess,
  markets,
  type Store,
} from "../data/store.ts";
import { copyText } from "../lib/clipboard.ts";
import { Icon } from "../lib/icons.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Rows, RowsCard, RowsLine, RowsNote, RowsTitle } from "../ui/Rows.tsx";
import {
  ACCESS_OPTIONS,
  AGENTS,
  type Agent,
  accessWords,
  capLine,
  EXPIRY_OPTIONS,
  expired,
  expiryWords,
  exportLine,
  nameReady,
  SHOWN_ONCE,
  setupLine,
  shapeName,
  usedWords,
} from "./Connect.model.ts";
import "./connect.css";

// a box of text to paste elsewhere, with a copy button in its corner that
// says Copied only when the copy landed
export function Snippet({
  label,
  text,
  hint,
}: {
  label: string;
  text: string;
  hint?: string;
}) {
  const copied = useSignal(false);
  useEffect(() => {
    if (!copied.value) return;
    const timer = setTimeout(() => {
      copied.value = false;
    }, 1200);
    return () => clearTimeout(timer);
  }, [copied.value]);
  return (
    <div class="field">
      <span class="label">{label}</span>
      <div class="connect-snippet">
        <pre class="connect-snippet-text">{text}</pre>
        <button
          type="button"
          class="btn-icon connect-snippet-copy"
          title={copied.value ? "Copied" : "Copy"}
          aria-label={`Copy ${label}`}
          onClick={() => {
            void copyText(text).then((ok) => {
              copied.value = ok;
            });
          }}
        >
          <Icon name={copied.value ? "check" : "copy"} size={14} />
        </button>
      </div>
      {hint !== undefined && <span class="connect-hint">{hint}</span>}
    </div>
  );
}

export function ShownKey({
  token,
  onDone,
}: {
  token: string;
  onDone: () => void;
}) {
  return (
    <div class="rows-item rows-item-open connect-block">
      <p class="connect-once" role="status">
        {SHOWN_ONCE}
      </p>
      <Snippet label="Key" text={token} />
      <Snippet
        label="Environment"
        text={exportLine(token)}
        hint="In your shell profile."
      />
      <div class="connect-foot">
        <button type="button" class="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

export function NewKey({
  store,
  onMade,
  onCancel,
}: {
  store: Store;
  onMade: (token: string) => void;
  onCancel: () => void;
}) {
  const name = useSignal("");
  const days = useSignal<number | null>(null);
  const access = useSignal<KeyAccess>("none");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value || !nameReady(name.value)) return;
    busy.value = true;
    error.value = null;
    try {
      const made = await store.createKey(name.value, days.value, access.value);
      onMade(made.token);
    } catch (err) {
      error.value = (err as Error).message;
      busy.value = false;
    }
  };
  return (
    <form class="rows-item rows-item-open connect-block" onSubmit={submit}>
      <div class="connect-pair">
        <label class="field">
          <span class="label">Name</span>
          <input
            ref={input}
            name="name"
            value={name.value}
            placeholder="claude-code"
            autocomplete="off"
            spellcheck={false}
            aria-invalid={error.value !== null}
            onInput={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              name.value = shapeName(el.value);
              el.value = name.value;
              error.value = null;
            }}
          />
        </label>
        <fieldset class="field connect-set">
          <legend class="label">Expires</legend>
          <div class="seg">
            {EXPIRY_OPTIONS.map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={days.value === o.value}
                class={`seg-option${days.value === o.value ? " seg-on" : ""}`}
                disabled={busy.value}
                onClick={() => {
                  days.value = o.value;
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <fieldset class="field connect-set">
        <legend class="label">Portfolios</legend>
        <div class="seg">
          {ACCESS_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={access.value === o.value}
              class={`seg-option${access.value === o.value ? " seg-on" : ""}`}
              disabled={busy.value}
              onClick={() => {
                access.value = o.value;
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div class="connect-foot">
        {error.value !== null && (
          <p class="connect-error" role="alert">
            {error.value}
          </p>
        )}
        <button
          type="button"
          class="btn"
          disabled={busy.value}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          disabled={busy.value || !nameReady(name.value)}
        >
          {busy.value ? "Creating" : "Create key"}
        </button>
      </div>
    </form>
  );
}

export function KeyRow({
  store,
  row,
  now,
}: {
  store: Store;
  row: AgentKey;
  now: number;
}) {
  const asking = useSignal(false);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const gone = expired(row, now);
  return (
    <RowsLine flush>
      <Icon name="key" size={14} class="connect-key-icon" />
      <RowsTitle
        name={<span class="cut connect-key-name">{row.name}</span>}
        sub={
          <>
            {`${usedWords(row, now)} · `}
            <span class={gone ? "rows-bad" : undefined}>
              {expiryWords(row, now)}
            </span>
            {accessWords(row) && ` · ${accessWords(row)}`}
          </>
        }
        prose
      />
      <span class="rows-end">
        {error.value !== null && (
          <span class="rows-end-words rows-bad" role="alert">
            {error.value}
          </span>
        )}
        {asking.value ? (
          <>
            <span class="rows-end-words">Agents using it lose access.</span>
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={busy.value}
              onClick={async () => {
                busy.value = true;
                error.value = await store.revokeKey(row.id);
                busy.value = false;
                asking.value = false;
              }}
            >
              {busy.value ? "Revoking" : "Revoke"}
            </button>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
              onClick={() => {
                asking.value = false;
              }}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            class="btn btn-small"
            aria-label={`Revoke ${row.name}`}
            onClick={() => {
              error.value = null;
              asking.value = true;
            }}
          >
            Revoke
          </button>
        )}
      </span>
    </RowsLine>
  );
}

export function Keys({
  store,
  shown,
}: {
  store: Store;
  shown: Signal<string | null>;
}) {
  const keys = store.keys.value ?? [];
  const limit = store.keysLimit.value ?? 0;
  const adding = useSignal(false);
  const full = keys.length >= limit;
  const now = Date.now();
  return (
    <RowsCard
      label="Keys"
      count={`${keys.length} of ${limit}`}
      action={
        full ? undefined : (
          <button
            type="button"
            class="btn btn-small rows-add"
            aria-label="New key"
            disabled={adding.value || shown.value !== null}
            onClick={() => {
              adding.value = true;
            }}
          >
            <Icon name="plus" size={14} />
            <span class="rows-add-words">New key</span>
          </button>
        )
      }
    >
      {shown.value !== null && (
        <ShownKey
          token={shown.value}
          onDone={() => {
            shown.value = null;
          }}
        />
      )}
      {adding.value && (
        <NewKey
          store={store}
          onMade={(token) => {
            adding.value = false;
            shown.value = token;
          }}
          onCancel={() => {
            adding.value = false;
          }}
        />
      )}
      {keys.length === 0 && !adding.value && <RowsNote>No keys yet.</RowsNote>}
      {keys.map((k) => (
        <KeyRow key={k.id} store={store} row={k} now={now} />
      ))}
      {full && <RowsNote>{capLine(limit)}</RowsNote>}
    </RowsCard>
  );
}

export function Setup({ origin }: { origin: string }) {
  const agent = useSignal<Agent>("claude");
  const line = setupLine(origin, agent.value);
  return (
    <RowsCard
      label="Setup"
      action={
        <div
          class="seg seg-small connect-tabs"
          role="tablist"
          aria-label="Agent"
        >
          {AGENTS.map((a) => (
            <button
              key={a.agent}
              type="button"
              role="tab"
              aria-selected={agent.value === a.agent}
              class={`seg-option${agent.value === a.agent ? " seg-on" : ""}`}
              onClick={() => {
                agent.value = a.agent;
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      }
    >
      <div class="rows-item connect-block">
        <Snippet
          key={agent.value}
          label={line.label}
          text={line.text}
          hint={line.hint}
        />
      </div>
    </RowsCard>
  );
}

export function ConnectBody({ store }: { store: Store }) {
  // the token made here, gone on Done or when the view goes
  const shown = useSignal<string | null>(null);
  const held = store.keys.value !== null;
  const origin = globalThis.location?.origin ?? "";
  return (
    <Page
      title="Connect agents"
      stale={held ? store.keysError.value : null}
      staleCount={store.keysFailures.value}
      failed={didNotLoad(
        held,
        store.keysError.value,
        store.keysCode.value,
        () => void store.loadKeys(),
      )}
    >
      {held && (
        <div class="connect">
          <Rows>
            <Keys store={store} shown={shown} />
          </Rows>
          <Rows>
            <Setup origin={origin} />
          </Rows>
        </div>
      )}
    </Page>
  );
}

export function Connect() {
  return <ConnectBody store={markets} />;
}
