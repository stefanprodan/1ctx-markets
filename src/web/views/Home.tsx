// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "preact/hooks";
import { markets, type Spark, type WatchEntry } from "../data/store.ts";
import { copyText } from "../lib/clipboard.ts";
import { Icon } from "../lib/icons.tsx";
import { useRefresh } from "../lib/refresh.ts";
import { Page } from "../ui/Page.tsx";
import {
  cardOf,
  clipIds,
  groupsOf,
  type Line,
  SPARK_H,
  SPARK_W,
  sparkOf,
} from "./Home.model.ts";
import "./home.css";

// CSS tokens paint it, so it wears the theme from its first frame
export function Sparkline({ line, id }: { line: Line | null; id: string }) {
  if (line === null) return <div class="home-spark" aria-hidden="true" />;
  const box = `0 0 ${SPARK_W} ${SPARK_H}`;
  if (line.base === null) {
    return (
      <svg
        class="home-spark"
        viewBox={box}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline
          class={`spark-line spark-${line.tone}`}
          points={line.points}
        />
      </svg>
    );
  }
  // one line drawn twice, each copy clipped to its side of the previous close
  return (
    <svg
      class="home-spark"
      viewBox={box}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${id}-up`}>
          <rect x="0" y="0" width={SPARK_W} height={line.base} />
        </clipPath>
        <clipPath id={`${id}-down`}>
          <rect
            x="0"
            y={line.base}
            width={SPARK_W}
            height={SPARK_H - line.base}
          />
        </clipPath>
      </defs>
      <line
        class="spark-base"
        x1="0"
        x2={SPARK_W}
        y1={line.base}
        y2={line.base}
      />
      <polyline
        class="spark-line spark-up"
        clip-path={`url(#${id}-up)`}
        points={line.points}
      />
      <polyline
        class="spark-line spark-down"
        clip-path={`url(#${id}-down)`}
        points={line.points}
      />
    </svg>
  );
}

const tone = (dir: -1 | 0 | 1) =>
  dir > 0 ? " home-up" : dir < 0 ? " home-down" : "";

function Card({
  entry,
  spark,
  id,
}: {
  entry: WatchEntry;
  spark: Spark | undefined;
  id: string;
}) {
  const c = cardOf(entry);
  // the ready card's shape, so nothing moves when its figures land
  if (c.type === "pending") {
    return (
      <div class="card home-card home-card-pending">
        <div class="home-top">
          <span class="home-bone home-bone-name" />
          <span class="home-state">Pending</span>
        </div>
        <span class="home-symbol cut">{c.value}</span>
        <div class="home-spark home-bone-line" aria-hidden="true" />
        <span class="home-bone home-bone-price" />
        <span class="home-bone home-bone-move" />
      </div>
    );
  }
  if (c.type !== "ready") {
    const body = (
      <>
        <span class="home-value cut">{c.value}</span>
        <span class="home-note">{c.text}</span>
        {c.type === "failed" && c.price !== undefined && (
          <span class="home-price">{c.price}</span>
        )}
      </>
    );
    const cls = `card home-card home-card-${c.type}`;
    return c.type === "failed" && c.href !== undefined ? (
      <a class={cls} href={c.href}>
        {body}
      </a>
    ) : (
      <div class={cls}>{body}</div>
    );
  }
  return (
    <a class="card home-card" href={c.href}>
      <div class="home-top">
        <span class="home-name cut">{c.name}</span>
        {c.state && <span class="home-state">{c.state}</span>}
      </div>
      <span class="home-symbol cut">{c.symbol}</span>
      <Sparkline line={sparkOf(spark)} id={id} />
      <span class="home-price">{c.price}</span>
      <span class={`home-move${tone(c.dir)}`}>
        {c.move}
        {c.move && c.percent && " "}
        {c.percent && <span class="home-pct">{c.percent}</span>}
      </span>
    </a>
  );
}

export function HomeBody({
  entries,
  sparks,
}: {
  entries: readonly WatchEntry[];
  sparks: ReadonlyMap<string, Spark>;
}) {
  if (entries.length === 0) return <EmptyPanel />;
  const clips = clipIds(entries);
  // one new value is a pending card; many are a first start, told in a panel
  const loading = waitingOf(entries) > 1;
  return (
    <>
      {loading && <LoadingPanel entries={entries} />}
      {groupsOf(loading ? entries.filter((e) => !isWaiting(e)) : entries).map(
        (g) => (
          <section
            key={g.kind ?? ""}
            class="home-group"
            aria-label={g.kind ?? undefined}
          >
            {g.kind !== null && <h2 class="label home-kind">{g.kind}</h2>}
            <div class="home-grid">
              {g.entries.map((e) => (
                <Card
                  key={e.value}
                  entry={e}
                  spark={e.id === null ? undefined : sparks.get(e.id)}
                  id={clips.get(e)!}
                />
              ))}
            </div>
          </section>
        ),
      )}
    </>
  );
}

// the card's own rule, so the poll and the panel count what draws as pending
const isWaiting = (e: WatchEntry) => cardOf(e).type === "pending";
const waitingOf = (entries: readonly WatchEntry[]) =>
  entries.filter(isWaiting).length;

const EXAMPLE: readonly (readonly [string, string])[] = [
  ["^VIX", "Volatility"],
  ["^GSPC", "S&P 500"],
  ["GC=F", "Gold"],
  ["SI=F", "Silver"],
  ["CL=F", "Crude oil"],
  ["BTC-USD", "Bitcoin"],
  ["ETH-USD", "Ether"],
];

// zsh reads an unquoted ^ as a pattern
const arg = (s: string) => (s.startsWith("^") ? `'${s}'` : s);

// two flags a line, so a phone shows each line whole
const COMMAND = [
  "1ctx-markets \\",
  `  --track ${arg("^VIX")} --track ${arg("^GSPC")} \\`,
  "  --track GC=F --track SI=F \\",
  "  --track CL=F --track BTC-USD \\",
  "  --track ETH-USD",
].join("\n");

// as 1ctx: Copied only when the copy landed
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      class="btn-icon home-copy"
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy the command"}
      onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

function EmptyPanel() {
  return (
    <section class="card home-panel">
      <h2 class="home-panel-title">Nothing tracked yet</h2>
      <p class="home-panel-text">
        Home shows the markets you choose, with their price, the day's move and
        a day line. Start the server with one <code>--track</code> for each, as
        Yahoo Finance writes the symbol:
      </p>
      <div class="home-code">
        <pre>{COMMAND}</pre>
        <CopyButton text={COMMAND} />
      </div>
      <ul class="home-legend">
        {EXAMPLE.map(([symbol, name]) => (
          <li key={symbol}>
            <span class="home-legend-symbol">{symbol}</span> {name}
          </li>
        ))}
      </ul>
      <p class="home-panel-note">
        Running it as a service? Add the same flags to{" "}
        <code>1ctx-markets service install --restart</code>.
      </p>
    </section>
  );
}

function LoadingPanel({ entries }: { entries: readonly WatchEntry[] }) {
  const total = entries.length;
  const ready = entries.filter((e) => cardOf(e).type === "ready").length;
  return (
    <section class="card home-panel home-loading">
      <div class="home-loading-head">
        <span class="home-spinner" aria-hidden="true" />
        <h2 class="home-panel-title">Getting prices</h2>
        <span class="home-loading-count" role="status">
          {ready} of {total}
        </span>
      </div>
      <div class="home-progress" aria-hidden="true">
        <div style={{ width: `${(ready / total) * 100}%` }} />
      </div>
      <ul class="home-legend">
        {entries.map((e) => (
          <li key={e.value} class={`home-chip-${cardOf(e).type}`}>
            <span class="home-legend-symbol">{e.value}</span>
          </li>
        ))}
      </ul>
      <p class="home-panel-note">
        The first time, the server fetches each market's price history. This can
        take a minute.
      </p>
    </section>
  );
}

// while a value is first fetched, the page asks again sooner than its minute
const WAITING_MS = 3_000;

export function Home() {
  useRefresh(markets.loadHome);
  const entries = markets.watchlist.value;
  const waiting = entries === null ? false : waitingOf(entries) > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void markets.loadHome();
    }, WAITING_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <Page
      title="Home"
      error={markets.homeError.value}
      foot={markets.attribution.value ?? undefined}
    >
      {entries === null ? (
        <p class="page-state">Loading</p>
      ) : (
        <HomeBody entries={entries} sparks={markets.sparks.value} />
      )}
    </Page>
  );
}
