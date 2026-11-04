// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

// A page head's one way to add: the same framed + on every page, its words
// in the label, so it never crowds the search and menu on a phone.

import { Icon } from "../lib/icons.tsx";

export function AddButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="btn page-add"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name="plus" size={16} />
    </button>
  );
}
