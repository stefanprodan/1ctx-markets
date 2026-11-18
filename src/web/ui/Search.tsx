// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The search in a card's head, beside its title: bordered; on a phone an
// empty one folds to its icon and opens in the title's place, and one
// tap on its ✕ clears and folds it.

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./search.css";

// the writes still to come back when value is one the box sent, or null
// when it came from elsewhere
export function echoOf(sent: readonly string[], value: string) {
  const own = sent.indexOf(value);
  return own < 0 ? null : sent.slice(own + 1);
}

export function Search(
  props: {
    placeholder: string;
    // a wait before the query is sent, for a list asked of the server
    delay?: number;
    // under the field, such as a menu of results
    children?: ComponentChildren;
  } & (
    | { query: Signal<string> }
    | { value: string; onChange: (q: string) => void }
  ),
) {
  const { placeholder, delay = 0, children } = props;
  const value = "query" in props ? props.query.value : props.value;
  const write =
    "query" in props
      ? (q: string) => {
          props.query.value = q;
        }
      : props.onChange;
  const text = useSignal(value);
  const open = useSignal(false);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // what the box wrote and the page has not yet rendered back: an effect
  // runs after later keys, and resetting to its older text drops them
  const sent = useRef<string[]>([]);
  const onChange = (q: string) => {
    // the same text again renders nothing, so nothing would take it off
    if (q === (sent.current.at(-1) ?? value)) return;
    sent.current.push(q);
    write(q);
  };
  // the query moved under the box (back, a link): the box follows,
  // and a write still pending would only put the old text back
  useEffect(() => {
    const left = echoOf(sent.current, value);
    if (left !== null) {
      sent.current = left;
      return;
    }
    sent.current = [];
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    text.value = value;
  }, [value, text]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const settle = (q: string, atOnce = false) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (atOnce || delay === 0) {
      onChange(q);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(q);
    }, delay);
  };
  const clear = () => {
    text.value = "";
    settle("", true);
    open.value = false;
    input.current?.blur();
  };
  const shown = open.value || text.value !== "";
  const field = (
    <label class={`search${shown ? "" : " search-shut"}`}>
      <Icon name="search" size={14} class="search-icon" />
      <input
        ref={input}
        class="search-input"
        type="search"
        name="q"
        placeholder={placeholder}
        aria-label={placeholder}
        autocomplete="off"
        value={text.value}
        onFocus={() => {
          open.value = true;
        }}
        onBlur={() => {
          open.value = false;
        }}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          settle(text.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") clear();
          else if (ev.key === "Enter") {
            // inside a form, Enter would submit it
            ev.preventDefault();
            settle(text.value, true);
          }
        }}
      />
      {shown && (
        <button
          type="button"
          class={`btn-icon search-x${text.value === "" ? " search-x-empty" : ""}`}
          aria-label="Clear search"
          // kept from taking the focus, so the box is still open when it runs
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            clear();
          }}
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </label>
  );
  if (children === undefined) return field;
  return (
    <div class={`search-at${shown ? "" : " search-at-shut"}`}>
      {field}
      {children}
    </div>
  );
}
