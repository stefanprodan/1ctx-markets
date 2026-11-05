// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ALERTS, ALERTS_FIRED as FIRED, symbolHref } from "../app/paths.ts";
import { onPhone } from "../app/shell.ts";
import type { Alert, Listings, Rule } from "../data/alerts.ts";
import type { Listing } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { ago, amount } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { nameOf, symbolOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { SymbolName } from "../ui/Symbol.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  conditionLines,
  dayLabel,
  firedText,
  gateText,
  inTile,
  NEAR_PERCENT,
  nearOf,
  nowText,
  rightNow,
  ruleSummary,
  STATE_WORDS,
  type StateKey,
  sortRules,
  stateOf,
  TILES,
  type TileKey,
  timeText,
  valueText,
} from "./Alerts.model.ts";
import { SymbolPick } from "./PortfolioForms.tsx";
import { listingWords, price as livePrice } from "./Portfolios.model.ts";
import "./instruments.css";
import "./portfolios.css";
import "./alerts.css";

type TabKey = "rules" | "fired";

const store = markets.alerts;

function Head({ tab }: { tab: TabKey }) {
  const unseen = store.seen.value?.unseen ?? 0;
  return (
    <Tabs
      label="Alerts"
      value={tab}
      tabs={[
        { key: "rules", label: "Rules", href: ALERTS },
        {
          key: "fired",
          label: "Fired",
          href: FIRED,
          count: tab === "rules" && unseen > 0 ? unseen : null,
        },
      ]}
    />
  );
}

function AlertsPage({ tab }: { tab: TabKey }) {
  useRefresh(store.loadAll);
  const adding = useSignal(false);
  const held = store.rules.value !== null;
  return (
    <Page
      title="Alerts"
      tabs={<Head tab={tab} />}
      stale={held ? store.error.value : null}
      staleCount={store.failures.value}
      actions={
        <button
          type="button"
          class="btn btn-small"
          onClick={() => {
            adding.value = true;
          }}
        >
          <Icon name="plus" size={14} />
          <span>Price alert</span>
        </button>
      }
      failed={didNotLoad(
        held,
        store.error.value,
        store.code.value,
        () => void store.loadAll(),
      )}
    >
      {tab === "rules" ? <RulesTab /> : <FiredTab />}
      {adding.value && (
        <AddDrawer
          onClose={() => {
            adding.value = false;
          }}
        />
      )}
    </Page>
  );
}

export const AlertRules = () => <AlertsPage tab="rules" />;
export const AlertsFired = () => <AlertsPage tab="fired" />;

// Watching is the usual state and stays plain; the rest are badges
const TONE: Record<StateKey, string | null> = {
  watching: null,
  holds: "al-tag-on",
  fired: "al-tag-on",
  paused: "al-tag-off",
  split: "al-tag-warn",
  earnings: "al-tag-off",
  stale: "al-tag-warn",
  unknown: "al-tag-warn",
};

function StateTag({ rule }: { rule: Rule }) {
  const s = stateOf(rule);
  const tone = TONE[s];
  return tone === null ? (
    <span class="al-state">{STATE_WORDS[s]}</span>
  ) : (
    <span class={`tag tag-side al-tag ${tone}`}>{STATE_WORDS[s]}</span>
  );
}

// how near: a short meter, full at the level, empty 10% or more away
function Distance({ rule }: { rule: Rule }) {
  const n = nearOf(rule, {});
  if (n.distance === null) {
    return n.of > 1 ? (
      <span class="small faint num">
        {n.holds === 0 ? "None met" : `${n.holds} of ${n.of} met`}
      </span>
    ) : (
      <span class="faint">–</span>
    );
  }
  const fill = Math.max(0, 1 - n.distance / 10);
  const near = n.distance <= NEAR_PERCENT;
  return (
    <span class="al-dist">
      <span class={`small num${near ? "" : " faint"}`}>
        {n.distance === 0 ? "Met" : `${n.distance.toFixed(1)}% away`}
      </span>
      <span class="al-meter" aria-hidden="true">
        <span
          class={`al-meter-fill${near ? " al-meter-near" : ""}`}
          style={{ width: `${(fill * 100).toFixed(0)}%` }}
        />
      </span>
    </span>
  );
}

