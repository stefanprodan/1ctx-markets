// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./setting.css";

// 1ctx's delete card: Delete asks once, beside Keep; a refusal says why
// in the foot and the card stays
export function SettingDelete({
  title,
  line,
  ask,
  refused,
  busy,
  onDelete,
}: {
  title: string;
  line: ComponentChildren;
  ask: string;
  refused: string | null;
  busy: boolean;
  onDelete: () => void;
}) {
  const asking = useSignal(false);
  useEffect(() => {
    if (!asking.value) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") asking.value = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking.value]);
  // a refusal ends the ask
  useEffect(() => {
    if (refused !== null) asking.value = false;
  }, [refused]);
  return (
    <section class="card setting setting-danger">
      <div class="setting-body">
        <div class="setting-words">
          <h2 class="setting-title">{title}</h2>
          <p class="setting-line">{line}</p>
        </div>
      </div>
      <div class="setting-foot">
        <div class="setting-delete">
          {refused !== null && !asking.value && (
            <p class="setting-refused" role="alert">
              <Icon name="alert" size={14} class="setting-refused-icon" />
              <span>{refused}</span>
            </p>
          )}
          {asking.value ? (
            <>
              <span class="setting-ask">{ask}</span>
              <button
                type="button"
                class="btn btn-danger"
                disabled={busy}
                onClick={onDelete}
              >
                {busy ? "Deleting" : "Delete"}
              </button>
              <button
                type="button"
                class="btn"
                disabled={busy}
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
              class="btn"
              disabled={busy}
              onClick={() => {
                asking.value = true;
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
