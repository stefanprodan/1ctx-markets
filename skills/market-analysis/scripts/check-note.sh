#!/usr/bin/env bash
# Check an analysis note against the market-analysis skill's rules.
#
#   bash check-note.sh NOTE.md
#
# Prints the bytes of each part against its budget and every broken rule
# with its line, then OK or the number of problems. Over the limit, it
# names the whole cut and the longest lines of each part over budget, so
# one patch gets under. Exits 1 when a rule is broken. Counts the text as
# analysis_edit stores it: bytes, one trailing newline off.
# Only bash, awk, sed, wc and tail, so it runs in a minimal shell too.

f=$1
if [ -z "$f" ] || [ ! -f "$f" ]; then
  echo "usage: bash check-note.sh NOTE.md" >&2
  exit 2
fi

# Bytes of lines a..b as sed prints them.
bytes() { sed -n "$1,$2p" "$f" | wc -c | tr -d ' '; }
total=$(wc -c < "$f" | tr -d ' ')
[ "$total" -gt 0 ] && [ -z "$(tail -c 1 "$f")" ] && total=$((total - 1))

kind=stock
grep -q 'template: etf-v1' "$f" && kind=etf
grep -q 'template: fx-v1' "$f" && kind=fx
grep -q 'template: commodity-v1' "$f" && kind=commodity
sed -n 2p "$f" | grep -Eq '^(Share-class|Twin|Tracker) reference · [0-9]{4}-[0-9]{2}-[0-9]{2}$' && kind=link
# The limit, and part budgets that add up to 400 or 500 under it, so a
# draft that overshoots its budgets still lands near the limit.
if [ "$kind" = stock ]; then
  limit=8000 bh=900 bd=3000 bc=2500 br=1100
elif [ "$kind" = link ]; then
  limit=1500 bh=1500 bd=0 bc=0 br=0
else
  limit=6000 bh=1000 bd=2600 bc=1300 br=700
fi
margin=300

# The parts: line numbers of "## Decide", "## Check", "## Reference".
last=$(wc -l < "$f" | tr -d ' ')
[ -n "$(tail -c 1 "$f")" ] && last=$((last + 1))
# awk reads stdin: it takes a file name holding "=" (EURRON=X.md) for an
# assignment and never opens it. No concatenation after ==: just-bash's
# awk reads `$0 == h " "` as `($0 == h) " "`, true on every line.
start() { awk -v h="## $1" -v hs="## $1 " '$0 == h || $0 == hs { print NR; exit }' < "$f"; }
d=$(start Decide) c=$(start Check) r=$(start Reference)

# A part runs from its line to the line before the next part; its last
# newline is no byte. The last part ends the file, which may have none.
# Plain variables only: nested expansions inside $(( )) differ by shell.
nl=1
[ -n "$(tail -c 1 "$f")" ] && nl=0
part() {
  local from=$1 to=$last cut=$nl n
  if [ -n "$2" ]; then
    to=$(($2 - 1))
    cut=1
  fi
  n=$(bytes "$from" "$to")
  n=$((n - cut))
  # an empty file has no newline to take off
  [ "$n" -lt 0 ] && n=0
  echo "$n"
}
sh=$(part 1 "$d")
sd=0 sc=0 sr=0
[ -n "$d" ] && sd=$(part "$d" "$c")
[ -n "$c" ] && sc=$(part "$c" "$r")
[ -n "$r" ] && sr=$(part "$r")
sizes="header $sh/$bh"
[ -n "$d" ] && sizes="$sizes · Decide $sd/$bd"
[ -n "$c" ] && sizes="$sizes · Check $sc/$bc"
[ -n "$r" ] && sizes="$sizes · Reference $sr/$br"
if [ "$kind" = link ]; then
  echo "link note: $total/$limit bytes"
else
  echo "$kind note: $total/$limit bytes · $sizes"
fi

