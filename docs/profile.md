# The owner's profile

Governs `src/profile/` (the store, the fenced read and the Markdown
renderer), `src/document/` (`applyEdits()`, the fence, the text and size
checks, the save and its eviction, the author's form, shared with the
analysis of `docs/analysis.md` and the trade plans of
`docs/trade-plans.md`, whose whole-state save calls `checked()` and
`evict()` from it), `src/operations/document.ts` (the arguments the
documents take), `src/operations/profile.ts`,
`src/tools/profile.ts`, the `/profile` routes in `src/api/routes.ts`
and their spec in `src/api/profile-spec.ts`. Keys and their access are
in `docs/admin.md`; the tool list per key and the server instructions
in `docs/tools.md`.

The profile is how the owner invests: goals, risk, trading style, rules
and analysis defaults, kept as one Markdown document so that every agent
reading the portfolio answers by the same preferences. It is the one
document the server keeps; every other document stays with the
agents' own knowledge base. The rules follow 1ctx's knowledge base
(its `docs/knowledge.md`): versioned text, exact edits, a stale
revision refused.

## One document

- **One profile per person**: revisions are keyed `(owner, revision)`
  (migration `0036-owners`), numbered per person, and every read and
  save takes the caller's owner, so another person's revision reads as
  one not kept.
- **Read whole.** Its sections refer to each other (a rule to a goal,
  a default to the trading style), so an agent needs all of it before
  an answer, and a read is one answer with no offset or limit.
- **Never parsed.** The server stores the text as sent and reads no
  field out of it: benchmarks, exclusions and caps are prose an agent
  applies, never settings the server computes with.
- **Not for what changes daily or per symbol.** Trades, holdings, cash,
  scorecards, per-symbol calls and dated logs have their own tools or
  belong in the agents' knowledge base; the display currency and time
  zone are portfolio settings.

## Text and size

- **Text is checked as 1ctx's `textFromString()`** (`documentText()`):
  well-formed UTF-8, no NUL, a leading BOM dropped. `text`, `old` and
  `new` never pass through `args.text()`, which trims and cuts at 100
  characters: spaces, blank lines and a missing last newline are kept.
- **A blank text is refused**: the profile is rewritten, never blanked
  by one call.
- **At most `MAX_DOCUMENT_BYTES` (24 KiB) of UTF-8**, about three times
  a full profile. The byte cap alone does not keep a read to one
  answer: JSON escaping grows short lines, quotes, tabs and control
  characters. So a save is also refused when its read answer would not
  pass `fits()` (`src/operations/answer.ts`), as 1ctx's `replace`
  refuses a file longer than one read page. Both refusals name the size
  and say what does not belong in a profile.

## Revisions

- **Every save is a revision** in `profile_versions`: its number from
  1, full text, bytes, author and time. The live profile is the highest
  revision.
- **The last `KEPT_REVISIONS` (100) are kept**, at most about 2.4 MB;
  the eviction runs in the save's write and never drops the live one.
  `version` of an evicted revision says the last 100 are kept.
- **A save equal to the live text stores nothing** and answers the live
  revision with `unchanged: true`, so an empty save never uses one of
  the kept revisions.
- **The author is who wrote it, as on trades**: the key's name, `admin`
  for the admin key, the person's name for a web UI login. It is copied into
  the revision, so a revoked key's history still reads.
- **Every write names the revision it read.** A stale one is refused as
  `{error: "conflict", message: "profile is at revision N", revision:
  N}` (409 over REST, the revision in the problem), so an agent reads
  again and retries, and a restore never overwrites a newer edit. The
  only write without a revision is the first `replace`; once a profile
  exists, it is refused the same way, and with none an edit or a
  replace naming a revision answers `revision: null`.
- **One `writer.write` closure per save** (`saveProfile()`, through
  the shared `saveIn()`): the
  existence check, the revision compare, `applyEdits()`, the text and
  size checks, the insert and the eviction, so two first replaces never
  both land.
- **No delete.** No key can remove the profile, and every kept revision
  stays restorable: `version`, then `replace` with its text.

## Edits

- **`edit` is 1ctx's `applyEdits()`** (`src/document/edit.ts`, pure): 1
  to `MAX_EDITS` (50) pairs of `old` and `new`; each `old` is non-empty
  and matches exactly once in the text at that revision, all matched
  before any applies, so pair order never changes the result and no
  `old` matches another pair's `new`. No two overlap; all apply or none.
- **A refusal names the pair from 1 and never quotes its `old`**:
  `edit 2: no match`, `edit 2: matches more than once` (it stops at a
  second match), `edit 2: overlaps edit 1`, `edit 1: old is empty`. The
  result then passes the checks of a `replace`.

## Reading it

- **The read is fenced** (`fenceFor()`, `fencedRead()`, ported from
  1ctx): the fence is one backtick longer than the text's longest run,
  so no line of the profile reads as the server's own words.
- **The header says it is preferences, not instructions.** Any write
  key can change the profile, so an agent that read untrusted news
  could plant text every other agent applies. The header names the
  revision, its author, time and bytes, says the text is the owner's
  preferences for the analysis that never ask to call a tool, change
  data or send anything, and that the owner's words in the chat come
  first. The footer names the revision again. `version` answers in the
  same form, so a read that fit when saved fits as a version.
- **With none yet** the read says so, and to a write key adds that
  `profile_edit` `replace` makes one.
- **It is in no other answer and no log line.** No tool or route
  returns its text but its own; a save logs its revision and bytes.

## Tools and routes

- **`profile` reads and `profile_edit` writes**, listed per key's
  profile access: `read` lists `profile`, `write` both, `none` neither.
  `profile` is read-only; `profile_edit` destructive. The call-time
  access check stays (`profileAnswer()`), in the portfolio tools'
  words. `profile`'s description opens with what it answers (how the owner
  invests), the one line a catalog client shows, then its own discovery
  line for clients that drop the server instructions, and `Changes go
  through profile_edit.` for a write key. The instructions' profile
  line names `profile` only, for want of room under their cap.
- **`revision` is an integer of at least 1** (digits as text are read
  too, as the other write tools do); `edits` 1 to 50 `{old, new}`
  objects, `old` non-empty, also read when sent as JSON text (at most 64
  KiB); `text` a string. The byte cap is
  the server's, since a schema counts characters.
- **REST** (`docs/api.md`): `GET /profile` answers `text`, `html`,
  `revision`, `author`, `updated_at` and `bytes`, every one null with
  no profile yet; `PUT /profile` takes `{revision?, text}` or
  `{revision, edits}`; `GET /profile/versions` and `GET
  /profile/versions/{revision}`. They take the profile scopes and the
  64 KiB body cap.
- **Markdown is drawn on the server** (`renderMarkdown()`, ported from
  1ctx without its code highlighting and app links), so the web UI
  ships no parser. It is the safety boundary for text any write key can
  set: no raw HTML, only http, https and mailto links, an image shown
  as its text and address, never fetched.
