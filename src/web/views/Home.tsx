// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { markets, type Spark, type WatchEntry } from "../data/store.ts";
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
  if (c.type !== "ready") {
    const body = (
      <>
        <span class="home-value cut">{c.value}</span>
        <span class="home-note">
          {c.type === "pending" ? "Pending" : c.text}
        </span>
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
  if (entries.length === 0) {
    return <p class="page-state">Nothing tracked yet.</p>;
  }
  const clips = clipIds(entries);
  return (
    <>
      {groupsOf(entries).map((g) => (
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
      ))}
    </>
  );
}

export function Home() {
  useRefresh(markets.loadHome);
  const entries = markets.watchlist.value;
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
