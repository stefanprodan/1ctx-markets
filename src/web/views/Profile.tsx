// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's profile: drawn as the server renders it, edited as text,
// and any kept revision opened and restored.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { says } from "../data/api.ts";
import type { DocumentStore, Loaded, RevisionRow } from "../data/document.ts";
import type { ProfileStore } from "../data/profile.ts";
import { markets } from "../data/store.ts";
import { ago } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  authorWords,
  kb,
  latest,
  MAX_BYTES,
  OUTLINE,
  sizeOf,
  TOOLS,
  type Tool,
  type Typing,
} from "./Profile.model.ts";
import "./profile.css";

// typed as a person types, so the browser's undo takes it back
export function typeInto(area: HTMLTextAreaElement, t: Typing) {
  // a save on its way: execCommand fails here and the fallback would
  // still change the text being saved
  if (area.readOnly) return;
  area.focus();
  area.setSelectionRange(t.from, t.to);
  if (!document.execCommand("insertText", false, t.text)) {
    area.setRangeText(t.text, t.from, t.to, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  area.setSelectionRange(t.start, t.end);
}

function run(area: HTMLTextAreaElement | null, tool: Tool) {
  if (area === null) return;
  const { value, selectionStart: start, selectionEnd: end } = area;
  typeInto(area, tool.run({ value, start, end }));
}

// a cell holding more is prose: it wraps, where a figure keeps its line
const LONG_CELL = 40;

// the server escapes any HTML in the text before it draws it
export function Drawn({ html }: { html: string }) {
  const doc = useRef<HTMLDivElement>(null);
  // CSS cannot size a table cell by its own length, so prose is marked,
  // before the paint so the table never draws at its unwrapped width
  useLayoutEffect(() => {
    for (const cell of doc.current?.querySelectorAll("td, th") ?? []) {
      cell.classList.toggle(
        "doc-cell-long",
        (cell.textContent?.length ?? 0) > LONG_CELL,
      );
    }
  }, [html]);
  return (
    <div
      ref={doc}
      class="profile-doc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function Toolbar({
  area,
  busy,
}: {
  area: () => HTMLTextAreaElement | null;
  busy: boolean;
}) {
  return (
    <div class="profile-toolbar" role="toolbar" aria-label="Formatting">
      {TOOLS.map((group, g) => (
        <div class="profile-tools" key={g}>
          {group.map((tool) => (
            <button
              key={tool.label}
              type="button"
              class="btn-icon profile-tool"
              title={tool.label}
              aria-label={tool.label}
              disabled={busy}
              // a press keeps the text box's selection
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(area(), tool)}
            >
              <Icon name={tool.icon} size={16} />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export type Preview = { html: string } | { failed: string } | null;

export function PreviewBox({ drawn }: { drawn: Preview }) {
  return (
    <div class="profile-editor profile-preview">
      {drawn === null ? (
        <p class="faint">Drawing…</p>
      ) : "failed" in drawn ? (
        <Notice error>{drawn.failed}</Notice>
      ) : drawn.html === "" ? (
        <p class="faint">Nothing to preview.</p>
      ) : (
        <Drawn html={drawn.html} />
      )}
    </div>
  );
}

export type EditorProps = {
  store: Pick<DocumentStore, "save" | "preview">;
  start: string;
  // the live text, so a first document's outline can be saved as it is
  saved: string;
  revision: number | null;
  onDone: () => void;
  // the text box's name for a screen reader
  label?: string;
  // something beside the text changed, such as a trade plan's name
  dirty?: boolean;
};

// the editor's state and parts, framed by a card or a drawer
export function useEditor({
  store,
  start,
  saved,
  revision,
  onDone,
  label = "Profile text",
  dirty = false,
}: EditorProps) {
  const [text, setText] = useState(start);
  // a load landing after Edit never moves the revision the save is checked at
  const [opened] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [drawn, setDrawn] = useState<Preview>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // only the last preview asked lands, and none after the editor closed
  const [asked] = useState(latest);
  useEffect(() => asked.drop, []);
  const size = sizeOf(text);
  async function save() {
    setBusy(true);
    setRefused(null);
    const said = await store.save(text, opened);
    setBusy(false);
    if (said === null) return onDone();
    setRefused(said);
  }
  function pick(next: "write" | "preview") {
    setTab(next);
    const current = asked.ask();
    if (next !== "preview") return;
    setDrawn(null);
    store.preview(text).then(
      (html) => {
        if (current()) setDrawn({ html });
      },
      (e) => {
        if (current()) setDrawn({ failed: says(e) });
      },
    );
  }
  const head = (
    <div class="profile-edit-head">
      <Tabs
        label="Editor"
        value={tab}
        onPick={pick}
        tabs={[
          { key: "write", label: "Write" },
          { key: "preview", label: "Preview" },
        ]}
      />
      {tab === "write" && <Toolbar area={() => area.current} busy={busy} />}
    </div>
  );
  const box = (
    <div class="profile-edit-box">
      {/* kept while Preview shows, so its undo and caret stay */}
      <textarea
        ref={area}
        class="profile-editor"
        value={text}
        hidden={tab !== "write"}
        readOnly={busy}
        spellcheck={false}
        aria-label={label}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      {tab === "preview" && <PreviewBox drawn={drawn} />}
      {refused !== null && <Notice error>{refused}</Notice>}
    </div>
  );
  const sizeLine = (
    <span class={size > MAX_BYTES ? "profile-size over" : "profile-size"}>
      {kb(size)} of {kb(MAX_BYTES)}
    </span>
  );
  const saveButton = (
    <button
      type="button"
      class="btn btn-primary"
      onClick={save}
      disabled={busy || (text === saved && !dirty)}
    >
      {busy ? "Saving…" : "Save"}
    </button>
  );
  return { busy, head, box, sizeLine, saveButton };
}

export function Editor(props: EditorProps) {
  const { busy, head, box, sizeLine, saveButton } = useEditor(props);
  return (
    <Card>
      {head}
      {box}
      <div class="profile-edit-foot">
        {sizeLine}
        <button
          type="button"
          class="btn"
          onClick={props.onDone}
          disabled={busy}
        >
          Cancel
        </button>
        {saveButton}
      </div>
    </Card>
  );
}

export function History({
  store,
  live,
  onClose,
  who = (author) => authorWords(author, markets.me.value?.name ?? null),
}: {
  store: Pick<DocumentStore, "versions" | "version" | "restore">;
  live: number;
  onClose: () => void;
  // an author as the reader is told it
  who?: (author: string) => string;
}) {
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // a restore done slides the drawer out once the render that ends busy
  // lets it close
  const closer = useRef<() => void>(() => {});
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (leaving) closer.current();
  }, [leaving]);
  useEffect(() => {
    store.versions().then(
      (r) => {
        if (alive.current) setRows(r);
      },
      () => {
        if (alive.current) setFailed("The history did not load.");
      },
    );
    return () => {
      alive.current = false;
    };
  }, []);
  async function show(n: number) {
    setFailed(null);
    try {
      const r = await store.version(n);
      if (alive.current) setOpen(r);
    } catch {
      if (alive.current) setFailed("That revision did not load.");
    }
  }
  async function restore(close: () => void) {
    if (open?.text == null) return;
    setBusy(true);
    setFailed(null);
    const said = await store.restore(open.text, live);
    if (!alive.current) return;
    setBusy(false);
    if (said !== null) return setFailed(said);
    closer.current = close;
    setLeaving(true);
  }
  const now = Date.now();
  return (
    <Drawer
      title={open === null ? "History" : `Revision ${open.revision}`}
      onClose={onClose}
      busy={busy}
      foot={
        open === null
          ? undefined
          : (close) => (
              <>
                <button
                  type="button"
                  class="btn"
                  disabled={busy}
                  onClick={() => {
                    setOpen(null);
                    setFailed(null);
                  }}
                >
                  Back
                </button>
                {open.revision !== live && (
                  <button
                    type="button"
                    class="btn btn-primary"
                    disabled={busy}
                    onClick={() => restore(close)}
                  >
                    Restore
                  </button>
                )}
              </>
            )
      }
    >
      {failed !== null && <Notice error>{failed}</Notice>}
      {open !== null ? (
        <Drawn html={open.html ?? ""} />
      ) : (
        rows !== null && (
          <ul class="profile-history">
            {rows.map((r) => (
              <li key={r.revision}>
                <button
                  type="button"
                  class="profile-history-row"
                  onClick={() => show(r.revision)}
                >
                  <span class="profile-history-title">
                    Revision {r.revision}
                    {r.revision === live && (
                      <span class="profile-current">Current</span>
                    )}
                  </span>
                  <span class="faint">
                    {who(r.author)} · {ago(r.at, now)} · {kb(r.bytes)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </Drawer>
  );
}

export function Profile() {
  return <ProfileBody store={markets.profile} />;
}

export function ProfileBody({ store }: { store: ProfileStore }) {
  const p = store.profile.value;
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  // an edit or a restore saves at the revision it opened, so an agent's
  // newer save is refused, never overwritten: no reload moves it meanwhile
  useRefresh(() => (editing || history ? undefined : store.load()));
  const failed = didNotLoad(
    p !== null,
    store.error.value,
    store.code.value,
    () => store.load(),
  );
  const none = p !== null && p.revision === null;
  const meta =
    p?.updated_at != null
      ? `Saved ${ago(p.updated_at, Date.now())} by ${authorWords(p.author, markets.me.value?.name ?? null)}`
      : undefined;
  const edit = () => setEditing(true);
  return (
    <Page
      title="Profile"
      meta={meta}
      search={editing ? false : undefined}
      failed={failed}
      actions={
        p !== null &&
        !editing &&
        !none && (
          <>
            <button type="button" class="btn" onClick={() => setHistory(true)}>
              History
            </button>
            <button type="button" class="btn btn-primary" onClick={edit}>
              <Icon name="pencil" size={14} />
              Edit
            </button>
          </>
        )
      }
    >
      {p !== null &&
        (editing ? (
          <Editor
            store={store}
            start={p.text ?? OUTLINE}
            saved={p.text ?? ""}
            revision={p.revision}
            onDone={() => setEditing(false)}
          />
        ) : none ? (
          <Notice
            icon="user"
            title="Write your profile"
            actions={
              <button type="button" class="btn btn-primary" onClick={edit}>
                <Icon name="pencil" size={14} />
                Write it
              </button>
            }
          >
            How you invest: your goals, risk, trading style and rules. Agents
            read it before any work on your portfolio.
          </Notice>
        ) : (
          <Card>
            <Drawn html={p.html ?? ""} />
          </Card>
        ))}
      {history && p?.revision != null && (
        <History
          store={store}
          live={p.revision}
          onClose={() => setHistory(false)}
        />
      )}
    </Page>
  );
}
