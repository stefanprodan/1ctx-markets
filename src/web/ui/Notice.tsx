// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A notice: a list with nothing in it, or what failed. A page that did
// not load at all is Page's `failed`.

import type { ComponentChildren } from "preact";
import { Icon, type IconName } from "../lib/icons.tsx";
import "./notice.css";

export function Notice({
  error,
  title,
  icon,
  actions,
  children,
}: {
  // a refusal in a box of its own, read out as an alert
  error?: boolean;
  // a panel that starts a page from nothing: an icon, a title, a line
  // and what to do
  title?: ComponentChildren;
  icon?: IconName;
  actions?: ComponentChildren;
  children?: ComponentChildren;
}) {
  if (error)
    return (
      <div class="notice-failed notice-error" role="alert">
        <Icon name="alert" size={16} class="notice-error-icon" />
        <span>{children}</span>
      </div>
    );
  if (title === undefined) return <p class="notice">{children}</p>;
  return (
    <section class="card notice-panel">
      {icon && (
        <div class="notice-icon" aria-hidden="true">
          <Icon name={icon} size={20} />
        </div>
      )}
      <h2 class="notice-title">{title}</h2>
      {children !== undefined && <p class="notice-text">{children}</p>}
      {actions !== undefined && <div class="notice-actions">{actions}</div>}
    </section>
  );
}
