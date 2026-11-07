// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's trade plans: the list and its filters, one plan drawn as the
// server renders it, the Profile page's editor and history for it.

import { useSignal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { symbolHref, TRADE_PLANS, tradePlanHref } from "../app/paths.ts";
import { navigate } from "../app/router.ts";
import type { Params } from "../app/routes.ts";
import { onPhone } from "../app/shell.ts";
import { markets } from "../data/store.ts";
import {
  fieldsChanged,
  type PlanFields,
  type PlanFilter,
  type PlanItem,
  type PlanRead,
  type PlanStatus,
  symbolsOf,
  type TradePlansStore,
} from "../data/trade-plans.ts";
import { ago, day } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { tickerOf } from "../lib/names.ts";
import { useRefresh } from "../lib/refresh.ts";
import { AddButton } from "../ui/AddButton.tsx";
import { Card } from "../ui/Card.tsx";
import { Drawer } from "../ui/Drawer.tsx";
import { MenuButton } from "../ui/Menu.tsx";
import { Notice } from "../ui/Notice.tsx";
import { didNotLoad, Page } from "../ui/Page.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { type Column, Table } from "../ui/Table.tsx";
import { authorWords } from "./Profile.model.ts";
import { Drawn, History, useEditor } from "./Profile.tsx";
import {
  FILTERS,
  fieldsOf,
  filterCount,
  NO_FIELDS,
  STATUS_WORDS,
  shownPlans,
  symbolChoices,
} from "./TradePlans.model.ts";
import "./alerts.css";
import "./instruments.css";
import "./profile.css";
import "./trade-plans.css";

const who = (author: string) =>
  authorWords(author, markets.me.value?.name ?? null);

// the alerts' badges, in words
const TONE: Record<PlanStatus, string> = {
  active: "al-tag-on",
  archived: "al-tag-off",
  removed: "al-tag-warn",
};

export function StatusTag({ status }: { status: PlanStatus }) {
  return (
    <span class={`tag tag-side al-tag tp-tag ${TONE[status]}`}>
      {STATUS_WORDS[status]}
    </span>
  );
}

export function DueTag() {
  return <span class="tag tag-side al-tag tp-tag al-tag-warn">Review due</span>;
}

function StatusWords({ label, n }: { label: string; n: number | null }) {
  return (
    <span class="tp-status">
      <span>{label}</span>
      {n !== null && <span class="al-count num">{n}</span>}
    </span>
  );
}

// in a row the chips sit over its link and a "+N" span under it, so a tap
// there opens the plan; with onMore the "+N" is a button of its own; plain
// chips are words under the row's link, as a phone's row opens on any tap
function Chips({
  symbols,
  max,
  onMore,
  plain,
}: {
  symbols: readonly string[];
  max: number;
  onMore?: () => void;
  plain?: boolean;
}) {
  if (symbols.length === 0) return null;
  // "+1" would take the room of the chip it hides
  const shown = symbols.length > max + 1 ? symbols.slice(0, max) : symbols;
  const rest = symbols.length - shown.length;
  return (
    <span class="tp-chips">
      {shown.map((s) =>
        plain ? (
          <span key={s} class="tag tp-chip">
            {tickerOf(s)}
          </span>
        ) : (
          <a key={s} class="tag tp-chip table-raise" href={symbolHref(s)}>
            {tickerOf(s)}
          </a>
        ),
      )}
      {rest > 0 &&
        (onMore ? (
          <button
            type="button"
            class="tag tp-chip tp-more"
            aria-label={`Show all ${symbols.length} symbols`}
            onClick={onMore}
          >
            +{rest}
          </button>
        ) : (
          <span class="tag tp-chip tp-more" title={`${rest} more`}>
            +{rest}
          </span>
        ))}
    </span>
  );
}

const LIST_CHIPS = 5;
const LIST_CHIPS_PHONE = 3;

// a phone keeps the plan's text near the top
const PHONE_CHIPS = 6;

function PlanSymbols({ symbols }: { symbols: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Chips
      symbols={symbols}
      max={onPhone.value && !open ? PHONE_CHIPS : symbols.length}
      onMore={() => setOpen(true)}
    />
  );
}

function ReviewBy({ p, now }: { p: PlanItem; now: number }) {
  if (p.review_by === null) return <span class="faint">—</span>;
  return (
    <span class="tp-review">
      <span class="num">{day(p.review_by, now)}</span>
      {p.review_due && <DueTag />}
    </span>
  );
}

function columns(now: number): Column<PlanItem>[] {
  return [
    {
      key: "name",
      head: "Name",
      width: { base: "minmax(0, 2fr)", phone: "minmax(0, 1fr)" },
      cell: (p) => (
        <span class="tp-cell">
          <span class="tp-name">{p.name}</span>
          {/* a phone keeps one column: what the others say goes under */}
          <span class="tp-under show-phone">
            {p.status !== "active" && <StatusTag status={p.status} />}
            {p.review_due && <DueTag />}
            <Chips symbols={p.symbols} max={LIST_CHIPS_PHONE} plain />
          </span>
        </span>
      ),
    },
    {
      key: "status",
      head: "Status",
      width: "minmax(0, 0.8fr)",
      hide: "phone",
      cell: (p) => <StatusTag status={p.status} />,
    },
    {
      key: "symbols",
      head: "Symbols",
      width: "minmax(0, 1.6fr)",
      hide: "phone",
      cell: (p) => <Chips symbols={p.symbols} max={LIST_CHIPS} />,
    },
    {
      key: "review",
      head: "Review by",
      width: "minmax(0, 1.1fr)",
      hide: "phone",
      cell: (p) => <ReviewBy p={p} now={now} />,
    },
    {
      key: "updated",
      head: "Updated",
      width: { base: "minmax(0, 1.2fr)", phone: "max-content" },
      align: "end",
      cell: (p) => (
        <span class="tp-cell tp-updated">
          <span>{ago(p.updated_at, now)}</span>
          <span class="faint small hide-phone">by {who(p.author)}</span>
        </span>
      ),
    },
  ];
}

export function TradePlans() {
  return <TradePlansBody store={markets.tradePlans} />;
}

export function TradePlansBody({ store }: { store: TradePlansStore }) {
  const [adding, setAdding] = useState(false);
  const filter = store.filter.value;
  const symbol = store.symbol.value;
  const deleted = filter === "removed";
  useRefresh(() => (adding ? undefined : store.load(deleted)));
  const plans = store.plans.value;
  const removed = store.removed.value;
  const now = Date.now();
  const failed = didNotLoad(
    plans !== null,
    store.error.value,
    store.code.value,
    () => void store.load(deleted),
  );
  const add = () => setAdding(true);
  const pick = (to: PlanFilter) => {
    store.filter.value = to;
    if (to === "removed") void store.load(true);
  };
  // deleted plans keep the filters, so they can be reached and restored
  const none =
    plans !== null &&
    plans.length === 0 &&
    !deleted &&
    symbol === null &&
    (removed === null || removed.length === 0);
  const choices = plans === null ? [] : symbolChoices(plans);
  // a ticker on two markets names each by its id
  const shared = new Set(
    choices.map((s) => tickerOf(s)).filter((t, i, all) => all.indexOf(t) !== i),
  );
  const rows = plans === null ? [] : shownPlans(plans, removed, filter, symbol);
  return (
    <Page
      title="Trade plans"
      failed={failed}
      stale={plans !== null ? store.error.value : null}
      staleCount={store.failures.value}
      actions={<AddButton label="New trade plan" onClick={add} />}
    >
      {none ? (
        <Notice
          icon="flag"
          title="No trade plans yet"
          actions={
            <>
              <button type="button" class="btn" onClick={() => pick("removed")}>
                Show deleted
              </button>
              <button type="button" class="btn btn-primary" onClick={add}>
                <Icon name="plus" size={14} />
                New trade plan
              </button>
            </>
          }
        >
          Buy ladders, dry powder to deploy, bond subscriptions: Markdown tagged
          with symbols, read by agents beside the live price.
        </Notice>
      ) : (
        <>
          <div class="tp-filters">
            {onPhone.value ? (
              // four segments with counts do not fit beside the symbol
              <span class="tp-filter">
                <MenuButton
                  label="Status"
                  field
                  text={
                    <StatusWords
                      label={FILTERS.find((f) => f.key === filter)!.label}
                      n={filterCount(plans, removed, filter)}
                    />
                  }
                  items={FILTERS.map((f) => ({
                    key: f.key,
                    label: (
                      <StatusWords
                        label={f.label}
                        n={filterCount(plans, removed, f.key)}
                      />
                    ),
                    checked: f.key === filter,
                    run: () => pick(f.key),
                  }))}
                />
              </span>
            ) : (
              <Segmented
                label="Status"
                options={FILTERS.map((f) => ({
                  value: f.key,
                  text: (
                    <StatusWords
                      label={f.label}
                      n={filterCount(plans, removed, f.key)}
                    />
                  ),
                }))}
                value={filter}
                onPick={pick}
              />
            )}
            {/* a symbol picked stays clearable once no plan holds it */}
            {(choices.length > 0 || symbol !== null) && (
              <span class="tp-filter tp-filter-symbol">
                <MenuButton
                  label="Symbol"
                  field
                  text={symbol === null ? "All symbols" : tickerOf(symbol)}
                  menuClass="tp-symbol-menu"
                  items={[
                    {
                      label: "All symbols",
                      checked: symbol === null,
                      run: () => {
                        store.symbol.value = null;
                      },
                    },
                    ...choices.map((s) => ({
                      key: s,
                      label: shared.has(tickerOf(s)) ? s : tickerOf(s),
                      checked: symbol === s,
                      run: () => {
                        store.symbol.value = s;
                      },
                    })),
                  ]}
                />
              </span>
            )}
          </div>
          <Card label="Trade plans">
            <Table
              label="Trade plans"
              columns={columns(now)}
              rows={rows}
              rowKey={(p) => p.id}
              open={(p) => ({ href: tradePlanHref(p.id) })}
              rowLabel={(p) => p.name}
              empty="None here."
              waiting={
                plans === null || (deleted && removed === null) ? 3 : undefined
              }
            />
          </Card>
        </>
      )}
      {adding && (
        <PlanDrawer
          store={store}
          onClose={() => setAdding(false)}
          onMade={(id) => navigate(tradePlanHref(id))}
        />
      )}
    </Page>
  );
}

export function PlanDrawer({
  store,
  plan,
  onClose,
  onMade,
}: {
  store: TradePlansStore;
  // none makes a new plan
  plan?: PlanRead;
  onClose: () => void;
  onMade?: (id: number) => void;
}) {
  const was = plan === undefined ? NO_FIELDS : fieldsOf(plan);
  const [name, setName] = useState(was.name);
  const [symbols, setSymbols] = useState(was.symbols.join(" "));
  const [review, setReview] = useState(was.review_by ?? "");
  const typed: PlanFields = {
    name: name.trim(),
    symbols: symbolsOf(symbols),
    review_by: review === "" ? null : review,
  };
  // the save reads the fields as they are when it runs
  const fields = useRef(typed);
  fields.current = typed;
  const [writes] = useState(() =>
    plan === undefined
      ? store.creator(
          () => fields.current,
          (id) => onMade?.(id),
        )
      : store.editor(
          plan.id,
          { fields: was, text: plan.text },
          () => fields.current,
        ),
  );
  const closer = useRef<() => void>(() => {});
  // a save done slides the drawer out once the render that ends busy
  // lets it close
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (leaving) closer.current();
  }, [leaving]);
  const { busy, head, box, sizeLine, saveButton } = useEditor({
    store: writes,
    start: plan?.text ?? "",
    saved: plan?.text ?? "",
    revision: plan?.revision ?? null,
    label: "Trade plan text",
    dirty:
      plan !== undefined && Object.keys(fieldsChanged(was, typed)).length > 0,
    onDone: () => setLeaving(true),
  });
  return (
    <Drawer
      title={plan === undefined ? "New trade plan" : "Edit trade plan"}
      onClose={onClose}
      busy={busy}
      tall
      footStart={sizeLine}
      foot={(close) => {
        closer.current = close;
        return (
          <>
            <button type="button" class="btn" onClick={close} disabled={busy}>
              Cancel
            </button>
            {saveButton}
          </>
        );
      }}
    >
      <div class="tp-edit">
        <div class="tp-fields">
          <label class="field tp-field-name">
            <span class="label">Name</span>
            <input
              value={name}
              maxLength={120}
              autocomplete="off"
              disabled={busy}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span class="label">Symbols</span>
            <input
              value={symbols}
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              disabled={busy}
              onInput={(e) => setSymbols((e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field">
            <span class="label">Review by</span>
            <input
              type="date"
              value={review}
              disabled={busy}
              onInput={(e) => setReview((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
        {head}
        {box}
      </div>
    </Drawer>
  );
}

// as the instrument page's More: a question in place of the items
function PlanMenu({
  plan,
  busy,
  onStatus,
  onDelete,
  onRestore,
  onHistory,
}: {
  plan: PlanItem;
  busy: boolean;
  onStatus: (status: PlanStatus) => void;
  onDelete: () => void;
  onRestore: () => void;
  onHistory: () => void;
}) {
  const asking = useSignal(false);
  // swapping the pane drops the clicked button, which the menu would
  // read as a click outside it
  const swap = (ev: MouseEvent, to: boolean) => {
    ev.stopPropagation();
    asking.value = to;
  };
  const item = (
    label: string,
    icon: "eye" | "eye-off" | "redo" | "list",
    run: () => void,
    close: () => void,
  ) => (
    <button
      type="button"
      class="menu-item"
      role="menuitem"
      onClick={() => {
        close();
        run();
      }}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
  return (
    <MenuButton
      head
      label="More"
      disabled={busy}
      menuClass="ins-menu"
      onOpen={() => {
        asking.value = false;
      }}
      back={() => {
        if (!asking.value) return false;
        asking.value = false;
        return true;
      }}
    >
      {(close) =>
        asking.value ? (
          <div class="ins-ask">
            <p class="ins-ask-title">Delete this plan?</p>
            <p class="ins-ask-line small faint">
              It can be restored from Deleted.
            </p>
            <div class="ins-ask-foot">
              <button
                type="button"
                class="btn btn-small"
                onClick={(ev) => swap(ev, false)}
              >
                Keep
              </button>
              <button
                type="button"
                class="btn btn-small btn-danger"
                onClick={() => {
                  close();
                  asking.value = false;
                  onDelete();
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ) : plan.status === "removed" ? (
          <>
            {item("History", "list", onHistory, close)}
            {item("Restore", "redo", onRestore, close)}
          </>
        ) : (
          <>
            {item("History", "list", onHistory, close)}
            {plan.status === "active"
              ? item("Archive", "eye-off", () => onStatus("archived"), close)
              : item("Unarchive", "eye", () => onStatus("active"), close)}
            <button
              type="button"
              class="menu-item menu-item-danger"
              role="menuitem"
              onClick={(ev) => swap(ev, true)}
            >
              <Icon name="trash" size={14} />
              Delete
            </button>
          </>
        )
      }
    </MenuButton>
  );
}

export function TradePlan({ params }: { params: Params }) {
  return <TradePlanBody store={markets.tradePlans} id={Number(params.id)} />;
}

export function TradePlanBody({
  store,
  id,
}: {
  store: TradePlansStore;
  id: number;
}) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // an edit or a restore saves at the revision it opened, so no reload
  // moves it meanwhile
  useRefresh(() => (editing || history ? undefined : store.reopen()));
  const mine = store.planAsk.value?.id === id;
  const p = mine ? store.plan.value : null;
  // opened for a symbol: at the first section it heads, once per arrival
  const scrolled = useRef<string | null>(null);
  const ask = store.planAsk.value;
  const anchor = p?.sections?.[0]?.anchor ?? null;
  useEffect(() => {
    const key = `${id} ${ask?.symbol ?? ""}`;
    // the plan read without the symbol stays on screen until its read lands
    const read =
      p !== null && (ask?.symbol == null || p.sections !== undefined);
    if (!read || scrolled.current === key) return;
    scrolled.current = key;
    if (anchor === null) return;
    document
      .getElementById(anchor)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [p, anchor]);
  const failed = didNotLoad(
    p !== null,
    mine ? store.planError.value : null,
    mine ? store.planCode.value : null,
    () => void store.open(id, ask?.symbol ?? null),
  );
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setSaid(null);
    const refused = await work();
    setBusy(false);
    setSaid(refused);
  };
  const now = Date.now();
  const gone = p?.status === "removed";
  return (
    <Page
      title={p?.name ?? "Trade plan"}
      titleCut
      back={TRADE_PLANS}
      // a plan's name may be long: on a phone it keeps the room
      meta={
        p === null || onPhone.value
          ? undefined
          : `Saved ${ago(p.updated_at, now)} by ${who(p.author)}`
      }
      search={editing ? false : undefined}
      failed={failed}
      error={said}
      actions={
        p !== null && (
          <>
            {!gone &&
              // a phone gives the plan's name the room: the pencil alone
              (onPhone.value ? (
                <button
                  type="button"
                  class="btn menu-btn-head"
                  aria-label="Edit"
                  title="Edit"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  <Icon name="pencil" size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  class="btn btn-primary"
                  disabled={busy}
                  onClick={() => setEditing(true)}
                >
                  <Icon name="pencil" size={14} />
                  Edit
                </button>
              ))}
            <PlanMenu
              plan={p}
              busy={busy}
              onStatus={(status) =>
                void run(() => store.setStatus(p.id, p.revision, status))
              }
              onDelete={() => void run(() => store.remove(p.id, p.revision))}
              onRestore={() => void run(() => store.restore(p.id))}
              onHistory={() => setHistory(true)}
            />
          </>
        )
      }
    >
      {p !== null && (
        <Card class="tp-plan">
          <dl class="tp-props">
            <div class="tp-prop">
              <dt>Status</dt>
              <dd>
                <StatusTag status={p.status} />
              </dd>
            </div>
            <div class="tp-prop">
              <dt>Review by</dt>
              <dd>
                <ReviewBy p={p} now={now} />
              </dd>
            </div>
            <div class="tp-prop tp-prop-symbols">
              <dt>
                Symbols
                {p.symbols.length > 0 && (
                  <span class="tp-prop-count num">{p.symbols.length}</span>
                )}
              </dt>
              <dd>
                {p.symbols.length === 0 ? (
                  <span class="faint">—</span>
                ) : (
                  <PlanSymbols symbols={p.symbols} />
                )}
              </dd>
            </div>
          </dl>
          <Drawn html={p.html} />
        </Card>
      )}
      {editing && p !== null && (
        <PlanDrawer
          store={store}
          plan={p}
          onClose={() => {
            setEditing(false);
            // a refused save leaves a newer plan to show
            void store.reopen();
          }}
        />
      )}
      {history && p !== null && (
        <History
          store={store.history(p.id)}
          live={p.revision}
          onClose={() => {
            setHistory(false);
            void store.reopen();
          }}
        />
      )}
    </Page>
  );
}
