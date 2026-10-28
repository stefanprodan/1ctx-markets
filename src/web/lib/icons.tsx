// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

const SPARKLE =
  "M19.5 1.0C19.5 2.925 21.075 4.5 23.0 4.5C21.075 4.5 19.5 6.075 19.5 8.0C19.5 6.075 17.925 4.5 16.0 4.5C17.925 4.5 19.5 2.925 19.5 1.0Z";

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
      aria-label="1ctx"
      role="img"
    >
      <path d="M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5" />
      <path d="M8.75 11.25 11.5 8.75V17.5" />
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
      <path
        fill="currentColor"
        transform="translate(23 68.5)"
        d="M4.03 0V-5.42H13.14V-29.2L3.98 -22.49V-29.2L12.03 -35H19.13V-5.42H26.47V0Z M42.62 0.48Q39.22 0.48 36.7 -0.79Q34.18 -2.06 32.79 -4.39Q31.4 -6.71 31.4 -9.88V-16.49Q31.4 -19.66 32.79 -21.98Q34.18 -24.31 36.7 -25.58Q39.22 -26.85 42.62 -26.85Q47.56 -26.85 50.56 -24.28Q53.55 -21.72 53.7 -17.31H47.8Q47.66 -19.37 46.24 -20.5Q44.83 -21.62 42.62 -21.62Q40.18 -21.62 38.79 -20.3Q37.4 -18.99 37.4 -16.54V-9.88Q37.4 -7.43 38.79 -6.09Q40.18 -4.75 42.62 -4.75Q44.88 -4.75 46.27 -5.87Q47.66 -7 47.8 -9.06H53.7Q53.55 -4.65 50.56 -2.09Q47.56 0.48 42.62 0.48Z M72.64 0Q68.95 0 66.76 -2.13Q64.58 -4.27 64.58 -7.91V-20.95H57.29V-26.37H64.58V-33.8H70.62V-26.37H81.12V-20.95H70.62V-8.05Q70.62 -6.9 71.27 -6.16Q71.92 -5.42 73.07 -5.42H80.88V0Z M85.15 0 94.36 -13.62 85.77 -26.37H92.53L96.61 -19.9Q96.99 -19.32 97.33 -18.6Q97.66 -17.88 97.81 -17.45Q98 -17.88 98.31 -18.6Q98.62 -19.32 99.01 -19.9L103.08 -26.37H109.89L101.31 -13.62L110.47 0H103.66L99.1 -7.24Q98.72 -7.82 98.36 -8.56Q98 -9.3 97.81 -9.73Q97.62 -9.3 97.28 -8.56Q96.95 -7.82 96.56 -7.24L91.96 0Z"
      />
    </svg>
  );
}

const PATHS = {
  // a pulse: what the server is doing
  status: "M1.5 8.5h3l2-5 3 9 2-4h3",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01",
  chevron: "M5 6.5l3 3 3-3",
  "chevron-right": "M6.5 5l3 3-3 3",
  check: "M3 8.5l3 3 7-7",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3.2 3.2",
  alert: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 4.75v3.75M8 11h.01",
  "sign-out": "M6.5 3H3v10h3.5M10 5l3 3-3 3M13 8H6",
  sidebar:
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 3v10",
  close: "M4 4l8 8M12 4l-8 8",
  redo: "M14 8a6 6 0 1 1-1.8-4.3M14 2v3.5h-3.5",
  moon: "M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.6 4.6 0 0 0 7.1 7.1z",
  key: "M5.5 13.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7.6 8.4 13.5 2.5M11.5 4.5l1.75 1.75M9.75 6.25l1.25 1.25",
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
