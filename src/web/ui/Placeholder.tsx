// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import "./placeholder.css";

export function Placeholder({
  chars = 8,
  band,
}: {
  chars?: number;
  band?: boolean;
}) {
  return band ? (
    <span class="placeholder placeholder-band" aria-hidden="true" />
  ) : (
    <span
      class="placeholder"
      style={{ width: `${chars}ch` }}
      aria-hidden="true"
    />
  );
}

export function WaitWords({
  show,
  spin,
  children,
}: {
  show: boolean;
  spin?: boolean;
  children: ComponentChildren;
}) {
  return (
    <span class="wait-words small faint" role="status">
      {show && (
        <>
          {spin && <span class="spinner" aria-hidden="true" />}
          {children}
        </>
      )}
    </span>
  );
}
