// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Holding } from "../data/portfolios.ts";
import type { Detail } from "../data/store.ts";
import { amountsHidden } from "../ui/Amounts.tsx";
import { Card, CardLabel } from "../ui/Card.tsx";
import { Change, Facts } from "../ui/Figures.tsx";
import { RangeBar } from "../ui/RangeBar.tsx";
import {
  type Fact,
  type Gauge,
  type Signals,
  signalsOf,
} from "./InstrumentCards.model.ts";
import { fundOf } from "./InstrumentFund.model.ts";
import { FundCards } from "./InstrumentFund.tsx";
import { PositionCard } from "./InstrumentPosition.tsx";

function FactList({ facts }: { facts: readonly Fact[] }) {
  if (facts.length === 0) return null;
  return (
    <Facts
      items={facts.map((f) => ({
        label: f.label,
        value: <span class={f.tone ? `num ${f.tone}` : "num"}>{f.value}</span>,
        note: f.note,
      }))}
    />
  );
}

function GaugeBody({ g }: { g: Gauge }) {
  return (
    <>
      {g.span && <RangeBar {...g.span} />}
      <FactList facts={g.facts} />
    </>
  );
}

export function PerformanceCard({ s }: { s: Signals }) {
  if (s.returns === null && s.range === null) return null;
  return (
    <Card title="Performance">
      {s.returns && (
        <Facts
          four
          items={s.returns.map((r) => ({
            label: r.label,
            value: <Change s={r.value} />,
          }))}
        />
      )}
      {s.range && (
        <>
          <CardLabel>52-week range</CardLabel>
          <GaugeBody g={s.range} />
        </>
      )}
    </Card>
  );
}

export function InstrumentCards({
  detail,
  held,
}: {
  detail: Detail;
  held: Holding | null;
}) {
  const hide = amountsHidden.value;
  const s = signalsOf(detail);
  const fund = fundOf(detail.instrument, detail.top_holdings);
  return (
    <div class="ins-cards">
      {held && <PositionCard h={held} hide={hide} />}
      <PerformanceCard s={s} />
      {s.session && (
        <Card title={s.session.today ? "Today" : "Last session"}>
          <GaugeBody g={s.session} />
        </Card>
      )}
      {s.trend.length > 0 && (
        <Card title="Trend">
          <FactList facts={s.trend} />
        </Card>
      )}
      {fund && <FundCards fund={fund} />}
    </div>
  );
}
