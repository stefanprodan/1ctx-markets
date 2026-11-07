// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Connect agents, as 1ctx's: the keys, each opening to its access and Revoke,
// and New key, then a setup tab per agent. A made key's token lives in this
// view alone, so Done or leaving the page drops it.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useId, useRef } from "preact/hooks";
import {
  type AgentKey,
  type KeyAccess,
  type KeyAccesses,
  markets,
  type Store,
} from "../data/store.ts";
import { copyText } from "../lib/clipboard.ts";
import { Icon } from "../lib/icons.tsx";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Facts } from "../ui/Figures.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { type Column, Table } from "../ui/Table.tsx";
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
      {hint !== undefined && <span class="small faint">{hint}</span>}
    </div>
  );
}

// the made key, once, in the drawer it was made in
export function ShownKey({ token }: { token: string }) {
  return (
    <>
      <p class="connect-once" role="status">
        {SHOWN_ONCE}
      </p>
      <Snippet label="Key" text={token} />
      <Snippet
        label="Environment"
        text={exportLine(token)}
        hint="In your shell profile."
      />
    </>
  );
}

function AccessPick({
  label,
  value,
  busy,
}: {
  label: string;
  value: Signal<KeyAccess>;
  busy: boolean;
}) {
  return (
    <div class="field">
      <span class="label">{label}</span>
      <Segmented
        label={label}
        options={ACCESS_OPTIONS.map((o) => ({ value: o.value, text: o.label }))}
        value={value.value}
        disabled={busy}
        onPick={(v) => {
          value.value = v;
        }}
      />
    </div>
  );
}

// what a key opens beyond market data: portfolios, alerts with their
// history, the owner's profile and the shared analysis
export function AccessPicks({
  portfolio,
  alerts,
  profile,
  analysis,
  tradePlans,
  busy,
}: {
  portfolio: Signal<KeyAccess>;
  alerts: Signal<KeyAccess>;
  profile: Signal<KeyAccess>;
  analysis: Signal<KeyAccess>;
  tradePlans: Signal<KeyAccess>;
  busy: boolean;
}) {
  return (
    <>
      <AccessPick label="Portfolios" value={portfolio} busy={busy} />
      <AccessPick label="Alerts" value={alerts} busy={busy} />
      <AccessPick label="Profile" value={profile} busy={busy} />
      <AccessPick label="Analysis" value={analysis} busy={busy} />
      <AccessPick label="Trade plans" value={tradePlans} busy={busy} />
    </>
  );
}

// Segmented picks words; the server takes days or none
const NEVER = "never";
const expiryKey = (days: number | null) =>
  days === null ? NEVER : String(days);

// the new key's form, then, in the same drawer, the key it made
export function NewKey({
  store,
  shown,
  onClose,
}: {
  store: Store;
  shown: Signal<string | null>;
  onClose: () => void;
}) {
  const name = useSignal("");
  const days = useSignal<number | null>(null);
  const portfolio = useSignal<KeyAccess>("none");
  const alerts = useSignal<KeyAccess>("none");
  const profile = useSignal<KeyAccess>("none");
  const analysis = useSignal<KeyAccess>("none");
  const tradePlans = useSignal<KeyAccess>("none");
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useId();
  useEffect(() => input.current?.focus(), []);
  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value || !nameReady(name.value)) return;
    busy.value = true;
    error.value = null;
    try {
      const made = await store.createKey(name.value, days.value, {
        portfolio: portfolio.value,
        alerts: alerts.value,
        profile: profile.value,
        analysis: analysis.value,
        trade_plans: tradePlans.value,
      });
      busy.value = false;
      shown.value = made.token;
    } catch (err) {
      error.value = (err as Error).message;
      busy.value = false;
    }
  };
  return (
    <Drawer
      title="New key"
      onClose={onClose}
      busy={busy.value}
      foot={(close) =>
        shown.value !== null ? (
          <button
            type="button"
            class="btn btn-small btn-primary"
            onClick={close}
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              form={form}
              class="btn btn-small btn-primary"
              disabled={busy.value || !nameReady(name.value)}
            >
              {busy.value ? "Creating" : "Create key"}
            </button>
          </>
        )
      }
    >
      {shown.value !== null ? (
        <ShownKey token={shown.value} />
      ) : (
        <form id={form} class="connect-form" onSubmit={submit}>
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
          <div class="field">
            <span class="label">Expires</span>
            <Segmented
              label="Expires"
              options={EXPIRY_OPTIONS.map((o) => ({
                value: expiryKey(o.value),
                text: o.label,
              }))}
              value={expiryKey(days.value)}
              disabled={busy.value}
              onPick={(v) => {
                days.value = v === NEVER ? null : Number(v);
              }}
            />
          </div>
          <AccessPicks
            portfolio={portfolio}
            alerts={alerts}
            profile={profile}
            analysis={analysis}
            tradePlans={tradePlans}
            busy={busy.value}
          />
          {error.value !== null && <Notice error>{error.value}</Notice>}
        </form>
      )}
    </Drawer>
  );
}

