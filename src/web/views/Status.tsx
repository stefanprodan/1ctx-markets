// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { says } from "../data/api.ts";
import {
  type JobStatus,
  markets,
  type SourceStatus,
  type Status as StatusAnswer,
} from "../data/store.ts";
import { plain } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { Card, GroupLabel } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Facts, Stats } from "../ui/Figures.tsx";
import { MenuButton, type MenuItem } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Placeholder } from "../ui/Placeholder.tsx";
import { type Column, Table, type TableGroup } from "../ui/Table.tsx";
import { AdminTabs } from "./Admin.tsx";
import { SAID_MS } from "./InstrumentMenu.tsx";
import {
  allOk,
  bytes,
  count,
  groups,
  jobLine,
  jobTone,
  jobWhen,
  retried,
  retryable,
  runTime,
  type SourceGroup,
  sourcesOn,
  switchFailure,
} from "./Status.model.ts";
import "./status.css";

type Failing = JobStatus["failing"][number];

// the jobs table's shape: what failed over its error, then its times
function failingColumns(next: boolean): Column<Failing>[] {
  return [
    {
      key: "scope",
      head: "Failing",
      width: "minmax(0, 1fr)",
      cell: (x) => (
        <>
          <span class="cut">{x.scope ?? ""}</span>
          <span class="small status-failed">{plain(x.error)}</span>
        </>
      ),
    },
    {
      key: "at",
      head: "Failed",
      width: "88px",
      align: "end",
      cell: (x) => <span class="faint">{runTime(x.at)}</span>,
    },
    // only a market check runs again on its own schedule
    ...(next
      ? [
          {
            key: "next",
            head: "Runs again",
            width: "88px",
            align: "end" as const,
            cell: (x: Failing) => (
              <span class="faint">
                {x.next_at === null ? "" : runTime(x.next_at)}
              </span>
            ),
          },
        ]
      : []),
  ];
}

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
          columns={failingColumns(j.failing.some((x) => x.next_at !== null))}
          rows={j.failing}
          rowKey={(x) => x.scope ?? ""}
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

const FIGURES = ["Instruments", "Sources", "Jobs", "Database"] as const;
type Figure = (typeof FIGURES)[number];

export function StatusWaiting() {
  return (
    <div class="srv">
      <Stats
        label="Server"
        items={FIGURES.map((label) => ({
          label,
          value: <Placeholder chars={4} />,
          note: <Placeholder chars={7} />,
        }))}
      />
      <Card title="Jobs">
        <Table
          label="Jobs"
          columns={jobColumns(Date.now())}
          rowKey={jobKey}
          waiting={6}
        />
      </Card>
    </div>
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
  const backing = s.sources.filter(
    (x) => x.state === "on" && x.backing_off !== null,
  ).length;
  const off = s.sources.filter((x) => x.state === "off" && x.key !== null);
  const figures: Record<Figure, { value: string; note: string }> = {
    Instruments: {
      value: count(s.instruments),
      note: `${count(s.tracked)} tracked`,
    },
    Sources: {
      value: String(sourcesOn(s.sources)),
      note: backing === 0 ? "all ok" : `${backing} paused`,
    },
    Jobs: {
      value: count(jobs.length),
      note: failing === 0 ? "all ok" : `${failing} failing`,
    },
    Database: {
      value: bytes(s.database_bytes),
      note: s.version,
    },
  };
  const [opened, setOpened] = useState<string | null>(null);
  // a job gone from a later answer takes its drawer with it
  const open = shown
    .flatMap((g) => g.jobs.map((j) => ({ j, source: g.source.label })))
    .find((x) => jobKey(x.j) === opened);
  return (
    <div class="srv">
      <Stats
        label="Server"
        items={FIGURES.map((label) => ({ label, ...figures[label] }))}
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
      {open !== undefined && (
        <Drawer title={open.j.label} onClose={() => setOpened(null)}>
          <JobDetails job={open.j} source={open.source} />
        </Drawer>
      )}
    </div>
  );
}

export const statusItems = (o: {
  failing: boolean;
  loading: boolean;
  onRefresh: () => void;
  onRetry: () => void;
}): MenuItem[] => [
  { label: "Refresh", icon: "redo", run: o.onRefresh, disabled: o.loading },
  {
    label: "Retry failed jobs",
    icon: "retry",
    run: o.onRetry,
    disabled: !o.failing,
  },
];

// as the instrument page's More menu
export function StatusMenu({
  busy,
  done,
  ...items
}: Parameters<typeof statusItems>[0] & { busy: boolean; done: boolean }) {
  return (
    <MenuButton
      head
      label="More"
      disabled={busy}
      items={statusItems(items)}
      face={
        busy ? (
          <span class="spinner srv-spin" role="img" aria-label="Retrying" />
        ) : done ? (
          <Icon name="check" size={16} class="status-done" />
        ) : undefined
      }
    />
  );
}

// Server admin's Status tab, at /admin
export function AdminStatus() {
  const s = markets.status.value;
  useRefresh(markets.loadStatus);
  const retrying = useSignal(false);
  const said = useSignal<{ done: boolean } | { error: string } | null>(null);
  // the check fades back to the menu's dots
  useEffect(() => {
    if (said.value === null || "error" in said.value) return;
    const timer = setTimeout(() => {
      said.value = null;
    }, SAID_MS);
    return () => clearTimeout(timer);
  }, [said.value]);
  const failing =
    s !== null && retryable(groups(s.sources, s.jobs).flatMap((g) => g.jobs));
  const retry = async () => {
    retrying.value = true;
    said.value = null;
    try {
      const r = await markets.retry();
      said.value = { done: retried(r) };
    } catch (error) {
      said.value = { error: says(error) };
    } finally {
      retrying.value = false;
    }
  };
  const outcome = said.value;
  return (
    <Page
      title="Server admin"
      tabs={<AdminTabs tab="status" />}
      stale={s === null ? null : markets.statusError.value}
      staleCount={markets.statusFailures.value}
      failed={didNotLoad(
        s !== null,
        markets.statusError.value,
        markets.statusCode.value,
        () => void markets.loadStatus(),
      )}
      error={outcome !== null && "error" in outcome ? outcome.error : null}
      actions={
        <StatusMenu
          busy={retrying.value}
          done={outcome !== null && "done" in outcome && outcome.done}
          failing={failing}
          loading={markets.loading.value}
          onRefresh={() => void markets.loadStatus()}
          onRetry={() => void retry()}
        />
      }
    >
      {s === null ? (
        <StatusWaiting />
      ) : (
        <StatusBody status={s} now={Date.now()} />
      )}
    </Page>
  );
}
