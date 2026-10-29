// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one way to copy text. The clipboard is missing on a plain-http
// page and refuses a page without focus; either way the answer is
// false, so a button shows Copied only when the copy landed.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
