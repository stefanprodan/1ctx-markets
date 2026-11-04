// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// A document as an agent reads it: fenced, so no line of it reads as the
// server's own words.

export type Revision = {
  revision: number;
  text: string;
  bytes: number;
  author: string;
  createdAt: number;
};

// one backtick longer than the text's longest run, so it cannot close it
export function fenceFor(text: string): string {
  let fence = "```";
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length >= fence.length) {
      fence = "`".repeat(match[0].length + 1);
    }
  }
  return fence;
}

export function fencedRead(
  header: string,
  text: string,
  footer: string,
): string {
  const fence = fenceFor(text);
  const beforeClose = text === "" || text.endsWith("\n") ? "" : "\n";
  return `${header}\n${fence}text\n${text}${beforeClose}${fence}\n${footer}`;
}
