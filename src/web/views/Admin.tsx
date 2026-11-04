// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Server admin, for admins: Status at /admin (Status.tsx), Settings at
// /admin/settings and Users at /admin/users, the tab in the address as
// Portfolios keeps its portfolio. Only the operator changes or tests
// SMTP; another admin reads it.

import { effect, type Signal, signal, useSignal } from "@preact/signals";
import { useEffect, useId } from "preact/hooks";
import { ADMIN, ADMIN_SETTINGS, ADMIN_USERS } from "../app/paths.ts";
import { navigate, path } from "../app/router.ts";
import type { AdminStore, Person, Role, SmtpAnswer } from "../data/admin.ts";
import { markets, type Store } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Facts } from "../ui/Figures.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  CONFIRM,
  failureWords,
  fileOf,
  formOf,
  INVITE_SENT,
  invitable,
  inviteFailed,
  missingLine,
  NO_EMAIL,
  plainError,
  removeLine,
  type SmtpForm,
  seenWords,
  settingsOf,
  testLine,
} from "./Admin.model.ts";
import "./connect.css";
import "./admin.css";

const ROLES = [
  { value: "member" as const, text: "Member" },
  { value: "admin" as const, text: "Admin" },
];

// detail: the SMTP server's own reply, on a faint line under the words
type Said = { text: string; error?: boolean; detail?: string };

// a refusal in the page's words, never the server's
const plainSaid = (said: Said | null): Said | null =>
  said?.error ? { ...said, text: plainError(said.text) } : said;

export function peopleColumns(
  me: string | null,
  now: number,
): Column<Person>[] {
  return [
    {
      key: "name",
      head: "Name",
      width: "minmax(0, 1.2fr)",
      cell: (p) => (
        <span class="cut">
          {p.name}
          {p.id === me && <span class="faint admin-tag">you</span>}
        </span>
      ),
    },
    {
      key: "email",
      head: "Email",
      width: "minmax(0, 1.6fr)",
      hide: "phone",
      cell: (p) => <span class="cut faint">{p.email ?? "Admin key"}</span>,
    },
    {
      key: "role",
      head: "Role",
      width: { base: "minmax(0, 0.8fr)", phone: "80px" },
      cell: (p) => (
        <span class="faint">{p.role === "admin" ? "Admin" : "Member"}</span>
      ),
    },
    {
      key: "seen",
      head: "Last sign-in",
      width: "minmax(0, 1fr)",
      align: "end",
      cell: (p) => <span class="faint">{seenWords(p, now)}</span>,
    },
  ];
}

function AddPerson({
  admin,
  emailOn,
  onClose,
}: {
  admin: AdminStore;
  emailOn: boolean;
  onClose: () => void;
}) {
  const name = useSignal("");
  const email = useSignal("");
  const role = useSignal<Role>("member");
  const busy = useSignal(false);
  // the person added: the invite's outcome, which ends the form
  const added = useSignal<Said | null>(null);
  const refused = useSignal<string | null>(null);
  const form = useId();
  const ready = name.value.trim() !== "" && email.value.includes("@");
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy.value || !ready || !emailOn) return;
    busy.value = true;
    refused.value = null;
    const to = email.value.trim();
    const r = await admin.addPerson(name.value.trim(), to, role.value);
    busy.value = false;
    if ("error" in r) {
      refused.value = plainError(r.error);
      return;
    }
    added.value = r.sent.sent
      ? { text: `Invite sent to ${to}. ${INVITE_SENT}` }
      : { text: inviteFailed(r.sent.reason, true), error: true };
  };
  return (
    <Drawer
      title="Add person"
      onClose={onClose}
      busy={busy.value}
      foot={(close) =>
        added.value !== null ? (
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
              disabled={!ready || !emailOn || busy.value}
            >
              Add and invite
            </button>
          </>
        )
      }
    >
      {added.value !== null ? (
        <Notice error={added.value.error}>{added.value.text}</Notice>
      ) : (
        <form id={form} class="connect-form" onSubmit={submit}>
          <label class="field">
            <span class="label">Name</span>
            <input
              value={name.value}
              autocomplete="off"
              disabled={busy.value}
              onInput={(e) => {
                name.value = (e.currentTarget as HTMLInputElement).value;
              }}
            />
          </label>
          <label class="field">
            <span class="label">Email</span>
            <input
              type="email"
              value={email.value}
              autocomplete="off"
              disabled={busy.value}
              onInput={(e) => {
                email.value = (e.currentTarget as HTMLInputElement).value;
              }}
            />
          </label>
          <div class="field">
            <span class="label">Role</span>
            <Segmented
              label="Role"
              options={ROLES}
              value={role.value}
              disabled={busy.value}
              onPick={(v) => {
                role.value = v;
              }}
            />
          </div>
          {!emailOn && (
            <Notice>Set up email first: people sign in by emailed link.</Notice>
          )}
          {refused.value !== null && <Notice error>{refused.value}</Notice>}
        </form>
      )}
    </Drawer>
  );
}

