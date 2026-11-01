// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type Candidate, type Listed, markets } from "../data/store.ts";
import { change, priceParts } from "../lib/format.ts";
import { kindOf, marketOf, nameOf, stopped, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card, GroupLabel } from "../ui/Card.tsx";
import { Change, Num } from "../ui/Figures.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Search } from "../ui/Search.tsx";
import { SymbolName } from "../ui/Symbol.tsx";
import { searcher, UPSTREAM_MIN } from "../ui/SymbolSearch.model.ts";
import {
  type Column,
  type SortDir,
  Table,
  type TableGroup,
} from "../ui/Table.tsx";
import { matches, type SortKey, sortRows } from "./Instruments.model.ts";

// a stored row, or a source's match no row holds yet
type Item = { listed: Listed } | { found: Candidate };

const idOf = (x: Item) => ("listed" in x ? x.listed.id : x.found.id);
const hrefOf = (id: string) => `/instruments/${encodeURIComponent(id)}`;

function nameCell(x: Item) {
  if ("found" in x) {
    const c = x.found;
    return (
      <SymbolName
        ticker={tickerOf(c.id, c.type)}
        name={nameOf(c.name, c.type, c.id)}
      />
    );
  }
  const r = x.listed;
  const name = nameOf(r.name, r.kind, r.id);
  const end = stopped(r);
  return (
    <SymbolName
      ticker={tickerOf(r.id, r.kind)}
      name={end ? [name, end].filter(Boolean).join(" · ") : name}
    />
  );
}

function priceCell(x: Item) {
  if ("found" in x) return <span class="tag">New</span>;
  const p = priceParts(x.listed);
  return (
    <>
      <Num currency={p.currency}>{p.value}</Num>
      {/* a phone drops the change column and keeps the move here */}
      <Change s={change(x.listed)} class="small show-phone" />
    </>
  );
}

const COLUMNS: readonly Column<Item>[] = [
  {
    key: "symbol",
    head: "Instrument",
    width: { base: "minmax(0, 2.2fr)", phone: "minmax(0, 1fr)" },
    sortable: true,
    sortFirst: "asc",
    cell: nameCell,
  },
  {
    key: "kind",
    head: "Kind",
    width: "minmax(0, 0.8fr)",
    sortable: true,
    sortFirst: "asc",
    hide: "phone",
    cell: (x) =>
      "found" in x
        ? x.found.type
          ? kindOf(x.found.type)
          : ""
        : kindOf(x.listed.kind),
  },
  {
    key: "market",
    head: "Market",
    width: "minmax(0, 0.8fr)",
    sortable: true,
    sortFirst: "asc",
    hide: "phone",
    cell: (x) => ("found" in x ? x.found.exchange : marketOf(x.listed)),
  },
  {
    key: "price",
    head: "Price",
    width: { base: "minmax(0, 1fr)", phone: "112px" },
    align: "end",
    cell: priceCell,
  },
  {
    key: "change",
    head: "Change",
    width: "minmax(0, 0.7fr)",
    align: "end",
    sortable: true,
    hide: "phone",
    cell: (x) => ("found" in x ? null : <Change s={change(x.listed)} />),
  },
];

// the sources' matches no row holds yet; opening one fetches it
function useNotStored(query: string, known: ReadonlySet<string>): Candidate[] {
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
  return (found ?? []).filter((c) => !c.stored && !known.has(c.id));
}

// the filter and the order live apart from the rows, so a refresh keeps
// them
export function InstrumentsList({
  all,
  query,
}: {
  all: Listed[] | null;
  query: Signal<string>;
}) {
  const sort = useSignal<SortKey>("symbol");
  const dir = useSignal<SortDir>("asc");
  const known = useMemo(() => new Set((all ?? []).map((r) => r.id)), [all]);
  const fresh = useNotStored(all === null ? "" : query.value, known);
  const rows =
    all === null
      ? undefined
      : sortRows(
          all.filter((r) => matches(r, query.value)),
          sort.value,
          dir.value,
        );
  const groups: TableGroup<Item>[] =
    rows === undefined
      ? []
      : [
          { key: "stored", rows: rows.map((listed) => ({ listed })) },
          ...(fresh.length > 0
            ? [
                {
                  key: "new",
                  label: (
                    <GroupLabel label="Not stored yet" count={fresh.length} />
                  ),
                  rows: fresh.map((found) => ({ found })),
                },
              ]
            : []),
        ];
  return (
    <Card
      title="All"
      label="Instruments"
      count={rows === undefined ? undefined : rows.length}
      actions={<Search query={query} placeholder="Search" />}
    >
      {rows !== undefined && (
        <Table
          label="Instruments"
          columns={COLUMNS}
          groups={groups}
          rowKey={idOf}
          open={(x) => ({ href: hrefOf(idOf(x)) })}
          rowLabel={(x) =>
            "listed" in x
              ? tickerOf(x.listed.id, x.listed.kind)
              : tickerOf(x.found.id, x.found.type)
          }
          sort={sort.value}
          dir={dir.value}
          onSort={(k, d) => {
            sort.value = k as SortKey;
            dir.value = d;
          }}
          empty="No instrument matches."
        />
      )}
    </Card>
  );
}

export function Instruments() {
  const query = useSignal("");
  useRefresh(markets.loadInstruments);
  const held = markets.instruments.value !== null;
  return (
    <Page
      title="Instruments"
      // the list's own search reaches the sources too
      search={false}
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
