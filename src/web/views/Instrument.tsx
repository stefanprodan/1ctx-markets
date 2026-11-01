// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useCallback, useEffect } from "preact/hooks";
import { navigate } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { says } from "../data/api.ts";
import { markets } from "../data/store.ts";
import { nameOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { CHART_CREDIT, Chart } from "./Chart.tsx";
import { type Choice, choices, summary, UNREAD } from "./Instrument.model.ts";
import { InstrumentCards } from "./InstrumentCards.tsx";
import { Head } from "./InstrumentHead.tsx";
import { InstrumentMenu, SAID_MS } from "./InstrumentMenu.tsx";
import { useHolding } from "./InstrumentPosition.tsx";
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

  const detail = markets.detailId.value === id ? markets.detail.value : null;
  const held = useHolding(detail?.instrument.id ?? null);
  const kind = detail?.instrument.kind;
  const symbol = tickerOf(id, kind);
  const options = detail === null ? [] : choices(detail.instrument);

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
    if (r.ok) navigate("/instruments");
    else
      refused.value =
        "rules" in r
          ? `A rule uses ${symbol}. Delete the rule first.`
          : r.error;
  };

  return (
    <Page
      title={symbol}
      meta={
        detail?.instrument.name
          ? nameOf(detail.instrument.name, kind, id)
          : undefined
      }
      failed={didNotLoad(
        detail !== null,
        markets.detailError.value,
        markets.detailCode.value,
        () => void load(),
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
          <InstrumentMenu
            symbol={symbol}
            busy={fetching.value}
            done={said.value?.text === "Updated"}
            removing={removing.value}
            onRefetch={() => void run(options[0]!)}
            onDelete={() => void remove()}
          />
        )
      }
    >
      {detail !== null && (
        <>
          <Head detail={detail} now={Date.now()} />
          <Chart id={id} intraday={detail.intraday} />
          <InstrumentCards detail={detail} held={held} />
        </>
      )}
    </Page>
  );
}