type Asking = null | "remove" | "signout";

// what the drawer's foot menu offers: never the reader's own Remove, and
// nothing on the operator's row, who always stays
export function personItems(
  person: Person,
  own: boolean,
): ("invite" | "signout" | "remove")[] {
  if (person.operator) return [];
  return [
    ...(invitable(person) ? (["invite"] as const) : []),
    "signout" as const,
    ...(own ? [] : (["remove"] as const)),
  ];
}

export function PersonDetails({
  store,
  person,
  now,
  onClose,
}: {
  store: Store;
  person: Person;
  now: number;
  onClose: () => void;
}) {
  const admin = store.admin;
  // the reader's own row: their name through /ui/me, their role locked
  const own = person.id === store.me.value?.id;
  // the operator adds an email to sign in by link too
  const withEmail = own && person.operator && admin.emailOn.value === true;
  const name = useSignal(person.name);
  const email = useSignal(person.email ?? "");
  const role = useSignal<Role>(person.role);
  const asking = useSignal<Asking>(null);
  // what Remove deletes, asked of the server before the question shows
  const removes = useSignal<string>("");
  const busy = useSignal(false);
  const said = useSignal<Said | null>(null);
  const confirming = useSignal(false);
  const form = useId();
  const run = async (work: () => Promise<Said | null>) => {
    busy.value = true;
    said.value = null;
    said.value = plainSaid(await work());
    busy.value = false;
  };
  const renamed = name.value.trim() !== person.name;
  const moved = withEmail && email.value.trim() !== (person.email ?? "");
  const changed = renamed || moved || role.value !== person.role;
  const save = async (): Promise<Said | null> => {
    if (renamed || role.value !== person.role) {
      const error = own
        ? await store.setMyName(name.value.trim())
        : await admin.setPerson(person.id, {
            ...(renamed ? { name: name.value.trim() } : {}),
            ...(role.value !== person.role ? { role: role.value } : {}),
          });
      if (error !== null) return { text: error, error: true };
    }
    if (moved) {
      const r = await store.setMyEmail(email.value.trim());
      if ("error" in r) return { text: r.error, error: true };
      if (!r.sent) {
        return { text: `Not sent. ${failureWords(r.reason)}.`, error: true };
      }
      confirming.value = true;
      return null;
    }
    return { text: "Saved." };
  };
  const items = personItems(person, own);
  return (
    <Drawer
      title={person.name}
      onClose={onClose}
      busy={busy.value}
      footStart={
        items.length === 0 ? undefined : asking.value === "remove" ? (
          removes.value
        ) : asking.value === "signout" ? (
          "Ends their sign-ins on every device. Their data stays."
        ) : (
          <MenuButton
            label={`More for ${person.name}`}
            left
            disabled={busy.value}
            items={items.map((it) =>
              it === "invite"
                ? {
                    label: "Send invite again",
                    icon: "redo" as const,
                    run: () =>
                      void run(async () => {
                        const r = await admin.invite(person.id);
                        if ("error" in r) return { text: r.error, error: true };
                        return r.sent
                          ? { text: "Invite sent." }
                          : { text: inviteFailed(r.reason), error: true };
                      }),
                  }
                : it === "signout"
                  ? {
                      label: "Sign out everywhere",
                      icon: "sign-out" as const,
                      run: () => {
                        said.value = null;
                        asking.value = "signout";
                      },
                    }
                  : {
                      label: "Remove",
                      icon: "trash" as const,
                      run: () =>
                        void run(async () => {
                          const counts = await admin.removal(person.id);
                          if ("error" in counts) {
                            return {
                              text: counts.error as string,
                              error: true,
                            };
                          }
                          removes.value = removeLine(counts);
                          asking.value = "remove";
                          return null;
                        }),
                    },
            )}
          />
        )
      }
      foot={(close) =>
        asking.value !== null ? (
          <>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
              onClick={() => {
                asking.value = null;
              }}
            >
              Keep
            </button>
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={busy.value}
              onClick={async () => {
                if (asking.value === "remove") {
                  busy.value = true;
                  const error = await admin.removePerson(person.id);
                  busy.value = false;
                  asking.value = null;
                  if (error === null) close();
                  else said.value = { text: plainError(error), error: true };
                  return;
                }
                await run(async () => {
                  const error = await admin.signOutPerson(person.id);
                  asking.value = null;
                  return error === null
                    ? { text: "Signed out everywhere." }
                    : { text: error, error: true };
                });
              }}
            >
              {asking.value === "remove" ? "Remove" : "Sign out"}
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
            <button
              type="submit"
              form={form}
              class="btn btn-small btn-primary"
              disabled={busy.value || !changed}
            >
              Save
            </button>
          </>
        )
      }
    >
      <Facts
        items={[
          {
            label: "Email",
            value: person.email ?? "Signs in with the admin key",
          },
          { label: "Last sign-in", value: seenWords(person, now, true) },
          { label: "Agent keys", value: String(person.keys) },
        ]}
      />
      <form
        id={form}
        class="connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy.value || !changed) return;
          void run(save);
        }}
      >
        <label class="field">
          <span class="label">Name</span>
          <input
            value={name.value}
            autocomplete="off"
            disabled={busy.value}
            onInput={(e) => {
              name.value = (e.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        {withEmail && (
          <label class="field">
            <span class="label">Email</span>
            <input
              type="email"
              value={email.value}
              autocomplete="email"
              disabled={busy.value}
              onInput={(e) => {
                email.value = (e.currentTarget as HTMLInputElement).value;
                confirming.value = false;
              }}
            />
            {confirming.value && <span class="small faint">{CONFIRM}</span>}
          </label>
        )}
        <div class="field">
          <span class="label">Role</span>
          <Segmented
            label="Role"
            options={ROLES}
            value={role.value}
            disabled={person.operator || own || busy.value}
            onPick={(v) => {
              role.value = v;
            }}
          />
          {person.operator ? (
            <span class="small faint">
              The admin key's person is always an admin.
            </span>
          ) : (
            own && (
              <span class="small faint">Your own role stays as it is.</span>
            )
          )}
        </div>
      </form>
      {said.value !== null && (
        <Notice error={said.value.error}>{said.value.text}</Notice>
      )}
    </Drawer>
  );
}

function Users({ store }: { store: Store }) {
  const admin = store.admin;
  const people = admin.people.value;
  const emailOn = admin.emailOn.value === true;
  const adding = useSignal(false);
  const opened = useSignal<string | null>(null);
  const now = Date.now();
  const me = store.me.value?.id ?? null;
  if (people === null) {
    return (
      <Card title="People">
        <Table
          label="People"
          columns={peopleColumns(me, now)}
          rowKey={(p) => p.id}
          waiting={2}
        />
      </Card>
    );
  }
  const open = people.find((p) => p.id === opened.value);
  return (
    <>
      <Card
        title="People"
        count={String(people.length)}
        actions={
          <button
            type="button"
            class="btn btn-small"
            onClick={() => {
              adding.value = true;
            }}
          >
            <Icon name="plus" size={14} />
            Add person
          </button>
        }
      >
        <Table
          label="People"
          columns={peopleColumns(me, now)}
          rows={people}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          open={(p) => ({
            run: () => {
              opened.value = p.id;
            },
          })}
        />
        {!emailOn && (
          <Notice>
            People can't be added until email is set up.{" "}
            <button
              type="button"
              class="btn-text"
              onClick={() => {
                emailAsked.value = true;
                navigate(ADMIN_SETTINGS);
              }}
            >
              Set up email
            </button>
          </Notice>
        )}
      </Card>
      {adding.value && (
        <AddPerson
          admin={admin}
          emailOn={emailOn}
          onClose={() => {
            adding.value = false;
          }}
        />
      )}
      {open !== undefined && (
        <PersonDetails
          key={open.id}
          store={store}
          person={open}
          now={now}
          onClose={() => {
            opened.value = null;
          }}
        />
      )}
    </>
  );
}

function TextField({
  form,
  field,
  label,
  disabled,
  numeric,
}: {
  form: Signal<SmtpForm>;
  field: "host" | "port" | "username" | "from" | "link";
  label: string;
  disabled: boolean;
  numeric?: boolean;
}) {
  return (
    <label class="field">
      <span class="label">{label}</span>
      <input
        value={form.value[field]}
        autocomplete="off"
        spellcheck={false}
        inputmode={numeric ? "numeric" : undefined}
        disabled={disabled}
        onInput={(e) => {
          form.value = {
            ...form.value,
            [field]: (e.currentTarget as HTMLInputElement).value,
          };
        }}
      />
    </label>
  );
}

// Users' Set up email asks Settings to open the SMTP drawer on arrival
export const emailAsked = signal(false);

// any step off Settings drops the ask, so a later visit opens no drawer
export function watchEmailAsk(): () => void {
  return effect(() => {
    if (path.value !== ADMIN_SETTINGS) emailAsked.value = false;
  });
}

export type Setting = {
  key: "email";
  name: string;
  state: string;
  detail: string;
};

export const settingRows = (answer: SmtpAnswer): Setting[] => [
  {
    key: "email",
    name: "SMTP",
    state: answer.email_on ? "On" : "Off",
    detail:
      answer.settings === null
        ? "Not set"
        : `${answer.settings.host}:${answer.settings.port}`,
  },
];

const SETTING_COLUMNS: Column<Setting>[] = [
  {
    key: "name",
    head: "Setting",
    width: { base: "minmax(0, 1fr)", phone: "64px" },
    cell: (s) => <span class="cut">{s.name}</span>,
  },
  {
    key: "detail",
    head: "Value",
    width: "minmax(0, 1.6fr)",
    cell: (s) => <span class="cut faint">{s.detail}</span>,
  },
  {
    key: "state",
    head: "State",
    width: "64px",
    align: "end",
    cell: (s) => <span class="faint">{s.state}</span>,
  },
];

function Settings({ store }: { store: Store }) {
  const answer = store.admin.smtp.value;
  const open = useSignal(emailAsked.peek());
  useEffect(() => {
    emailAsked.value = false;
  }, []);
  return (
    <>
      <Card title="Config">
        {answer === null ? (
          <Table
            label="Config"
            columns={SETTING_COLUMNS}
            rowKey={(s) => s.key}
            waiting={1}
          />
        ) : (
          <Table
            label="Config"
            columns={SETTING_COLUMNS}
            rows={settingRows(answer)}
            rowKey={(s) => s.key}
            rowLabel={(s) => s.name}
            open={() => ({
              run: () => {
                open.value = true;
              },
            })}
          />
        )}
      </Card>
      {answer !== null && open.value && (
        <SmtpDrawer
          store={store}
          onClose={() => {
            open.value = false;
          }}
        />
      )}
    </>
  );
}

export function SmtpDrawer({
  store,
  onClose,
}: {
  store: Store;
  onClose: () => void;
}) {
  const admin = store.admin;
  const answer = admin.smtp.value!;
  // only the operator changes or tests it: whoever sets the SMTP server
  // reads every link it carries
  const operator = store.me.value?.operator === true;
  // the test goes to the reader's own email
  const mine = (store.me.value?.email ?? null) !== null;
  const form = useSignal<SmtpForm>(formOf(answer.settings));
  const said = useSignal<Said | null>(null);
  const asking = useSignal(false);
  const busy = useSignal(false);
  const saved = answer.settings !== null;
  const off = !operator || busy.value;
  const formId = useId();
  const run = async (work: () => Promise<Said>) => {
    busy.value = true;
    said.value = null;
    said.value = await work();
    busy.value = false;
  };
  const picked = form.value.keyName;
  return (
    <Drawer
      title="SMTP"
      onClose={onClose}
      busy={busy.value}
      footStart={
        !operator || !saved ? undefined : asking.value ? (
          "Turns email off. Signed-in people stay signed in."
        ) : (
          <button
            type="button"
            class="btn btn-small"
            disabled={busy.value}
            onClick={() => {
              said.value = null;
              asking.value = true;
            }}
          >
            Remove
          </button>
        )
      }
      foot={(close) =>
        !operator ? (
          <button type="button" class="btn btn-small" onClick={close}>
            Close
          </button>
        ) : asking.value ? (
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
              onClick={() =>
                void run(async () => {
                  const error = await admin.removeSmtp();
                  asking.value = false;
                  return error === null
                    ? { text: "Email is off." }
                    : { text: error, error: true };
                })
              }
            >
              Remove
            </button>
          </>
        ) : (
          <>
            {answer.email_on && (
              <button
                type="button"
                class="btn btn-small"
                disabled={busy.value || !mine}
                onClick={() =>
                  void run(async () => testLine(await admin.testSmtp()))
                }
              >
                Send test
              </button>
            )}
            <button
              type="submit"
              form={formId}
              class="btn btn-small btn-primary"
              disabled={busy.value}
            >
              Save
            </button>
          </>
        )
      }
    >
      <form
        id={formId}
        class="connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (off) return;
          void run(async () => {
            const error = await admin.saveSmtp(settingsOf(form.value));
            if (error !== null) return { text: plainError(error), error: true };
            return {
              text: admin.smtp.peek()?.email_on
                ? "Saved. Email is on."
                : "Saved.",
            };
          });
        }}
      >
        <p class="small faint admin-lead">
          Sign-in links and invites go out through this server.
        </p>
        <div class="admin-row">
          <TextField form={form} field="host" label="Host" disabled={off} />
          <TextField
            form={form}
            field="port"
            label="Port"
            disabled={off}
            numeric
          />
        </div>
        <div class="field">
          <span class="label">Security</span>
          <Segmented
            label="Security"
            options={[
              { value: "tls" as const, text: "TLS" },
              { value: "starttls" as const, text: "STARTTLS" },
            ]}
            value={form.value.security}
            disabled={off}
            onPick={(v) => {
              form.value = { ...form.value, security: v };
            }}
          />
        </div>
        <TextField
          form={form}
          field="username"
          label="Username"
          disabled={off}
        />
        <div class="field">
          <span class="label">Password file</span>
          <MenuButton
            label="Password file"
            field
            left
            disabled={off || answer.key_names.length === 0}
            text={
              picked !== null
                ? fileOf(picked)
                : answer.key_names.length === 0
                  ? "No files"
                  : "Pick a file"
            }
            // with no file the menu never opens, so it is drawn empty
            items={
              answer.key_names.length === 0
                ? undefined
                : answer.key_names.map((name) => ({
                    label: fileOf(name),
                    checked: name === picked,
                    run: () => {
                      form.value = { ...form.value, keyName: name };
                    },
                  }))
            }
          >
            {() => null}
          </MenuButton>
          <span class="small faint">Files in secrets/ named email-*.key.</span>
        </div>
        {answer.key_missing && answer.settings?.key_name && (
          <Notice error>{missingLine(answer.settings.key_name)}</Notice>
        )}
        <TextField form={form} field="from" label="From" disabled={off} />
        <TextField
          form={form}
          field="link"
          label="Link address"
          disabled={off}
        />
        <span class="small faint admin-under">
          Where the links in emails point: this server's public address.
        </span>
        {operator && answer.email_on && !mine && (
          <p class="small faint admin-lead">{NO_EMAIL}</p>
        )}
      </form>
      {said.value !== null && (
        <Notice error={said.value.error}>
          {said.value.text}
          {said.value.detail && (
            <span class="small faint admin-detail">{said.value.detail}</span>
          )}
        </Notice>
      )}
    </Drawer>
  );
}

