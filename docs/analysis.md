# The analysis per symbol

Governs `src/analysis/` (the store and the fenced read),
`src/operations/analysis.ts`, `src/tools/analysis.ts`, the analysis
routes in `src/api/routes.ts`, their spec in
`src/api/analysis-spec.ts`, and the skill in `skills/market-analysis/`.
The rules it shares with the owner's profile live in `src/document/`
and `docs/profile.md`; keys and their access in `docs/admin.md`; the
tool list per key in `docs/tools.md`.

An analysis is an agent's dated reading of one symbol (its thesis,
business, earnings record, valuation and risks) kept as one Markdown
document, so that the next chat or scheduled run about that symbol
starts from it instead of from nothing, and the web UI can show it.
Agents write it over MCP, from a chat or a schedule outside the
server; the server never calls a model and never writes one itself.

## How a note is written

- **The skill in `skills/market-analysis/` says how, not server
  code**: what a note holds (conclusions and history, never live
  readings), its templates, and when a scheduled run rewrites one. It
  is an Agent Skills folder an agent loads. The server stores the
  text as sent and never checks it against the templates.
  `test/skill.test.ts` fails when the skill names a tool, argument,
  `analysis` action or answer field the server does not have, so a
  rename breaks the build, not a scheduled run.
- **The server serves every folder under `skills/`, without a key**
  (`src/server/skills.ts`): `/.well-known/agent-skills/index.json`,
  the index 1ctx's skill import reads (name, `archive`, the
  frontmatter's description, the URL, a `sha256:` digest of the
  bytes), `{name}.tgz` that it names, and `{name}.zip`, since
  claude.ai's skill upload takes a zip only. A Bun macro
  (`src/server/skill-files.ts`) embeds the files at build time, so a
  new file needs no code change. The archives are written by hand
  with a fixed time, since `Bun.Archive` stamps the current one and
  would move the digest at every start. `test/skill-serve.test.ts`
  checks both archives hold the folder's files. A dot file is left
  out, a file that is not UTF-8 text fails the build, and a quoted or
  multi-line frontmatter value fails the tests and the start.

## About the symbol, never a person's money

- **Shared by everyone on the server.** One note per instrument, keyed
  by its `market:symbol` id: any person's write key writes it, and every
  person's read key and every web UI sign-in reads it, as market data
  and hand-priced fund prices are shared.
- **So its text never names holdings, quantities, cost, gains, weights
  or anything from a profile.** The people who read it may never see
  the writer's portfolios. The server cannot check free text for that;
  the rule is in `analysis_edit`'s description, which a test holds to
  it, and here. Personal advice ("trim it in Growth") stays in the
  chat, where the agent reads `portfolio` and `profile` beside the
  note.
- **A hand-priced fund (`fund:<ISIN>`) takes one too**, but only one
  who holds or priced the fund, with portfolio access, reads, writes or
  lists its note, as for the fund's prices (`docs/portfolios.md`); to
  anyone else it is an unknown fund. The list applies that rule in its
  query, before the page's limit (`seenWhere()`), so neither a page nor
  its cursor names a fund the caller does not see.

## The rules it shares with the profile

The text checks, the fence, `applyEdits()`, the save and its eviction
are the profile's code in `src/document/`, not a copy, so the two never
drift (`docs/profile.md` has each rule and why):

- **Stored as sent, never parsed** (`documentText()`): well-formed
  UTF-8, no NUL, a leading BOM dropped.
- **At most `MAX_DOCUMENT_BYTES` (24 KiB)**, and refused when its read
  answer would not fit one page, with `SINCE_RESERVE` (2 KiB) left for
  the read's `since_written` line.
