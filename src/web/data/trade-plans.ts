// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// The owner's trade plans: the list, one plan opened, its writes, and the
// editor's and history's calls on the profile's document store.

import { batch, signal } from "@preact/signals";
import { ApiError, type Call, codeOf, says } from "./api.ts";
import { documentStore, STALE } from "./document.ts";

export const TRADE_PLANS_PATH = "/api/v1/trade-plans";

export const planPath = (id: number) => `${TRADE_PLANS_PATH}/${id}`;

export type PlanStatus = "active" | "archived" | "removed";

export type PlanFilter = "active" | "archived" | "all" | "removed";

export type PlanItem = {
  id: number;
  name: string;
  status: PlanStatus;
  symbols: string[];
  review_by: string | null;
  review_due: boolean;
  revision: number;
  updated_at: string;
  author: string;
  bytes: number;
};

export type PlanSection = {
  heading: string;
  level: number;
  line: number;
  anchor: string | null;
};

export type PlanRead = PlanItem & {
  created_at: string;
  text: string;
  html: string;
  // with a symbol asked: its stored id and the sections it heads
  symbol?: string;
  sections?: PlanSection[];
};

// what a plan's fields read as in a form: symbols as typed, a date or none
export type PlanFields = {
  name: string;
  symbols: string[];
  review_by: string | null;
};

type ListPage = { plans: PlanItem[]; next_page_token?: string };

// the server's words, and the listings to pick from when a symbol has several
export function refusal(e: unknown): string {
  const said = says(e);
  const body = e instanceof ApiError ? e.body : null;
  const listed = (body as { candidates?: { id?: unknown }[] } | null)
    ?.candidates;
  if (!Array.isArray(listed) || listed.length === 0) return said;
  const ids = listed
    .map((c) => c.id)
    .filter((id): id is string => typeof id === "string");
  return ids.length === 0 ? said : `${said} Listed as ${ids.join(", ")}.`;
}

// the fields landed before the text was refused, so the drawer says so
export const FIELDS_SAVED_STALE =
  "Name, symbols and date saved. The text changed since you opened it: copy it, then reload.";

// a stale revision carries the live one; a name taken is a conflict too
const stale = (e: unknown): boolean =>
  e instanceof ApiError &&
  e.code === "conflict" &&
  typeof (e.body as { revision?: unknown } | null)?.revision === "number";

export function fieldsChanged(
  was: PlanFields,
  now: PlanFields,
): Partial<PlanFields> {
  const out: Partial<PlanFields> = {};
  if (now.name !== was.name) out.name = now.name;
  if (JSON.stringify(now.symbols) !== JSON.stringify(was.symbols)) {
    out.symbols = now.symbols;
  }
  if (now.review_by !== was.review_by) out.review_by = now.review_by;
  return out;
}

export const symbolsOf = (typed: string): string[] => [
  ...new Set(
    typed
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  ),
];

async function allOf(call: Call, query: URLSearchParams): Promise<PlanItem[]> {
  const rows: PlanItem[] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams(query);
    if (token !== undefined) q.set("page_token", token);
    const page = await call<ListPage>(`${TRADE_PLANS_PATH}?${q}`);
    rows.push(...page.plans);
    token = page.next_page_token;
  } while (token !== undefined);
  return rows;
}

export type TradePlansStore = ReturnType<typeof tradePlansStore>;

