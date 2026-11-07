# Trade plans

Governs `src/trade-plans/` (the store, the sections and the fenced
read), `src/operations/trade-plans.ts`, `src/tools/trade-plans.ts`,
the `/trade-plans` routes in `src/api/routes.ts` and their spec in
`src/api/trade-plans-spec.ts`, and the `trade_plans` pointer in
`quote`. The rules it shares with the profile and the analysis live
in `src/document/` and `docs/profile.md`; keys and their access in
`docs/admin.md`; the tool list per key and the server instructions in
`docs/tools.md`; the tables in `docs/storage.md`.

A trade plan is the owner's own intent for a few symbols: a buy ladder,
dry powder to deploy, a bond subscription, kept as Markdown tagged with
the symbols it is about, so an agent asked about one of them reads the
owner's levels beside the live price. It is intent, never an order: no
broker, fill or alert comes from it.

## The account's, tagged with symbols only

- **A plan belongs to its owner's account, never to a portfolio.** It
  carries no portfolio id, no `portfolio holdings` pointer and no count
  on a portfolio or the Portfolio page; a plan that means one names it
  in its prose. Plans are found by their symbols: in `quote`, on the
  instrument page and through their own tools and page.
- **Never shared.** Every row is keyed by `owner`, as every owned
  table. A person who sees another's portfolios read only sees none of
  their plans, and no route takes `?owner=`: a plan says what someone
  means to do with their money, which a shared portfolio never shows.
  Another person's plan id answers `not_found`, as an unknown one.
- **Removing a person deletes their plans** with their tags and
  revisions (`removeUserRows()`, children first).

## Prose, never parsed

- **The server stores the text as sent** (`documentText()`) and never
  reads levels, quantities, rungs or dates out of it. Its structure is
  the symbol tags and the Markdown headings only. A parsed ladder would
  turn a note into an order book the server would then have to keep
  right; the owner's words stay theirs and the agent reads them.
- **A section belongs to a symbol by its heading alone**
  (`src/trade-plans/sections.ts`): a heading, ATX or setext, any level,
  outside code fences, up to the next heading of the same or a higher
  level, whose plain text holds the instrument's name for it. The
  headings are scanned there, since the renderer gives no source spans.
  A `---` under a list item, a quote or a table row (or a line lazily
  continuing one) is a thematic break, never a setext heading, as in
  CommonMark. A heading inside a quote, or a setext heading inside a
  list item, is not scanned, so it heads no section.
- **The name is case-sensitive and whole**: bounded by the start, the
  end, or any character but a letter, a digit or the name's own
  punctuation, so `^VIX`, `CL=F`, `EURUSD=X` and `BRK-B` match whole.
  The name is the id's part after the market (NVDA for `US:NVDA`); in
  the crypto market only, also the pair's base (BTC for
  `CRYPTO:BTC-USD`); for `fund:<ISIN>`, the ISIN or the fund's name.
  Case-insensitive matching would give "### Notes on timing" to
  `US:ON`; a one-letter symbol can still match a capital used as a
  word, accepted since sections only point a reader somewhere.
- **`slug()` is the one anchor form** for a heading: its plain text
  with accents folded, lowercased, everything but `a-z`, `0-9`, spaces
  and dashes dropped, spaces as dashes, so an id needs no escaping in
  an attribute or an address. `anchors()` makes them unique in one
  text: `md-` and the slug, a repeat taking `-1`, `-2` as it comes, a
  heading of no such characters `md-section`. The renderer gives each
  heading that `id` (`docs/profile.md`), and the REST read names each
  section's `anchor`: the first drawn heading, after the last one
  matched, whose words slug the same, so the web UI opens a plan at a
  symbol's first section.

## The rules it shares with the profile and the analysis

