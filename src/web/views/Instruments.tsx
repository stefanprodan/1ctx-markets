// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type Candidate, type Listed, markets } from "../data/store.ts";
import { useRefresh } from "../lib/refresh.ts";
import { didNotLoad, Page } from "../ui/Page.tsx";
import {
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../ui/Rows.tsx";
import { Search } from "../ui/Search.tsx";
import { searcher, UPSTREAM_MIN } from "./Dashboard.model.ts";
import {
  about,
  bySymbol,
  change,
  kindOf,
  matches,
  price,
  symbolOf,
} from "./Instruments.model.ts";
import "./instruments.css";

function Row({ row }: { row: Listed }) {
  const c = change(row);
  return (
    <RowsGo
      href={`/instruments/${encodeURIComponent(row.id)}`}
      off={!row.tracked}
    >
      <RowsTitle
        name={
          <>
            <span class="ins-symbol">{symbolOf(row.id)}</span>
            <span class="ins-name cut">{row.name ?? ""}</span>
          </>
        }
        sub={about(row)}
      />
      <RowsMeta
        keep
        under={
          <span
            class={c.dir > 0 ? "ins-up" : c.dir < 0 ? "ins-down" : undefined}
          >
            {c.text}
          </span>
        }
      >
        <span class="ins-price">{price(row)}</span>
      </RowsMeta>
    </RowsGo>
  );
}

// the sources' matches no row holds yet; opening one fetches it
function NotStored({
  query,
  known,
}: {
  query: string;
  known: ReadonlySet<string>;
}) {
  const [found, setFound] = useState<Candidate[] | null>(null);
  const finder = useMemo(
    () => searcher(markets.search, setFound, () => {}),
    [],
  );
  useEffect(() => finder.stop, [finder]);
  useEffect(
    () => finder.ask(query.trim().length >= UPSTREAM_MIN ? query : ""),
    [finder, query],
  );
  const rows = (found ?? []).filter((c) => !c.stored && !known.has(c.id));
  if (rows.length === 0) return null;
  return (
    <>
      <p class="label ins-new-label">Not stored yet</p>
      {rows.map((c) => (
        <RowsGo key={c.id} href={`/instruments/${encodeURIComponent(c.id)}`}>
          <RowsTitle
            name={
              <>
                <span class="ins-symbol">{symbolOf(c.id)}</span>
                <span class="ins-name cut">{c.name ?? ""}</span>
              </>
            }
            sub={[c.type ? kindOf(c.type) : null, c.exchange]
              .filter(Boolean)
              .join(" · ")}
          />
          <RowsMeta keep>
            <span class="tag ins-new">New</span>
          </RowsMeta>
        </RowsGo>
      ))}
    </>
  );
}

// the filter lives apart from the rows, so a refresh keeps it
export function InstrumentsList({
  all,
  query,
}: {
  all: Listed[] | null;
  query: Signal<string>;
}) {
  const rows = all?.filter((r) => matches(r, query.value)).sort(bySymbol);
  return (
    <RowsCard
      label="Instruments"
      search={<Search query={query} placeholder="Search" />}
      count={rows === undefined ? undefined : String(rows.length)}
    >
      {rows === undefined ? null : rows.length === 0 ? (
        <RowsNote>No instrument matches.</RowsNote>
      ) : (
        rows.map((r) => <Row key={r.id} row={r} />)
      )}
      {all !== null && (
        <NotStored query={query.value} known={new Set(all.map((r) => r.id))} />
      )}
    </RowsCard>
  );
}

export function Instruments() {
  const query = useSignal("");
  useRefresh(markets.loadInstruments);
  const held = markets.instruments.value !== null;
  return (
    <Page
      title="Instruments"
      stale={held ? markets.instrumentsError.value : null}
      staleCount={markets.instrumentsFailures.value}
      failed={didNotLoad(
        held,
        markets.instrumentsError.value,
        markets.instrumentsCode.value,
        () => void markets.loadInstruments(),
      )}
    >
      <InstrumentsList all={markets.instruments.value} query={query} />
    </Page>
  );
}
