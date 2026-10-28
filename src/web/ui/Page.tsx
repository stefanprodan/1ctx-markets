// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import "./page.css";

export const REPO = "https://github.com/stefanprodan/1ctx-markets";

export function Page({
  title,
  meta,
  actions,
  error,
  foot,
  children,
}: {
  title: string;
  // a short line beside the title, such as when the page was answered
  meta?: ComponentChildren;
  actions?: ComponentChildren;
  // a failure over the body, which stays as it was answered last
  error?: string | null;
  // a footer, only on a page that owes a credit (its charts'): the
  // server's name and version on the left, the credit on the right
  foot?: ComponentChildren;
  children?: ComponentChildren;
}) {
  // the server's, from the status the sign-in read
  const version = markets.status.value?.version;
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
      {foot && (
        <footer class="page-foot">
          <span>
            <a href={REPO} target="_blank" rel="noopener">
              1ctx Markets
            </a>
            {version !== undefined && ` ${version}`}
          </span>
          <span class="page-foot-end">{foot}</span>
        </footer>
      )}
    </div>
  );
}
