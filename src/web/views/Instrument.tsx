// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect, useMemo } from "preact/hooks";
import { SCREENER } from "../app/paths.ts";
import { navigate, path } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { says } from "../data/api.ts";
import { type BoardSection, markets } from "../data/store.ts";
import { nameOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Facts, HeroWaiting } from "../ui/Figures.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Placeholder, WaitWords } from "../ui/Placeholder.tsx";
import { CHART_CREDIT, Chart, ChartWaiting } from "./Chart.tsx";
import {
  addRefusal,
  addTo,
  homeSection,
  removeFromHome,
  waiting,
} from "./Dashboard.model.ts";
import {
  buyable,
  type Choice,
  choices,
  onLeave,
  onSymbolPage,
  refreshMs,
  summary,
  UNREAD,
} from "./Instrument.model.ts";
import { AnalysisSection } from "./InstrumentAnalysis.tsx";
import { InstrumentCards } from "./InstrumentCards.tsx";
import { Head } from "./InstrumentHead.tsx";
import { type HomeChoice, InstrumentMenu, SAID_MS } from "./InstrumentMenu.tsx";
import { useHolding } from "./InstrumentPosition.tsx";
import {
  BuyButton,
  showPrice,
  type TradeSheet,
  TradeSheets,
} from "./InstrumentTrade.tsx";
import { TradePlansSection } from "./InstrumentTradePlans.tsx";
import "./instruments.css";

export function Instrument({ params }: { params: Params }) {
  const id = params.id!;
  const load = useCallback(() => markets.refreshInstrument(id), [id]);
  useRefresh(load, false, refreshMs(markets.fastId.value, id));
  // so a fast refresh starts at once, not a whole period after the open
  useEffect(() => {
    if (document.visibilityState === "visible") void markets.live(id);
    return onLeave(document, window, () => markets.leave(id));
  }, [id]);
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
  useEffect(() => {
    void markets.loadLayout();
  }, [id]);

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
  const plans = useMemo(() => markets.tradePlans.tagged(id), [id]);
  const writing = useSignal(false);
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
      if (onSymbolPage(path.peek(), id)) {
        said.value = summary(results, options, symbol);
      }
    } catch (error) {
      if (onSymbolPage(path.peek(), id)) {
        said.value = { text: says(error), bad: true };
      }
    } finally {
      fetching.value = false;
    }
  };
  const remove = async () => {
    removing.value = true;
    refused.value = null;
    const r = await markets.remove(id);
    removing.value = false;
    if (!onSymbolPage(path.peek(), id)) return;
    if (r.ok) navigate(SCREENER);
    else
      refused.value =
        "rules" in r
          ? `An alert uses ${symbol}. Delete the alert first.`
          : r.error;
  };

  // Home keeps the id the server answers, not the one in the address
  const homeId = detail?.instrument.id ?? id;
  const toHome = async (next: BoardSection[]) => {
    refused.value = null;
    const r = await markets.saveLayout(next);
    if (!onSymbolPage(path.peek(), id)) return;
    if (r === "saved") said.value = { text: "Saved", bad: false };
    else {
      // said here, so Home never shows an error from no edit of its own
      refused.value = markets.saveError.peek();
      markets.saveError.value = null;
    }
  };
  // a save while World markets are still filling in would drop them for good
  const layout = waiting(markets.seeding.value) ? null : markets.layout.value;
  const home: HomeChoice = {
    sections: layout,
    at: layout === null ? -1 : homeSection(layout, homeId),
    onAdd: (section) => {
      const now = markets.layout.peek() ?? [];
      const next = addTo(now, section, homeId);
      if (next === null) refused.value = addRefusal(now, section, homeId);
      else void toHome(next);
    },
    onRemove: () =>
      void toHome(removeFromHome(markets.layout.peek() ?? [], homeId)),
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
            {/* a fund not held, with its analysis, has nothing to offer */}
            {(!hand || held !== null || write !== undefined) && (
              <InstrumentMenu
                symbol={symbol}
                // a fund the owner prices is never refetched or deleted here
                admin={markets.isAdmin.value && !hand}
                home={hand ? undefined : home}
                onWrite={write}
                onPrice={
                  hand && held !== null ? () => showPrice(sheet) : undefined
                }
                busy={fetching.value}
                done={
                  said.value?.text === "Updated" || said.value?.text === "Saved"
                }
                removing={removing.value}
                onRefetch={() => void run(options[0]!)}
                onDelete={() => void remove()}
                isin={detail.isin ?? null}
                onIsin={async (isin) => {
                  const error = await markets.setIsin(id, isin);
                  if (error === null && onSymbolPage(path.peek(), id)) {
                    said.value = { text: "Saved", bad: false };
                  }
                  return error;
                }}
              />
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
            saved={saved.value}
          />
          <InstrumentCards detail={detail} held={held} />
          <TradePlansSection key={id} store={plans} id={id} />
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
