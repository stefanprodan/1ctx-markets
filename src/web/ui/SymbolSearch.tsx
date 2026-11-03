// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The page head's symbol search, on every page: a result opens its
// instrument page; on a phone the bar's Search opens it as a full-screen
// sheet. Home's sections give each result an Add.

import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { symbolHref } from "../app/paths.ts";
import { visits } from "../app/router.ts";
import { onPhone } from "../app/shell.ts";
import { type BoardSection, type Candidate, markets } from "../data/store.ts";
import { Icon } from "../lib/icons.tsx";
import { kindOf, symbolOf } from "../lib/names.ts";
import { SymbolName } from "./Symbol.tsx";
import { escapeFrom, searcher, showsResults } from "./SymbolSearch.model.ts";
import "./symbol-search.css";

export type SearchAdds = {
  sections: readonly BoardSection[];
  onAdd: (section: number, id: string) => Promise<void>;
  // why the server would refuse the add, or null
  refuse: (section: number, id: string) => string | null;
};

const SEED_EVENT = "symbol-search";
const OPEN_EVENT = "symbol-search-open";
// on the button that opens the search, whose tap is no click outside it
export const OPENER = "data-opens-search";

// fills the head's search and opens it, such as from an example chip
export const seedSearch = (q: string) =>
  window.dispatchEvent(new CustomEvent(SEED_EVENT, { detail: q }));

// the searches on screen: none while a page leaves it out, which turns the
// bar's Search off
export const searchShown = signal(0);

// the bar's Search: dispatched inside the tap, since iOS opens the
// keyboard only for a focus inside it
export const openSearch = () => window.dispatchEvent(new Event(OPEN_EVENT));

export function SymbolResults({
  found,
  busy,
  refused,
  adds,
  picking,
  adding,
  onGo,
  onPick,
  onAdd,
}: {
  found: readonly Candidate[];
  busy: boolean;
  refused: string | null;
  adds?: SearchAdds;
  // the result whose section list is open
  picking: string | null;
  // the result being added, fetched before it lands
  adding: string | null;
  onGo: () => void;
  onPick: (id: string | null) => void;
  onAdd: (section: number, id: string) => void;
}) {
  const sections = adds?.sections ?? [];
  const where = (id: string) => sections.find((s) => s.ids.includes(id))?.name;
  return (
    <div class="menu ssearch-results">
      {found.length === 0 && !busy && (
        <span class="ssearch-none">Nothing found.</span>
      )}
      {refused !== null && (
        <span class="ssearch-none" role="alert">
          {refused}
        </span>
      )}
      {found.map((c) => {
        const on = where(c.id);
        return (
          <Fragment key={c.id}>
            <div class="ssearch-result">
              <a class="ssearch-go" href={symbolHref(c.id)} onClick={onGo}>
                <SymbolName ticker={symbolOf(c.id)} name={c.name} />
                <span class="ssearch-meta">
                  {c.type && <span>{kindOf(c.type)}</span>}
                  <span>{c.exchange}</span>
                  {!c.stored && <span class="tag ssearch-new">New</span>}
                </span>
              </a>
              {adds === undefined ? null : on !== undefined ? (
                <span class="ssearch-on" title={`On ${on}`}>
                  <Icon name="check" size={14} /> {on}
                </span>
              ) : adding === c.id ? (
                <span class="ssearch-on">Fetching…</span>
              ) : (
                <button
                  type="button"
                  class="btn btn-small ssearch-add"
                  aria-expanded={
                    sections.length > 0 ? picking === c.id : undefined
                  }
                  onClick={() => {
                    if (sections.length > 0) {
                      onPick(picking === c.id ? null : c.id);
                      return;
                    }
                    onAdd(0, c.id);
                  }}
                >
                  <Icon name="plus" size={14} /> Add
                </button>
              )}
            </div>
            {/* in the list, not floating: the list scrolls and would cut it */}
            {picking === c.id && on === undefined && adding !== c.id && (
              <div class="ssearch-pick">
                <span class="label ssearch-pick-label">Add to</span>
                {sections.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    class="menu-item"
                    onClick={() => onAdd(i, c.id)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function SymbolSearch({ adds }: { adds?: SearchAdds }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const pickingRef = useRef<string | null>(null);
  pickingRef.current = picking;
  const [refused, setRefused] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shut = () => {
    setOpen(false);
    setSheet(false);
    setPicking(null);
    setQuery("");
  };
  // the shell's phone check, not a width: a phone on its side is wide
  const phone = onPhone.value;
  // a step to another page, the browser's Back too, closes the sheet
  const step = visits.value;
  useEffect(() => {
    if (onPhone.peek()) shut();
  }, [step]);
  // the field shows before the render does, so the focus lands in the tap
  const openSheet = () => {
    root.current?.classList.add("ssearch-sheet");
    input.current?.focus();
    setSheet(true);
    setOpen(true);
  };
  useEffect(() => {
    searchShown.value++;
    window.addEventListener(OPEN_EVENT, openSheet);
    return () => {
      searchShown.value--;
      window.removeEventListener(OPEN_EVENT, openSheet);
    };
  }, []);
  useEffect(() => {
    const onSeed = (ev: Event) => {
      setQuery((ev as CustomEvent<string>).detail);
      // a phone's search shows only as the sheet
      setSheet(true);
      setOpen(true);
      input.current?.focus();
    };
    window.addEventListener(SEED_EVENT, onSeed);
    return () => window.removeEventListener(SEED_EVENT, onSeed);
  }, []);
  const finder = useMemo(() => searcher(markets.search, setFound, setBusy), []);
  useEffect(() => finder.stop, [finder]);
  useEffect(() => finder.ask(query), [finder, query]);
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const at = ev.target as Element;
      if (root.current?.contains(at) || at.closest?.(`[${OPENER}]`)) return;
      setOpen(false);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (escapeFrom(pickingRef.current) === "picker") setPicking(null);
      else {
        setOpen(false);
        setSheet(false);
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  const add = async (section: number, id: string) => {
    setPicking(null);
    if (adds === undefined) return;
    const why = adds.refuse(section, id);
    setRefused(why);
    if (why !== null) return;
    setAdding(id);
    await adds.onAdd(section, id);
    setAdding(null);
    shut();
  };
  return (
    <div
      class={`ssearch${phone ? " ssearch-phone" : ""}${sheet ? " ssearch-sheet" : ""}`}
      ref={root}
    >
      <div class="ssearch-bar">
        <label class="ssearch-box">
          <Icon name="search" size={14} class="ssearch-glass" />
          <input
            ref={input}
            class="ssearch-input"
            type="search"
            placeholder="Search a symbol or name"
            aria-label="Search a symbol or name"
            autocomplete="off"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setRefused(null);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
          />
          {busy && <span class="ssearch-spin" aria-hidden="true" />}
        </label>
        <button type="button" class="btn ssearch-cancel" onClick={shut}>
          Cancel
        </button>
      </div>
      {showsResults(open, found, busy, refused) && (
        <SymbolResults
          found={found!}
          busy={busy}
          refused={refused}
          adds={adds}
          picking={picking}
          adding={adding}
          onGo={shut}
          onPick={setPicking}
          onAdd={(section, id) => void add(section, id)}
        />
      )}
    </div>
  );
}
