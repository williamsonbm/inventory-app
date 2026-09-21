<!--
Grilling-prep evidence for #9 — which implementation wins per material family.
Prepared 2026-09-21 to make the owner's grilling session productive. It gathers
comparative evidence and puts questions to the owner; it does NOT decide the winners.
Every non-obvious claim carries the command or file:line that produced it; where there
is no command, it says "I think". Re-derived against both siblings (read-only):
materials-planner and hanger-web-app under /workspace on the claude-pod alias.
Feeds #9 (grilling) and, downstream, #10 and the database slice.
See also: docs/research/hanger-web-app-schema-complexity-survey.md (#21) and
docs/research/hanger-web-app-schema-review.md (2026-09-20).
-->

# Which implementation wins, per material family? — evidence for the #9 grilling

**Ticket:** [#9](https://github.com/williamsonbm/inventory-app/issues/9) (`wayfinder:grilling`) ·
**Prepared:** 2026-09-21 · **Decides nothing** — this is grilling prep.

---

## Bottom line (plain language)

**For four of the five families, "which parser wins" turns out to be almost the wrong
question — because the two systems are running the *same* parser.** The materials
planner's job-sheet readers were copied out of hanger-web-app. The plate reader is
the same file bar two lines; the lumber reader and its cut engine say "ported" at the
top; the hanger reader is the same design, a bit trimmed. So there is no big
parser-quality gap to pick a winner on for lumber, plates, or hangers.

The real difference between the two systems is **what wraps the parser**:

- **The planner is a calculator.** You drop today's sheets in, it tells you what to
  buy, it remembers nothing. It presents that answer well — it shows need vs. have vs.
  buy, it shows lumber both as linear feet *and* as whole boards to order, it lets you
  edit the list of stock lengths, and it never silently drops a line it did not
  recognise.
- **The web app is a ledger.** It keeps a running record per family — physical counts,
  supplier receipts, reorder thresholds, live availability — and it can take material
  *in* (it reads a Simpson packing-list PDF to book hanger deliveries; it converts
  plate box-counts to pieces). The planner does none of that; it has no database at
  all (verified: no `pg`, no writes anywhere in its code).

So the honest shape of the answer is **not five independent contests**. It is mostly
**one decision you have already half-made** — the map's "snapshot first, commitment
later." The winner for most families is a **hybrid by construction**: keep the
planner's parsers and its buy-list presentation as the "drop and forget" front door;
keep the web app's ledger as the database layer you switch on when commitment lands.
The two genuine per-family exceptions are **LVL** and **EWP**, which need their own
calls.

**One correction to carry in:** a comment in two planner files claims the EWP cut
engine is "kept byte-identical" to the web app's. It is not — they have drifted, with
different default board lengths. If EWP optimisation ever comes back, that drift is a
real choice, not a formality (detail in the EWP section).

**What I need from you** is at the end of each family section and collected in
*Questions for the grilling*. The sharpest ones: for lumber, is the web app's
built-but-idle lumber ledger something you want to switch on, or scrap? For EWP,
does the winner keep the multi-job length search at all (this reopens ADR 0001 §5)?
For LVL, the planner groups purely by depth, which your own #4 finding says cannot be
right.

---

## The reframing, stated once (Details)

The task lists six comparison dimensions per family (parser robustness, feature
completeness, code/test quality, on-screen visibility, target-fit, maintainability).
Applied honestly, the evidence collapses most of them onto a single axis, because the
parsers are shared ancestry. Here is that finding first, because it changes how every
family below reads.

**The job-sheet parsers descend from one codebase.** Measured with
`diff -w -B` (ignore whitespace and blank lines), planner vs. web-app:

| Family | Planner file | Web-app file | Substantive differing lines | Reading |
|---|---|---|---|---|
| Plates | `src/plates/parsePlateSummary.js` (110 ln) | `src/parsePlateSummary.js` (110 ln) | **2** | Effectively the same file. Both headers even carry the web-app-only note "sku_norm is computed by the database" — a copy-paste tell, since the planner has no database. |
| Lumber | `src/lumber/parseLumberSheet.js` (146 ln) | `src/parseLumberSummary.js` (157 ln) | — | Planner header line 5: "Ported from the hanger-web-app's src/parseLumberSummary.js". Cut engine `src/lumber/lumberCutMap.js:6`: "Ported byte-for-byte in behavior from the hanger-web-app's src/lumberCutMap.js". |
| Hangers | `src/hangers/parseHangerSheet.js` (202 ln) | `src/parseHangerSheet.js` (234 ln) | **70** | Same design (walk every cell for labels; reject the date-range batch report), trimmed and adapted. Common lineage, not a rewrite. |
| LVL | `src/lvl/parseLvlSheet.js` (101 ln) | *(no standalone file; LVL lives inside EWP)* | — | Planner wrote a focused sibling parser precisely because the web app models LVL inside EWP. See the LVL section. |

Command, e.g. for plates:
`diff -w -B materials-planner/src/plates/parsePlateSummary.js hanger-web-app/src/parsePlateSummary.js | grep -cE '^[<>]'` → `2`.

**Consequence.** For lumber, plates and hangers, dimension 1 (parser robustness) and
much of dimension 3 (code quality of the parse) are close to a **wash** — you would be
choosing between two copies of the same reader. The differentiator is what surrounds
it, which splits cleanly:

- **Planner-only strength (presentation / snapshot):** the `plan*` layer nets
  Need / Have / Buy, reports lumber as linear-feet *and* whole boards, consumes on-hand
  first and splits "from on-hand" vs. "to purchase", exposes an editable per-group
  stock-length menu, and surfaces anything it could not match as `unmatched` rather
  than dropping it (`src/lumber/planLumber.js:1-40`, `src/lumber/lumberMenu.js:1-20`).
- **Web-app-only strength (state / commitment):** a full per-family ledger
  (commitment + receipt + physical-count + threshold + availability views), plus
  material intake the planner has no analog for — a Simpson packing-list PDF reader for
  hanger receipts (`src/parseSimpsonPackingList.js`) and a plate box/pallet→eaches
  converter (`src/plateBoxConvert.js`).

**Target-fit (dimension 5) is the tie-breaker, and it is architectural, not
per-family.** The planner is stateless by construction — verified:
`grep -rlE "require\(['\"]pg['\"]\)|new Pool|INSERT INTO" materials-planner/src` returns
nothing; its only routes are `/api/*/plan` and menu editing. The web-app families are
Postgres-backed (36 tables / 11 views / 15 functions per the 2026-09-20 review §1). The
Vercel+Supabase rebuild needs *both* shapes eventually: the snapshot front door has no
database to fight, and the database slice will want the ledger. That is why "hybrid"
below is not a dodge — it is the map's snapshot-first / commitment-later split, read
onto code that already exists on both sides.

### How this was verified

- Planner test suite: `cd materials-planner && node --test` → **197 pass, 0 fail**
  (full run, exit 0; the run takes ~5 min because two EWP optimiser suites exercise the
  slow length search). Non-optimiser suites alone: 155 pass, 0 fail.
- Web-app route census: `grep -oE "app\.(get|post|put|delete|patch)\(['\"]/api/..."`
  over `hanger-web-app/server.js` → 113 routes total; per family below.
- Schema facts are taken from the two evidence docs (#21 survey, 2026-09-20 review) and
  spot-re-derived where cited. Those docs already cross-checked each other; I did not
  re-run their full passes.
- **Not verified from here:** whether the web app's lumber ledger is actually *used* in
  production vs. bypassed. The schema survey (§8) records that the live database was
  never queried; "built-but-bypassed" is `CLAUDE.md`'s statement, not something the code
  can prove. Treat it as owner-supplied.

---

## Lumber

**The map already leans "planner wins for lumber." Tested here, that lean is right in
its conclusion but wrong in its stated reason — and it hides a real decision.**

### Evidence

- **The parser is not the planner's advantage, because it is the web app's parser.**
  `src/lumber/parseLumberSheet.js:5` — "Ported from the hanger-web-app's
  src/parseLumberSummary.js". The cut engine is a byte-for-byte behavioural port too
  (`src/lumber/lumberCutMap.js:6`). So #9's phrase "the planner's lumber parser… has
  more utility and better visibility than the web app's" is **mislocated**: the
  utility and visibility are in the *planning layer*, not the parser.
- **Where the planner genuinely does more (snapshot presentation):**
  - Answers two questions in one pass — linear feet *and* whole stock boards to buy —
    side by side per size/grade (`src/lumber/planLumber.js:1-24`).
  - Consumes on-hand boards first via a first-fit-decreasing pass, so pieces split into
    "from on-hand" vs. "to purchase" (`planLumber.js:8-16`).
  - Editable purchase-length menu per (size, grade), seeded from the owner's
    carried-lengths sheet, with the size→grade normalisation the web app does in the DB
    instead (`src/lumber/lumberMenu.js:1-20`, `src/lumber/normalizeLumber.js:1-24`).
  - A grade with no menu entry is reported as `unmatched`, "never silently dropped"
    (`lumberMenu.js:18-20`). This is the "better visibility" the owner values.
  - Test coverage: `test/lumber.test.js` — 31 cases, part of the 197 that pass.
- **Where the web app genuinely does more (state the planner lacks entirely):** lumber
  is a **complete built ledger**, not a stub. 18 routes
  (`grep -oE "/api/lumber[a-z/-]*" hanger-web-app/server.js | sort -u`): `availability`,
  `counts/{pending,review,sheet,submit}`, `jobs{,/cancel,/pdf,/status}`,
  `receipts{,/qty,/status}`, `receive/manual`, `sku{,/jobs}`, `skus`, `status`,
  `threshold/{set,remove}`. It has its own schema (`lumber_schema.sql`, the largest of
  the four family files at 282 structural lines — 2026-09-20 review §10) and a per-job
  cut-sheet PDF builder (`src/lumberPullList.js`). That is the "built" in
  built-but-bypassed.
- **A caveat the owner should weigh:** the web app's lumber threshold table is the
  *one* keyed on the normalised match key rather than the display string
  (`lumber_schema.sql:282`, survey §4c), i.e. lumber sidesteps bug F10 that the other
  three families carry. Lumber is, by that measure, the **best-built** of the web app's
  four ledgers — which makes "scrap it" more costly than it first looks.

### Tentative recommendation — PROPOSAL for grilling, not a decision

**Hybrid, planner-forward.** Keep the planner's lumber parser + `planLumber`
presentation as the snapshot/buy-list front door (this is what the owner already
reaches for). Do **not** treat that as a reason to delete the web app's lumber ledger:
it is the most correctly-built of the four DB families and is exactly the
commitment-later machinery the map wants the door kept open for. Port the presentation;
preserve the ledger for the database slice.

### Questions for the owner

1. The lumber ledger in the web app is fully built (18 routes, counts, receipts,
   thresholds, PDFs). Is it actually **bypassed today**, and if so **why** — never
   trusted, too slow, wrong numbers, or just never rolled out? (This decides whether
   "keep the ledger" is preserving something valuable or embalming something broken.)
2. When commitment-later arrives, do you want lumber to gain physical counts and
   supplier receipts like hangers/plates have — or stay a pure calculator?
3. The planner's editable stock-length menu was seeded from your 2026-08-25
   carried-lengths sheet. Is that list still current, and is it the source of truth, or
   is the web app's `lumber_catalog`?

---

## Plates

### Evidence

- **Parsers are the same file** — 2 substantive differing lines (command above). So
  parser robustness is a wash.
- **Planner side:** `src/plates/{parsePlateSummary,parseCsv,readPlateStockCsv,planPlates}.js`;
  `planPlates.js` is 269 lines; `test/plates.test.js` 28 cases (passing). Snapshot buy-list
  in eaches, netted against a stock CSV.
- **Web-app side — a real capability the planner cannot express:** plates are
  physically **counted by box/pack but received by the pallet**, so the ledger carries
  *two* conversion factors and a pure converter, `src/plateBoxConvert.js`
  ("box/pack count lines → eaches"), behind `POST /api/plates/counts/submit-boxes`. The
  2026-09-20 review §2 and survey §6 both flag this as complexity that **earned its
  keep**: a banded line with no known pallet count is skipped and flagged, never
  silently multiplied by 20 (`plate_schema.sql:439-454`; `015_plate_banded_pallet.sql:15-17`).
  24 `/api/plates` routes back the full ledger.
- **Divergences the web app owns that the planner never had to face** (survey §4): plate
  consumption fires at **build**, not ship (`plate_schema.sql:14-16`); a self-approval
  gate is deliberately skipped for plates; special-order is a display-only marking.
  These are shop-floor facts encoded in the ledger, invisible to a stateless calculator.

### Tentative recommendation — PROPOSAL

**Hybrid, ledger-forward.** The planner plate parser is fine to carry (it is the web
app's), but plates are the family where the web app's *state* does the most real work —
box/pallet conversion, build-time consumption, banded-pallet safety. For the snapshot
front door, use the planner presentation; for anything committing, the web app's plate
ledger is the one to keep, not re-derive.

### Questions for the owner

1. In the snapshot ("drop and forget") mode, do you ever need plate **box→eaches**
   conversion, or is that purely a physical-count concern that only matters in the
   committing/ledger mode?
2. Do you want the plate **self-approval gate** (someone can't approve their own count)
   to survive the move off Tailscale? The 2026-09-20 review (§7, E4) flags that leaving
   Tailscale silently drops it.

---

## Hangers

### Evidence

- **Parsers share design; planner's is trimmed** — 70 substantive differing lines over
  ~200 (planner 202 ln vs web-app 234 ln). Both walk every cell for metadata labels and
  both reject the date-range "Hangers Needed For" batch report as unjoinable
  (`materials-planner/src/hangers/parseHangerSheet.js:7-15`). The web app's extra ~32
  lines are not obviously richer parsing; worth a closer look only if you suspect the
  planner dropped a case (see question 2).
- **Planner side:** adds `hangerCanon.js` (SKU canonicalisation the web app does in the
  DB), `readHangerStockCsv.js`, `planHangers.js` (229 ln); `test/hangers.test.js` 19
  cases (passing).
- **Web-app side — intake the planner has no analog for:** hangers are the web app's
  *original* family and own the unprefixed route namespace (`/api/skus`,
  `/api/counts/*`, `/api/threshold/*`, `/api/receipts`, `/api/import/*` — that is why a
  `/api/hanger*` search returns 0). Uniquely, it **books receipts from a supplier PDF**:
  `src/parseSimpsonPackingList.js` parses the text of a Simpson Strong-Tie packing list
  (Simpson is the hanger supplier) with careful pack/unit handling. The planner cannot
  receive material at all.
- The web app's `hanger_receipt` is live (17 references; two INSERT paths at
  `server.js:1907`, `:1975` — survey §5), i.e. the receiving path is real, not dormant.

### Tentative recommendation — PROPOSAL

**Hybrid, matching the others.** Planner parser + presentation for the snapshot; web
app's hanger ledger + Simpson-PDF receiving for the committing mode. Hangers add nothing
that breaks the common pattern — which is itself useful evidence that the pattern holds.

### Questions for the owner

1. Is supplier-PDF receiving (Simpson packing lists) a workflow you want in the rebuild,
   or has that also been bypassed in favour of manual entry / the planner?
2. The planner's hanger parser is 32 lines shorter than the web app's. Do you know of a
   real hanger sheet the planner mis-reads that the web app gets right? (If not, the
   trim is probably dead code the web app never removed — but you would know the edge
   cases I can't see from files.)

---

## LVL

**This is a genuine per-family contest, and the planner's own design carries a known
flaw.**

### Evidence

- **This is the one family the planner treats as first-class and the web app buries.**
  Web app: LVL is **one route**, `GET /api/ewp/lvl-availability` (`server.js:3896`),
  modelled inside the EWP schema. Planner: a dedicated `src/lvl/` — `parseLvlSheet.js`
  (its own focused parser, written because the EWP parser gates the whole file on
  `Product: EWP` and would drop LVL beams riding on Roof/Floor jobs — `parseLvlSheet.js:5-16`)
  and `planLvl.js` (198 ln). `test/lvl.test.js` 10 cases (passing).
- **Planner strength:** it counts LVL that appears on non-EWP jobs at all — the web
  app's `Product: EWP` gate structurally cannot (`parseLvlSheet.js:5-16`). It handles
  ply-counting correctly without a separate multiplier (`planLvl.js:19-24`).
- **Planner weakness — verified, and it collides with your own recorded finding:**
  `planLvl` groups **by depth only** ("Grouped by DEPTH ONLY (extractDepth), never by
  full size string" — `planLvl.js:24`). But #4's decision (recorded in the map) found
  that **one depth holds both a stocked and a non-stocked series, so a depth-keyed rule
  cannot work.** The planner's LVL grouping is exactly the rule #4 says is wrong.
- **Web-app strength — hard-won availability math the planner has no equivalent for:**
  the web app splits LVL availability into two columns, `available_lf` vs.
  `avail_after_forecast_lf` (`ewp_009_lvl_forecast_split.sql`). The survey §6 records
  *why* the simpler one-number version was tried and rejected on evidence: it made 18″
  LVL read 16 LF available against 160 LF physically unreserved, and hid depth-24″
  sitting at −160 LF. It also carries the open F26 under-buying bug (LVL "returns to
  stock" remainders costed at zero but never returned — survey §5 warning).

### Tentative recommendation — PROPOSAL

**Split the LVL decision in two, because "which wins" has different answers for the two
halves:**
- **Parsing / what counts as LVL demand:** planner wins — it sees LVL on Roof/Floor
  jobs the web app's gate drops.
- **Availability / netting math:** lean web app — its forecast-split model was paid for
  with real wrong-number incidents; the planner's depth-only grouping is the rule #4
  already rejected. **Do not** port `planLvl`'s grouping as-is.

A hybrid LVL: planner's inclusive parser feeding a web-app-style depth-plus-series
availability model. This is more integration work than the other families, which is
itself a finding.

### Questions for the owner

1. Confirm the #4 finding in the concrete: is there a depth where you stock one series
   and treat another as non-stock? If yes, the planner's depth-only LVL grouping is a
   bug to fix on the way in, not a feature to preserve.
2. Do you rely on the web app's forecast-adjusted LVL number
   (`avail_after_forecast_lf`) today, or do you eyeball forecast separately? (This
   decides whether the two-column model is a must-keep or a nicety.)
3. LVL is where the open F26 under-buying bug lives. Is fixing it in scope for the
   rebuild, or a known-accepted gap?

---

## EWP

**Read the scope first: the heavy optimiser is already out of the hosted app, so "EWP
wins" cannot mean "the optimiser wins." And a re-derivation turned up a stale claim.**

### Evidence

- **Scope constraint (settled, do not relitigate):** the planner's EWP optimiser tab is
  **excluded** from the hosted app (#39/#41). Measured 58–230s against Vercel's 300s
  ceiling; a single job at three lengths is 58.0s (#9 comment, 2026-09-15). So the
  hosted EWP question is about the **ledger/board side**, not the multi-job length
  search.
- **What the web app owns for EWP (in scope):** the richest of the four ledgers — 36
  `/api/ewp` routes, 10 tables / 4 views / 5 functions (2026-09-20 review §1). It
  **counts distinct physical boards**, not a summed quantity (`ewp_schema.sql:201`,
  survey §1) — the correct unit, and one the planner's stateless model does not track.
  Board identity, receipt/awaiting-board transitions, the LVL forecast split above.
- **Re-derivation catch — the "byte-identical" claim is false.** Two planner files
  assert the EWP engine is kept byte-identical to the web app's
  (`src/lvl/planLvl.js:7-8`; `src/lumber/lumberCutMap.js:9`). It is not:
  `diff -w materials-planner/src/ewp/optimizeCuts.js hanger-web-app/src/ewp/optimizeCuts.js`
  → 112 differing lines (66 comments, ~44 code). The code differences are substantive
  and evolutionary — the **planner's copy is the more advanced fork**:
  - Different **default I-Joist purchase menu**: planner
    `[48,44,40,36,32,28,24,22,20,18,16,14,12,10,8]` (8′–48′) vs. web app
    `[48,44,40,36,34,32,30,28]` (12′–48′). These produce **different buy plans** for the
    same job.
  - Planner adds a **per-size** length override (`purchaseLengthsBySize`) the web app
    lacks; web app resolves by category+depth only.
  - Planner makes the LNS time budget configurable via `opts.lnsMaxMs` /
    `opts.lnsMaxIters`; the web app **hardcodes** them as `const`. This matters: #39
    records that `lnsMaxMs` "is the dial that works, and it is unreachable from the route
    layer." That is true of the **web app**; the **planner already exposes it**. If EWP
    optimisation is ever hosted, the planner engine is the one that already fixed the
    exact knob #39 flagged.
- **Recorded decision in tension (must be resolved by #9, per CLAUDE.md precedence):**
  ADR 0001 §5 says "for EWP the length search stays, and a non-stock flag is added"
  (accepted 2026-09-06, never superseded). The #9 comment (2026-09-15) reopens it:
  "does the winner keep the batch search at all?" An ADR outranks a ticket comment, so
  whoever resolves #9 must **either supersede ADR 0001 §5 or reaffirm it in the ADR** —
  not leave the contradiction standing.

### Tentative recommendation — PROPOSAL

**Two separable calls:**
- **EWP ledger / availability (in hosted scope):** web app wins — distinct-board
  counting and the LVL forecast split are correct and have no planner equivalent.
- **EWP length optimisation (out of hosted scope today):** defer, but record the two
  facts above. *If* it returns, the planner's engine is the better fork (configurable
  budget, per-size menu) — but the menus have drifted, so adopting it is a real choice,
  and the single-job-at-a-time question (below) may remove the batch search entirely.

I lean toward **superseding ADR 0001 §5's "the length search stays"** only if the owner
confirms one-job-at-a-time planning — but I am flagging the tension, not deciding it.

### Questions for the owner

1. **The ADR 0001 §5 question, put plainly:** when you plan EWP, do you plan **one job
   at a time**, or a **batch of jobs together**? If one at a time, the multi-job length
   *search* is mostly dead weight (a single-job optimiser at three lengths is 58s of it),
   and "which EWP engine wins" changes more from this answer than from any code
   comparison.
2. Did you ever ask for **multi-job, multi-length** EWP optimisation, or did it exist
   only because the tool ran on your own machine (#39's framing)?
3. The two EWP engines have drifted to **different default board lengths**. Which list is
   correct for the yard today — the planner's 8′–48′ or the web app's 12′–48′? (Someone
   changed one and not the other; you know which is right.)

---

## Cross-family summary

| Family | Parser | Planner adds | Web app adds | Tentative lean | The one question that decides it |
|---|---|---|---|---|---|
| Lumber | **Shared** (ported) | LF+boards buy-list, on-hand-first, editable menu, `unmatched` | Full ledger (18 routes), best-keyed thresholds, PDF pull sheets | Hybrid, planner-forward | Is the built lumber ledger bypassed, and why? |
| Plates | **Shared** (2-line diff) | Snapshot buy-list | Box/pallet→eaches, build-time consume, banded safety (24 routes) | Hybrid, ledger-forward | Is box→eaches needed in snapshot mode? |
| Hangers | Shared design, trimmed | Snapshot buy-list, canon | Simpson-PDF receiving, original ledger | Hybrid | Do you want supplier-PDF receiving? |
| LVL | **Planner-only parser** | Sees LVL on non-EWP jobs; ply-aware | Forecast-split availability (hard-won) | **Split:** planner parse + web-app math | Does one depth hold both stocked & non-stock series? (#4) |
| EWP | Engine **drifted**, not identical | More-evolved optimiser (configurable budget, per-size menu) | Distinct-board ledger; LVL forecast | **Split:** web-app ledger; optimiser deferred | One job at a time, or a batch? (reopens ADR 0001 §5) |

### Decisions that must be made together, not family-by-family

1. **The architectural split is the real decision.** For lumber/plates/hangers, the
   per-family "winner" is the same shape: planner presentation for snapshot, web-app
   ledger for commitment. So the grilling should first settle **"is the front door the
   planner's snapshot, with the web-app ledgers switched on later per family?"** — and
   then the three families fall out of that one answer. Deciding them separately risks
   coining three different dialects of the same choice (a thing `CLAUDE.md` warns
   against).

2. **"Winner" ≠ "delete the loser."** Because the parsers are shared and the strengths
   are complementary (presentation vs. state), most families want *both* sides kept,
   wired to the snapshot-vs-commitment split. Framing #9 as "pick one implementation and
   bin the other" would throw away either the buy-list visibility or the ledger. The
   useful output of the grilling is a **per-family split line**, not a per-family
   winner.

3. **LVL and EWP break the pattern and must be decided on their own** — LVL because its
   parser genuinely differs and its planner grouping is a known-bad rule; EWP because
   the optimiser is out of scope and its engine has drifted.

4. **Two recorded decisions ride on this ticket and cannot be left implicit:**
   - **ADR 0001 §5** ("the EWP length search stays") vs. the #9 comment's "keep the batch
     search at all?" — resolve in the ADR. *(I lean against §5's "stays" if planning is
     one-job-at-a-time — flagged, not decided.)*
   - The **`_dev` schema names** (`hangers_dev`, `plates_dev`, …) are a trial to be
     dropped when porting (per memory / 2026-09-20 review §4); any "keep the web-app
     ledger" decision inherits that rename.

---

## Limits of this evidence

- **Runtime usage is invisible from here.** "Built-but-bypassed" for lumber, and whether
  any ledger is actually exercised today, are owner facts — the code cannot show them,
  and the live database was never queried (survey §8).
- **I did not re-run the full #21 / 2026-09-20 verification passes.** Schema facts are
  quoted from those docs with spot re-derivation; they already cross-checked each other.
- **Parser "quality" beyond structure:** I established shared *lineage* by diff, not that
  either copy is bug-free. The 70-line hanger gap and any web-app parser edge cases the
  planner trimmed are worth a targeted read only if the owner names a mis-read sheet.
- **This document decides nothing.** It is input to the #9 grilling.
