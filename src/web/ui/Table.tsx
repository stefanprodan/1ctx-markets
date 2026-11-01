// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A table on one column grid, from its columns' definitions: sortable
// heads, a row that opens its page or its drawer, a ⋯ menu per row,
// group labels between rows, columns dropped on a tablet and a phone.

import type { ComponentChildren, HTMLAttributes } from "preact";
import { Icon } from "../lib/icons.tsx";
import { MenuButton, type MenuItem } from "./Menu.tsx";
import { Notice } from "./Notice.tsx";
import "./table.css";

// a track at each width; a narrower one falls back to the wider
export type Width = string | { base: string; tablet?: string; phone?: string };

export type Column<R> = {
  key: string;
  head?: ComponentChildren;
  width: Width;
  align?: "start" | "end";
  // the head's own alignment, when it differs from the cells'
  headAlign?: "start" | "end";
  // its head sorts the rows by it, first in this direction
  sortable?: boolean;
  sortFirst?: SortDir;
  // the sort button's hover words, given whether it is the sorted one
  // and which way
  sortTitle?: (on: boolean, dir: SortDir) => string;
  // dropped at this width and under
  hide?: "tablet" | "phone";
  // false drops it at every width: nothing in view fills it
  show?: boolean;
  cell: (row: R) => ComponentChildren;
};

export type TableGroup<R> = {
  key: string;
  // a GroupLabel or a PeriodLabel; none for a group alone
  label?: ComponentChildren;
  rows: readonly R[];
};

// a row opens a page (a link over the whole row) or runs an action
export type Open = { href: string } | { run: () => void };

type At = "base" | "tablet" | "phone";

export type SortDir = "asc" | "desc";

// more on a row's <tr>, such as a drag while a list is edited
export type RowAttrs = Pick<
  HTMLAttributes<HTMLTableRowElement>,
  "class" | "draggable" | "onDragStart" | "onDragEnd" | "onDragOver" | "onDrop"
>;

// a click on the sorted column turns it round; another column starts in
// its own first direction, high to low unless it says
export function nextSort(
  sort: string | undefined,
  dir: SortDir | undefined,
  key: string,
  first: SortDir = "desc",
): SortDir {
  if (sort !== key) return first;
  return dir === "asc" ? "desc" : "asc";
}

// the empty words show only when nothing would: no rows, and no label
// of a folded group standing in for them
export function showsEmpty<R>(groups: readonly TableGroup<R>[]): boolean {
  return groups.every((g) => g.rows.length === 0 && g.label === undefined);
}

// the grid's tracks at one width, the menu's last
export function tracks<R>(
  columns: readonly Column<R>[],
  at: At,
  menu = false,
): string {
  const out = shownAt(columns, at).map((c) => {
    if (typeof c.width === "string") return c.width;
    const w = c.width;
    return at === "phone"
      ? (w.phone ?? w.tablet ?? w.base)
      : at === "tablet"
        ? (w.tablet ?? w.base)
        : w.base;
  });
  if (menu) out.push("var(--table-more)");
  return out.join(" ");
}

// the columns on screen at one width
export function shownAt<R>(columns: readonly Column<R>[], at: At): Column<R>[] {
  return columns.filter(
    (c) =>
      c.show !== false &&
      !(at !== "base" && c.hide === "tablet") &&
      !(at === "phone" && c.hide === "phone"),
  );
}

const cellClass = (c: Column<unknown>, head = false) =>
  [
    "table-cell",
    ((head ? (c.headAlign ?? c.align) : c.align) ?? "start") === "end" &&
      "table-end",
    c.hide && `table-hide-${c.hide}`,
  ]
    .filter(Boolean)
    .join(" ");