function ruleColumns(l: Listings): Column<Rule>[] {
  return [
    {
      key: "rule",
      head: "Rule",
      width: "minmax(0, 2.4fr)",
      cell: (r) => (
        <span class="al-rule">
          <SymbolName
            compact
            ticker={tickerOf(r.symbol, l[r.symbol]?.type)}
            name={nameOf(
              l[r.symbol]?.name ?? null,
              l[r.symbol]?.type,
              r.symbol,
            )}
          />
          <span class="al-cond">{ruleSummary(r, l)}</span>
          {r.note && <span class="al-note small faint">{r.note}</span>}
          <span class="show-phone al-phone-line">
            <span class="al-phone-now">
              {nearOf(r, l).shown && (
                <span class="small num">{nearOf(r, l).shown!.text} ·</span>
              )}
              <Distance rule={r} />
            </span>
            <StateTag rule={r} />
          </span>
        </span>
      ),
    },
    {
      key: "now",
      head: "Now",
      width: "minmax(0, 0.9fr)",
      align: "end",
      hide: "phone",
      cell: (r) => {
        const n = nearOf(r, l);
        return n.shown === null ? (
          <span class="faint">–</span>
        ) : (
          <span class="num">{n.shown.text}</span>
        );
      },
    },
    {
      key: "near",
      head: "Distance",
      width: "minmax(0, 1fr)",
      align: "end",
      hide: "phone",
      cell: (r) => <Distance rule={r} />,
    },
    {
      key: "state",
      head: "State",
      width: "minmax(0, 1.1fr)",
      align: "end",
      hide: "phone",
      cell: (r) => <StateTag rule={r} />,
    },
  ];
}