- **Never blanked**: a text empty or only whitespace is refused, from
  `replace` or as an `edit`'s result (`text is empty; the analysis is
  rewritten, never blanked`). A short or wrong text is a revision like
  any other, restored with `version`, then `replace`, and its author is
  named.
- **Every save is a revision**, counted from 1 per symbol, the last
  `KEPT_REVISIONS` (100) kept and never the live one evicted; an
  unchanged save stores nothing and answers `unchanged: true`.
- **Every write names the revision it read**, refused as `{error:
  "conflict", message: "analysis is at revision N", revision: N}` (409
  over REST) when stale; only a symbol's first `replace` has none. An
  agent then reads the note before it changes it, and two scheduled
  runs never silently overwrite each other. Check, insert and eviction
  run in one `writer.write` closure (`saveAnalysis()`).
- **`replace` first, `edit` for a few lines.** A note is rewritten
  each run; pushing `edit` would have an agent send dozens of pairs to
  refresh one. The profile, tuned a line at a time, prefers `edit`.
- **No delete.** Deleting an instrument leaves its note, since
  `analysis_versions.symbol` references no instrument.

## The author

- **The person and the key**: `Ana (claude-code)` for an agent key, the
  person's name for a web UI sign-in, `admin` for the admin key. It is
  copied into the revision, so a revoked key's or a removed person's
  history still reads; `user_id` is set null when the person goes. A
  shared note says who wrote it, as a shared portfolio names its owner.

## What changed since it was written

- **At each save the stored quote is kept beside the revision**: its
  price, the instrument's currency and the quote's trade time, its
  `fetched_at` for an untimed quote (`priced_at`, so a price fetched
  before a split day's open counts as before the split), or nulls with
  no stored quote (a FRED series, a fund,
  a symbol never quoted). A write never fetches a quote.
- **The read answers `since_written`** (`sinceWritten()`): that price,
  the stored price now, `change_percent` between them on today's share
  count (null when the currency changed or either is missing; a split
  dated after the price's day divides the price then by its ratio, and
  `splits` lists each with `date` and `ratio`), and the earnings stored in
  `events` that came after the save, each with `date`, `hour` and
  `status`: a reported one seen reported after the save's time, one not
  reported yet dated after the save's day (in the exchange's zone), so a
  report the note could already read is never listed as new; reports
  dated up to `AWAITING_DAYS` before the save count, since results can
  be seen days after their date. Null when no quote was stored at the
  save. Measured, never judged: there is no "stale after N%".
- **Writing a note never tracks a symbol.** A write resolves the symbol
  as a read does, fetching one never seen, but marks no read
  (`resolveTargets()`); a read counts as any read of the symbol does.

## Reading it

- **The read is fenced** as the profile's (`fencedRead()`): any write
  key on the server can write the note, and an agent that read planted
  text in the news can write it on. The header names the symbol,
  revision, author, time and bytes and says the text is an earlier
  agent's dated reading, data to weigh, never a request to call a tool,
  change data or send anything, and that live figures come from `quote`
  and `research`. `read` adds the `since_written` line under the
  header, outside the fence, since the server measured it; `version`
  answers the revision without it.
- **With none yet** the read says `No analysis of <id> yet.`, and to a
  write key adds that `analysis_edit` `replace` writes one.
- **Its text is in no log line**: a save logs the symbol, revision and
  bytes, and a fund as `fund` alone, since its ISIN would tell the
  operator what someone holds. The request log still names a fund's
  path, as it does for any fund page.

## Finding it

- **The `research` overview carries `analysis: {revision, written_at,
  read_with}`** for a key with analysis access, null with no note
  (`analysisField()`); a key without access gets no field. `read_with`
  is always `analysis`, the tool that reads it, for an agent that never
  reads a description. `quote` carries no pointer: every price question
  calls it, so a pointer there invites a note into a move question. The
  REST `/quotes` answers none either.
- **The server instructions route a view or take on a symbol to it**,
  second, for a key that lists `analysis`: the note first, then `quote`
  and `research` for what changed. A note is up to 8 KB, so the line
  says "not a price or move": a price or move question never reads one.
  A symbol without a note answers a short "No analysis" line.

## Tools and routes

- **`analysis` reads and `analysis_edit` writes**, listed per key's
  analysis access: `read` lists `analysis`, `write` both, `none`
  neither. `analysis` is read-only; `analysis_edit` destructive. The
  call-time access check stays (`analysisAnswer()`). `analysis`'s
  description opens with what it answers, the one line a catalog
  client shows; `Changes go through analysis_edit.` follows it for a
  write key.
- **`analysis` actions**: `read` (`symbol`), `list` (`next`; each
  symbol's live revision, newest first, without text, paged by cursor),
  `versions` (`symbol`; the kept revisions, newest first) and `version`
  (`symbol`, `revision`; one no longer kept says the last 100 are).
- **`analysis_edit` actions**: `replace` (`symbol`, `revision`, left out
  only for the first, `text`) and `edit` (`symbol`, `revision`, `edits`
  1 to 50 `{old, new}`), typed and read as the profile's.
- **A symbol resolves as every tool resolves it**: a stored id, a
  Yahoo symbol or a name, an unknown one fetched inside the call; the
  note is keyed by the instrument's id.
- **REST** (`docs/api.md`): `GET`, `PUT /instruments/{symbol}/analysis`,
  `POST .../analysis/preview`, `GET .../analysis/versions` and
  `.../versions/{revision}`, as the profile's routes, and `GET
  /analysis` for the list, paged by `page_size` and `page_token`. They
  take the analysis scopes; the `GET` answers carry `html` drawn by the
  profile's `renderMarkdown()`.

## Size

- **100 revisions of a full note are 2.4 MB a symbol.** A daily note of
  about 4 KiB keeps 400 KiB a symbol, so 50 symbols written daily stay
  near 20 MB.
