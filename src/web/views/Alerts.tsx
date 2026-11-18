// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import {
  ALERTS,
  ALERTS_HISTORY as FIRED,
  symbolHref,
  tradePlanHref,
} from "../app/paths.ts";
import { onPhone } from "../app/shell.ts";
import type { Alert, Listings, Trigger } from "../data/alerts.ts";
import type { Listing } from "../data/portfolios.ts";
import { markets } from "../data/store.ts";
import { amount } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { nameOf, symbolOf, tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { AddButton } from "../ui/AddButton.tsx";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Search } from "../ui/Search.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { SymbolName } from "../ui/Symbol.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
  alertMatches,
  comparisonsOf,
  conditionLines,
  dayLabel,
  figureOf,
  firedText,
  GONE_SHOWN,
  gateText,
  historyGroups,
  inTile,
  NEAR_PERCENT,
  NOT_MET,
  nearOf,
  nowText,
  ON_WORDS,
  PRICE_UNREAD,
  plansFor,
  rightNow,
  ruleSummary,
  STATE_WORDS,
  type Standing,
  type StateKey,
  sortRules,
  stateOf,
  TILES,
  type TileKey,
  timeText,
  treeOf,
  triggerMatches,
  triggerText,
  whenLabel,
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
      label="Price alerts"
      value={tab}
      tabs={[
        { key: "rules", label: "Price alerts", href: ALERTS },
        {
          key: "fired",
          label: "History",
          href: FIRED,
          count: tab === "rules" && unseen > 0 ? unseen : null,
        },
      ]}
    />
  );
}