function RulesTab() {
  const tile = useSignal<TileKey>("all");
  const open = useSignal<number | null>(null);
  const rules = store.rules.value;
  const alerts = store.alerts.value ?? [];
  const l = store.listings.value;
  const now = Date.now();
  const sorted = rules === null ? [] : sortRules(rules);
  const shown = sorted.filter((r) => inTile(tile.value, r, alerts, now));
  const rule = rules?.find((r) => r.id === open.value) ?? null;
  if (rules !== null && rules.length === 0) {
    return (
      <Notice title="No rules yet" icon="bell">
        Add a price alert, or ask an agent to watch a level.
      </Notice>
    );
  }
  return (
    <>
      <fieldset class="scr-set" aria-label="Filters">
        <div class="scr-tiles al-tiles">
          {TILES.map((t) => {
            const on = t.key === tile.value;
            const n =
              rules === null
                ? null
                : sorted.filter((r) => inTile(t.key, r, alerts, now)).length;
            return (
              <button
                key={t.key}
                type="button"
                class={`scr-tile${on ? " scr-tile-on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  tile.value = t.key;
                }}
              >
                <span class="scr-n num">{n ?? "–"}</span>
                <span class="scr-name">{t.name}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <Card title={TILES.find((t) => t.key === tile.value)!.name} label="Rules">
        <Table
          label="Rules"
          columns={ruleColumns(l)}
          rows={shown}
          rowKey={(r) => r.id}
          open={(r) => ({
            run: () => {
              open.value = r.id;
            },
          })}
          rowLabel={(r) => ruleSummary(r, l)}
          empty="None here."
          head={!onPhone.value}
          waiting={rules === null ? 4 : undefined}
        />
      </Card>
      {rule !== null && (
        <RuleDrawer
          key={rule.id}
          rule={rule}
          fired={alerts.filter((a) => a.rule_id === rule.id)}
          onClose={() => {
            open.value = null;
          }}
        />
      )}
    </>
  );
}

function RuleDrawer({
  rule,
  fired,
  onClose,
}: {
  rule: Rule;
  fired: readonly Alert[];
  onClose: () => void;
}) {
  const l = store.listings.value;
  const busy = useSignal(false);
  const asking = useSignal(false);
  const said = useSignal<string | null>(null);
  const run = async (
    work: () => Promise<string | null>,
    close?: () => void,
  ) => {
    busy.value = true;
    said.value = null;
    const refused = await work();
    busy.value = false;
    if (refused !== null) said.value = refused;
    else close?.();
  };
  const gate = gateText(rule, l);
  const lines = conditionLines(rule.condition, rule.symbol, l);
  const values = rule.now.values;
  const now = Date.now();
  return (
    <Drawer
      title={tickerOf(rule.symbol, l[rule.symbol]?.type)}
      onClose={onClose}
      swaps
      busy={busy.value}
      footStart={
        asking.value ? (
          "Remove this rule?"
        ) : (
          <button
            type="button"
            class="btn btn-small btn-danger"
            disabled={busy.value}
            onClick={() => {
              asking.value = true;
            }}
          >
            <Icon name="trash" size={14} /> Remove
          </button>
        )
      }
      foot={(close) =>
        asking.value ? (
          <>
            <button
              type="button"
              class="btn btn-small"
              disabled={busy.value}
              onClick={() => {
                asking.value = false;
              }}
            >
              Keep
            </button>
            <button
              type="button"
              class="btn btn-small btn-danger"
              disabled={busy.value}
              onClick={() => void run(() => store.remove(rule.id), close)}
            >
              {busy.value ? "Removing" : "Remove"}
            </button>
          </>
        ) : rule.paused === "split" ? (
          <button type="button" class="btn btn-small" onClick={close}>
            Close
          </button>
        ) : (
          <button
            type="button"
            class="btn btn-small btn-primary"
            disabled={busy.value}
            onClick={() =>
              void run(() => store.pause(rule.id, rule.paused === null))
            }
          >
            {rule.paused === null ? "Pause" : "Resume"}
          </button>
        )
      }
    >
      <div class="al-drawer">
        <div class="al-drawer-head">
          <a class="al-drawer-link" href={symbolHref(rule.symbol)}>
            {nameOf(
              l[rule.symbol]?.name ?? null,
              l[rule.symbol]?.type,
              rule.symbol,
            )}
          </a>
          <StateTag rule={rule} />
        </div>
        {said.value && <Notice error>{said.value}</Notice>}
        {stateOf(rule) === "fired" && (
          <p class="small faint">Fires again once this is no longer true.</p>
        )}
        {rule.paused === "split" && (
          <p class="small faint">
            A split changed the price scale. Delete this rule and make it again
            with new levels.
          </p>
        )}
        <section class="al-section">
          <h3 class="card-label">When</h3>
          {gate && <p class="al-gate">{gate}</p>}
          <ul class="al-checks">
            {lines.map((line, i) => {
              const v = line.text.endsWith(" of")
                ? undefined
                : values[
                    lines.slice(0, i).filter((x) => !x.text.endsWith(" of"))
                      .length
                  ];
              return (
                <li
                  key={i}
                  class="al-check"
                  style={{ paddingLeft: `${line.depth * 16}px` }}
                >
                  {v !== undefined && (
                    <Icon
                      name={
                        v.holds === true
                          ? "check"
                          : v.holds === false
                            ? "circle"
                            : "alert"
                      }
                      size={14}
                      class={
                        v.holds === true
                          ? "al-yes"
                          : v.holds === false
                            ? "al-no"
                            : "al-unknown"
                      }
                    />
                  )}
                  <span>
                    {line.text}
                    {v !== undefined && (
                      <span class="faint small num al-now">
                        {" "}
                        now {nowText(v, rule.symbol, l)}
                        {rightNow(v, rule.symbol, l) !== null &&
                          ` · ${rightNow(v, rule.symbol, l)}`}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        {rule.note && (
          <section class="al-section">
            <h3 class="card-label">Note</h3>
            <p class="al-note-full">{rule.note}</p>
          </section>
        )}
        <section class="al-section">
          <h3 class="card-label">Fired</h3>
          {fired.length === 0 ? (
            <p class="small faint">Not yet.</p>
          ) : (
            <ul class="al-history">
              {fired.map((a) => (
                <li key={a.id} class="small">
                  <span class="num faint">
                    {dayLabel(a.fired_at, now)} {timeText(a.fired_at)}
                  </span>
                  <span>
                    {a.values[0] ? firedText(a.values[0], a.symbol, l) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p class="small faint">
          Made {ago(rule.created_at, now)}
          {rule.last_evaluated_at &&
            ` · checked ${ago(rule.last_evaluated_at, now)}`}
        </p>
      </div>
    </Drawer>
  );
}

function FiredTab() {
  const alerts = store.alerts.value;
  const l = store.listings.value;
  const rules = store.rules.value ?? [];
  // opening Fired sees the newest; leaving it ends the visit's dots
  useEffect(() => {
    if (alerts !== null) void store.markSeen();
  }, [alerts?.[0]?.id]);
  useEffect(() => store.leftFired, []);
  if (alerts === null)
    return (
      <Card label="Fired">
        <Table
          label="Fired"
          columns={[]}
          rows={[]}
          rowKey={() => 0}
          waiting={4}
        />
      </Card>
    );
  if (alerts.length === 0) {
    return (
      <Notice title="Nothing fired yet" icon="bell">
        A rule's alert shows here the moment it fires.
      </Notice>
    );
  }
  const now = Date.now();
  const before = store.seenBefore.value;
  const days: { label: string; rows: Alert[] }[] = [];
  for (const a of alerts) {
    const label = dayLabel(a.fired_at, now);
    if (days.at(-1)?.label !== label) days.push({ label, rows: [] });
    days.at(-1)!.rows.push(a);
  }
  return (
    <>
      {days.map((d) => (
        <Card key={d.label} title={d.label} flush label={d.label}>
          <ul class="al-fired">
            {d.rows.map((a) => {
              const rule = rules.find((r) => r.id === a.rule_id);
              const first = a.values[0];
              const live =
                rule?.now.values[0]?.left.field === first?.left.field
                  ? rule?.now.values[0]?.left.value
                  : undefined;
              return (
                <li key={a.id}>
                  <a class="al-fired-row" href={symbolHref(a.symbol)}>
                    <span class="al-fired-time num faint">
                      {before !== null && a.id > before && (
                        <span class="al-dot" role="img" aria-label="New" />
                      )}
                      {timeText(a.fired_at)}
                    </span>
                    <span class="al-fired-body">
                      <SymbolName
                        compact
                        ticker={tickerOf(a.symbol, l[a.symbol]?.type)}
                        name={nameOf(
                          l[a.symbol]?.name ?? null,
                          l[a.symbol]?.type,
                          a.symbol,
                        )}
                      />
                      <span>
                        {a.values.length === 1 && first
                          ? firedText(first, a.symbol, l)
                          : a.values
                              .map((v) => firedText(v, a.symbol, l))
                              .join("; ")}
                      </span>
                      {a.note && (
                        <span class="small faint al-note">{a.note}</span>
                      )}
                    </span>
                    <span class="al-fired-now small faint num">
                      {live !== undefined && live !== null && first
                        ? `Now ${valueText(first.left.field, live, first.left.symbol, l)}`
                        : ""}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      {store.next.value !== null && (
        <button
          type="button"
          class="btn-text faint scr-more"
          disabled={store.more.value}
          onClick={() => void store.loadMore()}
        >
          Show more
        </button>
      )}
      <p class="small faint al-kept">Alerts are kept for 90 days.</p>
    </>
  );
}

function AddDrawer({ onClose }: { onClose: () => void }) {
  const symbol = useSignal("");
  const picked = useSignal<Listing | null>(null);
  const where = useSignal<string | null>(null);
  const chosen = useSignal(false);
  const side = useSignal<"below" | "above">("below");
  const level = useSignal("");
  const note = useSignal("");
  const busy = useSignal(false);
  const said = useSignal<string | null>(null);
  const n = Number(level.value.replace(",", "."));
  const typed = level.value.trim() !== "" && Number.isFinite(n) && n > 0;
  const price = picked.value?.price ?? null;
  const currency = picked.value?.currency ?? null;
  // a level the price already meets would fire at once
  const met =
    typed &&
    price !== null &&
    (side.value === "below" ? price <= n : price >= n);
  // a level typed before the price came in waits for it, so a met one is
  // never saved; a listing with no price lets it through
  const ready =
    symbol.value !== "" &&
    typed &&
    !met &&
    (price !== null || picked.value !== null);
  const save = async (close: () => void) => {
    if (!ready || busy.value) return;
    busy.value = true;
    said.value = null;
    const refused = await store.add(
      symbol.value,
      side.value === "above",
      n,
      note.value,
    );
    busy.value = false;
    if (refused === null) close();
    else said.value = refused;
  };
  return (
    <Drawer
      title="Price alert"
      onClose={onClose}
      busy={busy.value}
      foot={(close) => (
        <button
          type="button"
          class="btn btn-small btn-primary"
          disabled={!ready || busy.value}
          onClick={() => void save(close)}
        >
          Add
        </button>
      )}
    >
      <div class="connect-form al-form">
        {/* picked, the symbol is shown as Add trade shows it */}
        {chosen.value ? (
          <div class="field">
            <span class="pf-field-head">
              <span class="label">Symbol</span>
            </span>
            <div class="menu-btn-field pf-chosen">
              <span class="pf-chosen-main">
                <SymbolName
                  compact
                  ticker={symbolOf(symbol.value)}
                  name={picked.value?.name ?? undefined}
                />
                <button
                  type="button"
                  class="btn-icon pf-chosen-x"
                  aria-label="Change symbol"
                  onClick={() => {
                    chosen.value = false;
                    symbol.value = "";
                    picked.value = null;
                    where.value = null;
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
              {picked.value && (
                <span class="faint small hide-phone">
                  {[
                    where.value,
                    price === null
                      ? null
                      : `${livePrice(price, currency)} live`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </div>
          </div>
        ) : (
          <SymbolPick
            value={symbol}
            autoFocus
            onPick={(c) => {
              chosen.value = true;
              picked.value = null;
              where.value =
                listingWords({ id: c.id, exchange_name: c.exchange_name }) ||
                null;
              void markets.portfolios.listing(c.id).then((got) => {
                if (symbol.value !== c.id || got === null) return;
                picked.value = got;
                // the side follows a level typed before the price came in
                const v = Number(level.value.replace(",", "."));
                if (
                  got.price !== null &&
                  Number.isFinite(v) &&
                  v > 0 &&
                  v !== got.price
                ) {
                  side.value = v > got.price ? "above" : "below";
                }
              });
            }}
            onEdit={() => {
              picked.value = null;
              where.value = null;
            }}
          />
        )}
        <label class="field">
          <span class="label">Price{currency ? ` (${currency})` : ""}</span>
          <input
            inputMode="decimal"
            value={level.value}
            autocomplete="off"
            placeholder={price === null ? "" : String(price)}
            onInput={(e) => {
              level.value = (e.currentTarget as HTMLInputElement).value;
              const v = Number(level.value.replace(",", "."));
              // the side follows the level: above the price waits for a rise
              if (
                price !== null &&
                Number.isFinite(v) &&
                v > 0 &&
                v !== price
              ) {
                side.value = v > price ? "above" : "below";
              }
            }}
          />
          {/* the live price is under the symbol; here, how far the level is */}
          {price !== null && typed && (
            <span class="small faint">
              {met
                ? `Already ${side.value === "below" ? "at or below" : "at or above"} ${amount(n, currency)}`
                : `${((Math.abs(n - price) / price) * 100).toFixed(1)}% away`}
            </span>
          )}
        </label>
        <div class="field">
          <span class="label">Alert when the price is</span>
          <Segmented
            label="Alert when the price is"
            options={[
              { value: "below", text: "At or below" },
              { value: "above", text: "At or above" },
            ]}
            value={side.value}
            onPick={(v) => {
              side.value = v;
            }}
          />
        </div>
        <label class="field">
          <span class="label">Note</span>
          <textarea
            rows={3}
            maxLength={500}
            value={note.value}
            onInput={(e) => {
              note.value = (e.currentTarget as HTMLTextAreaElement).value;
            }}
          />
        </label>
        {said.value && <Notice error>{said.value}</Notice>}
      </div>
    </Drawer>
  );
}
