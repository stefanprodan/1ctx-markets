// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { markets, type Status as StatusAnswer } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Page } from "../ui/Page.tsx";
import { Rows, RowsCard, RowsLine, RowsMeta, RowsTitle } from "../ui/Rows.tsx";
import {
  bytes,
  clockTime,
  count,
  failures,
  groupName,
  groups,
  jobLine,
  jobTone,
  jobWhen,
  type SourceGroup,
  sourceState,
  sourcesOn,
  trackFailed,
  trackLine,
} from "./Status.model.ts";
import "./status.css";

function Tile({
  label,
  figure,
  sub,
  bad,
}: {
  label: string;
  figure: string;
  sub?: string;
  bad?: boolean;
}) {
  return (
    <div class="card srv-tile">
      <span class="label">{label}</span>
      <span class="srv-figure">{figure}</span>
      {sub && (
        <span class={`srv-sub${bad ? " status-failed" : ""}`}>{sub}</span>
      )}
    </div>
  );
}

function SourceCard({ group, now }: { group: SourceGroup; now: number }) {
  const off = group.source?.state === "off";
  const backing = group.source?.backing_off != null;
  return (
    <RowsCard
      label={groupName(group)}
      count={group.source === null ? undefined : sourceState(group.source, now)}
      class={`srv-source${backing ? " srv-source-bad" : ""}`}
    >
      {group.jobs.length === 0 ? (
        <RowsLine off>
          <RowsTitle name="No runs yet" />
        </RowsLine>
      ) : (
        group.jobs.map((j) => {
          const failed = jobTone(j) === "failed";
          const lines = failed ? failures(j) : [];
          return (
            <RowsLine key={j.job} off={off} flush>
              <span
                class={`srv-mark status-${off ? "stopped" : jobTone(j)}`}
                aria-hidden="true"
              />
              <RowsTitle
                name={j.label}
                sub={jobLine(j) || undefined}
                lines={lines.map((text) => ({ text, bad: true }))}
                wrap
              />
              <RowsMeta>{jobWhen(j, now)}</RowsMeta>
            </RowsLine>
          );
        })
      )}
    </RowsCard>
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
          bad={failing > 0}
        />
        <Tile
          label="Database"
          figure={bytes(s.database_bytes)}
          sub={s.version}
        />
      </div>
      <Rows>
        {groups(s.sources, s.jobs).map((g) => (
          <SourceCard key={g.id} group={g} now={now} />
        ))}
        {s.track.length > 0 && (
          <RowsCard label="Always tracked" count={count(s.track.length)}>
            <ul class="srv-track">
              {s.track.map((t) => (
                <li key={t.value} class="srv-track-item">
                  <span class="srv-track-value">{t.value}</span>
                  <span
                    class={`srv-track-id${trackFailed(t) ? " status-failed" : ""}`}
                  >
                    {trackLine(t)}
                  </span>
                </li>
              ))}
            </ul>
          </RowsCard>
        )}
      </Rows>
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
