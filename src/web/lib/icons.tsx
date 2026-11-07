// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { SPARKLE, WORD } from "../../shared/marks.ts";

// the brand book's stroke: 1.75 under 32 px, 1.5 from there
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={size < 32 ? 1.75 : 1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="Markets"
      role="img"
    >
      <path d="M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5" />
      <path d="M5.5 17 9.25 12.75 12.25 14.75 16.5 9" />
      <path fill="var(--sparkle)" stroke="none" d={SPARKLE} />
    </svg>
  );
}

export function Logo({ height = 26 }: { height?: number }) {
  const width = Math.round((height * 170.19) / 90);
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 170.19 90"
      aria-label="1ctx"
      role="img"
    >
      <g
        transform="translate(3 15)"
        fill="none"
        stroke-width="6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          stroke="currentColor"
          d="M126.19 0H18.72A18.72 18.72 0 0 0 0 18.72V53.28A18.72 18.72 0 0 0 18.72 72H133.47A18.72 18.72 0 0 0 152.19 53.28V26"
        />
        <path
          fill="var(--sparkle)"
          stroke="none"
          transform="translate(74.19 -18) scale(4)"
          d={SPARKLE}
        />
      </g>
      <path fill="currentColor" transform="translate(23 68.5)" d={WORD} />
    </svg>
  );
}

// "1ctx" alone, cropped to its letters
export function Wordmark({ height = 26 }: { height?: number }) {
  return (
    <svg
      width={Math.round((height * 107.5) / 35.7)}
      height={height}
      viewBox="3.5 -35.2 107.5 35.7"
      aria-label="1ctx"
      role="img"
    >
      <path fill="currentColor" d={WORD} />
    </svg>
  );
}

const PATHS = {
  home: "M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5zM6.5 13.5v-4h3v4",
  // a pulse: what the server is doing
  status: "M1.5 8.5h3l2-5 3 9 2-4h3",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  chevron: "M5 6.5l3 3 3-3",
  "chevron-right": "M6.5 5l3 3-3 3",
  "chevron-left": "M10 3.5 5.5 8l4.5 4.5",
  check: "M3 8.5l3 3 7-7",
  copy: "M6 6h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3.2 3.2",
  alert: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 4.75v3.75M8 11h.01",
  "sign-out": "M6.5 3H3v10h3.5M10 5l3 3-3 3M13 8H6",
  sidebar:
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 3v10",
  close: "M4 4l8 8M12 4l-8 8",
  redo: "M14 8a6 6 0 1 1-1.8-4.3M14 2v3.5h-3.5",
  retry:
    "M2 8a6 6 0 0 1 10.2-4.3L14 5.5M14 2v3.5h-3.5M14 8a6 6 0 0 1-10.2 4.3L2 10.5M2 14v-3.5h3.5",
  moon: "M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z",
  key: "M5.5 13.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7.6 8.4 13.5 2.5M11.5 4.5l1.75 1.75M9.75 6.25l1.25 1.25",
  // the editor's toolbar, and Profile: a person
  heading: "M4 3v10M12 3v10M4 8h8",
  bold: "M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.5a2.5 2.5 0 0 1 0 5H4.5z",
  italic: "M10 3H6.5M9.5 13H6M8.75 3 7.25 13",
  quote: "M3 4v8M6 5h7M6 8h7M6 11h5",
  code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
  link: "M7 9a3 3 0 0 0 4.2.3l2-2a3 3 0 0 0-4.2-4.2l-1 1M9 7a3 3 0 0 0-4.2-.3l-2 2a3 3 0 0 0 4.2 4.2l1-1",
  numbered:
    "M6.5 4h7M6.5 8h7M6.5 12h7M2.5 3l1-.5V6M2.5 9.5a1 1 0 0 1 2 0c0 .8-2 1.5-2 2.5h2",
  user: "M8 8a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.5 13.5c.6-2.6 2.9-4 5.5-4s4.9 1.4 5.5 4",
  // Portfolios: a briefcase
  briefcase: "M2.5 5.5h11v8h-11zM6 5.5v-2h4v2M2.5 9h11",
  shield:
    "M8 1.75 13 3.5v4c0 3.2-2.1 5.6-5 6.75C5.1 13.1 3 10.7 3 7.5v-4zM5.75 8l1.5 1.5 3-3",
  download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  upload: "M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10",
  // Connect agents: a plug
  plug: "M8 14.5v-3M6 5.5v-4M10 5.5v-4M4 5.5h8v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z",
  plus: "M8 3v10M3 8h10",
  // a condition not met yet: an empty circle, never a cross that reads as delete
  circle: "M8 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  // Trade plans: a flag planted at a level
  flag: "M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5",
  // Price alerts: a bell
  bell: "M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.75 13.5a1.4 1.4 0 0 0 2.5 0",
  grid: "M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z",
  rows: "M2.5 4h11M2.5 8h11M2.5 12h11",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  grip: "M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01",
  "arrow-up": "M8 13V3M4 7l4-4 4 4",
  "arrow-down": "M8 3v10M4 9l4 4 4-4",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9",
  pencil: "M10.5 2.5l3 3-8 8H2.5v-3z",
  // Settings: three sliders
  sliders: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11M5.5 3v3M10.5 6.5v3M7 10v3",
  star: "M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4l-3.7 2.1.8-4.2L2 6.4l4.2-.5z",
  eye: "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  "eye-off":
    "M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8zM6 8a2 2 0 1 0 4 0a2 2 0 1 0-4 0M2.5 13.5l11-11",
} satisfies Record<string, string>;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  class: cls,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width={1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
