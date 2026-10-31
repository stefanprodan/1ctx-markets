// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The app's own menus: Dropdown, and ListFilter for a list head.

import { Icon } from "../lib/icons.tsx";
import { useMenu } from "../lib/menu.ts";
import "./dropdown.css";

export function Dropdown({
  label,
  value,
  options,
  onPick,
  chip,
  right,
  quiet,
}: {
  label: string;
  value: string | null;
  options: { value: string | null; text: string }[];
  onPick: (v: string | null) => void;
  // small, on the line it changes: a price's currency, the total's
  chip?: boolean;
  right?: boolean;
  // a list head's filter, drawn as 1ctx draws one
  quiet?: boolean;
}) {
  const { open, root } = useMenu();
  const picked = options.find((x) => x.value === value) ?? options[0]!;
  const menu = chip
    ? `drop-chip-menu${right ? " drop-chip-menu-right" : ""}`
    : "drop-menu";
  return (
    <div class={chip ? "drop-chip" : "drop"} ref={root}>
      <button
        type="button"
        class={chip ? "drop-chip-btn" : quiet ? "drop-quiet" : "btn drop-btn"}
        aria-label={`${label}: ${picked.text}`}
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="cut">{picked.text}</span>
        {chip ? (
          <Icon name="chevron" size={12} />
        ) : (
          <Icon name="chevron" size={14} class="drop-chevron" />
        )}
      </button>
      {open.value && (
        <div class={`menu ${menu}`} role="menu" aria-label={label}>
          {options.map((x) => (
            <button
              key={x.value ?? ""}
              type="button"
              class={`menu-item${x === picked ? " menu-item-on" : ""}`}
              role="menuitemradio"
              aria-checked={x === picked}
              onClick={() => {
                open.value = false;
                if (x !== picked) onPick(x.value);
              }}
            >
              <span class="cut">{x.text}</span>
              {x === picked && (
                <Icon name="check" size={14} class="drop-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// a list head's filter as 1ctx draws it: segments, a menu on a phone
export function ListFilter<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { value: T; text: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <>
      <span class="rows-filters-pick">
        <Dropdown
          quiet
          label={label}
          value={value}
          options={options}
          onPick={(v) => onPick(v as T)}
        />
      </span>
      <fieldset class="seg seg-small rows-filters" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            class={`seg-option${o.value === value ? " seg-on" : ""}`}
            aria-pressed={o.value === value}
            onClick={() => {
              if (o.value !== value) onPick(o.value);
            }}
          >
            {o.text}
          </button>
        ))}
      </fieldset>
    </>
  );
}