export type AdminTab = "status" | "settings" | "users";

// the tabs every Server admin address draws under its head
export function AdminTabs({ tab }: { tab: AdminTab }) {
  return (
    <Tabs
      label="Server admin"
      tabs={[
        { key: "status", label: "Status", href: ADMIN },
        { key: "settings", label: "Settings", href: ADMIN_SETTINGS },
        { key: "users", label: "Users", href: ADMIN_USERS },
      ]}
      value={tab}
    />
  );
}

export function AdminPage({
  store,
  tab,
}: {
  store: Store;
  tab: "settings" | "users";
}) {
  const admin = store.admin;
  const users = tab === "users";
  const held = users ? admin.people.value !== null : admin.smtp.value !== null;
  const error = users ? admin.peopleError.value : admin.smtpError.value;
  const code = users ? admin.peopleCode.value : admin.smtpCode.value;
  return (
    <Page
      title="Server admin"
      tabs={<AdminTabs tab={tab} />}
      stale={held ? error : null}
      staleCount={users ? admin.peopleFailures.value : admin.smtpFailures.value}
      failed={didNotLoad(
        held,
        error,
        code,
        () => void (users ? admin.loadPeople() : admin.loadSmtp()),
      )}
    >
      <div class="admin">
        {users ? <Users store={store} /> : <Settings store={store} />}
      </div>
    </Page>
  );
}

export function AdminUsers() {
  return <AdminPage store={markets} tab="users" />;
}

export function AdminSettings() {
  return <AdminPage store={markets} tab="settings" />;
}
