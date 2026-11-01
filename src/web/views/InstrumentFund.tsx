// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Card } from "../ui/Card.tsx";
import { Weights } from "../ui/Weights.tsx";
import type { Fund } from "./InstrumentFund.model.ts";

export function FundCards({ fund }: { fund: Fund }) {
  return (
    <>
      <Card title="Top holdings">
        <div class="ins-fund">
          {fund.line && <p class="ins-line small faint">{fund.line}</p>}
          {fund.top.length > 0 && <Weights rows={fund.top} />}
        </div>
      </Card>
      {fund.split && (
        <Card title={fund.split.title}>
          <div class="ins-fund">
            <Weights rows={fund.split.rows} />
            {fund.split.note && (
              <p class="ins-line small faint">{fund.split.note}</p>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
