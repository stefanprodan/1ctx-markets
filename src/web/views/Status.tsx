// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentChildren } from "preact";
import { markets, type Status as StatusAnswer } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Page } from "../ui/Page.tsx";
import {
  bytes,
  clockTime,
  count,
  failingLine,
  jobLine,
  jobTone,
  sourceLine,
  sourcesOn,
  sourceTone,
  trackLine,
  trackTone,
} from "./Status.model.ts";
import "./status.css";

function Tile({
  label,
  figure,
  sub,
}: {
  label: string;
  figure: string;
  sub?: string;
}) {
  return (
    <div class="card srv-tile">
      <span class="label">{label}</span>
      <span class="srv-figure">{figure}</span>
      {sub && <span class="srv-sub">{sub}</span>}
    </div>
  );
}

function Dot({ tone }: { tone: string }) {
  return <span class={`srv-dot status-${tone}`} aria-hidden="true" />;
}

function Card({
  title,
  children,
}: {
  title: string;
  children: ComponentChildren;
}) {
  return (
    <section class="card srv-card">
      <header class="srv-card-head">
        <h2 class="srv-card-title">{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function StatusBody({
  status: s,
  now,
}: {
  status: StatusAnswer;
  now: number;
}) {
  const failing = s.jobs.filter((j) => jobTone(j) === "failed").length;
  return (
    <>
      <div class="srv-tiles">
        <Tile
          label="Instruments"
          figure={count(s.instruments)}
          sub={`${count(s.tracked)} tracked`}
        />
        <Tile
          label="Sources"
          figure={`${sourcesOn(s.sources)} on`}
          sub={`of ${s.sources.length}`}
        />
        <Tile
          label="Jobs"
          figure={count(s.jobs.length)}
          sub={failing === 0 ? "none failing" : `${failing} failing`}
        />
        <Tile
          label="Database"
          figure={bytes(s.database_bytes)}
          sub={s.version}
        />
      </div>
      <Card title="Sources">
        <ul class="srv-rows">
          {s.sources.map((src) => (
            <li key={src.name} class="srv-row">
              <Dot tone={sourceTone(src)} />
              <span class="srv-name">{src.name}</span>
              <span
                class={`srv-line${src.backing_off ? " status-failed" : ""}`}
              >
                {sourceLine(src, now)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Jobs">
        {s.jobs.length === 0 ? (
          <p class="srv-empty">No runs yet.</p>
        ) : (
          <ul class="srv-rows">
            {s.jobs.map((j) => {
              const failingScopes = failingLine(j);
              return (
                <li key={`${j.source}/${j.job}`} class="srv-row srv-row-wrap">
                  <Dot tone={jobTone(j)} />
                  <span class="srv-name">
                    {j.source}
                    <span class="srv-job"> {j.job}</span>
                  </span>
                  <span class="srv-line">{jobLine(j, now)}</span>
                  {(j.last.error !== null || failingScopes !== null) && (
                    <span class="srv-error status-failed">
                      {[j.last.error, failingScopes]
                        .filter((x) => x !== null)
                        .join(" · ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Tracked by flag">
        {s.track.length === 0 ? (
          <p class="srv-empty">None.</p>
        ) : (
          <ul class="srv-rows">
            {s.track.map((t) => (
              <li key={t.value} class="srv-row">
                <Dot tone={trackTone(t)} />
                <span class="srv-name">{t.value}</span>
                <span class="srv-line">{trackLine(t)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function Status() {
  const s = markets.status.value;
  const at = markets.statusAt.value;
  return (
    <Page
      title="Status"
      meta={at === null ? undefined : `as of ${clockTime(at)}`}
      error={markets.statusError.value}
      actions={
        <button
          type="button"
          class="btn btn-small"
          disabled={markets.loading.value}
          onClick={() => void markets.loadStatus()}
        >
          <Icon name="redo" size={14} />
          Refresh
        </button>
      }
    >
      {s === null ? (
        <p class="page-state">{markets.loading.value ? "Loading" : ""}</p>
      ) : (
        <StatusBody status={s} now={Date.now()} />
      )}
    </Page>
  );
}