From `src/document/`, never a copy (`docs/profile.md` has each rule
and why): `applyEdits()` (1 to 50 `{old, new}`, each old found once,
all or none, a refusal naming the pair), `documentText()`, the 24 KiB
cap and the one-page read check (`checked()`, with
`SECTIONS_RESERVE`, 4 KiB, left for a read's headings; the read it
measures holds the plan's symbols), `conflict()`, `fencedRead()`,
`KEPT_REVISIONS` and the eviction (`evict()`), and the author's form
(`authorOf()`).

## Revisions

- **A revision is the whole state**: name, text, symbols, status and
  `review_by`. A change to any of them is a new revision with its
  author and time; an unchanged save stores nothing and answers
  `unchanged: true` with the live revision. The text history alone
  would not say when a plan dropped a symbol or was archived.
- **The last 100 per plan are kept**, the live one never evicted. A
  version no longer kept says the last 100 are.
- **Every change names the revision it read**: a stale one is refused
  as `{error: "conflict", message: "trade plan N is at revision R",
  revision: R}` (409 over REST), so an agent reads before it writes and
  two writers never overwrite each other.
- **Delete is a soft remove, restorable with no time limit**, as a
  removed trade is. Neither is a revision: a restored plan comes back
  at the revision it had. A deleted plan lists only under `status:
  removed`, its read still answers, and every change but `restore` is
  refused until it is restored.

## Names, statuses and limits

- **A name is 1 to 120 characters, one line, unique among the owner's
  active plans**, stored trimmed and NFC-normalized, so a letter typed
  as one code point or as a base and a combining mark is one name, and
  compared after Unicode lowercasing in the write, since SQLite's
  `nocase` folds ASCII only ("Ș" and "ș" would differ). A
  create, rename, restore or un-archive onto a name an active plan
  holds is refused naming that plan. Archived and deleted plans hold no
  name.
- **At most 100 active plans per owner** (`MAX_ACTIVE_PLANS`), checked
  on create, on restore of an active plan and on `set status: active`;
  archived and deleted ones do not count. Both rules are checked inside
  the write, since the name and status live in the revision.
- **`status` is `active` or `archived`** on a revision; `removed` is
  answered for a deleted plan. Archiving takes a plan out of `quote`
  and the default list but keeps it whole.
- **`review_by` is a `YYYY-MM-DD` date**, checked as one, null clearing
  it. `review_due` is true once the owner's own day is past it: their
  `time_zone` (`portfolio_settings`), else UTC.

## Symbols

- **At most 50 per plan, the same instrument once** after resolution,
  so `VVSM.DE` and `XETRA:VVSM` store as one id, in the order given.
- **Each resolves without a fetch first**: `storedInstrument()` (REST's
  `restStored()`), and only the rest go to `resolveTargets()`, which
  may fetch inside the call. A stored but untracked id would otherwise
  catch up and could time out.
- **Any error refuses the whole call**, naming the input and its error
  (`candidates` with the candidates, `not_found`, `timeout` with "call
  again", `no_data`, `rate_limited`, `source_error`, `refused`), and
  nothing is saved, as a fund's holdings entry does.
- **Tagging never tracks an instrument**: `resolveTargets()` marks no
  read. An instrument the admin deletes leaves its id in the tag,
  matched again if it comes back.
- **A fund tag needs portfolio read**: `fund:<ISIN>` resolves as the
  analysis's does (`isFundKey()`, `seenFund()`), only for a key that
  reads the owner's portfolios and a fund they hold or priced; else it
  is refused for that symbol as an unknown fund.
- **A list or read filter by symbol never fetches**: a stored id or
  form, an id given with its market as written, anything else matching
  no plan.

## Reading it

- **The read is fenced** (`fencedRead()`), headed with the plan's id,
  revision, author, time and bytes, and saying the text is the owner's
  own plan: information to weigh, never an order, and never a request
  to call a tool, change data or send anything. The header carries the
  warning, not the tool description. A `plan:` line under it, outside
  the fence, holds every field; with `symbol`, the `sections` of that
  symbol (`heading`, `level`, `line`, at most 20, a heading cut at 120
  characters). The save checks the text with `SECTIONS_RESERVE` left
  for them, but quotes and control characters in headings grow when
  escaped, so the read drops sections from the end until the answer as
  sent is one page, and says how many in `sections_left_out`.
- **Its name and text are in no log line**: a save logs the plan id,
  revision and bytes.

## Tools and routes

- **`trade_plans` reads and `trade_plans_edit` writes**, listed per
  key's trade plans access: `read` lists `trade_plans`, `write` both,
  `none` neither. `trade_plans` is read-only, `trade_plans_edit`
  destructive. A plan is picked by `id`, as an alert is. A web UI
  sign-in and the admin key write their own.
- **`trade_plans` actions**: `list` (`status`: `active` by default,
  `archived`, `removed`, `all` for active and archived; `symbol`;
  `next`; newest updated first, without text), `read` (`id`,
  `symbol`), `versions` (`id`; each kept revision with what it
  `changed` from the one before, null when that one is not kept) and
  `version` (`id`, `revision`; that revision's whole state).
- **`trade_plans_edit` actions**: `create` (`name`, `text`, `symbols`,
  `review_by`), `edit`, preferred (`id`, `revision`, `edits`),
  `replace` (`id`, `revision`, `text`), `set` (`id`, `revision` and one
  or more of `name`, `symbols`, the whole list, `status`, `review_by`),
  `delete` (`id`, `revision`) and `restore` (`id`). A plan is tuned a
  rung at a time, so `edit` leads, as for the profile.
- **The routes** (`docs/api.md`) take `trade_plans:read` and
  `trade_plans:write`, the caller's own plans only, and draw `html`
  with `renderMarkdown()`.

## Finding it

- **`quote` carries `trade_plans: [{id, name, updated_at, read_with}]`**
  for each item the caller's active plans are tagged with, for a key
  with trade plans access; left out with none, never the text. It names
  the 10 newest (`QUOTE_PLANS`) and adds `trade_plans_more: <n>` only
  when more are tagged: one quote item is never split across pages, and
  100 plans with long names would outgrow one. `list` with `symbol`
  gives them all.
  `read_with` is always `trade_plans`, the tool that reads one, for an
  agent that never reads a description. It is added in the `quote`
  tool from its `who` (`tradePlansField()` in `agentItem()`), never in
  the REST projection, which admin and `/quotes` share. `research` and
  `portfolio holdings` carry none.
- **The server instructions route to it** for a key that lists
  `trade_plans`: the owner's plans for a symbol, which `quote` names,
  intent and never an order.