// session: the store's sign-in count, so no answer from before a sign-out
// lands on a signed-out page
export function tradePlansStore(call: Call, session: () => number) {
  // active and archived; the deleted are read only when asked for
  const plans = signal<PlanItem[] | null>(null);
  // the page's filters, kept while the person moves about the app
  const filter = signal<PlanFilter>("active");
  const symbol = signal<string | null>(null);
  const removed = signal<PlanItem[] | null>(null);
  const error = signal<string | null>(null);
  const code = signal<number | null>(null);
  const failures = signal(0);
  const plan = signal<PlanRead | null>(null);
  // the id and symbol the plan shown was read for
  const planAsk = signal<{ id: number; symbol: string | null } | null>(null);
  const planError = signal<string | null>(null);
  const planCode = signal<number | null>(null);

  // a later load supersedes one in flight
  let lists = 0;
  async function load(deleted = false): Promise<void> {
    const mine = ++lists;
    const at = session();
    try {
      const [live, gone] = await Promise.all([
        allOf(call, new URLSearchParams({ status: "all" })),
        deleted
          ? allOf(call, new URLSearchParams({ status: "removed" }))
          : Promise.resolve(null),
      ]);
      if (mine !== lists || at !== session()) return;
      batch(() => {
        plans.value = live;
        if (gone !== null) removed.value = gone;
        error.value = null;
        code.value = null;
      });
    } catch (e) {
      if (mine !== lists || at !== session()) return;
      batch(() => {
        error.value = says(e);
        code.value = codeOf(e);
        failures.value++;
      });
    }
  }

  // the plans tagged with one instrument, active and archived, for its
  // page; a failed read keeps the last answer, and none until one lands
  function tagged(id: string) {
    const rows = signal<PlanItem[] | null>(null);
    let reads = 0;
    async function read(): Promise<void> {
      const mine = ++reads;
      const at = session();
      try {
        const got = await allOf(
          call,
          new URLSearchParams({ status: "all", symbol: id }),
        );
        if (mine === reads && at === session()) rows.value = got;
      } catch {}
    }
    return { plans: rows, load: read };
  }

  let opens = 0;
  async function open(id: number, symbol: string | null = null): Promise<void> {
    const mine = ++opens;
    const at = session();
    const ask = planAsk.peek();
    // another plan's answer never shows under this one's title
    if (ask?.id !== id) {
      batch(() => {
        plan.value = null;
        planError.value = null;
        planCode.value = null;
      });
    }
    planAsk.value = { id, symbol };
    try {
      const q = symbol === null ? "" : `?${new URLSearchParams({ symbol })}`;
      const answer = await call<PlanRead>(`${planPath(id)}${q}`);
      if (mine !== opens || at !== session()) return;
      batch(() => {
        plan.value = answer;
        planError.value = null;
        planCode.value = null;
      });
    } catch (e) {
      if (mine !== opens || at !== session()) return;
      batch(() => {
        planError.value = says(e);
        planCode.value = codeOf(e);
      });
    }
  }

  const reopen = (): Promise<void> => {
    const ask = planAsk.peek();
    return ask === null ? Promise.resolve() : open(ask.id, ask.symbol);
  };

  // a write's refusal in the server's words, or null once done; the plan
  // shown and the list are read again either way, so a refusal for a
  // newer save shows that save
  async function write(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<string | null> {
    const at = session();
    let said: string | null = null;
    try {
      await call(path, method, body);
    } catch (e) {
      said = refusal(e);
    }
    if (at !== session()) return null;
    await Promise.all([reopen(), load(removed.peek() !== null)]);
    return said;
  }

  const setStatus = (id: number, revision: number, status: PlanStatus) =>
    write(planPath(id), "PUT", { revision, status });
  const remove = (id: number, revision: number) =>
    write(`${planPath(id)}?revision=${revision}`, "DELETE");
  const restore = (id: number) => write(`${planPath(id)}/restore`, "POST");

  // the draft drawn as a save draws it; nothing is kept
  const preview = (text: string) =>
    call<{ html: string }>(`${TRADE_PLANS_PATH}/preview`, "POST", {
      text,
    }).then((a) => a.html);

  // the editor's store for a new plan: its save makes the plan, the
  // fields read as the save asks for them
  function creator(fields: () => PlanFields, onMade: (id: number) => void) {
    return {
      preview,
      save: async (text: string): Promise<string | null> => {
        const at = session();
        try {
          const f = fields();
          const made = await call<PlanItem>(TRADE_PLANS_PATH, "POST", {
            name: f.name,
            text,
            symbols: f.symbols,
            review_by: f.review_by,
          });
          if (at !== session()) return null;
          onMade(made.id);
          void load(removed.peek() !== null);
          return null;
        } catch (e) {
          return at !== session() ? null : refusal(e);
        }
      },
    };
  }

  // the editor's store for a plan: a save sets the fields changed first,
  // so a taken name or a symbol's refusal stops it before the text is
  // touched, then the text, each at the revision the last one left; a
  // retry after a refused text sends the text alone
  function editor(
    id: number,
    start: { fields: PlanFields; text: string },
    fields: () => PlanFields,
  ) {
    let was = start.fields;
    let text = start.text;
    // the revision this drawer's own last save left; a stale refusal
    // forgets it, so the drawer stays stale until reloaded, as the profile's
    let current: number | null = null;
    const save = async (
      typed: string,
      revision: number | null,
    ): Promise<string | null> => {
      const at = session();
      let live =
        current !== null && (revision === null || current > revision)
          ? current
          : revision;
      let setDone = false;
      try {
        const now = fields();
        const set = fieldsChanged(was, now);
        if (Object.keys(set).length > 0) {
          const done = await call<PlanItem>(planPath(id), "PUT", {
            revision: live,
            ...set,
          });
          live = current = done.revision;
          was = now;
          setDone = true;
        }
        if (typed !== text) {
          const done = await call<PlanItem>(planPath(id), "PUT", {
            revision: live,
            text: typed,
          });
          current = done.revision;
          text = typed;
        }
      } catch (e) {
        if (at !== session()) return null;
        if (!stale(e)) return refusal(e);
        current = null;
        return setDone ? FIELDS_SAVED_STALE : STALE;
      }
      if (at === session())
        await Promise.all([reopen(), load(removed.peek() !== null)]);
      return null;
    };
    return { preview, save };
  }

  // a revision put back at the live one: the history's restore
  const history = (id: number) => {
    const doc = documentStore(call, session, planPath(id));
    return {
      ...doc,
      restore: async (text: string, live: number) => {
        const said = await doc.restore(text, live);
        await reopen();
        return said;
      },
    };
  };

  function clear(): void {
    lists++;
    opens++;
    batch(() => {
      plans.value = null;
      removed.value = null;
      filter.value = "active";
      symbol.value = null;
      error.value = null;
      code.value = null;
      plan.value = null;
      planAsk.value = null;
      planError.value = null;
      planCode.value = null;
    });
  }

  return {
    plans,
    removed,
    filter,
    symbol,
    error,
    code,
    failures,
    load,
    tagged,
    plan,
    planAsk,
    planError,
    planCode,
    open,
    reopen,
    setStatus,
    remove,
    restore,
    preview,
    creator,
    editor,
    history,
    clear,
  };
}
