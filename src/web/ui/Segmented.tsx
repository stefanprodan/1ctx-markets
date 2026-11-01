// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A mode inside a card: a few options side by side, the picked one
// filled. Its look is base.css's .seg.

import type { ComponentChildren } from "preact";

export function Segmented<V extends string>({
  label,
  options,
  value,
  onPick,
  small,
  disabled,
}: {
  label: string;
  options: readonly { value: V; text: ComponentChildren; title?: string }[];
  value: V;
  onPick: (v: V) => void;
  // the small one in a card's head
  small?: boolean;
  // a save on its way holds the pick
  disabled?: boolean;
}) {
  return (
    <fieldset class={`seg${small ? " seg-small" : ""}`} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={`seg-option${o.value === value ? " seg-on" : ""}`}
          aria-pressed={o.value === value}
          title={o.title}
          disabled={disabled}
          onClick={() => {
            if (o.value !== value) onPick(o.value);
          }}
        >
          {o.text}
        </button>
      ))}
    </fieldset>
  );
}
