// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { type Listed, markets } from "../data/store.ts";
import { Page } from "../ui/Page.tsx";
import {
  RowsCard,
  RowsGo,
  RowsMeta,
  RowsNote,
  RowsTitle,
} from "../ui/Rows.tsx";
import { Search } from "../ui/Search.tsx";
import {
  about,
  bySymbol,
  change,
  matches,
  price,
  symbolOf,
} from "./Instruments.model.ts";
import "./instruments.css";

// prices land every few minutes; a list re-read is one local query
export const REFRESH_MS = 60_000;

// while the page is on screen, and at once when the tab comes back
function useRefresh(load: () => unknown): void {
  useEffect(() => {
    const visible = () => document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) void load();
    }, REFRESH_MS);
    const back = () => {
      if (visible()) void load();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, [load]);
}

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
    </RowsCard>
  );
}

export function Instruments() {
  const query = useSignal("");
  useRefresh(markets.loadInstruments);
  return (
    <Page title="Instruments" error={markets.instrumentsError.value}>
      <InstrumentsList all={markets.instruments.value} query={query} />
    </Page>
  );
}
