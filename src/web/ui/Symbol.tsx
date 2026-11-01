// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A holding or an instrument named: its ticker over its name. Names go
// through lib/names.ts first (a coin without its quote currency).

import type { ComponentChildren } from "preact";
import { Placeholder } from "./Placeholder.tsx";
import "./symbol.css";

export function SymbolName({
  ticker,
  name,
  href,
  compact,
}: {
  ticker: ComponentChildren;
  // a line under the ticker: the name, or what stands for it
  name?: ComponentChildren;
  // the ticker links to its page; in a Table the row is the link instead
  href?: string | null;
  // one line, the name faint after the ticker
  compact?: boolean;
}) {
  const t = href ? (
    <a class="sym-ticker sym-link" href={href}>
      {ticker}
    </a>
  ) : (
    <span class="sym-ticker">{ticker}</span>
  );
  const shown = name !== undefined && name !== null && name !== "";
  return (
    <span class={`sym${compact ? " sym-compact" : ""}`}>
      {t}
      {shown && <span class="sym-name">{name}</span>}
    </span>
  );
}

export function SymbolWaiting({ compact }: { compact?: boolean }) {
  return (
    <SymbolName
      compact={compact}
      ticker={<Placeholder chars={5} />}
      name={<Placeholder chars={compact ? 10 : 14} />}
    />
  );
}
