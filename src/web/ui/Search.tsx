// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import "./search.css";

const SEARCH_DELAY = 200;

export function Search(
  props: { placeholder: string } & (
    | { query: Signal<string> }
    | { value: string; onChange: (q: string) => void }
  ),
) {
  const { placeholder } = props;
  const value = "query" in props ? props.query.value : props.value;
  const onChange =
    "query" in props
      ? (q: string) => {
          props.query.value = q;
        }
      : props.onChange;
  const text = useSignal(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the query moved under the box (back, a link): the box follows,
  // and a write still pending would only put the old text back
  useEffect(() => {
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
    if (atOnce) {
      timer.current = null;
      onChange(q);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      onChange(q);
    }, SEARCH_DELAY);
  };
  return (
    <label class="search">
      <Icon name="search" size={14} class="search-icon" />
      <input
        class="search-input"
        type="search"
        name="q"
        placeholder={placeholder}
        aria-label={placeholder}
        autocomplete="off"
        value={text.value}
        onInput={(ev) => {
          text.value = ev.currentTarget.value;
          settle(text.value);
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            text.value = "";
            settle("", true);
          } else if (ev.key === "Enter") {
            // inside a form, Enter would submit it
            ev.preventDefault();
            settle(text.value, true);
          }
        }}
      />
    </label>
  );
}
