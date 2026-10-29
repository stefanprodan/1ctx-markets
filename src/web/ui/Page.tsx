// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import "./page.css";

export const REPO = "https://github.com/stefanprodan/1ctx-markets";

// how long a failed refresh shows over the answer still on screen
export const STALE_MS = 5000;

export type Failed = {
  words: string;
  status: number | null;
  retry: () => void;
};

// as 1ctx: a page with nothing on screen says it did not load; one still
// holding its last answer keeps the one-line error over it instead
export function didNotLoad(
  held: boolean,
  words: string | null,
  status: number | null,
  retry: () => void,
): Failed | undefined {
  return held || words === null ? undefined : { words, status, retry };
}

export function Page({
  title,
  meta,
  actions,
  error,
  stale,
  staleCount,
  failed,
  foot,
  children,
}: {
  title: string;
  // a short line beside the title, such as when the page was answered
  meta?: ComponentChildren;
  actions?: ComponentChildren;
  // a failure over the body, which stays as it was answered last
  error?: string | null;
  // a refresh failed over the answer still on screen: shown a few
  // seconds, and again at each later failure
  stale?: string | null;
  // the page's count of failed loads, so each new failure shows again
  staleCount?: number;
  // the page could not load at all: 1ctx's notice, in place of the body
  failed?: Failed;
  // a footer, only on a page that owes a credit (its charts'): the
  // server's name and version on the left, the credit on the right
  foot?: ComponentChildren;
  children?: ComponentChildren;
}) {
  // the server's, from the status the sign-in read
  const version = markets.status.value?.version;
  const [shown, setShown] = useState<string | null>(stale ?? null);
  useEffect(() => {
    setShown(stale ?? null);
    if (stale === null || stale === undefined) return;
    const timer = setTimeout(() => setShown(null), STALE_MS);
    return () => clearTimeout(timer);
  }, [stale, staleCount]);
  const notice = error || shown;
  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">{title}</h1>
        {meta && <span class="page-meta">{meta}</span>}
        {actions && <div class="page-actions">{actions}</div>}
      </div>
      {notice && (
        <div class="notice-failed page-failed" role="alert">
          <Icon name="alert" size={16} class="page-failed-icon" />
          <span>{notice}</span>
        </div>
      )}
      {failed ? (
        <div class="notice-failed page-load-failed" role="alert">
          <Icon name="alert" size={20} class="page-failed-icon" />
          <div class="page-failed-words">
            <p class="page-failed-title">
              This page did not load
              {failed.status !== null && (
                <span class="code-tag">HTTP {failed.status}</span>
              )}
            </p>
            <p class="page-failed-text">{failed.words}</p>
          </div>
          <button
            type="button"
            class="btn page-failed-retry"
            onClick={failed.retry}
          >
            Try again
          </button>
        </div>
      ) : (
        children
      )}
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
