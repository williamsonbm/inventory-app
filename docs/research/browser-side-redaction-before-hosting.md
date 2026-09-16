# Browser-side redaction of MiTek material summaries, before hosting

- **Ticket:** none. This review was run outside the tracker, and two existing issues (#41, #38)
  were deliberately **not read**, because they carry another reviewer's conclusions and the task
  was to answer from the code. No claim below is sourced from either.
- **Type:** research finding, not a decision record. Two owner decisions taken during the review
  are recorded under *Decisions taken*; neither has an ADR yet.
- **Scope:** the browser half of the `materials-planner` planning pages — the inline `<script>`
  blocks in `src/planner/lumber.html`, `plates.html`, `hangers.html`, `lvl.html`, plus
  `src/planner/planner-ui.js` and `src/planner/csvPile.js`. Server-side parsers were read to
  judge blast radius; the change itself lands in the browser. `src/planner/planner.html` and the
  EWP modules being dropped (`optimizeCuts`, `selectStockLengths`, `applyStock`, `dbAdapters`,
  `detectWarnings`, `inventoryImpact`, `normalizeSize`, `cutListModel`) are out of scope.
- **Date of the run:** 2026-09-16, against `materials-planner` at `9426d1f`.
- **How this was verified:** every number below came from running the real `plan*` modules over
  the real fixtures in `materials-planner/test/*-fixtures/`, not from reading the code. The
  method is described under *Reproducing this* so it can be re-run; the scratchpad harness
  itself was session-local and is gone. `materials-planner` was never written to.

## The change being assessed

The four planning pages read a MiTek material summary CSV in the browser and POST the whole file
as JSON text to a route on the same machine. Moving to a hosted server sends that whole sheet off
the office machine — and a material summary carries per-line and per-job costs, the job-site
address, phone numbers, the customer name, and the sales representative's and designer's names.

So the browser must remove those values before the request is sent, and **the buy lists must not
change**. Two mechanisms were on the table: delete the rows that hold sensitive values, or keep
every row and column and empty the offending cells.

---

## Bottom line

Blanking cells is the safer mechanism and did not change a single buy list in testing. Deleting
rows is not merely risky — it cannot do the job, for two independent reasons, and has been
dropped.

The largest hazard belongs to neither mechanism. **Both have to rewrite the CSV text, and this
repo has no CSV writer** — only readers. That rewrite, not the redaction, is where a wrong buy
list with no error actually comes from.

> **Superseded 2026-09-16, after this review.** The diagnosis above holds and is the most
> valuable finding in this document. The prescription that follows from it — write a CSV writer —
> is one step further than necessary. **Both mechanisms have to rewrite the text only because
> both parse the text.** A mechanism that never parses never reassembles, so the round-trip
> hazard cannot arise at all. Measured afterwards: substituting on the raw text changed **zero**
> plan outputs across 236 tab-runs, removed **more** than blank-and-rewrite did, and needs no
> writer. See *Superseding measurement* at the end. This document is otherwise unchanged; the
> premise it did not test is named rather than edited away, because that omission is the point of
> the rule added to `CLAUDE.md` on 2026-09-16.

---

## Decisions taken

1. **The delete-rows mechanism is dropped.** Owner decision, 2026-09-16. Reasons are Findings 2
   and 3 below.
2. **"Rebuild the sheet from only the cells the buy list needs" was considered and rejected.**
   It was floated as a third option, on the theory that sending nothing you did not deliberately
   choose removes the quoting hazard entirely. It does not survive contact with the architecture:
   the browser does not parse these sheets, the server does, so the browser would have to
   reimplement enough of five server-side parsers to know which cells to keep — a second copy of
   the parsing rules, in a different runtime, free to drift from the real one.

   The owner also confirmed that **MiTek's export format is fixed and outside their control**,
   which removes the one cost that made a blocklist unattractive: there is no format churn to
   chase. Enumerate the sensitive spots once and they stay enumerated.
3. **Recommended approach: blank the cells, and write a real CSV writer to reassemble the sheet.**
   The writer is roughly ten lines. What makes it safe is the test, not the code: run every
   fixture through blank-and-rewrite and assert the buy lists are unchanged.

   **Superseded 2026-09-16.** Replaced by: substitute on the raw text, parse nothing, write
   nothing. The test remains exactly as described, and it is still what makes the change safe.
   #41 §5 carries the current mechanism.

---

## Findings, worst first

### 1. Rewriting the CSV can silently corrupt it, whichever mechanism is chosen

`grep -rniE "to[_ ]?csv|stringifyCsv|csvStringify|serializeCsv" --include=*.js --include=*.html src/`
returns one comment and no code. The only quote-aware code in the repo is `parseCsv`
(`src/ewp/parseCsv.js`, copied into `src/plates/parseCsv.js`), which is a reader.

Control run — correct quote-aware read, naive `rows.join(',')` write, **no redaction at all**:

```
BEFORE |,"2,124",MT20  3x3,219.87,"19,116.00",$222.00 ,$222.00 ,,,,
AFTER  |,2,124,MT20  3x3,219.87,19,116.00,$222.00 ,$222.00 ,,,,
```

`parsePlateSummary` reads `qtyCol=1`, `sizeCol=2`, so `MT20 3x3 × 2124` comes back as a SKU named
`"124"` with quantity `2`. The buy list still has thirteen plausible-looking rows:

```
before ["MT20  3x3",2124], ["MT20  1.5x3",1576], …
after  ["052",6], ["124",2], ["576",1], …
```

Worse on the stock side, because stock CSVs carry `"11 7/8"" PJI-40"`:

```
BEFORE |"11 7/8"" PJI-40",28,"11 7/8""",6,0,6,0,4,
AFTER  |11 7/8" PJI-40,28,11 7/8",6,0,6,0,4,
re-parsed BEFORE: ["11 7/8\" PJI-40","28","11 7/8\"","6","0","6","0","4",""]   9 cols
re-parsed AFTER : ["11 7/8 PJI-40,28,11 7/8","6","0","6","0","4",""]           7 cols
```

LVL plan for `33591J` netted against that stock file:

```
orig stock            [["9-1/2\"",0],["11-7/8\"",0],["14\"",176]]
naive-rewritten stock [["11-7/8\"",40],["14\"",0]]
blank-cells stock     [["9-1/2\"",0],["11-7/8\"",0],["14\"",176]]
```

176 linear feet of 14" LVL silently becomes zero. This is the wrong-buy-list-no-error case in its
purest form, and it comes from the round trip rather than from the redaction.

**Fix:** originally, a proper CSV writer covered by a round-trip test over every fixture.
**Superseded 2026-09-16:** do not parse the sheet at all. A mechanism that never breaks the text
into rows and columns never has to reassemble it, so this failure cannot occur. The round-trip
test stays.

### 2. Deleting rows makes the server mistake a job sheet for a stock file

`src/plates/readPlateStockCsv.js` `findHeader()` scans **only the first 10 rows**:

```js
for (let r = 0; r < Math.min(rows.length, 10); r++) {
SKU_COLS = ['sku', 'sku_display', 'item', 'product', 'description'];
QTY_COLS = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
```

Every MiTek sheet carries roughly thirty header rows above the material sections, and most of
them hold the sensitive values. Delete them and the sheet gets shorter, sliding the LUMBER SUMMARY
column header into that window:

```
 8 | LUMBER SUMMARY,,,,,,,,,,
 9 | SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
```

`SKU` is in SKU_COLS and `Qty` is in QTY_COLS, so `looksLikePlateStockCsv` returns true. Flip test
across 9 fixtures × 4 server sniffers × 4 mechanisms:

```
FLIP 10004F-materials-fullexport.csv A1 plates false -> true
FLIP batch-0002-scrubbed.csv         A1 plates false -> true
server re-routing sniffer flips: 4
```

Replicating the routing in `src/planner/server.js:103-120` on a two-job plates batch:

```
rerouted to STOCK: [ '10004F.csv' ]  remaining jobs: [ '10001R.csv' ]
buy list: [["MT20  1.5x4",930,930],["MT20  3x4",632,632], … ]   ← 10001R only
```

10004F's twelve plate SKUs — including 2,124 of `MT20 3x3` and 1,576 of `MT20 1.5x3` — are gone.
HTTP 200, `ok: true`. It also parsed as stock: `rowCount 3 items 3 skipped 63`, three phantom SKUs
named `Total: 2.1 RigidLam DF LVL 1-3/4 x 16`.

Plates is also the one page that never renders the reroute banner:

```
$ for p in lumber plates hangers lvl; do grep -c 'rerouted' src/planner/$p.html; done
lumber 2   plates 0   hangers 2   lvl 2
```

The only on-screen signal is a green `<div class="note ok"><b>Stock:</b> …` at `plates.html:181`
naming a job file as the stock file. A single-file batch fails loudly (400, "No usable plate
material summaries found"); a multi-job batch — the normal case — does not.

Blanking cells does not change the row count, so it cannot trigger this. Measured: zero sniffer
flips under blanking.

### 3. Row deletion cannot remove per-line cost at all

Cost does not live on its own rows. From `test/lumber-fixtures/batch-0000-scrubbed.csv:35`:

```
2z4spdss,10,8-00-00,2x4 SP DSS,Regular,,80.00,53.30,$4.16,$865.13,$88.40
```

Quantity `10`, LENGTH `8-00-00`, MATERIAL NAME and three cost columns, one row. The same holds for
plates (`,144,MT20  1.5x4,9.94,864.00,$0.44,$51.07`), LVL
(`1BM1-2,…,3,44-00-00,,,"$1,082.40 ","$1,082.40 "`) and hangers
(`4,Hanger,HUS412,,,,$444.00 ,$444.00`). **The set of rows carrying cost is the buy list.**

Forcing it — delete the sensitive header rows plus every row holding a `$` value — across
9 fixtures × 4 tabs:

```
=== unchanged: 123   CHANGED: 21 ===
  11 A2 delete-meta+$rows
  10 C  naive rewrite
```

All eleven are a whole buy list collapsing to `[]`. Example:

```
!! batch-0002-scrubbed.csv [lumber] A2
   before buy:[["2x4|#1",528],["2x4|#2",7146],["2x4|DSS",791], … 9 rows]
   after  buy:[]
```

Semi-loud: an empty table, `ok: true`, and one extra line inside the "Ingestion notices &
warnings" block, which `planner-ui.js renderWarnings` renders collapsed by default.

### 4. A row emptied completely vanishes with no warning; on Hangers it truncates the section

`src/hangers/parseHangerSheet.js:132` — `if (isBlankRow(r)) break;` — a blank row **terminates**
the section. Blanking every cell of the first hanger row of `10004F`:

```
CHANGED hangers blank the FIRST hanger row (HUS412)
   before {"w":1,"buy":[["THA426",45,45],["LU24",6,6],["HUS412",4,4]]}
   after  {"w":1,"buy":[]}
```

55 pieces to zero, warning count unchanged. Plates, lumber and LVL `continue` rather than `break`,
so they lose only the one row — still silently:

```
CHANGED lvl    blank an LVL data row (1BM6-3)  ["16\"",234] → ["16\"",132]
CHANGED lumber blank a lumber data row         2x4|DSS 128 LF → absent, w stays 0
```

`src/lvl/parseLvlSheet.js:76-88` has four `continue` guards and not one warning, so LVL is the
quietest tab. Blanking the `NAILED` annotation row *removed* the only warning that existed
(`w:1 → w:0`).

Shapes that a currency-keyed blanker would turn into blank rows already exist —
`test/ewp-fixtures/33844J-materials.csv:48` is `,,,,,,,"$2,045.31"` and `:56` is `,,,,,,,$306.11`.
On these nine fixtures none lands inside a Hangers data region, so **this was not observed firing
on a real sheet.** It is a latent shape, not a demonstrated failure. Guard the blanker so it never
empties a row completely.

### 5. `csvPile` persists the original text, and all four pages POST from it automatically on load

`csvPile.js` stores `{name, text, addedAt}` verbatim (`writeFiles` → `serialize` →
`localStorage.setItem` under `csvPile.v1`). `dropZones.rebuild()` hands those same objects to
`getJobs()`/`getStock()`, which the four pages stringify straight into the request body. Two
placements, two different problems:

- **Redact at POST** — the raw sheet stays in `localStorage` indefinitely (only "Clear all"
  removes it), and the panel badges and sniffers keep reading the real thing.
- **Redact at intake**, before `CsvPile.add` — the pile holds redacted text, so that is what
  `looksLikeAnyStock`, `pickStock` and the badges classify, and what the server re-sniffs. That is
  the Finding 2 path.

Either way, **a pile written before the change ships is POSTed raw with no user action**:
`lumber.html:265`, `plates.html:128`, `hangers.html:111` and `lvl.html:104` all call `autoRun()`
on load, and `autoRun = PlannerUI.debounce(runPlan, 80)`.

Filenames travel too — `getJobs()` returns `{name, text}`, and the name is echoed back and
rendered.

### 6. Four body-build sites, and a second pile writer outside the change's scope

`grep -n "fetch(\|body:" src/planner/*.html` gives four independent bodies:

| file:line | body |
|---|---|
| `lumber.html:323` | `{ files, stock, menu, redirects }` |
| `plates.html:102` | `{ files, stock }` |
| `hangers.html:92` | `{ files, stock }` |
| `lvl.html:85` | `{ files, stock }` |

All four read `dz.getJobs()` / `dz.getStock()`, so `dropZones` is the single chokepoint that
covers every one of them — put the redaction behind `getJobs()`/`getStock()` in
`planner-ui.js:302-303`, not at the four `fetch` calls and not at intake.

But `grep -rn "CsvPile\.add" src/planner/` gives **two** writers: `planner-ui.js:243` and
`planner.html:436` (the EWP page's own drop panel). They share one `localStorage` key, so
intake-time redaction on `planner-ui.js` alone would leave `planner.html` writing raw text into
the pile all four pages read. That closes itself when `planner.html` is dropped; until then it is
open.

### 7. Test coverage of the browser files

```
$ node --test test/planner-ui.test.js test/csvPile.test.js
# tests 13  # pass 13  # fail 0
```

Nine tests on `csvPile`'s pure helpers (`mergeFiles`, `pickStock`, `serialize`/`parseStored`), and
**four on a single function**, `looksLikePlateOrHangerStock`.

Untested: `looksLikeAnyStock` and `looksLikeItemSpanQtyStock` (exported to Node, no test calls
them), `stockProductHints`, everything DOM-facing in `planner-ui.js`, and the two per-page
`isStockFile` predicates, which live inline at `lumber.html:281` and `lvl.html:47` and are not
importable at all. `grep -rn "require(.*planner" test/` confirms no test loads any of the four
HTML pages.

---

## Anchors that were probed and held

Row-index windows and section terminators were the obvious place for a mechanism to do damage, so
each was probed directly rather than reasoned about. Most held:

| anchor | used by | probe result |
|---|---|---|
| all-blank row → `break` | hangers | **CHANGED — whole section lost** (Finding 4) |
| `COST BREAKDOWN WORKSHEET!` | LVL, EWP | deleting it: no change (the `Total Board Feet` row catches it) |
| `/^total\b/` prefix | all four | deleting `Total Hangers:` (holds `$2.00`): no change |
| `Address:` / `Job Name:` rows | — | deleting either: no change |
| `,,,,,,UNIT,TOTAL,,,` sub-header | — | blanking it: no change (it sits above `headerIdx`) |
| `rows.slice(0, 40)` metadata window | lumber, plates, hangers | not a hazard: `Job Number:` is on row 2 in all nine fixtures, and deletion only pulls rows up. Inserting 12, 13, 14 and 20 header rows into `10004F` changed nothing |

Two predictions that did **not** hold, recorded so they are not re-derived:

- **Cross-section column collision.** Cost columns are 8/9/10 in LUMBER SUMMARY, 5/6 in PLATE
  SUMMARY and 6/7 in Hangers, while plate `SIZE-GAUGE` and LVL `QTY` are both column 2 — so a
  mechanism that learns cost offsets from one section and applies them file-wide looked likely to
  blank material data. All three offset sets were applied file-wide to `10004F`: no change.
- **Browser-side classifier drift.** `looksLikeAnyStock`, `looksLikePlateOrHangerStock` and the
  two inline `isStockFile` predicates were run over all nine fixtures under all four mechanisms.
  Every one stayed `false`. The 1024-character sniff window does move — `batch-0000` reaches line
  40 originally and line 25 after deletion — but no fixture flipped. The classifier that did flip
  was the server's, in Finding 2.

---

## Column lookup: by name or by position

Mixed, and it does not turn out to be the deciding factor.

- **By name:** `parseLumberSheet`, `parsePlateSummary` and `parseHangerSheet` scan
  `rows.slice(0, 40)` for `Label:` / next-cell pairs and find data columns with
  `header.indexOf('qty')` and friends.
- **By fixed position:** `parseLvlSheet` (and `parseJobCsv`) use `cols[0] === 'Job Name:'` and
  `cols[2] === 'Job Number:'`.

Neither mechanism moves columns sideways, so the by-position parsers are not at risk. The risk is
in the *row-index* windows — `slice(0, 40)`, `Math.min(at + 6)`, and the 10-row window in
Finding 2 — and only row deletion disturbs those.

---

## Open questions

- **Does the scrub script still exist? ANSWERED 2026-09-16: yes.** It is `scrub-mats.py`, and it
  lives on the owner's own machine rather than in either repo, which is why a `find` across
  `/workspace` turned up only outputs. It is therefore the blocklist, already settled and already
  trusted in practice, and porting its rules to the browser is smaller and safer than deriving
  them fresh. Its financial rule is broader than money alone: it removes any value holding `$` or
  `%` with a digit. Measured 2026-09-16 with that same rule in the browser, over the owner's 50
  sheets: 200 of 200 plan outputs unchanged, and it removes 797 percentage values — the margin
  and markup figures — that a money-only rule leaves in place.
- **Can the Hangers blank-row truncation (Finding 4) be reached on a real sheet? ANSWERED
  2026-09-16: not on any sheet available.** The blanker was run *without* its guard across the
  owner's 50 real sheets and these 9 fixtures — 236 tab-runs, **zero** plan outputs changed. The
  shape remains latent, so the guard stays; it is not urgent.
- **Do real sheets have longer header blocks than the fixtures?** All nine have `Job Name:` on row
  28 and `Job Number:` on row 2 — suspiciously uniform, and every fixture is scrubbed or
  synthetic. Finding 2's severity depends on how much the prelude shortens on real files. Settled
  by running `looksLikePlateStockCsv` over a week of real exports, before and after deletion.
- **Is any sensitive value inside the material sections rather than the header block?** Only costs
  were found there. Settled by one unscrubbed export.
- **Do the other three server sniffers share the 10-row window?** `looksLikeStockCsv`,
  `looksLikeHangerStockCsv` and `looksLikeLumberStockCsv` did not flip on any fixture, so they
  were not opened. Only `looksLikePlateStockCsv` is verified.
- **Anything about the DOM half of `planner-ui.js`.** There is no Node harness for it and no
  browser was run, so drop-zone behaviour, the cross-tab `storage` event path and badge rendering
  are unverified.

---

## Reproducing this

The harness was session-local and is gone; rebuilding it is about forty lines.

1. `require()` `planLumber`, `planPlates`, `planHangers` and `planLvl` directly from
   `materials-planner/src/`, and read the nine job fixtures from `test/plate-fixtures/`,
   `test/ewp-fixtures/` and `test/lumber-fixtures/`.
2. Fingerprint each tab's answer as the buy-list rows plus the job, rejection and warning counts.
   Re-derive by hashing the whole plan object as well — the two must agree. They did: 36 full-plan
   SHA-256 hashes, zero differing under blanking.
3. Implement each candidate mechanism as `text → text`, read with the repo's own `parseCsv` and
   written back with both a correct quote-aware writer and a naive `join(',')` one. The gap
   between those two writers is Finding 1.
4. Diff fingerprints before and after, per fixture, per tab.
5. Separately, run the four server sniffers (`looksLikeLumberStockCsv`, `looksLikePlateStockCsv`,
   `looksLikeHangerStockCsv`, `looksLikeStockCsv`) and the browser classifiers over the same
   matrix, and report any file whose classification changed. That is what surfaced Finding 2.

`node --test` works in `materials-planner`. The full suite takes about six minutes; individual
files take about a second.

---

## Superseding measurement — added 2026-09-16, after this review

This section was added by a second reviewer who had read this document. It records what changed
and what held.

### The premise this review did not test

The review compared two mechanisms, both of which parse the sheet into rows and columns and write
it back. Finding 1 is the correct and valuable observation that the *write back* is where a wrong
buy list comes from. The step not taken was to ask whether the parse is needed at all.

It is not. Substituting on the raw text — six find-and-replace passes, no parse, no reassembly —
removes the same values and leaves every unmatched byte exactly as it arrived.

```js
text.replace(/\$\s?[\d,]+(?:\.\d+)?/g, '')            // money
    .replace(/-?[\d,]+(?:\.\d+)?%/g, '')              // percentages
    .replace(/(Sales Rep:,)[^,\r\n]*/g, '$1')
    .replace(/(^|\r?\n)(Designer,)[^,\r\n]*/g, '$1$2')
    .replace(/(Address:,)[^,\r\n]*/g, '$1')
    .replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '')
```

### Measured, on both corpora

The nine fixtures this review used, plus the owner's 50 real sheets from
`inventory-app/csv-examples/scrubbed/`, which this review did not have. Fingerprint is a SHA-256
of the whole plan object, per fixture per tab, exactly as *Reproducing this* describes.

| | parse → blank → write | **substitute on raw text** |
|---|---|---|
| plan outputs changed, 9 fixtures | 0 of 36 | **0 of 36** |
| plan outputs changed, 50 real sheets | 0 of 200 | **0 of 200** |
| monetary values removed, 50 real sheets | 6,110 | **6,138** |
| percentage values removed | 797 | 797 |
| residual `$` left behind | 139 | **106** |
| residual phone-shaped strings | 6 | **0** |
| CSV writer required | yes | **no** |
| Finding 1 corruption possible | yes | **structurally impossible** |

The residue is fixed template label text only — `Total $/Bd Ft`, `Gross Profit (Margin %)`. Every
number is gone. Labels are not sensitive.

For contrast, the Finding 1 control on the larger corpus: a naive rewrite **with no redaction at
all** changes 10 of 36 plan outputs on the fixtures and **32 of 200 on the real sheets**.

### What held, unchanged

Every other finding in this document was checked against the source and stands. Findings 2, 4, 5
and 6 were each confirmed at the exact file and line cited, with one correction, noted inline:
the hangers blank-row terminator is at `parseHangerSheet.js:132`, not `:141`.

Finding 2 gets stronger on real data. This review worried that all nine fixtures carrying
`Job Number:` on row 2 looked "suspiciously uniform" and might be an artefact of scrubbing. It is
not — all 50 real sheets carry it on row 2 as well, because the MiTek template puts it there. But
the first material section sits at rows 29 to 31, so **0 of 50 real sheets land in the 10-row
sniffer window today, and 49 of 50 would after deleting about 30 header rows.** Finding 2 is the
normal case, not an edge case.

### Where the current mechanism lives

#41 §5, amended 2026-09-16. It carries the substitution, the three constraints drawn from
Findings 4, 5 and 6, and both rejected mechanisms with their reasons.

### Why this document is amended rather than rewritten

`CLAUDE.md` gained a rule on 2026-09-16 requiring that the simpler approach be tested before one
that needs new machinery, and requiring that an approach inherited from a spec, a research
document or another agent has its premise named before it is built on. This document is the
worked example behind that rule. Editing the unexamined premise out of it would remove the
evidence.
