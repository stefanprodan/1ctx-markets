// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import {
  type JobStatus,
  markets,
  type Status as StatusAnswer,
  type WatchEntry,
} from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
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
  plain,
  runTime,
  type SourceGroup,
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
      {j.failing.length === 0 ? (
        <p class="srv-ok">{allOk(j)}</p>
      ) : (
        <ul class="srv-failing">
          {j.failing.map((x) => (
            <li key={x.scope ?? ""}>
              <span class="srv-failing-scope">{x.scope ?? ""}</span>
              <span class="status-failed">{plain(x.error)}</span>
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
  return (
    <RowsCard
      label={group.source.label}
      count={group.jobs.length === 1 ? "1 job" : `${group.jobs.length} jobs`}
      class="srv-source"
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
  watchlist: track,
  now,
}: {
  status: StatusAnswer;
  watchlist: readonly WatchEntry[];
  now: number;
}) {
  const shown = groups(s.sources, s.jobs);
  const jobs = shown.flatMap((g) => g.jobs);
  const failing = jobs.filter((j) => jobTone(j) === "failed").length;
  const switched = switchFailure(s.jobs);
  const backing = s.sources.filter(
    (x) => x.state === "on" && x.backing_off !== null,
  ).length;
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
          sub={backing === 0 ? "all ok" : `${backing} paused`}
        />
        <Tile
          label="Jobs"
          figure={count(jobs.length)}
          sub={failing === 0 ? "all ok" : `${failing} failing`}
        />
        <Tile
          label="Database"
          figure={bytes(s.database_bytes)}
          sub={s.version}
        />
      </div>
      <Rows>
        {!s.sync && <p class="srv-off">Sync is off.</p>}
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
        {track.length > 0 && (
          <RowsCard label="Always tracked" count={count(track.length)}>
            <ul class="srv-track">
              {track.map((t) => (
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
      title="Server status"
      meta={at === null ? undefined : `as of ${clockTime(at)}`}
      stale={s === null ? null : markets.statusError.value}
      staleCount={markets.statusFailures.value}
      failed={didNotLoad(
        s !== null,
        markets.statusError.value,
        markets.statusCode.value,
        () => void markets.loadStatus(),
      )}
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
        <StatusBody
          status={s}
          watchlist={markets.watchlist.value ?? []}
          now={Date.now()}
        />
      )}
    </Page>
  );
}
