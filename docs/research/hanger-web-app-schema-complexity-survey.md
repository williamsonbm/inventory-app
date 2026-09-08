# hanger-web-app schema: where the complexity actually sits

- **Ticket:** [#21](https://github.com/williamsonbm/inventory-app/issues/21)
- **Feeds:** [#10](https://github.com/williamsonbm/inventory-app/issues/10) (refactor vs. rebuild) — this is
  evidence for that decision, not the decision itself.
- **Type:** research finding — a survey, not a recommendation. It does not say which family's
  implementation should win (that is [#9](https://github.com/williamsonbm/inventory-app/issues/9)) and
  it proposes no migration.
- **Scope:** `hanger-web-app`'s Postgres schema only — the SQL under `hanger-web-app/sql/`, read
  against what `server.js` and `src/` actually query. `hanger-web-app` is read-only from this repo;
  nothing here changed it.
- **Access date:** 2026-09-08.
- **How this was verified:** the findings below were produced by one pass over the sources, then
  re-derived from scratch by a second pass that was deliberately never shown the first, then
  adversarially fact-checked by a third against the primary sources. Claims that the three passes
  disagreed on were resolved by reading the source directly, and the disagreements are recorded
  where they mattered. Two claims in the first draft did not survive and have been removed — see
  *Corrections* at the end.

## Bottom line

The complexity sits in one place: **seven database objects are built once per material family, four
times over, and they are near-textually identical.** Hangers, plates, EWP and lumber each carry
their own commitment ledger, receipt ledger, physical-count table, threshold table, count-submission
table, and two views that derive how much is on hand and how much is available. Normalise two of
those views for family names and diff them and **two lines differ, both of them a CTE alias letter**
(`sql/hanger_schema.sql:169-203` against `sql/plate_schema.sql:171-205`).

That repetition is 701 of the 1,087 lines of structural SQL in the four family files — **64%**.

The cost is not the copies themselves. It is that a fix in one copy has to be remembered three more
times, and sometimes is not. The clearest evidence is a live, open bug: **F11 exists in all four
families at once**, because the view carrying it was copied four times before anyone noticed.

**But the direction that fix points is not the obvious one, and this is the finding that most
changes what #10 should conclude.** F11 is not a copy-paste slip in the views. It is caused by
information the *tables* never captured — the consumption event records a calendar date and no time
of day. Merging the four views into one shared calculation would therefore **not** fix F11. Only a
schema change would. The duplication is real and it is expensive, but the headline bug is not an
argument for consolidation, and a survey that claims otherwise is overselling the case.

Two further things a reader of this survey should carry into #10:

- **`hanger-web-app` has already decided this question once, and wrote down why.** `STATUS.md:344-368`
  records a dated position — *"Refactoring stance — decided 2026-08-12. Opportunistic only. Unify a
  material's code when already working in it. Do NOT attempt a general refactor"* — because *"there
  is essentially no route-level test coverage, the app is in daily production use, and this domain's
  bugs are subtle. Tests come first."* Any argument for consolidation has to engage with that, not
  route around it.
- **Not all divergence is duplication.** Several families solve the same problem differently for
  reasons that are documented and good. Flattening those would lose real information. They are
  separated from the unexplained divergences in §4 below.

## Details

### 1. The repeated shape

Seven objects, once per family: `<fam>_commitment`, `<fam>_receipt`, `<fam>_stock_count`,
`<fam>_threshold`, `<fam>_count_submission`, and the views `<fam>_on_hand` and `<fam>_availability`.

Code lines, excluding comments and blanks:

| Family | commitment | receipt | stock_count | on_hand | threshold | availability | count_sub | **total** |
|---|---|---|---|---|---|---|---|---|
| hanger | 22 | 18 | 9 | 35 | 6 | 17 | 12 | **119** |
| plate | 20 | 16 | 9 | 35 | 6 | 17 | 13 | **116** |
| ewp | 33 | 20 | 11 | 38 | 8 | 19 | 12 | **141** |
| lumber | 30 | 22 | 10 | 48 | 7 | 21 | 12 | **150** |

That is 526 lines. Add the `<fam>_demand_check(jsonb)` functions — `hanger_schema.sql:271`,
`plate_schema.sql:265`, `lumber_schema.sql:529` — and it reaches **701 lines, 64% of the 1,087 lines
of structural SQL** in the four family files (the files also hold 179 lines of seed data, excluded
from that denominator).

**There are three `demand_check` functions, not four.** EWP has none, and that absence is
deliberate: ADR 0004 (`docs/adr/0004-snapshot-stores-nothing.md`) records that EWP is cut-to-length,
so what to buy is not derivable from a material list the way it is for the other three. This matters
because it is the first place the "four of everything" framing breaks down — the repetition is real,
but it is not total, and the exceptions are usually reasoned.

**How identical, measured.** Normalising `hanger_on_hand` and `plate_on_hand` for family name and
consumption verb leaves **two differing lines, both a CTE alias letter** (`s` for ships, `b` for
builds). `hanger_availability` against `plate_availability` normalises to **one differing line, and
that difference is whitespace**. `ewp_on_hand` and `lumber_on_hand` are the same shape widened to a
two-part and three-part key.

**The one structural axis that genuinely differs** is the unit being counted: hangers, plates and
lumber sum a quantity; EWP counts distinct physical boards (`sql/ewp_schema.sql:201` against
`sql/hanger_schema.sql:190`); lumber adds a length dimension the others have no use for. A hanger has
no length and a board is not a quantity. That difference is warranted and is not duplication.

### 2. The cost, made concrete — and why it does not point where it seems to

`STATUS.md:106` records **F11**: *"Same-day count-then-consume never deducts — arrivals compare full
timestamps, ships/builds compare dates only."* `STATUS.md:90` calls it the top live correctness bug.

It is present in all four families, at `sql/hanger_schema.sql:194`, `sql/plate_schema.sql:196`,
`sql/ewp_schema.sql:205` and `sql/lumber_schema.sql:250` — and those four are the complete set of
`base_at::date` occurrences in the live schema. Each compares arrivals at full precision
(`r.arrived_at > lc.base_at`) but consumption at date precision
(`c.shipped_date > lc.base_at::date`). Since a date is never strictly greater than itself, a
consumption event on the same calendar day as a physical count is dropped. The `keys` CTE still emits
the key and the final `SELECT` coalesces the ships CTE to zero, so nothing downstream rescues it —
the deduction is lost permanently, not deferred.

**The root cause is in the tables, not the views.** `shipped_date` (`hanger_schema.sql:108`,
`ewp_schema.sql:75`) and `built_date` (`plate_schema.sql:95`, `lumber_schema.sql:109`) are `date`
columns. `arrived_at` and `counted_at` are `timestamptz`. The consumption event never recorded a time
of day, so the view has no finer precision available to compare against — `c.shipped_date >
lc.base_at::date` is close to the only sane comparison between a `date` and a `timestamptz`.

**Consequence for #10: consolidating the four views would not fix F11.** The missing information is
not duplicated across four places; it was never captured in any of them. The fix is a schema change —
record a timestamp on the consumption event, across four commitment tables and the triggers that
stamp them — which is exactly the class of migration this ticket says must wait for #10.

**It is also narrower than "never deducts."** Count at 10am, ship at 2pm: the deduction is real and is
lost, so on hand reads high. Ship at 8am, count at 10am: the physical count already reflects the
shipment, so excluding it is *correct*. The database cannot tell those two orderings apart.
`STATUS.md:106` words this precisely ("count-then-**consume**"); looser restatements overstate it.

**Two things make it worse than the register suggests.** The plate and lumber triggers stamp
`NEW.built_date := CURRENT_DATE` (`plate_schema.sql:121`, `lumber_schema.sql:151`), so a build marked
through the app on a count day is *structurally guaranteed* to carry today's date and fail the
comparison — this is not an edge case. And both triggers are `BEFORE UPDATE OF status`
(`plate_schema.sql:125-127`, `lumber_schema.sql:156-159`), so an INSERT landing directly at
`status='built'` never fires them, leaves `built_date` NULL, and a NULL fails the `>` comparison
**forever**, not just on the count day. That is F11 compounding with F14 (`STATUS.md:109`), and the
register tracks them separately.

**How this is managed today, and what the habit does not cover.** The owner confirmed on 2026-09-08
that this drift is known and already handled by procedure: **jobs built in the yard are flipped to
built in the web app *before* the physical count is taken.** That habit is correct, and it covers the
failure that has actually bitten — consumption flipped *after* a count, which deducts a second time
from a baseline that already excluded it.

It leaves one case uncovered. Material consumed and flipped *later on the same day as the count* is
dropped permanently: the count baseline predates it, and the same-day comparison excludes it. Because
counts are **monthly** (`ewp_schema.sql:12`, `:137`, `:147`), the resulting on-hand figure reads
**high** until the next count — and an inflated on-hand quantity causes under-buying, the same
direction of error as F26.

So F11 is lower severity than the register's "fires on any count day where something ships" implies,
because the procedure removes the common half. The residual risk is the remainder of the count day,
and it rests on a person remembering rather than on the schema.

**Related, already tracked as N1** (`STATUS.md:131`, worked example at `:346-368`): only
`lumber_availability` filters `superseded_at IS NULL` in its committed-demand CTE
(`sql/lumber_schema.sql:487`). Hangers (`:236`), plates (`:233`) and EWP (`:225`) filter on status
alone and rely on supersede always also stamping `cancelled`. Latent, not live — the invariant does
hold today — but three of four trust it and one verifies it. Same four-copies mechanism.

### 3. Duplication that crosses the database/app boundary

The repetition does not stop at the schema edge, and this is the part a schema-only reading misses.

**No availability view carries a human-readable display name**, so every reader re-derives one with a
LATERAL `COALESCE` chain over the threshold, count, commitment and receipt tables. That chain is
written **four times — three in JavaScript and one in SQL**: `server.js:262-300` (hangers), `~2477`
(plates, its own comment says it "mirrors hanger/EWP AVAILABILITY_SQL"), `~3193` (lumber, same),
and `sql/ewp_schema.sql:669-685` (EWP, in SQL, comment says it mirrors what the route already does).

The `SHORT` / `LOW` / `NO-THRESHOLD` / `OK` classification likewise exists in app SQL strings
(`server.js:266-271`) *and* independently inside each `demand_check` function
(`hanger_schema.sql:315-322`, `plate_schema.sql:303-309`, `lumber_schema.sql:574-580`).

**Inside one view, twice.** `ewp_lvl_availability_lf` contains the depth-extraction regexp block at
`sql/ewp_schema.sql:689-700` and again, verbatim, at `:711-722`. Its own comment says it mirrors
`src/ewp/extractDepth.js`, making a third copy, and the known-depths list is hardcoded a fourth time
in `ewp_ijoist_lengths_valid()` at `:504`.

### 4. Same problem, different family, different answer

**Explained on the record.** These are real differences with documented reasons. Unifying them would
destroy information:

| Divergence | Where | Reason given |
|---|---|---|
| Consumption at **ship** for hangers/EWP, at **build** for plates/lumber | `plate_schema.sql:94` vs `hanger_schema.sql:107` | `plate_schema.sql:14-16` — the plate goes into the truss when the truss is fabricated, days before the job ships |
| Match-key grain differs per family | `hanger_schema.sql:103`, `ewp_schema.sql:95`, `lumber_schema.sql:125-126` | `hanger_schema.sql:13-14`, `lumber_schema.sql:13-14` |
| EWP counts distinct boards, others sum a quantity | `ewp_schema.sql:201` | `ewp_schema.sql:14-15` — a board is the unit |
| Only plates/lumber guard "cannot cancel after consumption" | `plate_schema.sql:125`, `lumber_schema.sql:156` | `plate_schema.sql:105-111` — decided 2026-06-11, at trigger level "so EVERY writer is bound (Adminer included)" |
| EWP has no `demand_check` | — | ADR 0004 — EWP is cut-to-length |
| Plates have manual special-order marking but no import-driven path | `018_plate_special_order_sku.sql:27-38` | `:10-18` — `plate_commitment.status` has no such value; "not requested, not built" |
| Self-approval gate skipped for plates | `plate_schema.sql:369-376` | Plates counting is office-only; a second approver would add friction with no safety benefit |

Special-order is worth drawing out, because the same idea has **three unrelated mechanisms**: a
`status` enum value plus a display-only marking table for hangers (`hanger_schema.sql:106`, `:398-405`);
a display-only table alone for plates (`018_plate_special_order_sku.sql:27-38`); and for EWP a lookup
of series tokens (`ewp_special_order_series`, `ewp_schema.sql:258-267`) matched by
`ewp_is_special_order()` and used to filter `ewp_optimizer_inventory` (`:286-289`). **The EWP one is
not display-only** — it changes what the cut optimizer may draw from, confirmed live at
`server.js:4282`. Lumber has no special-order concept at all; its nearest equivalent is grade
substitution inside `lumber_grade_canon()` (`lumber_schema.sql:59-74`), which maps 2x8 `#1` to 2x8 DSS
because RTW no longer keeps that grade on hand.

**Nobody explains these.** Each is a place a shared implementation would have to pick one answer:

- **a. The reorder comparison operator.** `ewp_availability` uses strict `<` (`ewp_schema.sql:235`);
  hangers (`:245`), plates (`:243`) and lumber (`:499`) use `<=`, each citing migration 004. Nothing
  anywhere says why EWP was left behind. This is N2 (`STATUS.md:132`). "At threshold" reads OK for EWP
  and LOW for the other three, silently.
- **b. The `superseded_at` asymmetry** in the committed-demand CTEs — N1, described in §2.
- **c. Threshold tables are keyed on the *display* string, not the match key** — `sql/hanger_schema.sql:221`,
  `plate_schema.sql:218`, `ewp_schema.sql:169`; only `lumber_threshold` uses the normalised key
  (`:282`). This is the structural root of F10 (`STATUS.md:105`), where two rows normalising to one key
  both match and fan an item out into duplicate availability rows. No comment explains the choice.
- **d. `threshold NOT NULL` on EWP only** (`ewp_schema.sql:168`). Hangers, plates and lumber are all
  nullable, each with a written reason. EWP's is never justified, and it has a consequence: because a
  threshold cannot be blanked, `ewp_010_drop_22_threshold.sql:36` had to **`DELETE` the row**, in a
  system whose stated rule is that nothing is ever deleted.
- **e. `plate_commitment.revision DEFAULT 0`** (`plate_schema.sql:96`) against `DEFAULT 1` everywhere
  else. The surrounding comments are otherwise word-for-word identical. No functional effect found.
- **f. Two incompatible config-table shapes.** `ewp_config` is `(key, num_value, txt_value, note,
  updated_at)` (`ewp_schema.sql:312-318`); `lumber_config` is `(key, value jsonb)`
  (`lumber_schema.sql:291-294`). Lumber's own header calls EWP "lumber's only sibling precedent for a
  schema-level knob" and then does not follow it.
- **g. `lumber_receipt.line_key` is `UNIQUE` without `NOT NULL`** (`lumber_schema.sql:182`), against
  `UNIQUE NOT NULL` in the other three. That column is the idempotency key, and a nullable one admits
  unlimited NULL rows.
- **h. No "cannot cancel after consumption" guard for hangers or EWP.** The plate trigger's stated
  reason — cancelling a consumed line would wrongly add it back to on hand — applies identically to a
  shipped hanger line, since `hanger_on_hand` subtracts shipped rows (`:193`). Only two such triggers
  exist in the whole schema.
- **i. No non-negative constraint anywhere.** Of the 16 `CHECK` constraints across the four family
  files and `011_job_sync.sql`, 14 are status enums and two are structural. Not one quantity or
  threshold column has a `>= 0` check, in any family. This is F9 (`STATUS.md:104`), and it is uniform —
  a shared gap rather than a divergence.

### 5. What no running code reads

Method: every table and column name grepped against `server.js`, `src/`, `public/`, `tools/`,
`scripts/` and `test/`, with each hit read in context. Views and SQL functions count as readers — a
table read only by a view is live. **Four categories, which should not be conflated.**

**Genuinely dead — no reader, no writer.** Three whole tables and twelve columns:

| Object | Evidence |
|---|---|
| `lumber_cut_map` (whole table, 15 seeded rows) | The only occurrence in any executable file is a comment at `server.js:1236` — "lumber_cut_map is no longer queried or consulted here." Superseded by `src/lumberCutMap.js`. Part of N6 (`STATUS.md:136`). |
| `lumber_config` (whole table) | Zero hits in any `.js`/`.html`. The `drop_threshold_ft` hits at `src/ewp/optimizeCuts.js:100` and `server.js:4258` refer to `ewp_config.lvl_drop_threshold_ft`, a **different table**. |
| `lumber_pack_ref` (whole table, seeded empty) | Zero hits, and zero for `pieces_per_pack`. Not named in N6. |
| `ewp_receipt.is_remnant`, `.source_board_key` | Zero hits anywhere, plus an unused partial index at `ewp_schema.sql:330-331`. See the warning below. |
| `lumber_receipt.is_remnant`, `.source_cut_key` | Zero hits. Self-described as dormant at `lumber_schema.sql:183-185`. Part of N6. |
| `ewp_commitment.size_canon`, `ewp_demand.size_canon` | Zero occurrences in any `.js`/`.html`. Both are `GENERATED ALWAYS ... STORED`, so they occupy real bytes on every row, and no view reads them either. |
| `ewp_receipt.item_canon`, `ewp_stock_count.item_canon` | One hit in `server.js`, at line 5112, and it is a comment. |
| `ewp_config.txt_value` | Zero hits; only `num_value` is ever selected. |
| `lumber_catalog.sku_code`, `.description` | Zero hits for `sku_code`. Every query selects only the triple. The 60-line seeded catalog carries a code and description per row that nothing reads. |
| `job_sync_import.window_start`, `.window_end` | Zero hits; the only INSERT supplies three other columns. |

> **Warning, and the most consequential single finding in this survey.** The dead EWP remnant columns
> are **not** safe cleanup material. `STATUS.md:117` records **F26**: *"LVL 'returns to stock'
> remainders are zero-cost in the optimizer's objective, but nothing ever actually returns them to
> stock"* — so the optimizer under-buys. `src/ewp/optimizeCuts.js:426` confirms it treats a qualifying
> LVL remainder as zero cost. The mechanism that was supposed to return that material to the on-hand
> quantity is exactly `ewp_receipt.is_remnant` / `source_board_key`, described in the schema as "Phase
> 5 app logic" (`ewp_schema.sql:305-308`) and never built. **The dead columns and the live under-buying
> bug are the same unfinished feature.** Dropping them in a simplification pass would turn "wire up
> columns that already exist" into a full migration. N6 already asks whether to retire the lumber half
> of this scaffolding; the EWP half is in the same state and is the more consequential one, and is not
> currently in the register.

**Dark, not dead.** `job_sync`'s three tables and the `job_sync_latest` view are read and written by
real routes (`server.js:5765` onward), but every route is gated on `JOBSYNC_ENABLED`
(`server.js:155-156`), which is unset. ADR 0001 decides this deliberately: *"Leave `JOBSYNC_ENABLED`
unset. Keep the code in the tree. Do not delete it."* A config flip makes them live.

**Write-only — costed on every write, never read.** `ewp_commitment.optimize_run_id` is written at
`server.js:4551` and `:4657` and appears nowhere else: no SELECT, no WHERE, no ORDER BY. Its index
`ewp_commitment_run_idx` (`ewp_schema.sql:101`) serves no query. The stated purpose was to trace or
undo a whole optimizer run as a unit; the undo was never built. `lumber_stock_count.counted_by` is
the same shape — one hit, an INSERT column list at `server.js:3453`.

**Read by a person, not a program.** `public.schema_migrations` has no application reader **by
design**: `012_schema_migrations.sql:6-8` states that nothing executes migrations off this table, and
that it exists so a human can look at one table on the live host. Working as intended.

**Checked and found live, despite zero direct hits.** `ewp_special_order_series` is read by
`ewp_is_special_order()`, called at `server.js:4282`, `:5131`, `:5174`. `ewp_lvl_depth_threshold` is
joined by `ewp_lvl_availability_lf`, queried at `server.js:3902`. `hanger_receipt` is referenced 17
times across working routes — its schema comment claiming "no confirmed hanger PO feed yet"
(`hanger_schema.sql:125-127`) is stale, since two live INSERT paths exist at `server.js:1907` and
`:1975`.

### 6. Complexity that earns its keep

The strongest cases are where the record shows a simpler version was tried and produced a wrong
number.

- **`avail_after_forecast_lf` as a second column** rather than one availability number
  (`ewp_schema.sql:794-799`, ADR 0002). The simple version made 18″ LVL read **16 linear feet
  available against 160 linear feet physically unreserved**. The obvious simplification of the fix —
  one number, drop forecast from the flag — was considered and rejected on evidence: depth 24″ was
  sitting at **−160 linear feet** with no warning at all. Two columns is the minimum that gives both a
  truthful "what can the yard hand me today" and a flag that still sees the future.
- **`ewp_demand.dismissed_at`, stamped at ship time** (`ewp_schema.sql:416-418`, ADR 0003). The simple
  predicate `status <> 'cancelled'` also matched shipped rows, hiding **1,110 linear feet of LVL across
  6 jobs**. Both alternatives are recorded and refused with reasons. The rollback script clears only
  `dismissed_by = 'migration ewp_009'`, so it cannot touch the 48 human dismissals on live — that
  precision is why the complexity is affordable.
- **Schema-qualifying `public.norm()` inside `hanger_canon()`** (`017_hanger_canon_schema_qualify.sql`).
  Five bare `norm(...)` calls worked on live but broke `pg_restore`, which runs with an empty
  `search_path`: the STORED generated columns invoke the function at table-creation time, so the tables
  were never created and the restore cascaded — **47 errors observed in a disaster-recovery drill**.
  Four `public.` prefixes bought back the restore path. The baseline carries "DO NOT un-qualify these"
  in capitals.
- **The `DISTINCT ON` tiebreak in `optimized_commitment`** (`ewp_schema.sql:747-757`). Without it,
  which revision's length won was arbitrary — a nondeterministic number on a shop-floor screen. Six
  extra tokens make it deterministic.
- **`plate_pack_factor.receipt_eaches_per_unit`** as a second conversion factor
  (`plate_schema.sql:447-451`). Banded plates are **counted** by a 20-piece pack but **received** by the
  pallet, so one factor per SKU is provably wrong. The detail that earns it is the NULL handling: a
  banded line with no known pallet count is **skipped and flagged**, never silently multiplied by 20
  (`015_plate_banded_pallet.sql:15-17`). Choosing to fail loudly rather than guess is the value.
- **Migration 019's abort guard and 020's ordering guard.** A `DO $$` block that counts rows whose
  stored normalised key disagrees with a fresh recomputation and raises rather than proceeding, because
  redefining a canon function does **not** recompute STORED generated columns. 020 refuses to run at all
  if 019 has not been applied, because its rows would otherwise silently re-merge two plate types.
  `STATUS.md:248` records the 019 guard reporting zero drift on live. Pure overhead in the success case;
  the only thing standing between a function change and a half-keyed table otherwise.
- **The append-only ledger and supersede pattern**, used identically across all four families. Nothing
  is ever deleted and the write role has no DELETE grant (`sql/create_write_role.sql`,
  `ARCHITECTURE.md:288-289`). This is one of the four-times-repeated patterns from §1 and also the one
  most clearly worth keeping as it is: it is what makes a bad re-import recoverable without losing
  history.

**Less certain.** `ewp_ijoist_lengths_valid()` (`ewp_schema.sql:497-517`, constraint at `:529`)
hardcodes the known depths and menu lengths in SQL, duplicating `src/ewp/extractDepth.js` and the
engine's length menu. The file calls it "belt & suspenders" and the route validates too. The
defence-in-depth argument is real — the write role can reach these tables outside the app entirely —
but no incident of a bad write is recorded, and the cost is a third place to update when a depth is
added. Genuine redundancy or genuine insurance; the record does not settle it.

### 7. What this means for #10 — evidence, not a call

- **64% of the structural SQL in the four family files is one pattern written four times**, and two
  register findings (F11, N1) exist in multiple copies because of it. That is a real, boundable piece
  of work if a refactor is chosen.
- **The headline bug does not argue for consolidation.** F11 needs data the schema never captured.
  Consolidation would make future fixes cheaper; it would not make this one happen. Anyone citing F11
  as the reason to unify the four families has the argument backwards.
- **The source repo already decided against a general refactor, on 2026-08-12, and gave its reason:
  no route-level test coverage on a system in daily production use** (`STATUS.md:344-368`). That
  reason is about *risk*, not about whether the duplication is real — the same document measures the
  duplication and calls it real. If #10 lands on refactor, the recorded stance says tests come first
  and that they are the expensive part. If #10 lands on rebuild, that constraint dissolves, and the
  measured duplication above is the best available estimate of what would not need rebuilding twice.
- **Not everything that looks alike should be merged.** §4's explained divergences encode real
  differences in how the shop works. §6's complexity was paid for with production incidents.
- **The dead scaffolding is small** — three tables and twelve columns — and removing it does not touch
  the duplication story. It is worth doing on its own merits, with the F26 exception called out in §5.

### 8. Limits of this survey

- **The live database was never queried.** Everything here is read from DDL and application code. Every
  "dead" claim means "no code path references this name", not "this table has zero rows". A populated
  table with no reader is a different problem from an empty one, and they cannot be told apart from here.
- **The table count cannot be settled from files.** The non-archived SQL defines **36 tables, 11 views
  and 15 functions across 6 namespaces** — `hangers_dev` 6, `plates_dev` 7, `ewp_dev` 10, `lumber_dev` 9,
  `job_sync` 3, `public` 1. The ticket's "37 tables across 5 schemas" omits `public`, which under its own
  scoping would make the file count 35. More importantly, `sql/README.md:16-24` records that live is
  migrated by hand, file by file, and never rebuilt from the baselines, and `sandbox/build-db.sh:62-67`
  records that live and a from-scratch build already diverge in applied files. **Only
  `SELECT table_schema, count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' GROUP BY 1`
  against the live host settles the real number.**
- **Generic column names resist grepping.** `note`, `status`, `active`, `id` appear thousands of times;
  no deadness verdict was attempted on those. The dead columns listed are ones with distinctive names
  where every hit was read.
- **Audit severities are the audit's own.** `STATUS.md:84-86` warns that its severity is code-risk, not
  business-risk, and that F6 was the top-ranked correctness bug until its premise was checked and it
  closed `wontfix`. F11 was re-verified against the code for this survey and survives; the caveat still
  applies to the register generally.

### Corrections to the first draft

Recorded because the survey feeds a decision, and a reader should know what changed:

- The first draft claimed **four** near-identical `demand_check` functions. There are three; EWP has
  none, for a documented reason (ADR 0004). The claim was removed.
- The first draft argued that consolidating the four families would fix F11 "unambiguously". That is
  wrong — see §2 — and the argument is now reversed and explained.
- The first draft did not mention `STATUS.md`'s recorded refactoring stance, while arguing for the
  refactor it forbids. Now addressed in §7.
- The first draft said `ewp_lvl_availability_lf` has five CTEs. It has four: `lvl_on_hand`,
  `unoptimized_demand`, `optimized_commitment`, `open_lf_by_depth`.
- The first draft guessed that the ticket's "37 tables" counted a view. That does not reconcile —
  there are 11 views — and the honest answer is that files cannot settle it. See §8.

### One finding outside this survey's scope, flagged because it lands on #20

The self-approval gate that stops a submitter approving their own physical count reads
`if (action === "approve" && AUTH_MODE === "tailscale" && !ALLOW_SELF_APPROVAL)` —
`server.js:2405`, `:3438`, `:4066`. It is conditioned on Tailscale being the auth mode. Moving off
Tailscale therefore does not only remove the login system, as `CLAUDE.md` already records; it
**silently disables this control as well**. Relevant to
[#20](https://github.com/williamsonbm/inventory-app/issues/20) and
[#6](https://github.com/williamsonbm/inventory-app/issues/6).