function AlertsPage({ tab }: { tab: TabKey }) {
  useRefresh(store.loadAll);
  // the owner's plans, for History's Plan and an alert's drawer
  useEffect(() => {
    void markets.tradePlans.load();
  }, []);
  useRefresh(() => markets.tradePlans.load(), true);
  const adding = useSignal(false);
  const held = store.alerts.value !== null;
  return (
    <Page
      title="Price alerts"
      tabs={<Head tab={tab} />}
      stale={held ? store.error.value : null}
      staleCount={store.failures.value}
      actions={
        // a phone's head holds the framed + alone, as a trade plan's does
        onPhone.value ? (
          <AddButton
            label="New price alert"
            onClick={() => {
              adding.value = true;
            }}
          />
        ) : (
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
        )
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

function StateTag({ rule }: { rule: Alert }) {
  const s = stateOf(rule);
  const tone = TONE[s];
  return tone === null ? (
    <span class="al-state">{STATE_WORDS[s]}</span>
  ) : (
    <span class={`tag tag-side al-tag ${tone}`}>{STATE_WORDS[s]}</span>
  );
}

// how near: a short meter, full at the level, empty 10% or more away
function Distance({ rule }: { rule: Alert }) {
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
        {n.met ? "Met" : `${n.distance.toFixed(1)}% away`}
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

function ruleColumns(l: Listings): Column<Alert>[] {
  return [
    {
      key: "rule",
      head: "Alert",
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
  const query = useSignal("");
  const rules = store.alerts.value;
  const triggers = store.history.value ?? [];
  const l = store.listings.value;
  const now = Date.now();
  // the search narrows every filter, so their counts follow it
  const sorted = (rules === null ? [] : sortRules(rules)).filter((r) =>
    alertMatches(r, query.value, l),
  );
  const shown = sorted.filter((r) => inTile(tile.value, r, triggers, now));
  const rule = rules?.find((r) => r.id === open.value) ?? null;
  if (rules !== null && rules.length === 0) {
    return (
      <Notice title="No alerts yet" icon="bell">
        Add a price alert, or ask an agent to watch a level.
      </Notice>
    );
  }
  return (
    <>
      <fieldset class="seg al-filters" aria-label="Filters">
        {TILES.map((t) => {
          const on = t.key === tile.value;
          const n =
            rules === null
              ? null
              : sorted.filter((r) => inTile(t.key, r, triggers, now)).length;
          return (
            <button
              key={t.key}
              type="button"
              class={`seg-option${on ? " seg-on" : ""}${n === 0 ? " al-zero" : ""}`}
              aria-pressed={on}
              title={t.name === t.short ? undefined : t.name}
              onClick={() => {
                tile.value = t.key;
              }}
            >
              <span>{t.short}</span>
              <span class="al-count num">{n ?? "–"}</span>
            </button>
          );
        })}
      </fieldset>
      <Card
        title={TILES.find((t) => t.key === tile.value)!.name}
        count={rules === null ? null : shown.length}
        actions={<Search query={query} placeholder="Search alerts" />}
      >
        <Table
          label="Price alerts"
          columns={ruleColumns(l)}
          rows={shown}
          rowKey={(r) => r.id}
          open={(r) => ({
            run: () => {
              open.value = r.id;
            },
          })}
          rowLabel={(r) => ruleSummary(r, l)}
          empty={
            // a match under another filter is not "no match"
            sorted.length > 0 || query.value.trim() === ""
              ? "None here."
              : `No alert matches “${query.value}”.`
          }
          head={!onPhone.value}
          waiting={rules === null ? 4 : undefined}
        />
      </Card>
      {rule !== null && (
        <RuleDrawer
          key={rule.id}
          rule={rule}
          fired={triggers.filter((a) => a.alert_id === rule.id)}
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
  rule: Alert;
  fired: readonly Trigger[];
  onClose: () => void;
}) {
  const l = store.listings.value;
  const plans = plansFor(markets.tradePlans.plans.value, rule.symbol);
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
  const tree = treeOf(rule.when);
  const lines =
    tree === null
      ? [{ text: rule.when, depth: 0, at: null }]
      : conditionLines(tree, rule.symbol, l);
  const cs = comparisonsOf(rule.when);
  const on = ON_WORDS[rule.on];
  const now = Date.now();
  return (
    <Drawer
      title={tickerOf(rule.symbol, l[rule.symbol]?.type)}
      onClose={onClose}
      swaps
      busy={busy.value}
      footStart={
        asking.value ? (
          "Remove this alert?"
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
        ) : rule.state === "split_paused" ? (
          <button type="button" class="btn btn-small" onClick={close}>
            Close
          </button>
        ) : (
          <button
            type="button"
            class="btn btn-small btn-primary"
            disabled={busy.value}
            onClick={() =>
              void run(() => store.pause(rule.id, rule.state !== "paused"))
            }
          >
            {rule.state === "paused" ? "Resume" : "Pause"}
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
          <p class="small faint">
            Can trigger again on a later trading day, after it stops being true.
          </p>
        )}
        {rule.state === "split_paused" && (
          <p class="small faint">
            A split changed the price scale. Delete this alert and make it again
            with new levels.
          </p>
        )}
        <section class="al-section">
          <h3 class="card-label">When</h3>
          {gate && <p class="al-gate">{gate}</p>}
          <ul class="al-checks">
            {lines.map((line, i) => {
              const v = line.at === null ? undefined : rule.now[line.at];
              const c = line.at === null ? undefined : cs[line.at];
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
                        {c !== undefined &&
                          rightNow(c, v, rule.symbol, l) !== null &&
                          ` · ${rightNow(c, v, rule.symbol, l)}`}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {on && <p class="small faint">{on}</p>}
        </section>
        {rule.note && (
          <section class="al-section">
            <h3 class="card-label">Note</h3>
            <p class="al-note-full">{rule.note}</p>
          </section>
        )}
        {plans.length > 0 && (
          <section class="al-section">
            <h3 class="card-label">Trade plans</h3>
            <ul class="al-history">
              {plans.map((p) => (
                <li key={p.id}>
                  <a
                    class="al-drawer-link"
                    href={tradePlanHref(p.id, rule.symbol)}
                  >
                    {p.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section class="al-section">
          <h3 class="card-label">Triggered</h3>
          {fired.length === 0 ? (
            <p class="small faint">Not yet.</p>
          ) : (
            <ul class="al-history">
              {fired.map((a) => {
                const first = comparisonsOf(a.when)[0];
                return (
                  <li key={a.id} class="small">
                    <span class="num faint">
                      {dayLabel(a.triggered_at, now)} {timeText(a.triggered_at)}
                    </span>
                    <span>
                      {first ? firedText(first, a.values, a.symbol, l) : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  );
}

function FiredTab() {
  const alerts = store.history.value;
  const rules = store.alerts.value ?? [];
  const opened = useSignal(false);
  const query = useSignal("");
  // opening Fired sees the newest; leaving it ends the visit's dots
  useEffect(() => {
    if (alerts !== null) void store.markSeen();
  }, [alerts?.[0]?.id, store.newest.value]);
  useEffect(() => store.leftFired, []);
  if (alerts === null)
    return (
      <Card label="History">
        <Table
          label="History"
          columns={[]}
          rows={[]}
          rowKey={() => 0}
          waiting={4}
        />
      </Card>
    );
  const l = store.listings.value;
  const g = historyGroups(alerts, rules, (t) =>
    triggerMatches(t, query.value, l),
  );
  const find = (
    <div class="al-find">
      <Search query={query} placeholder="Search history" />
    </div>
  );
  if (g === null && query.value.trim() !== "") {
    return (
      <>
        {find}
        <p class="faint al-none">No alert matches “{query.value}”.</p>
        {store.next.value !== null && (
          <button
            type="button"
            class="btn-text al-more"
            disabled={store.more.value}
            onClick={() => void store.loadMore()}
          >
            Show more
          </button>
        )}
      </>
    );
  }
  if (g === null) {
    return (
      <Notice title="Nothing triggered yet" icon="bell">
        An alert shows here the moment it triggers.
      </Notice>
    );
  }
  const now = Date.now();
  const hidden = opened.value ? 0 : Math.max(0, g.gone.length - GONE_SHOWN);
  const gone = g.gone.slice(0, g.gone.length - hidden);
  const more = (hidden > 0 || store.next.value !== null) && (
    <button
      type="button"
      class="btn-text al-more"
      disabled={store.more.value}
      onClick={() => {
        opened.value = true;
        void store.loadMore();
      }}
    >
      {hidden > 0 ? `Show ${hidden} more` : "Show more"}
    </button>
  );
  return (
    <>
      {find}
      <Latest s={g.latest} now={now} />
      {g.met.length > 0 && (
        <Card flush class="al-live" label="Still met">
          <ul class="al-list">
            {g.met.map((s) => (
              <li key={s.trigger.id} class="al-item">
                <ItemHead t={s.trigger} now={now} />
                {s.trigger.note && (
                  <span class="al-note-all">{s.trigger.note}</span>
                )}
                <span class="al-line">
                  <Price s={s} />
                  <PlanButton symbol={s.trigger.symbol} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {gone.length > 0 && (
        <Card flush title={NOT_MET} count={g.gone.length} label={NOT_MET}>
          <ul class="al-list">
            {gone.map((s) => (
              <li key={s.trigger.id} class="al-item al-gone">
                <ItemHead t={s.trigger} now={now} />
                {s.trigger.note && (
                  <span class="al-note small faint">{s.trigger.note}</span>
                )}
                <span class="al-line">
                  <Price s={s} />
                  {s.tag !== null && <BackTag text={s.tag} />}
                </span>
              </li>
            ))}
          </ul>
          {more}
        </Card>
      )}
      {gone.length === 0 && more}
      <p class="small faint al-kept">Alerts are kept for 90 days.</p>
    </>
  );
}

// the newest trigger, large; the gold edge only while it is still met
function Latest({ s, now }: { s: Standing; now: number }) {
  const l = store.listings.value;
  const t = s.trigger;
  const p = figureOf(s, l);
  return (
    <Card flush class={s.met ? "al-live" : undefined} label="Latest alert">
      <div class="al-item al-big">
        <ItemHead t={t} now={now} />
        <span>{triggerText(t, l)}</span>
        <span class="al-line">
          {p !== null && (
            <span class="al-fig num">
              {p.figure}
              {p.currency && <span class="al-ccy">{p.currency}</span>}
            </span>
          )}
          <PlanButton symbol={t.symbol} />
        </span>
        {s.tag !== null && (
          <span>
            <BackTag text={s.tag} />
          </span>
        )}
        {t.note && <span class="al-note-all">{t.note}</span>}
      </div>
    </Card>
  );
}

// the ticker is the link; its cover makes the whole row one
function ItemHead({ t, now }: { t: Trigger; now: number }) {
  const l = store.listings.value;
  const before = store.seenBefore.value;
  return (
    <span class="al-head">
      {before !== null && t.id > before && (
        <span class="al-dot" role="img" aria-label="New" />
      )}
      <a class="al-link" href={symbolHref(t.symbol)}>
        <SymbolName
          compact
          ticker={tickerOf(t.symbol, l[t.symbol]?.type)}
          name={nameOf(l[t.symbol]?.name ?? null, l[t.symbol]?.type, t.symbol)}
        />
      </a>
      <span class="al-when small faint num">
        · {whenLabel(t.triggered_at, now)}
      </span>
    </span>
  );
}

function Price({ s }: { s: Standing }) {
  const f = figureOf(s, store.listings.value);
  if (f === null) return null;
  return (
    <span class="small num">
      {f.currency === null ? f.figure : `${f.figure} ${f.currency}`}
    </span>
  );
}

function BackTag({ text }: { text: string }) {
  return <span class="tag tag-side al-tag">{text}</span>;
}

// the symbol's active plans: one is a link, several a menu of them
function PlanButton({ symbol }: { symbol: string }) {
  const plans = plansFor(markets.tradePlans.plans.value, symbol);
  const l = store.listings.value;
  if (plans.length === 0) return null;
  const one = plans.length === 1 ? plans[0]! : null;
  return (
    <span class="al-over">
      {one !== null ? (
        <a
          class="btn btn-small btn-primary"
          href={tradePlanHref(one.id, symbol)}
          title={one.name}
        >
          Plan
        </a>
      ) : (
        <MenuButton
          label={`Plans for ${tickerOf(symbol, l[symbol]?.type)}`}
          head
          face="Plan"
          buttonClass="btn-small btn-primary"
          items={plans.map((p) => ({
            key: String(p.id),
            label: p.name,
            href: tradePlanHref(p.id, symbol),
          }))}
        />
      )}
    </span>
  );
}

function AddDrawer({ onClose }: { onClose: () => void }) {
  const symbol = useSignal("");
  const picked = useSignal<Listing | null>(null);
  const where = useSignal<string | null>(null);
  const chosen = useSignal(false);
  // the pick's listing did not load: Add waits on a price it never gets
  const unread = useSignal(false);
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
                    unread.value = false;
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              </span>
              {unread.value && (
                <span class="error small" role="alert">
                  {PRICE_UNREAD}
                </span>
              )}
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
              unread.value = false;
              where.value =
                listingWords({ id: c.id, exchange_name: c.exchange_name }) ||
                null;
              void markets.portfolios.listing(c.id).then((got) => {
                if (symbol.value !== c.id) return;
                if (got === null) {
                  unread.value = true;
                  return;
                }
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