// a key's details: when it was used and ends, its picks saved on the kept
// key, and Revoke, asked once before it cuts the agents off
// a key of the person signed in; an admin also lists everyone else's
export const ownKey = (k: AgentKey, me: string | null): boolean =>
  k.owner === undefined || me === null || k.owner.id === me;

export function KeyDetails({
  store,
  row,
  now,
  own = true,
  onDone,
}: {
  store: Store;
  row: AgentKey;
  now: number;
  // another person's key: an admin revokes it but never changes it
  own?: boolean;
  // told whether the key was revoked, once the drawer has slid out
  onDone: (revoked: boolean) => void;
}) {
  const portfolio = useSignal<KeyAccess>(row.portfolio ?? "none");
  const alerts = useSignal<KeyAccess>(row.alerts ?? "none");
  const profile = useSignal<KeyAccess>(row.profile ?? "none");
  const analysis = useSignal<KeyAccess>(row.analysis ?? "none");
  const tradePlans = useSignal<KeyAccess>(row.trade_plans ?? "none");
  const busy = useSignal(false);
  const asking = useSignal(false);
  const error = useSignal<string | null>(null);
  const form = useId();
  // a save or a revoke done slides the drawer out as Cancel does, once
  // the render that ends busy lets it close
  const closer = useRef<() => void>(() => {});
  const leaving = useSignal(false);
  const revoked = useRef(false);
  useEffect(() => {
    if (leaving.value) closer.current();
  }, [leaving.value]);
  const next: KeyAccesses = {
    portfolio: portfolio.value,
    alerts: alerts.value,
    profile: profile.value,
    analysis: analysis.value,
    trade_plans: tradePlans.value,
  };
  const same =
    next.portfolio === (row.portfolio ?? "none") &&
    next.alerts === (row.alerts ?? "none") &&
    next.profile === (row.profile ?? "none") &&
    next.analysis === (row.analysis ?? "none") &&
    next.trade_plans === (row.trade_plans ?? "none");
  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy.value || same) return;
    busy.value = true;
    error.value = null;
    try {
      await store.setKeyAccess(row.id, next);
      busy.value = false;
      leaving.value = true;
    } catch (err) {
      error.value = (err as Error).message;
      busy.value = false;
    }
  };
  const revoke = async () => {
    busy.value = true;
    error.value = await store.revokeKey(row.id);
    busy.value = false;
    if (error.value === null) {
      revoked.current = true;
      leaving.value = true;
      return;
    }
    asking.value = false;
  };
  return (
    <Drawer
      title={row.name}
      onClose={() => onDone(revoked.current)}
      busy={busy.value}
      footStart={
        asking.value ? (
          "Agents using it lose access."
        ) : (
          <button
            type="button"
            class="btn btn-small"
            aria-label={`Revoke ${row.name}`}
            disabled={busy.value}
            onClick={() => {
              error.value = null;
              asking.value = true;
            }}
          >
            Revoke
          </button>
        )
      }
      foot={(close) => {
        closer.current = close;
        return asking.value ? (
          <>
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
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={busy.value}
              onClick={revoke}
            >
              {busy.value ? "Revoking" : "Revoke"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
              onClick={close}
            >
              Cancel
            </button>
            {own && (
              <button
                type="submit"
                form={form}
                class="btn btn-small btn-primary"
                disabled={busy.value || same}
              >
                {busy.value ? "Saving" : "Save"}
              </button>
            )}
          </>
        );
      }}
    >
      <Facts
        items={[
          ...(own || row.owner === undefined
            ? []
            : [{ label: "Owner", value: row.owner.name }]),
          { label: "Last used", value: usedWords(row, now) },
          {
            label: "Expires",
            value: (
              <span class={expired(row, now) ? "error" : undefined}>
                {expiryWords(row, now)}
              </span>
            ),
          },
        ]}
      />
      <form id={form} class="connect-form" onSubmit={submit}>
        <AccessPicks
          portfolio={portfolio}
          alerts={alerts}
          profile={profile}
          analysis={analysis}
          tradePlans={tradePlans}
          busy={busy.value || !own}
        />
      </form>
      {error.value !== null && <Notice error>{error.value}</Notice>}
    </Drawer>
  );
}

