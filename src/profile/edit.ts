// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Part of the profile changed by exact replacement, as an agent's editor
// does: each old matches once in the text it read, so the order of the
// pairs never changes the result and no edit matches another's text.

import { ArgError } from "../operations/args.ts";

export type ProfileEdit = { old: string; new: string };

export const MAX_EDITS = 50;

// every old is matched against the text as given, before any pair
// applies; a refusal names the pair from 1 and never quotes its old
export function applyEdits(
  text: string,
  edits: readonly ProfileEdit[],
): string {
  if (edits.length === 0 || edits.length > MAX_EDITS) {
    throw new ArgError(`edits must hold 1 to ${MAX_EDITS} pairs`);
  }
  const spans = edits.map((edit, i) => {
    const name = `edit ${i + 1}`;
    if (edit.old === "") throw new ArgError(`${name}: old is empty`);
    const start = text.indexOf(edit.old);
    if (start === -1) throw new ArgError(`${name}: no match`);
    // a second match stops the search: counting them all costs their
    // number times old's length on repetitive text
    if (text.indexOf(edit.old, start + 1) !== -1) {
      throw new ArgError(`${name}: matches more than once`);
    }
    return { index: i, start, end: start + edit.old.length, edit };
  });
  // in pair order, so the later pair is the one named
  for (const span of spans) {
    const other = spans.find(
      (earlier) =>
        earlier.index < span.index &&
        earlier.start < span.end &&
        span.start < earlier.end,
    );
    if (other !== undefined) {
      throw new ArgError(
        `edit ${span.index + 1}: overlaps edit ${other.index + 1}`,
      );
    }
  }
  let out = "";
  let at = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, span.start) + span.edit.new;
    at = span.end;
  }
  return out + text.slice(at);
}
