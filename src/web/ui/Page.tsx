// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { Icon } from "../lib/icons.tsx";
import "./page.css";

export function Page({
  title,
  meta,
  actions,
  error,
  children,
}: {
  title: string;
  // a short line beside the title, such as when the page was answered
  meta?: ComponentChildren;
  actions?: ComponentChildren;
  // a failure over the body, which stays as it was answered last
  error?: string | null;
  children?: ComponentChildren;
}) {
  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">{title}</h1>
        {meta && <span class="page-meta">{meta}</span>}
        {actions && <div class="page-actions">{actions}</div>}
      </div>
      {error && (
        <div class="notice-failed page-failed" role="alert">
          <Icon name="alert" size={16} class="page-failed-icon" />
          <span>{error}</span>
        </div>
      )}
      {children}
    </div>
  );
}
