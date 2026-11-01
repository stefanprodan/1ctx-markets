// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import plex from "../fonts/IBMPlexSans-Regular.woff2";
import mono from "../fonts/JetBrainsMono-Regular.woff2";

// Bun inlines a CSS url() under 128 KiB, so the faces are declared here
export function addFonts(): void {
  for (const [family, path] of [
    ["IBM Plex Sans", plex],
    ["JetBrains Mono", mono],
  ] as const) {
    document.fonts.add(
      new FontFace(family, `url(${path}) format("woff2")`, {
        weight: "400",
        display: "swap",
      }),
    );
  }
}