export function keyColumns(
  keys: readonly AgentKey[],
  now: number,
  // an admin's list holds everyone's keys
  owners = false,
): Column<AgentKey>[] {
  return [
    {
      key: "name",
      head: "Name",
      width: "minmax(0, 1.4fr)",
      cell: (k) => <span class="cut">{k.name}</span>,
    },
    {
      key: "owner",
      head: "Owner",
      width: "minmax(0, 1fr)",
      show: owners,
      cell: (k) => <span class="cut faint">{k.owner?.name ?? ""}</span>,
    },
    {
      key: "used",
      head: "Last used",
      width: "minmax(0, 1fr)",
      hide: "phone",
      cell: (k) => <span class="faint">{usedWords(k, now)}</span>,
    },
    {
      key: "expires",
      head: "Expires",
      width: { base: "minmax(0, 1fr)", phone: "100px" },
      align: "end",
      cell: (k) => (
        <span class={expired(k, now) ? "error" : "faint"}>
          {expiryWords(k, now)}
        </span>
      ),
    },
    {
      key: "access",
      head: "Access",
      width: "minmax(0, 1.4fr)",
      align: "end",
      hide: "phone",
      // many keys reach no portfolio, rule, profile or analysis
      show: keys.some((k) => accessWords(k) !== null),
      cell: (k) => <span class="faint">{accessWords(k) ?? ""}</span>,
    },
  ];
}

// the new key's drawer gone, and the token it showed with it
export function dropNewKey(
  adding: Signal<boolean>,
  shown: Signal<string | null>,
): void {
  adding.value = false;
  shown.value = null;
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
  const admin = store.isAdmin.value;
  const me = store.me.value?.id ?? null;
  // the cap is each person's own
  const own = keys.filter((k) => ownKey(k, me));
  const adding = useSignal(false);
  // the key as opened, so its drawer slides out after a revoke drops it
  const opened = useSignal<AgentKey | null>(null);
  const newKey = useRef<HTMLButtonElement>(null);
  const refocus = useSignal(false);
  const full = own.length >= limit;
  const now = Date.now();
  const open =
    opened.value === null
      ? undefined
      : (keys.find((k) => k.id === opened.value!.id) ?? opened.value);
  // the revoked key's row went with the focus it would return to
  useEffect(() => {
    if (!refocus.value || opened.value !== null) return;
    refocus.value = false;
    newKey.current?.focus();
  }, [refocus.value, opened.value]);
  // the drawers sit beside the card: inside, the table would stop being its
  // last child and the card's bottom padding would grow while one is open
  return (
    <>
      <Card
        title="Keys"
        count={`${own.length} of ${limit}`}
        actions={
          full ? undefined : (
            <button
              ref={newKey}
              type="button"
              class="btn btn-small"
              onClick={() => {
                adding.value = true;
              }}
            >
              <Icon name="plus" size={14} />
              New key
            </button>
          )
        }
      >
        <Table
          label="Keys"
          columns={keyColumns(keys, now, admin)}
          rows={keys}
          rowKey={(k) => k.id}
          open={(k) => ({
            run: () => {
              opened.value = k;
            },
          })}
          rowLabel={(k) => k.name}
          empty="No keys yet."
        />
        {full && <Notice>{capLine(limit)}</Notice>}
      </Card>
      {(adding.value || shown.value !== null) && (
        <NewKey
          store={store}
          shown={shown}
          onClose={() => dropNewKey(adding, shown)}
        />
      )}
      {open !== undefined && (
        <KeyDetails
          key={open.id}
          store={store}
          row={open}
          now={now}
          own={ownKey(open, me)}
          onDone={(revoked) => {
            opened.value = null;
            refocus.value = revoked;
          }}
        />
      )}
    </>
  );
}

export function Setup({ origin }: { origin: string }) {
  const agent = useSignal<Agent>("claude");
  const line = setupLine(origin, agent.value);
  return (
    <Card
      title="Setup"
      actions={
        <Segmented
          label="Agent"
          small
          options={AGENTS.map((a) => ({ value: a.agent, text: a.label }))}
          value={agent.value}
          onPick={(v) => {
            agent.value = v;
          }}
        />
      }
    >
      <Snippet
        key={agent.value}
        label={line.label}
        text={line.text}
        hint={line.hint}
      />
    </Card>
  );
}

function KeysWaiting() {
  return (
    <Card title="Keys">
      <Table
        label="Keys"
        columns={keyColumns([], Date.now())}
        rowKey={(k) => k.id}
        waiting={2}
      />
    </Card>
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
      <div class="connect">
        {held ? <Keys store={store} shown={shown} /> : <KeysWaiting />}
        <Setup origin={origin} />
      </div>
    </Page>
  );
}

export function Connect() {
  return <ConnectBody store={markets} />;
}
