// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Tabs: plain words, the one picked underlined, a faint count beside a
// tab; on a phone they scroll sideways and fade at the edge.

import type { ComponentChildren } from "preact";
import "./tabs.css";

export type Tab<K extends string | number | null> = {
  key: K;
  label: ComponentChildren;
  count?: number | null;
  // a tab that is an address is a link, its page the picked one
  href?: string;
};

export function Tabs<K extends string | number | null>({
  tabs,
  value,
  onPick,
  label,
}: {
  tabs: readonly Tab<K>[];
  value: K;
  onPick?: (key: K) => void;
  label: string;
}) {
  const links = tabs.every((t) => t.href !== undefined);
  const at = tabs.findIndex((t) => t.key === value);
  // arrows move along the tabs and pick, as a tablist does
  const onKey = (ev: KeyboardEvent) => {
    if (links || tabs.length === 0) return;
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0;
    const to =
      ev.key === "Home"
        ? 0
        : ev.key === "End"
          ? tabs.length - 1
          : step === 0
            ? -1
            : (Math.max(at, 0) + step + tabs.length) % tabs.length;
    if (to < 0) return;
    ev.preventDefault();
    const list = ev.currentTarget as HTMLElement;
    list.querySelectorAll<HTMLElement>("[role=tab]")[to]?.focus();
    onPick?.(tabs[to]!.key);
  };
  return (
    <div class="tabs">
      {links ? (
        <nav class="tabs-list" aria-label={label}>
          {tabs.map((t) => (
            <a
              key={String(t.key)}
              class={`tab${t.key === value ? " tab-on" : ""}`}
              href={t.href}
              aria-current={t.key === value ? "page" : undefined}
            >
              {t.label}
              <Count n={t.count} />
            </a>
          ))}
        </nav>
      ) : (
        <div
          class="tabs-list"
          role="tablist"
          aria-label={label}
          onKeyDown={onKey}
        >
          {tabs.map((t, i) => {
            const on = t.key === value;
            return (
              <button
                key={String(t.key)}
                type="button"
                role="tab"
                class={`tab${on ? " tab-on" : ""}`}
                aria-selected={on}
                tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
                onClick={() => {
                  if (!on) onPick?.(t.key);
                }}
              >
                {t.label}
                <Count n={t.count} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Count({ n }: { n: number | null | undefined }) {
  if (n === undefined || n === null) return null;
  return <span class="tab-count num">{n}</span>;
}