awk -v kind="$kind" -v limit="$limit" -v total="$total" -v margin="$margin" \
  -v d="${d:-0}" -v c="${c:-0}" -v r="${r:-0}" \
  -v sh="$sh" -v sd="$sd" -v sc="$sc" -v sr="$sr" \
  -v bh="$bh" -v bd="$bd" -v bc="$bc" -v br="$br" '
# The just-bash awk reads a name before "(" as a call, even with a space
# between, so no concatenation here starts with a parenthesis.
function bad(n, msg, line,  s) {
  s = msg
  if (n) s = "L" n " " s
  if (line != "") s = s ": " substr(line, 1, 70)
  out[++np] = s
}
# Whole word or phrase w in s (lower case), with no letter, digit, _ or -
# on either side. RE2 has no \< or \y, so the edges are spelled out.
function has(s, w) {
  return s ~ ("(^|[^a-z0-9_-])" w "([^a-z0-9_-]|$)")
}
function hasc(s, w) {
  return s ~ ("(^|[^A-Za-z0-9_-])" w "([^A-Za-z0-9_-]|$)")
}
# The five longest text lines from a to b. Sizes are awk lengths, bytes
# in one awk and characters in another, so they rank lines and are
# marked as about. picked is global and emptied first: the just-bash awk
# keeps the local arrays of a function between calls.
function longest(a, b,  i, k, best, top, s, sep) {
  for (i in picked) delete picked[i]
  s = ""
  sep = ""
  for (k = 1; k <= 5; k++) {
    best = 0
    top = -1
    for (i = a; i <= b; i++)
      if ((i in size) && !(i in picked) && size[i] > top) {
        top = size[i]
        best = i
      }
    if (best == 0) break
    picked[best] = 1
    s = s sep "L" best " ~" top
    sep = ", "
  }
  return s
}
# A hint is no problem of its own: it says where the over-limit cut goes.
function hint(name, a, b, have, budget) {
  if (have > budget)
    hints[++nh] = "  cut from " name ": " have " is " have - budget \
      " over its " budget " budget; longest: " longest(a, b)
}
BEGIN {
  if (kind == "link") {
    if (d || c || r) bad(0, "a link note has no parts: the main note holds them", "")
  } else {
    if (!d) bad(0, "missing part ## Decide", "")
    if (!c) bad(0, "missing part ## Check", "")
    if (!r) bad(0, "missing part ## Reference", "")
    if (d && c && r && !(d < c && c < r))
      bad(0, "parts out of order: Decide, Check, Reference", "")
  }
  if (total > limit && kind == "link")
    bad(0, "over the " limit "-byte limit by " total - limit ": keep only " \
      "what differs from the main note", "")
  else if (total > limit)
    bad(0, "over the " limit "-byte limit by " total - limit ": cut " \
      total - limit + margin " (to " limit - margin ") in one patch, " \
      "each part below to its budget; never a trigger, a level or a " \
      "Key driver'\''s breaks-if", "")
  nk = split("written|price at writing|why|review by|full review|changed", keys, "|")
  if (kind == "stock") keys[++nk] = "stance"
  if (kind == "stock" || kind == "fx") keys[++nk] = "value band"
  if (kind == "etf") { keys[++nk] = "exposure stance"; keys[++nk] = "vehicle"; keys[++nk] = "valuation" }
  if (kind == "fx") { keys[++nk] = "stance"; keys[++nk] = "carry" }
  if (kind == "commodity") { keys[++nk] = "stance"; keys[++nk] = "value band"; keys[++nk] = "curve" }
  if (kind == "link") nk = 0
  ntime = split("now|currently|this week|today", time, "|")
  nself = split("you|your|my|cost basis|position size|trim|add zone", self, "|")
  nlive = split("RSI|MACD|Bollinger|ATR|52-week|VIX|SMA[0-9]*|EMA[0-9]*|[0-9]+-day (moving )?average", live, "|")
  split("RSI|MACD|Bollinger|ATR|52-week|VIX|SMA|EMA|N-day average", livename, "|")
}
{
  line = $0
  row = line ~ /^\|/
  # A heading ends its block, so a table right under one still renders.
  if (row && !intable && NR > 1 && prev ~ /[^ \t]/ && prev !~ /^#+([ \t]|$)/)
    bad(NR, "no blank line before the table", prev)
  if (intable && !row && line ~ /[^ \t]/)
    bad(NR, "no blank line after the table", line)
  intable = row
  prev = line
  if (!d || NR < d) head = head "\n" line
  if (line !~ /^#+([ \t]|$)/ && line !~ /^\|[-| :]*$/ && line ~ /[^ \t]/)
    size[NR] = length(line)

  # No next: the just-bash awk stops END after one statement when the
  # last record ran next, so a heading takes the else branch instead.
  # "#1 producer" is text: a heading has a space after its hashes.
  if (line ~ /^#+([ \t]|$)/) {
    incov = line ~ /^### Unverified coverage/
    if (line ~ /^#+ Sources[ \t]*$/) bad(NR, "no Sources list: cite each figure inline", "")
  } else
    text_line(line)
}
function text_line(line,  p, q, i) {
  if (incov && line ~ /^- /) bullets++
  if (incov && row && line !~ /^\|-/) rows++
  if (index(line, "<!--")) bad(NR, "template guidance left in", line)
  if (line ~ /\]\([^)]*\/symbol\/[^)]+\)/) linked = 1

  # Prose: no code spans, link targets or URLs.
  p = line
  gsub(/`[^`]*`/, "", p)
  gsub(/\]\([^)]*\)/, "]", p)
  gsub(/https?:\/\/[^ )]+/, "", p)
  if (index(p, "$")) bad(NR, "bare $: write the currency code", line)
  # "MY" (Malaysia) is upper case and no personal word.
  q = p
  gsub(/(^|[^A-Za-z])MY([^A-Za-z]|$)/, " ", q)
  q = tolower(q)
  for (i = 1; i <= ntime; i++)
    if (has(q, time[i])) bad(NR, "time word \"" time[i] "\": date it instead", line)
  for (i = 1; i <= nself; i++)
    if (has(q, self[i])) bad(NR, "personal word \"" self[i] "\": the note is about the symbol", line)
  # Live readings, in Decide only: Price history keeps past ones, such
  # as extension over a moving average at a peak.
  if (d && NR > d && (!c || NR < c))
    for (i = 1; i <= nlive; i++)
      if (hasc(p, live[i])) bad(NR, "live reading " livename[i] ": the tools serve it", line)
}
END {
  for (i = 1; i <= nk; i++)
    if (!index(head, "\n- " keys[i] ":") && !index(head, "· " keys[i] ":"))
      bad(0, "header line missing: " keys[i] ":", "")
  if (kind == "link" && !linked) bad(0, "no link to the page of the main note", "")
  coverage = bullets + (rows > 0 ? rows - 1 : 0)
  if (coverage > 4) bad(0, "Unverified coverage holds " coverage " items, at most four", "")
  # Over the limit, every part over its budget is a place to cut. Under
  # it, only a Decide well over its budget is worth a note.
  if (total > limit) {
    hint("the header", 1, d ? d - 1 : NR, sh, bh)
    if (d) hint("Decide", d, c ? c - 1 : NR, sd, bd)
    if (c) hint("Check", c, r ? r - 1 : NR, sc, bc)
    if (r) hint("Reference", r, NR, sr, br)
  } else if (d && sd > bd + 300)
    print "note: Decide is " sd ", about " bd " is the aim; longest: " longest(d, c ? c - 1 : NR)
  for (i = 1; i <= np; i++) print out[i]
  for (i = 1; i <= nh; i++) print hints[i]
  print np ? np " problems" : "OK"
  exit np ? 1 : 0
}' < "$f"
