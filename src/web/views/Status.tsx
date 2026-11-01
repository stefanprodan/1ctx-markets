// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useState } from "preact/hooks";
import {
  type JobStatus,
  markets,
  type SourceStatus,
  type Status as StatusAnswer,
  type WatchEntry,
} from "../data/store.ts";
import { plain } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { Card, GroupLabel } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Facts, Stats } from "../ui/Figures.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { type Column, Table, type TableGroup } from "../ui/Table.tsx";
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
  sourcesOn,
  switchFailure,
  trackFailed,
  trackLine,
} from "./Status.model.ts";
import "./status.css";

type Failing = JobStatus["failing"][number];

const FAILING: Column<Failing>[] = [
  {
    key: "scope",
    width: "minmax(0, 1fr)",
    cell: (x) => <span class="cut">{x.scope ?? ""}</span>,
  },
  {
    key: "error",
    width: "minmax(0, 1.4fr)",
    cell: (x) => <span class="status-failed">{plain(x.error)}</span>,
  },
  {
    key: "at",
    width: "88px",
    align: "end",
    cell: (x) => <span class="faint">{runTime(x.at)}</span>,
  },
];

// what a job does, then its failing scopes with error and time, or that
// all are ok
export function JobDetails({
  job: j,
  source,
}: {
  job: JobStatus;
  source?: string;
}) {
  return (
    <>
      {j.about !== null && <p class="srv-line">{j.about}</p>}
      <Facts
        items={[
          ...(source === undefined ? [] : [{ label: "Source", value: source }]),
          {
            label: "Last run",
            value: runTime(j.last.ended_at ?? j.last.started_at),
          },
        ]}
      />
      {j.failing.length === 0 ? (
        <p class="srv-line">{allOk(j)}</p>
      ) : (
        <Table
          label="Failing"
          columns={FAILING}
          rows={j.failing}
          rowKey={(x) => x.scope ?? ""}
          head={false}
          dense
        />
      )}
      {j.failing_scopes > j.failing.length && (
        <Notice>
          {count(j.failing_scopes - j.failing.length)} more failing
        </Notice>
      )}
    </>
  );
}

export function jobColumns(now: number): Column<JobStatus>[] {
  return [
    {
      key: "state",
      width: "8px",
      cell: (j) => (
        <span class={`srv-dot status-${jobTone(j)}`} aria-hidden="true" />
      ),
    },
    {
      key: "job",
      head: "Job",
      width: { base: "minmax(0, 1.2fr)", phone: "minmax(0, 1fr)" },
      cell: (j) => (
        <>
          <span class="cut">{j.label}</span>
          <span class="small faint show-phone">{jobLine(j)}</span>
        </>
      ),
    },
    {
      key: "covers",
      head: "Covers",
      width: "minmax(0, 1.4fr)",
      hide: "phone",
      cell: (j) => <span class="faint">{jobLine(j)}</span>,
    },
    {
      key: "last",
      head: "Last run",
      width: { base: "minmax(0, 0.8fr)", phone: "80px" },
      align: "end",
      cell: (j) => <span class="faint">{jobWhen(j, now)}</span>,
    },
  ];
}

// one card of every job, a group per source as the holdings are grouped
export function JobsCard({
  groups: all,
  now,
  onOpen,
}: {
  groups: readonly SourceGroup[];
  now: number;
  onOpen: (key: string) => void;
}) {
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const total = all.reduce((n, g) => n + g.jobs.length, 0);
  const tableGroups: TableGroup<JobStatus>[] = all.map((g) => {
    const name = g.source.name;
    const closed = shut.has(name);
    return {
      key: name,
      label: (
        <GroupLabel
          label={g.source.label}
          count={g.jobs.length}
          trail={g.jobs.length === 0 ? "No runs yet." : undefined}
          open={!closed}
          onToggle={() =>
            setShut((was) => {
              const next = new Set(was);
              if (!next.delete(name)) next.add(name);
              return next;
            })
          }
        />
      ),
      rows: closed ? [] : g.jobs,
    };
  });
  return (
    <Card title="Jobs" count={count(total)}>
      <Table
        label="Jobs"
        columns={jobColumns(now)}
        groups={tableGroups}
        rowKey={jobKey}
        open={(j) => ({ run: () => onOpen(jobKey(j)) })}
        rowLabel={(j) => j.label}
        empty="No runs yet."
      />
    </Card>
  );
}

const jobKey = (j: JobStatus) => `${j.source}/${j.job}`;

const ADD: Column<SourceStatus>[] = [
  {
    key: "source",
    width: "minmax(0, 1fr)",
    cell: (x) => (
      <>
        <span>{x.label}</span>
        <span class="small faint">{x.key!.adds}</span>
        <span class="small faint">
          Save the key in <code>{x.key!.file}</code> in the data directory, then
          restart the server.
        </span>
      </>
    ),
  },
  {
    key: "signup",
    width: "88px",
    align: "end",
    cell: (x) => (
      <a href={x.key!.signup} target="_blank" rel="noopener">
        Get a key
      </a>
    ),
  },
];

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
  const off = s.sources.filter((x) => x.state === "off" && x.key !== null);
  const [opened, setOpened] = useState<string | null>(null);
  // a job gone from a later answer takes its drawer with it
  const open = shown
    .flatMap((g) => g.jobs.map((j) => ({ j, source: g.source.label })))
    .find((x) => jobKey(x.j) === opened);
  return (
    <div class="srv">
      <Stats
        label="Server"
        items={[
          {
            label: "Instruments",
            value: count(s.instruments),
            note: `${count(s.tracked)} tracked`,
          },
          {
            label: "Sources",
            value: String(sourcesOn(s.sources)),
            note: backing === 0 ? "all ok" : `${backing} paused`,
          },
          {
            label: "Jobs",
            value: count(jobs.length),
            note: failing === 0 ? "all ok" : `${failing} failing`,
          },
          {
            label: "Database",
            value: bytes(s.database_bytes),
            note: s.version,
          },
        ]}
      />
      {!s.sync && <Notice>Sync is off.</Notice>}
      {switched !== null && <Notice error>{switched}</Notice>}
      <JobsCard groups={shown} now={now} onOpen={setOpened} />
      {off.length > 0 && (
        <Card title="Add a source">
          <Table
            label="Add a source"
            columns={ADD}
            rows={off}
            rowKey={(x) => x.name}
            head={false}
          />
        </Card>
      )}
      {track.length > 0 && (
        <Card title="Always tracked" count={count(track.length)}>
          <ul class="srv-track">
            {track.map((t) => (
              <li key={t.value} class="srv-track-item">
                <span class="num">{t.value}</span>
                <span
                  class={`small cut ${trackFailed(t) ? "status-failed" : "faint"}`}
                >
                  {trackLine(t)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {open !== undefined && (
        <Drawer title={open.j.label} onClose={() => setOpened(null)}>
          <JobDetails job={open.j} source={open.source} />
        </Drawer>
      )}
    </div>
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
          class="btn"
          aria-label="Refresh"
          disabled={markets.loading.value}
          onClick={() => void markets.loadStatus()}
        >
          <Icon name="redo" size={14} />
          <span class="hide-phone">Refresh</span>
        </button>
      }
    >
      {s === null ? (
        markets.loading.value && <p class="page-state">Loading</p>
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
