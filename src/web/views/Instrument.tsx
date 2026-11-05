// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect, useMemo } from "preact/hooks";
import { SCREENER } from "../app/paths.ts";
import { navigate } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { says } from "../data/api.ts";
import { markets } from "../data/store.ts";
import { nameOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Facts, HeroWaiting } from "../ui/Figures.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Placeholder, WaitWords } from "../ui/Placeholder.tsx";
import { CHART_CREDIT, Chart, ChartWaiting } from "./Chart.tsx";
import {
  buyable,
  type Choice,
  choices,
  summary,
  UNREAD,
} from "./Instrument.model.ts";
import { moreMenu } from "./InstrumentAnalysis.model.ts";
import { AnalysisSection } from "./InstrumentAnalysis.tsx";
import { InstrumentCards } from "./InstrumentCards.tsx";
import { Head } from "./InstrumentHead.tsx";
import { InstrumentMenu, SAID_MS } from "./InstrumentMenu.tsx";
import { useHolding } from "./InstrumentPosition.tsx";
import {
  BuyButton,
  FundMenu,
  type TradeSheet,
  TradeSheets,
} from "./InstrumentTrade.tsx";
import "./instruments.css";

export function Instrument({ params }: { params: Params }) {
  const id = params.id!;
  const load = useCallback(() => markets.loadInstrument(id), [id]);
  useRefresh(load);
  const fetching = useSignal(false);
  const said = useSignal<{ text: string; bad: boolean } | null>(null);
  // the button's outcome fades back to Refetch
  useEffect(() => {
    if (said.value === null || said.value.bad) return;
    const timer = setTimeout(() => {
      said.value = null;
    }, SAID_MS);
    return () => clearTimeout(timer);
  }, [said.value]);
  const removing = useSignal(false);
  const refused = useSignal<string | null>(null);

  const mine = markets.detailId.value === id;
  const detail = mine ? markets.detail.value : null;
  const saved = useSignal(0);
  const sheet = useSignal<TradeSheet | null>(null);
  const held = useHolding(detail?.instrument.id ?? null, saved.value);
  const hand = detail?.quote?.kind === "hand_price";
  const kind = detail?.instrument.kind;
  const symbol = tickerOf(id, kind);
  const options = detail === null ? [] : choices(detail.instrument);
  const analysis = useMemo(() => markets.analysis(id), [id]);
  const writing = useSignal(false);
  // Back or Forward reuses the page, so a drawer never carries a draft over
  useEffect(() => {
    writing.value = false;
  }, [id]);
  // offered once the read says there is none, never before it lands
  const write =
    analysis.doc.value !== null && analysis.doc.value.revision === null
      ? () => {
          writing.value = true;
        }
      : undefined;

  const run = async (c: Choice) => {
    fetching.value = true;
    said.value = null;
    try {
      const results = await markets.refetch(id, c.parts, c.sections);
      said.value = summary(results, options, symbol);
    } catch (error) {
      said.value = { text: says(error), bad: true };
    } finally {
      fetching.value = false;
    }
  };
  const remove = async () => {
    removing.value = true;
    refused.value = null;
    const r = await markets.remove(id);
    removing.value = false;
    if (r.ok) navigate(SCREENER);
    else
      refused.value =
        "rules" in r
          ? `An alert uses ${symbol}. Delete the alert first.`
          : r.error;
  };

  return (
    <Page
      title={symbol}
      back={SCREENER}
      meta={
        detail?.instrument.name
          ? nameOf(detail.instrument.name, kind, id)
          : undefined
      }
      failed={didNotLoad(
        detail !== null,
        mine ? markets.detailError.value : null,
        mine ? markets.detailCode.value : null,
        () => void markets.loadInstrument(id, true),
      )}
      stale={detail === null ? null : markets.detailError.value}
      staleCount={markets.detailFailures.value}
      error={
        (said.value?.bad || said.value?.text === "Not available"
          ? said.value.text
          : null) ??
        refused.value ??
        (detail?.error ? UNREAD : null)
      }
      foot={
        detail !== null && (
          <>
            {detail.credit && (
              <>
                Data by{" "}
                <a href={detail.credit.url} target="_blank" rel="noopener">
                  {detail.credit.name}
                </a>
                {" · "}
              </>
            )}
            Charts by{" "}
            <a href={CHART_CREDIT} target="_blank" rel="noopener">
              TradingView
            </a>
          </>
        )
      }
      actions={
        detail !== null && (
          <>
            {/* a buy of what the page is on, held or not */}
            {buyable(detail.instrument) && <BuyButton open={sheet} />}
            {hand ? (
              // a fund the owner prices sells and is priced here
              <FundMenu open={sheet} held={held !== null} onWrite={write} />
            ) : (
              moreMenu(markets.isAdmin.value, write !== undefined) && (
                <InstrumentMenu
                  symbol={symbol}
                  admin={markets.isAdmin.value}
                  onWrite={write}
                  busy={fetching.value}
                  done={said.value?.text === "Updated"}
                  removing={removing.value}
                  onRefetch={() => void run(options[0]!)}
                  onDelete={() => void remove()}
                />
              )
            )}
          </>
        )
      }
    >
      {detail !== null ? (
        <>
          <Head detail={detail} now={Date.now()} />
          <Chart
            key={id}
            id={id}
            intraday={detail.intraday}
            hand={hand}
            // a share's bars do not change with a trade; a fund's price can
            saved={hand ? saved.value : 0}
          />
          <InstrumentCards detail={detail} held={held} />
          <AnalysisSection
            key={id}
            store={analysis}
            symbol={symbol}
            writing={writing}
          />
          <TradeSheets
            id={detail.instrument.id}
            fund={
              hand
                ? {
                    isin: detail.instrument.id.slice("fund:".length),
                    name: detail.instrument.name ?? symbol,
                    market: held?.market ?? null,
                  }
                : null
            }
            held={held}
            open={sheet}
            onSaved={() => {
              saved.value++;
              void markets.loadInstrument(id, true);
            }}
          />
        </>
      ) : (
        <InstrumentWaiting
          symbol={symbol}
          first={markets.firstFetch.value === id}
          slow={markets.detailSlow.value}
        />
      )}
    </Page>
  );
}

function CardWaiting() {
  return (
    <Card title={<Placeholder chars={11} />}>
      <Facts
        items={[9, 12, 8, 10].map((chars) => ({
          label: <Placeholder chars={chars} />,
          value: <Placeholder chars={7} />,
        }))}
      />
    </Card>
  );
}

// a first fetch takes seconds, so it is said at once
export function InstrumentWaiting({
  symbol,
  first,
  slow,
}: {
  symbol: string;
  first: boolean;
  slow: boolean;
}) {
  return (
    <>
      <HeroWaiting />
      <ChartWaiting>
        {first ? (
          <WaitWords show spin>
            {`Fetching ${symbol} for the first time`}
          </WaitWords>
        ) : (
          <WaitWords show={slow}>Loading the chart</WaitWords>
        )}
      </ChartWaiting>
      <div class="ins-cards">
        <CardWaiting />
        <CardWaiting />
      </div>
    </>
  );
}
