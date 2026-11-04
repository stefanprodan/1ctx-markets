// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A symbol's shared analysis: a card under the others once one is written,
// one drawer to write or edit it, and its kept revisions.

import type { Signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AnalysisStore } from "../data/analysis.ts";
import { markets } from "../data/store.ts";
import { ago, percent } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Change } from "../ui/Figures.tsx";
import {
  analysisAuthor,
  OUTLINE,
  sinceLine,
} from "./InstrumentAnalysis.model.ts";
import { Drawn, History, useEditor } from "./Profile.tsx";
import "./profile.css";
import "./analysis.css";

const who = (author: string) =>
  analysisAuthor(author, markets.me.value?.name ?? null);

function WriteDrawer({
  store,
  symbol,
  onClose,
  onSaved,
}: {
  store: AnalysisStore;
  symbol: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const a = store.doc.peek();
  const closer = useRef<() => void>(() => {});
  // a save done slides the drawer out once the render that ends busy
  // lets it close
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (leaving) closer.current();
  }, [leaving]);
  const { busy, head, box, sizeLine, saveButton } = useEditor({
    store,
    start: a?.text ?? OUTLINE,
    saved: a?.text ?? "",
    revision: a?.revision ?? null,
    label: "Analysis text",
    onDone: () => {
      onSaved();
      setLeaving(true);
    },
  });
  return (
    <Drawer
      title={`${symbol} analysis`}
      onClose={onClose}
      busy={busy}
      tall
      footStart={sizeLine}
      foot={(close) => {
        closer.current = close;
        return (
          <>
            <button type="button" class="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            {saveButton}
          </>
        );
      }}
    >
      {head}
      {box}
      <p class="ana-shared small faint">Everyone on this server can read it.</p>
    </Drawer>
  );
}

export function AnalysisSection({
  store,
  symbol,
  writing,
}: {
  store: AnalysisStore;
  symbol: string;
  // opened by the page's menu while there is none yet
  writing: Signal<boolean>;
}) {
  const [history, setHistory] = useState(false);
  const landed = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void store.load();
  }, [store]);
  // an open editor or history saves at the revision it opened, so no
  // reload moves it meanwhile
  useRefresh(() => (writing.value || history ? undefined : store.load()), true);
  const a = store.doc.value;
  useEffect(() => {
    if (!landed.current || a?.revision == null) return;
    landed.current = false;
    card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // the menu that opened the drawer may be gone, so focus lands on the card
    card.current
      ?.querySelector<HTMLButtonElement>(".ana-edit")
      ?.focus({ preventScroll: true });
  }, [a?.revision]);
  const drawer = writing.value && (
    <WriteDrawer
      store={store}
      symbol={symbol}
      // a refused save leaves a newer note to show
      onClose={() => {
        writing.value = false;
        void store.load();
      }}
      onSaved={() => {
        landed.current = true;
      }}
    />
  );
  if (a?.revision == null) return <>{drawer}</>;
  const since = sinceLine(a.since_written);
  // the drawer keeps its slot as the card arrives, so a first save
  // closes it rather than opening it again
  return (
    <>
      {drawer}
      <div ref={card} class="ana-card">
        <Card
          title="Analysis"
          actions={
            <span class="ana-actions">
              <button
                type="button"
                class="btn btn-small"
                onClick={() => setHistory(true)}
              >
                History
              </button>
              <button
                type="button"
                class="btn btn-small ana-edit"
                onClick={() => {
                  writing.value = true;
                }}
              >
                <Icon name="pencil" size={14} />
                Edit
              </button>
            </span>
          }
        >
          <p class="ana-meta">
            Written {ago(a.at, Date.now())} by {who(a.author ?? "")}
            {since.change !== null && (
              <>
                {" · "}
                <Change s={percent(since.change)} /> since
              </>
            )}
            {since.reported && " · earnings reported since"}
          </p>
          <Drawn html={a.html ?? ""} />
        </Card>
      </div>
      {history && (
        <History
          store={store}
          live={a.revision}
          who={who}
          onClose={() => setHistory(false)}
        />
      )}
    </>
  );
}