export function Table<R>({
  columns,
  rows,
  groups,
  rowKey,
  open,
  rowLabel,
  menu,
  menuLabel,
  rowAttrs,
  sort,
  dir = "desc",
  onSort,
  empty,
  dense,
  head = true,
  label,
}: {
  columns: readonly Column<R>[];
  // a flat list, or groups with their labels
  rows?: readonly R[];
  groups?: readonly TableGroup<R>[];
  rowKey: (row: R) => string | number;
  open?: (row: R) => Open | null;
  // what a row opens, read out on its link or button
  rowLabel?: (row: R) => string;
  menu?: (row: R) => readonly MenuItem[];
  // the ⋯ button's name, such as "Actions for AAPL"
  menuLabel?: (row: R) => string;
  rowAttrs?: (row: R) => RowAttrs;
  // the column the rows are sorted by, and which way
  sort?: string;
  dir?: SortDir;
  // the column clicked and the direction it asks for (nextSort)
  onSort?: (key: string, dir: SortDir) => void;
  // said in place of rows when there are none
  empty?: ComponentChildren;
  // 52px rows, for a long list such as trades
  dense?: boolean;
  // false leaves the head row out, for a list that needs no names
  head?: boolean;
  label?: string;
}) {
  const cols = columns.filter((c) => c.show !== false);
  const all: readonly TableGroup<R>[] = groups ?? [
    { key: "", rows: rows ?? [] },
  ];
  const style = {
    "--table-cols": tracks(columns, "base", menu !== undefined),
    "--table-cols-tablet": tracks(columns, "tablet", menu !== undefined),
    "--table-cols-phone": tracks(columns, "phone", menu !== undefined),
  };
  const span = cols.length + (menu ? 1 : 0);
  return (
    <table
      class={`table${dense ? " table-dense" : ""}`}
      aria-label={label}
      style={style}
    >
      <thead hidden={!head}>
        <tr class="table-row table-head">
          {cols.map((c) => {
            const on = c.sortable && sort === c.key;
            return (
              <th
                key={c.key}
                class={cellClass(c as Column<unknown>, true)}
                scope="col"
                aria-sort={
                  c.sortable
                    ? on
                      ? dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                    : undefined
                }
              >
                {c.sortable && onSort ? (
                  <button
                    type="button"
                    class={`table-sort${on ? " table-sort-on" : ""}`}
                    title={c.sortTitle?.(on === true, dir)}
                    onClick={() =>
                      onSort(c.key, nextSort(sort, dir, c.key, c.sortFirst))
                    }
                  >
                    {c.head}
                    {on && (
                      <Icon
                        name={dir === "asc" ? "arrow-up" : "arrow-down"}
                        size={11}
                      />
                    )}
                  </button>
                ) : (
                  c.head
                )}
              </th>
            );
          })}
          {menu && (
            <th class="table-cell table-more" scope="col">
              <span class="table-hidden">Actions</span>
            </th>
          )}
        </tr>
      </thead>
      {all.map((g) => (
        <tbody key={g.key} class="table-group">
          {g.label !== undefined && (
            <tr class="table-label">
              <td colSpan={span}>{g.label}</td>
            </tr>
          )}
          {g.rows.map((r) => {
            const o = open?.(r) ?? null;
            const items = menu?.(r) ?? [];
            const { class: more, ...attrs } = rowAttrs?.(r) ?? {};
            return (
              <tr
                key={rowKey(r)}
                {...attrs}
                class={`table-row${o ? " table-row-open" : ""}${more ? ` ${more}` : ""}`}
              >
                {cols.map((c, i) => (
                  <td key={c.key} class={cellClass(c as Column<unknown>)}>
                    {i === 0 && o && <OpenOver o={o} label={rowLabel?.(r)} />}
                    {c.cell(r)}
                  </td>
                ))}
                {menu && (
                  <td class="table-cell table-more">
                    {items.length > 0 && (
                      <MenuButton
                        label={menuLabel?.(r) ?? "Actions"}
                        items={items}
                      />
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      ))}
      {empty !== undefined && showsEmpty(all) && (
        <tbody class="table-group">
          <tr class="table-empty">
            <td colSpan={span}>
              <Notice>{empty}</Notice>
            </td>
          </tr>
        </tbody>
      )}
    </table>
  );
}

// over the whole row, under its menu
function OpenOver({ o, label }: { o: Open; label: string | undefined }) {
  const words = <span class="table-hidden">{label ?? "Open"}</span>;
  return "href" in o ? (
    <a class="table-open" href={o.href}>
      {words}
    </a>
  ) : (
    <button type="button" class="table-open" onClick={o.run}>
      {words}
    </button>
  );
}
