// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import {
  type JobStatus,
  markets,
  type Status as StatusAnswer,
} from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { Page } from "../ui/Page.tsx";
import { Rows, RowsCard, RowsLine, RowsMeta, RowsTitle } from "../ui/Rows.tsx";
import { RowsOpen } from "../ui/RowsOpen.tsx";
import {
  allOk,
  bytes,
  clockTime,
  count,
  groups,
  jobLine,
  jobTone,
  jobWhen,
  runTime,
  type SourceGroup,
  sourceState,
  sourcesOn,
  switchFailure,
  trackFailed,
  trackLine,
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

export function JobDetails({ job: j }: { job: JobStatus }) {
  return (
    <div class="srv-details">
      {j.about !== null && <p class="srv-about">{j.about}</p>}
      {j.failing.length === 0 && j.last.status !== "failed" ? (
        <p class="srv-ok">{allOk(j)}</p>
      ) : (
        <ul class="srv-failing">
          {(j.failing.length > 0
            ? j.failing
            : [
                {
                  scope: j.last.scope,
                  error: j.last.error,
                  at: j.last.ended_at,
                },
              ]
          ).map((x) => (
            <li key={x.scope ?? ""}>
              <span class="srv-failing-scope">{x.scope ?? ""}</span>
              <span class="status-failed">{x.error ?? "failed"}</span>
              <span class="srv-failing-at">{runTime(x.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {j.failing_scopes > j.failing.length && (
        <p class="srv-failing-more">
          {count(j.failing_scopes - j.failing.length)} more failing
        </p>
      )}
    </div>
  );
}

function SourceCard({
  group,
  now,
  opened,
  toggle,
}: {
  group: SourceGroup;
  now: number;
  opened: ReadonlySet<string>;
  toggle: (key: string) => void;
}) {
  const backing = group.source.backing_off !== null;
  return (
    <RowsCard
      label={group.source.label}
      count={sourceState(group.source, now)}
      class={`srv-source${backing ? " srv-source-bad" : ""}`}
    >
      {group.jobs.length === 0 ? (
        <RowsLine off>
          <RowsTitle name="No runs yet" />
        </RowsLine>
      ) : (
        group.jobs.map((j) => {
          const key = `${j.source}/${j.job}`;
          return (
            <RowsOpen
              key={key}
              open={opened.has(key)}
              onToggle={() => toggle(key)}
              indent="chevron"
              head={
                <>
                  <span
                    class={`srv-mark status-${jobTone(j)}`}
                    aria-hidden="true"
                  />
                  <RowsTitle name={j.label} sub={jobLine(j) || undefined} />
                  <RowsMeta>{jobWhen(j, now)}</RowsMeta>
                </>
              }
            >
              <JobDetails job={j} />
            </RowsOpen>
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
  const shown = groups(s.sources, s.jobs);
  const jobs = shown.flatMap((g) => g.jobs);
  const failing = jobs.filter((j) => jobTone(j) === "failed").length;
  const switched = switchFailure(s.jobs);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
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
          figure={String(sourcesOn(s.sources))}
          sub={s.sources
            .filter((x) => x.state === "on")
            .map((x) => x.short)
            .join(", ")}
        />
        <Tile
          label="Jobs"
          figure={count(jobs.length)}
          sub={failing === 0 ? "none failing" : `${failing} failing`}
        />
        <Tile
          label="Database"
          figure={bytes(s.database_bytes)}
          sub={s.version}
        />
      </div>
      <Rows>
        {switched !== null && (
          <p class="notice-failed" role="alert">
            {switched}
          </p>
        )}
        {shown.map((g) => (
          <SourceCard
            key={g.source.name}
            group={g}
            now={now}
            opened={opened}
            toggle={toggle}
          />
        ))}
        {s.sources.some((x) => x.state === "off" && x.key !== null) && (
          <RowsCard label="Add a source">
            {s.sources
              .filter((x) => x.state === "off" && x.key !== null)
              .map((x) => (
                <RowsLine key={x.name} flush>
                  <span class="avatar srv-logo">{x.mark}</span>
                  <RowsTitle
                    name={x.label}
                    sub={x.key!.adds}
                    lines={[
                      {
                        text: (
                          <>
                            Save the key in <code>{x.key!.file}</code> in the
                            data directory, then restart the server.
                          </>
                        ),
                      },
                    ]}
                    wrap
                  />
                  <RowsMeta keep>
                    <a href={x.key!.signup} target="_blank" rel="noopener">
                      Get a key
                    </a>
                  </RowsMeta>
                </RowsLine>
              ))}
          </RowsCard>
        )}
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
