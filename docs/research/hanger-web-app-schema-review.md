<!--
Provenance and in-session verification — added by the inventory-app session that
commissioned this review, 2026-09-20.

- Produced by a separate model against a self-contained package of hanger-web-app's SQL, its
  query surface (server.js + src/), and reference docs. It feeds #9 (which implementation wins
  per family) and the eventual database slice. It reviews ONLY hanger-web-app's schema; it does
  not compare the materials planner.
- Independently spot-checked here against the source: object counts (36 tables / 11 views /
  15 functions), the F11 date-only consumption comparison in all four family on-hand views, the
  six connection pools, `lumber_cut_map` seeding 12 tuples (correcting the #21 survey's "15"),
  and 16 CHECK constraints — all reproduced.
- It is an assessment with illustrative DDL, NOT a runnable migration. Its "risky" items need a
  live schema-only dump and the owner decisions in its §9 before implementation.
- Ticket: #9 / #10. See also docs/research/hanger-web-app-schema-complexity-survey.md (#21).
-->

# Schema review: evidence, reasoning, and illustrative target DDL

Reviewed 20 September 2026. Reference package: `schema-review-package/`. All source references below are relative to that directory. The package is unchanged. **The SQL in this document is a set of illustrative proposals, not an ordered or runnable migration. No SQL was executed against a database.**

## Plain-language assessment

Keep the inventory model, and strengthen its boundaries before simplifying its structure. It already has useful safeguards: physical counts reset accumulated drift, imports preserve earlier revisions, purchases do not become stock until they arrive, and EWP counts boards rather than cutting instructions. Those distinctions should survive the rebuild. See the evidence in §2.

The most consequential problem is missing information about **when material actually left stock**. A shipment after a morning count can disappear from the calculation because shipments and builds have dates while counts have timestamps. Combining the four inventory calculations would not recover that missing information. The rebuild needs accurate consumption timestamps and a clear rule for when physical counts were observed, separately from when somebody approved them. [E1, E2]

The cloud move also needs explicit database object names and a new authentication boundary. The current application depends on connection-specific settings and Tailscale-specific identity checks. Copying those assumptions into pooled serverless requests would be unsafe. These changes do not require merging the material ledgers. [E3, E4]

My recommendation is to retain the four family ledgers initially, qualify their database references, improve keys and validation, and add reliable count/consumption provenance. Evaluate a shared catalog and presentation layer next. Treat a single universal ledger as a separate, higher-risk design decision. The existing refactoring stance explicitly identifies weak route coverage as the reason to proceed carefully; rebuilding does not remove the need to prove equivalent inventory results. [`reference/STATUS.md:344–365`: “Tests come first”.]

**No further information is needed to complete this source-based review.** Before implementation, the decisions and live-data evidence listed in §9 are needed. They affect migration safety and business behavior, rather than preventing a useful proposal now. The approximate 12 MB size is supplied by the brief, not independently measured. [`README.md`, Context.]

## 1. Scope and interpretation of the source

The four family baselines describe the principal shape. Later files must also be read to determine the intended endpoint; some later changes have already been copied into baselines. The archive is history, not another set of live objects. `plate_baseline.sql` is **sample count data**, not structural DDL or an authoritative production inventory. [`schema/README.md:5–24,49–68`; `schema/plate_baseline.sql:4–8`: “SAMPLE count”.]

| Source | Effect that matters to this review |
|---|---|
| `011_job_sync.sql:30–108` | Adds a separate control-feed schema, three tables, a latest-row view, foreign keys, and grants. |
| `012_schema_migrations.sql:31–39,45–80` | Adds human-readable migration bookkeeping. Its seed records historical filenames; it is not proof that this package was executed on a particular database. |
| `013_plate_banded_counts.sql:14–24`, `014_plate_more_pack_factors.sql:18–26`, `015_plate_banded_pallet.sql:20–40` | Catalog additions and separate receipt-unit conversion. These effects also appear in the plate baseline. |
| `016_plate_mt18ahs_reconcile.sql:26–51` | Historical merge: changes canonicalization, deletes MT18HS counts, rewrites display strings. Do not replay this as harmless setup against production data. |
| `017_hanger_canon_schema_qualify.sql:27–37` | Qualifies the nested `public.norm` calls; this fix is also in the hanger baseline. |
| `018_plate_special_order_sku.sql:10–22,27–45` | Adds manual, display-only plate special-order designation. It does not introduce a commitment special-order status. |
| `019_plate_unmerge_mt18hs.sql:47–51` | Final plate canonicalization preserves separate HS and AHS identities, retaining the cosmetic M/MT aliases. |
| `020_plate_mt18hs_catalog.sql:48–67` | Adds two HS pack-factor rows after testing canonical separation. Factors are explicitly recorded as not independently verified at lines 27–36. |
| `ewp_008_lvl_lf_split.sql:149–173`, `ewp_009_lvl_forecast_split.sql:96–113,179–260` | Final LF semantics come from 009: available excludes forecast; a separate forecast-adjusted figure drives purchasing warnings; demand suppression is per job **and category**. |
| `ewp_010_drop_22_threshold.sql:34–40` | Deletes the depth-22 row from `ewp_lvl_depth_threshold`, not from `ewp_threshold`. |
| `backfill_*.sql` | Historical, one-time data corrections; explicitly excluded from normal rebuild by `schema/README.md:40–47`. |

The live schema, row contents, query plans, active flags, external integrations, and actual grants were unavailable. The source package also omits the original test suite, frontend, deployment scripts, and ADR files referenced by its documents. Claims about those absent artifacts are attributed reports, not independently verified observations. File inventory command: `rg --files schema-review-package`.

### Re-derived inventory and corrections to the earlier survey

Counting distinct, schema-qualified object definitions in top-level SQL, excluding `_archive/` and `verify/`, gives:

| Namespace | Tables | Views | Functions |
|---|---:|---:|---:|
| `hangers_dev` | 6 | 2 | 2 |
| `plates_dev` | 7 | 2 | 3 |
| `ewp_dev` | 10 | 4 | 5 |
| `lumber_dev` | 9 | 2 | 4 |
| `job_sync` | 3 | 1 | 0 |
| `public` | 1 | 0 | 1 |
| **Total** | **36** | **11** | **15** |

This reproduces the survey's **file-definition** totals, not a live catalog count. The reproducible command is in §10. It deduplicates repeated `CREATE OR REPLACE` definitions and interprets each file's `SET search_path` for unqualified definitions.

The seven repeated objects do exist in all four families. Counting their definition lines plus the adjacent indexes and redundant lumber commitment `ADD COLUMN` statements reproduces the survey's 119/116/141/150 = **526 lines**. The three demand-check functions add 60/54/61 = **175**, giving **701**. These are structural similarities, not 701 interchangeable lines. The functions and call sites are `hanger_schema.sql:271–334`, `plate_schema.sql:265–320`, `lumber_schema.sql:529–596`, and `app/server.js:1359,1385,1409`.

I could **not reproduce the exact 1,087 structural / 179 seed-line partition**. My explicit method (§10) counts 1,266 nonblank, noncomment lines: 184 in complete `INSERT` statements and 1,082 elsewhere. This gives 701/1,082 ≈ **64.8%**, rather than treating “64%” as a precise design metric. The survey does not supply its original counting command. [`reference/prior-schema-survey.md:29,65–80`.]

Additional corrections and qualifications:

- `lumber_cut_map` seeds **12**, not 15, tuples. Count `lumber_schema.sql:342–364`. The survey's “twelve columns” list actually enumerates **13**: two EWP remnant, two lumber remnant, four canon, one config, two catalog, and two Job Sync columns. [`reference/prior-schema-survey.md:236–249`.]
- The survey links the EWP board-threshold `NOT NULL` decision to migration 010's deletion. That migration acts on the **different** LF threshold table. Both are nonnullable, but the causal example should name the right table. [`ewp_schema.sql:164–170,645–648`; `ewp_010_drop_22_threshold.sql:36`.]
- Migration 019's check omits `plate_special_order_sku`, despite naming it in the surrounding explanation. It scans only five tables. Its function replacement also precedes the check without an explicit surrounding transaction. A failure stops the check, but under ordinary autocommit does not undo the preceding replacement. Migration 020 similarly needs stop-on-error/transaction discipline for its guard to protect later statements. [`019_plate_unmerge_mt18hs.sql:47–96`; `020_plate_mt18hs_catalog.sql:48–67`.]
- Replaying 008 after the supplied EWP baseline is not a safe fresh-build recipe: the baseline already exposes `avail_after_forecast_lf`, while 008 replaces the view with an older, shorter column list. PostgreSQL permits appending view columns with `CREATE OR REPLACE`, not dropping existing output columns that way. This is a source-derived replay hazard; I did not run the absent build script. [`ewp_schema.sql:791–799`; `ewp_008_lvl_lf_split.sql:149–173`; [PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html).]
- The comment “exactly one” active I-joist preset overstates what the partial unique index guarantees: it prevents two active rows, but permits zero. The application has an explicit fallback for zero. Preserve that fallback unless the business rule changes. [`ewp_schema.sql:532–536`; `app/server.js:4262–4273`.]
- The package verifies **no named application references**, not “nothing reads this anywhere.” The earlier survey searched directories that are absent here. Keep that distinction when considering retirement. [`reference/prior-schema-survey.md:232–234,355–368`; §6 below.]
- The display-name recovery is repeated, but the survey's lumber example is incorrect: that route selects size/grade/length directly from `lumber_catalog`, rather than using the claimed lateral display-name chain. Hangers, plates, and EWP do contain display-recovery chains. [`app/server.js:262–289,2454–2475,3172–3188,4237–4251`; `reference/prior-schema-survey.md:157–161`.]

## 2. What should be preserved

| Valuable property | Evidence and practical implication |
|---|---|
| Derived balances | `hanger_schema.sql:169–203` computes latest count plus arrivals minus consumption; the other on-hand views follow this shape. Preserve recomputability instead of introducing a second authoritative balance field. |
| Per-item count cutoffs | `hanger_schema.sql:171–186`, `ewp_schema.sql:180–196`, `lumber_schema.sql:222–240`. A partial count updates only counted keys; missing is not a count of zero. |
| Revision history and retry keys | `hanger_schema.sql:110–113`, `ewp_schema.sql:76–99`; `app/server.js:1465–1468,1515,4536–4555`. Keep stable idempotency keys and supersede old open revisions without erasing consumed history. |
| Count staging and atomic review | `hanger_schema.sql:358–371`; `app/server.js:2395–2436` locks the pending submission and applies one batch inside a transaction. Pending drafts must not affect stock. |
| Board identity | `ewp_schema.sql:91–93,201,223`: on-hand cuts require a board key; consumption and reservations count distinct boards. One board carrying three cuts consumes one board. |
| Explicit receipt state | `ewp_schema.sql:124–130,191–197`; `app/server.js:5325–5353` couples receipt arrival/reversal to awaiting-board transitions under a transaction lock. |
| Separate stock and purchasing figures | `ewp_009_lvl_forecast_split.sql:228–250`: `available_lf` differs from `avail_after_forecast_lf`. Do not fold unoptimized forecast into physical reservations. |
| Two plate unit conversions | `plate_schema.sql:439–454,552–567`; `app/server.js:3016–3044`. Count-unit packs and receipt-unit pallets need different factors. A missing banded pallet factor must stay unknown, not silently become a 20-piece pack. |
| Restrictions on destructive writes | `create_write_role.sql:18–31`, `grant_ewp.sql:21–26`, `grant_lumber.sql:17–23`. Preserve no-DELETE access for normal app operations. This is history retention, not a complete immutable audit log: UPDATE remains allowed. |

### Invariants that a shared implementation must retain

| Family | Stock key | Commitment grain / consumption | Reorder boundary today |
|---|---|---|---|
| Hangers | Canonical SKU | Quantity; consumes on shipment | `<=` |
| Plates | Canonical SKU | Quantity in eaches; consumes on build | `<=` |
| Lumber | Size + grade + stock length | Quantity of stock-board draws; consumes on build | `<=` |
| EWP | Canonical item + span | Cut rows grouped into distinct boards; consumes on shipment, on-hand source only | `<` for board availability |

Evidence: `hanger_schema.sql:103–108,190–194,245`; `plate_schema.sql:90–96,192–196,243`; `lumber_schema.sql:101–109,244–250,499`; `ewp_schema.sql:63–75,199–205,223–235`. The plate baseline explains build-time consumption at lines 14–16; EWP source routing is explicit in `app/src/ewp/dbAdapters.js:93–101`.

EWP's different reorder operator, its threshold nullability, and plate revision default 0 versus the other defaults of 1 are **unresolved policy/history questions**, not invitations to normalize behavior. The application explicitly supplies plate revisions during imports, which limits the significance of the default. [`reference/STATUS.md:132`; `plate_schema.sql:96`; `app/server.js:1586`; `hanger_schema.sql:113`; `ewp_schema.sql:86`; `lumber_schema.sql:110`.]

## 3. Prioritized findings and proposal classification

Every DDL block below is labeled. **Safe** means no intended change to accepted business values or calculations, although deployment still needs ordinary verification. **Behavior-preserving** means identical results are required and must be demonstrated. **Risky** includes fixes that deliberately change results, reject previously accepted rows, depend on unknown data, or need an operational decision. An additive nullable column can be safe by itself while activating its new semantics is risky.

| Evidence | Finding | Recommendation / classification |
|---|---|---|
| **E1:** `reference/STATUS.md:106,109`; `hanger_schema.sql:194`, `plate_schema.sql:196`, `ewp_schema.sql:205`, `lumber_schema.sql:250`: `...date > lc.base_at::date` | F11: date-only consumption loses the ordering within a count day. Plate/lumber guards also run only on UPDATE. With an existing count, a null consumption date fails the comparison; with no count the `lc.base_at IS NULL` branch includes it. | Capture actual consumption timestamps, including direct consumed INSERTs; change all four calculations. **Risky correctness fix**, independent of consolidation. |
| **E2:** `app/server.js:2422–2429,2816–2823,3453,4089–4096`: count rows use approval-time `now()` | The cutoff is when the office approved, not necessarily when the stock was observed. A delayed approval can exclude a real intervening arrival/consumption. This is an inference from those writes; its operational incidence is unknown. | Record observation time separately from submission and review time. **Risky** until count timing and delayed-entry rules are agreed. |
| **E3:** `app/server.js:215–257`; `hanger_schema.sql:289,324`; `ewp_schema.sql:278` | Six possible pools use startup `search_path`; even qualified function calls contain unqualified nested references. | Qualify base objects and nested function references. **Behavior-preserving**, after dependency and restore checks. |
| **E4:** `app/server.js:2405,3438,4066`; plate review at `2796–2836` | Self-approval checks depend on Tailscale for three families. The supplied plate review has no equivalent check. | Authenticated actor IDs and explicit office/shop permissions. Porting existing controls is **behavior-preserving**; extending the gate to plates is a **risky policy change** requiring a decision. |
| **E5:** `hanger_schema.sql:220–225,248`; `plate_schema.sql:217–222,246`; `ewp_schema.sql:164–171,238` | Threshold display-string PKs permit two rows for the same matching key. Joins can duplicate availability; the LF scalar subquery can instead fail with multiple rows (`ewp_009...:126–127`). F10 is recorded as latent, not live. | Unique normalized keys after conflict review. **Risky** until data and all writers are checked; then preserves valid-state behavior. |
| **E6:** `reference/STATUS.md:104,107`; table definitions listed in §10 | Sixteen CHECKs across the four baselines and 011: fourteen enum-like status/source/action checks and two structural checks; none constrain quantity to nonnegative. Lumber generated size/grade may be NULL. | Validate physical inputs, lengths, and parseability at the DB boundary; quarantine bad imports. **Risky** because accepted writes change. Do not constrain derived balances to nonnegative. |
| **E7:** `ewp_schema.sql:327–331`; `app/src/ewp/optimizeCuts.js:426`; `reference/STATUS.md:117` | F26: qualifying LVL leftovers receive zero waste cost, but no supplied app code writes the remnant fields. | **Keep** `is_remnant`, `source_board_key`, and the supporting index. Finish generation/reversal as a separate **risky feature completion**. |
| **E8:** `lumber_schema.sql:182`; `app/server.js:3645–3651` | Lumber's unique receipt retry key is nullable even though the manual receive path supplies one. | Require a key for future receipts after auditing other writers and existing NULLs. **Risky validation tightening**. |
| **E9:** `app/server.js:4749–4794` | EWP shipment and forecast dismissal/restoration use successive pool queries, without one surrounding transaction. A failure between them can leave the two states inconsistent. | Use one checked-out client, transaction, and consistent lock protocol for shipment, forecast, eventual remnants, and audit. **Risky correctness fix**; schema consolidation alone does not provide atomicity. |
| **E10:** `schema/019_plate_unmerge_mt18hs.sql:47–96` | Canonical function replacement, stored generated keys, and safety checks can diverge or partially commit. | Transactional deploy, collision reports, complete recomputation checks, explicit provenance. **Behavior-preserving** for qualification-only edits; **risky** for any identity rule change. |

## 4. Illustrative target DDL, with rationale

The recommended first target retains `hangers_dev`, `plates_dev`, `lumber_dev`, and `ewp_dev` as private family namespaces. Their names need not dictate environment: use separate Supabase projects for development and production. Renaming them is optional and not a correctness prerequisite. All relations/functions should be qualified regardless of whether a later target uses one schema. A single schema does **not** make unqualified names independent of `search_path`. [E3; [PostgreSQL schemas](https://www.postgresql.org/docs/current/ddl-schemas.html).]

Unshown columns, family-specific tables, and business rules remain as described in §1–2. These are focused target deltas and optional design alternatives, not a complete `CREATE DATABASE` script. Their presentation order is reasoning order, not deployment order.

### P1 — Remove ambient name resolution

**[behavior-preserving]** Preserve the normalization algorithm byte-for-byte while making its dependencies explicit. Do this for all SQL functions, generated expressions in fresh DDL, trigger functions, and application SQL. Qualifying only the outer function name is insufficient. [E3]

```sql
-- [behavior-preserving] Representative final definition; same matching rule.
CREATE OR REPLACE FUNCTION ewp_dev.ewp_is_special_order(p_item text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM ewp_dev.ewp_special_order_series AS s
    WHERE s.series_norm <> ''
      AND position(s.series_norm IN ewp_dev.norm(p_item)) > 0
  );
$$;
```

Use qualified calls such as `hangers_dev.hanger_demand_check($1::jsonb)` and qualify the tables and canon/norm calls **inside** its body. Pinning a function-local path is additional protection; `pg_temp` belongs last and business tables must still be explicit. Do not make these read functions `SECURITY DEFINER` merely to hide missing grants. [`hanger_schema.sql:271–334`; [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html).]

A common pure normalizer can eventually replace the duplicate `ewp_dev.norm` and `public.norm`, but only after exact input/output comparison. Keep the family canonicalizers separate; their alias rules differ. [`hanger_schema.sql:42–75`; `ewp_schema.sql:32–48`; `019_plate_unmerge_mt18hs.sql:47–51`.]

### P2 — Capture consumption time and the actual count cutoff

**[safe]** Adding nullable fields preserves existing readers. **[risky]** Switching writers and balance calculations to those fields changes inventory behavior and requires a historical cutover strategy. `consumed_at` means the actual ship event for hangers/EWP and actual build event for plates/lumber—not import time, approval time, or deployment time. Keep the existing date columns during transition.

```sql
-- [safe] Additive storage only; these statements alone do NOT fix F11.
ALTER TABLE hangers_dev.hanger_commitment ADD COLUMN consumed_at timestamptz;
ALTER TABLE plates_dev.plate_commitment   ADD COLUMN consumed_at timestamptz;
ALTER TABLE lumber_dev.lumber_commitment  ADD COLUMN consumed_at timestamptz;
ALTER TABLE ewp_dev.ewp_commitment        ADD COLUMN consumed_at timestamptz;

ALTER TABLE hangers_dev.hanger_count_submission ADD COLUMN observed_at timestamptz;
ALTER TABLE plates_dev.plate_count_submission   ADD COLUMN observed_at timestamptz;
ALTER TABLE lumber_dev.lumber_count_submission  ADD COLUMN observed_at timestamptz;
ALTER TABLE ewp_dev.ewp_count_submission         ADD COLUMN observed_at timestamptz;
```

**[risky]** Representative target invariant after cutover: a consumed line must carry a time; other current statuses must not. Require the timestamp from the verified event writer. An unconditional `DEFAULT now()` would manufacture event times on imports and delayed entries. The target plate/lumber guard must retain “cannot cancel directly after build”; all four writers must clear the current consumption timestamp on an authorized reversal and retain the prior event in audit. [E1, E2; `plate_schema.sql:112–127`; `lumber_schema.sql:142–158`.]

```sql
-- [risky] Final target constraints, AFTER historical reconciliation.
-- Not an immediate migration over legacy date-only consumed rows.
ALTER TABLE hangers_dev.hanger_commitment
  ADD CONSTRAINT hanger_consumption_time_ck
  CHECK ((status = 'shipped') = (consumed_at IS NOT NULL));
ALTER TABLE plates_dev.plate_commitment
  ADD CONSTRAINT plate_consumption_time_ck
  CHECK ((status = 'built') = (consumed_at IS NOT NULL));
ALTER TABLE lumber_dev.lumber_commitment
  ADD CONSTRAINT lumber_consumption_time_ck
  CHECK ((status = 'built') = (consumed_at IS NOT NULL));
ALTER TABLE ewp_dev.ewp_commitment
  ADD CONSTRAINT ewp_consumption_time_ck
  CHECK ((status = 'shipped') = (consumed_at IS NOT NULL));
```

These constraints also cover INSERT, unlike the old timestamp guards. They do not decide which user can reverse a build, synchronize the legacy date fields, or enforce immutability of consumed quantities; those are transaction/authorization responsibilities until explicitly added to database procedures.

**[risky]** The representative hanger target view changes only consumption timing. It deliberately leaves the current key universe, receipt inclusion, and null-baseline behavior intact. This is illustrative final-state DDL; historical nullable consumption rows must be resolved before using it.

```sql
-- [risky] F11 correction, not a view-consolidation refactor.
CREATE VIEW hangers_dev.hanger_on_hand_v2 AS
WITH last_count AS (
  SELECT DISTINCT ON (sku_norm)
         sku_norm, qty AS base_qty, counted_at AS base_at
  FROM hangers_dev.hanger_stock_count
  ORDER BY sku_norm, counted_at DESC
), keys AS (
  SELECT sku_norm FROM hangers_dev.hanger_stock_count
  UNION SELECT sku_norm FROM hangers_dev.hanger_receipt
  UNION SELECT sku_norm FROM hangers_dev.hanger_commitment
), arrivals AS (
  SELECT r.sku_norm, sum(r.qty) AS qty
  FROM hangers_dev.hanger_receipt AS r
  LEFT JOIN last_count AS lc ON lc.sku_norm = r.sku_norm
  WHERE r.stocked AND r.status = 'arrived'
    AND (lc.base_at IS NULL OR r.arrived_at > lc.base_at)
  GROUP BY r.sku_norm
), ships AS (
  SELECT c.sku_norm, sum(c.quantity) AS qty
  FROM hangers_dev.hanger_commitment AS c
  LEFT JOIN last_count AS lc ON lc.sku_norm = c.sku_norm
  WHERE c.status = 'shipped'
    AND (lc.base_at IS NULL OR c.consumed_at > lc.base_at)
  GROUP BY c.sku_norm
)
SELECT k.sku_norm,
       coalesce(lc.base_qty, 0) + coalesce(a.qty, 0)
         - coalesce(s.qty, 0) AS on_hand,
       lc.base_at AS counted_at
FROM keys AS k
LEFT JOIN last_count AS lc ON lc.sku_norm = k.sku_norm
LEFT JOIN arrivals AS a ON a.sku_norm = k.sku_norm
LEFT JOIN ships AS s ON s.sku_norm = k.sku_norm;
```

Apply the same timestamp comparison to plate/lumber build CTEs and EWP ship CTEs, preserving each key, source predicate, and aggregation. In particular, do not replace EWP's distinct-board calculation with a cut-row count. Give all cuts belonging to one consumption event the same effective timestamp. Define the exact-boundary convention: the count includes events at or before its observation cutoff; only strictly later events are added/subtracted. [E1; `ewp_schema.sql:199–206`.]

Approval should write `observed_at` to `stock_count.counted_at`; retain `reviewed_at` for the approval instant. A family-wide observation time is sufficient only if the count is a synchronized snapshot. If the yard is counted in sections while stock moves, use per-line observation times or an agreed movement freeze. This is an operational choice, not something `now()` can solve. [E2; `reference/hanger-web-app-CONTEXT.md:86–93`.]

Legacy dates do not reveal within-day ordering. Do not backfill them to midnight or noon and label them exact. Recover timestamps from reliable records where possible; otherwise identify date-only historical events and obtain a reconciled physical baseline at cutover. A temporary compatibility calculation can retain the old comparison for unresolved historical rows, but that explicitly retains their ambiguity. Delayed corrections or reversals that cross an intervening physical count need an adjustment/recount policy: deleting a historical consumption state alone cannot reconstruct what that newer count included.

### P3 — Make threshold keys match the joins

**[risky]**, becoming behavior-preserving only after proving no normalized duplicates and adapting every upsert. Do not pick a threshold by `MIN`, `MAX`, or last-write-wins when two display names collide; the owner must resolve intent. Preserve NULL versus zero and the existing EWP operator. [E5]

```sql
-- [risky] Illustrative uniqueness targets after duplicate resolution.
-- Keep display-string PKs during the compatibility period.
ALTER TABLE hangers_dev.hanger_threshold
  ADD CONSTRAINT hanger_threshold_norm_uq UNIQUE (sku_norm);
ALTER TABLE plates_dev.plate_threshold
  ADD CONSTRAINT plate_threshold_norm_uq UNIQUE (sku_norm);
ALTER TABLE ewp_dev.ewp_threshold
  ADD CONSTRAINT ewp_threshold_norm_span_uq UNIQUE (item_norm, span);
```

The eventual primary key may be these normalized columns, or the catalog ID in P7. Do not add a second unique index if an equivalent constraint already exists in the live database. Generated normalized columns can be empty even when display text is nonnull; reject blank/invalid identities only after inventorying those cases. Source definitions: `hanger_schema.sql:221–223`, `plate_schema.sql:218–220`, `ewp_schema.sql:165–169`.

**[risky / uncertain]** Allowing EWP threshold clearing without deletion is a reasonable candidate, but changes an unexplained divergence. Treat board and LF thresholds separately. Migration 010 is not evidence that EWP board thresholds should become nullable.

```sql
-- [risky] OPTIONAL, only if clear-without-delete is approved for each table.
ALTER TABLE ewp_dev.ewp_threshold
  ALTER COLUMN threshold DROP NOT NULL;
ALTER TABLE ewp_dev.ewp_lvl_depth_threshold
  ALTER COLUMN threshold_lf DROP NOT NULL;
```

Nullable LF thresholds do not disable negative-after-forecast warnings: the final LF view has a separate `< 0` condition. Do not replace it with the simpler board availability reorder expression. [`ewp_009_lvl_forecast_split.sql:233–237`.]

### P4 — Validate inputs without suppressing real shortages

**[risky]** These reject writes the current DB accepts. Profile historical negatives, NULL keys, and length values first. Preserve negative **derived** on-hand/available figures: they reveal overshipment or overcommitment. If signed adjustments are a real workflow, model them explicitly rather than banning them in their appropriate ledger. [E6]

```sql
-- [risky] Representative constraints; NOT VALID still checks new/updated rows.
ALTER TABLE hangers_dev.hanger_stock_count
  ADD CONSTRAINT hanger_count_qty_ck CHECK (qty >= 0) NOT VALID;
ALTER TABLE plates_dev.plate_receipt
  ADD CONSTRAINT plate_receipt_qty_ck CHECK (qty >= 0) NOT VALID;
ALTER TABLE lumber_dev.lumber_commitment
  ADD CONSTRAINT lumber_stock_key_ck CHECK (
    size_norm IS NOT NULL AND size_norm <> ''
    AND grade_norm IS NOT NULL AND grade_norm <> ''
    AND stock_length_ft > 0
    AND stock_length_ft NOT IN ('NaN'::numeric, 'Infinity'::numeric)
    AND quantity >= 0
  ) NOT VALID;
ALTER TABLE ewp_dev.ewp_demand
  ADD CONSTRAINT ewp_demand_input_ck CHECK (
    qty >= 0 AND required_length > 0
    AND required_length NOT IN ('NaN'::numeric, 'Infinity'::numeric)
  ) NOT VALID;
ALTER TABLE plates_dev.plate_pack_factor
  ADD CONSTRAINT plate_pack_factor_positive_ck CHECK (
    eaches_per_unit > 0
    AND (receipt_eaches_per_unit IS NULL OR receipt_eaches_per_unit > 0)
  ) NOT VALID;
ALTER TABLE lumber_dev.lumber_receipt
  ADD CONSTRAINT lumber_receipt_retry_key_ck
  CHECK (line_key IS NOT NULL AND btrim(line_key) <> '') NOT VALID;
ALTER TABLE hangers_dev.hanger_count_submission
  ADD CONSTRAINT hanger_count_lines_array_ck
  CHECK (jsonb_typeof(lines) = 'array') NOT VALID;
```

Complete the same domain-appropriate validation matrix for all four families: counts and receipts ≥0; approved commitment quantity rules; thresholds ≥0 or NULL where supported; finite positive physical lengths; arrived status requires `arrived_at`; valid count-line shapes and keys. Existing constraints such as the EWP on-hand board-key check remain. A JSON-array check does not validate its elements or permissions. `NOT VALID` is a staging aid, not an exemption for future bad writes. [E6; `ewp_schema.sql:91–93`; [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html).]

Keep exact `numeric` lengths until the accepted measurement increment and range are known; do not introduce floating-point identity or round odd-span remnants into standard lengths. Keep job numbers as text, identity PKs as bigint, and scheduling dates as dates. Proposed type changes without measured capacity or precision needs would add conversion risk for little demonstrated benefit. Current types: `ewp_schema.sql:57–77,124`; `lumber_schema.sql:96–114`; `hanger_schema.sql:96–113`.

### P5 — Index observed access patterns, not every column

**[safe]** Candidate nonunique indexes do not change results. I think they are sensible first measurements, not proven performance wins: no `EXPLAIN (ANALYZE, BUFFERS)` or workload statistics were available. Latest-count queries order by match key then descending time, whereas existing uniqueness indexes start with time. Job revision queries also justify considering a job/revision index. [`hanger_schema.sql:162,171–174`; `ewp_schema.sql:154,180–183`; `app/server.js:1515,4536`.]

```sql
-- [safe] Optional candidates; retain only if plans/latency justify their cost.
CREATE INDEX hanger_count_latest_idx
  ON hangers_dev.hanger_stock_count (sku_norm, counted_at DESC) INCLUDE (qty);
CREATE INDEX plate_count_latest_idx
  ON plates_dev.plate_stock_count (sku_norm, counted_at DESC) INCLUDE (qty);
CREATE INDEX ewp_count_latest_idx
  ON ewp_dev.ewp_stock_count (item_norm, span, counted_at DESC) INCLUDE (qty);
CREATE INDEX lumber_count_latest_idx
  ON lumber_dev.lumber_stock_count
     (size_norm, grade_norm, stock_length_ft, counted_at DESC) INCLUDE (qty);
CREATE INDEX hanger_job_revision_idx
  ON hangers_dev.hanger_commitment (job_number, revision DESC);
```

Compare equivalent plate/lumber job indexes before adding them. EWP already has live-job, optimizer-run, status/source, and material-key indexes. Existing count uniqueness remains necessary; the new index is not a replacement. Partial arrived/committed indexes can wait for actual plans, especially at the brief's small database size. Do not introduce partitioning, cached balances, or materialized views without a demonstrated bottleneck. [`ewp_schema.sql:95–101,154`; §1 scope.]

### P6 — Count provenance and audit identity

**[safe]** Nullable provenance fields can be added without changing current behavior. **[risky]** Enforcing new identity and approval rules requires the auth and role decisions in §9. Preserve legacy byline text as historical evidence; do not pretend it is a verified Supabase user ID. [E4; `reference/STATUS.md:111–112`.]

```sql
-- [safe] Additive representative family; repeat with each family's submission FK.
ALTER TABLE hangers_dev.hanger_stock_count
  ADD COLUMN submission_id bigint
    REFERENCES hangers_dev.hanger_count_submission(id);
ALTER TABLE hangers_dev.hanger_count_submission
  ADD COLUMN submitted_by_user_id uuid,
  ADD COLUMN reviewed_by_user_id uuid;

-- [safe] New storage only; event coverage must be wired in separately.
CREATE SCHEMA audit;
CREATE TABLE audit.inventory_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  actor_label text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'system', 'migration')),
  request_id uuid NOT NULL,
  action text NOT NULL,
  object_schema text NOT NULL,
  object_table text NOT NULL,
  object_id text NOT NULL,
  before_state jsonb,
  after_state jsonb
);
```

This audit shape intentionally avoids a cascading FK to `auth.users`: deleting an account should not erase historical attribution. The trusted backend supplies verified actor IDs; imported history may have a NULL UUID and an honest legacy label. Creating the table alone does not create an audit trail. Write events transactionally with their mutations, restrict UPDATE/DELETE, and define retention and who can read them. A backend with arbitrary audit INSERT permission can forge events; tighter database procedures/triggers are an option if auditing every SQL writer is required.

Preserve raw `lines` and plate `box_lines` as immutable submission evidence, including the conversion factors actually applied. A normalized count-line child table is optional if per-line time, relational validation, or reporting needs justify it; keep raw submissions even then. Current staging shapes are at `hanger_schema.sql:358–371`, `plate_schema.sql:387–400`, `ewp_schema.sql:349–361`, `lumber_schema.sql:619–633`.

### P7 — Evaluate a shared catalog before a shared ledger

**[risky / uncertain]** A stable stock-item identity can remove repeated display-name recovery and make normalized keys explicit. It also introduces a new source of truth, mapping work, and the question of whether an uncounted catalog item should appear in availability. Current hanger/plate/EWP availability is driven by ledger keys, not solely by catalog/threshold membership. Preserve that distinction until deliberately changed. [`app/server.js:262–300,4237–4251`; `hanger_schema.sql:176–180`; `ewp_schema.sql:185–189`; `020_plate_mt18hs_catalog.sql:4–16`.]

```sql
-- [risky] OPTIONAL catalog candidate for PostgreSQL 15+; not the first cutover.
CREATE SCHEMA inventory;
CREATE TABLE inventory.stock_item (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('hanger','plate','lumber','ewp')),
  match_key text NOT NULL CHECK (btrim(match_key) <> ''),
  grade_key text,
  stock_length_ft numeric,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (
    (family IN ('hanger','plate') AND grade_key IS NULL AND stock_length_ft IS NULL)
    OR (family = 'ewp' AND grade_key IS NULL AND stock_length_ft IS NOT NULL
        AND stock_length_ft > 0)
    OR (family = 'lumber' AND grade_key IS NOT NULL AND grade_key <> ''
        AND stock_length_ft IS NOT NULL AND stock_length_ft > 0)
  ),
  CHECK (stock_length_ft IS NULL OR
         stock_length_ft NOT IN ('NaN'::numeric, 'Infinity'::numeric)),
  UNIQUE NULLS NOT DISTINCT (family, match_key, grade_key, stock_length_ft),
  UNIQUE (id, family)
);

-- [risky] Example link preventing a hanger row from referencing another family.
-- Nullable item ID during mapping; original raw display and generated key stay.
ALTER TABLE hangers_dev.hanger_commitment
  ADD COLUMN stock_item_id bigint,
  ADD COLUMN stock_item_family text GENERATED ALWAYS AS ('hanger'::text) STORED,
  ADD CONSTRAINT hanger_stock_item_fk
    FOREIGN KEY (stock_item_id, stock_item_family)
    REFERENCES inventory.stock_item (id, family);
```

Here `match_key` means canonical SKU for hangers/plates, canonical item for EWP, and normalized nominal size for lumber. Map using the **final** canonical rules, audit collisions, and require unambiguous mappings before making links mandatory. Do not make a changing alias table into an `IMMUTABLE` generated-column function. Use explicit alias resolution during ingest with retained raw input, or keep deterministic, version-controlled family canon functions.

An EWP stock bucket is not a physical board instance. A later board/cut normalization would need a plan revision/run, a board row, and cut rows referencing it; it must settle whether board numbers identify physical stock or only a plan-local board. Adding revision to the current distinct-board count without investigating that meaning could double-consume history. [`ewp_schema.sql:69,79–101,201`; `app/server.js:4540–4555`.]

## 5. Consolidation options and tradeoffs

| Option | Benefit | Cost and boundary | Assessment |
|---|---|---|---|
| Retain ledgers, share tested query construction / presentation | Fewer copied fixes; smallest data migration | Four schemas still exist; tests must parameterize real family differences | **Recommended first. Behavior-preserving** only with output parity. |
| Shared catalog plus family ledgers | Stable display and identity; clearer FKs; fewer lateral display lookups | Must map unknowns, aliases, variants and uncounted stock; new catalog administration | **Candidate, risky**, P7. |
| Shared counts/receipts/submissions with family-specific commitments | Some workflow duplication removed | Requires typed key/unit validation, provenance migration, receipt sourcing and per-family approval behavior | **Candidate, risky**; prove value after identity work. |
| One universal commitment ledger / one stock arithmetic view | Centralized arithmetic and event processing | Quantity rows versus cuts, board deduplication, consume stage, source states, revision semantics, and policy branching remain | **Not justified for first cutover. Risky**, not rejected forever. |

Evidence for the differences is in §2, with cross-layer display duplication at `app/server.js:262–300,2454–2475,4237–4251` and `ewp_009_lvl_forecast_split.sql:124–150`. Lumber instead projects its catalog's key fields (`app/server.js:3172–3188`). A shared view can project a common reporting shape while retaining family-specific calculations underneath. It should expose grain/units explicitly so a “quantity” total cannot accidentally sum EWP linear feet and plate eaches.

Adding `superseded_at IS NULL` to the three demand CTEs currently relying on status can be behavior-preserving **only after** proving the existing invariant that superseded rows are cancelled. If violating rows exist, their treatment is a correctness decision. Preserve current shipped/built history rather than blindly applying “live only” to every historical consumption query. [`reference/STATUS.md:131`; `hanger_schema.sql:236`; `plate_schema.sql:233`; `ewp_schema.sql:225`; `lumber_schema.sql:487`.]

**Consolidating views does not fix F11.** Keep its timestamp work and behavioral tests separate from consolidation, so changed numbers have an explainable cause.

## 6. Unused, dormant, and incomplete structures

I searched both `app/server.js` and all `app/src/`, then checked SQL-side dependencies. Exact name-search commands are in §10. Absence of an app reference does not establish that a production table is empty or that no administrator/reporting integration uses it.

| Object | Verified supplied-code evidence | Recommendation |
|---|---|---|
| `ewp_receipt.is_remnant`, `source_board_key` | No app-name hits; schema explicitly describes generation/voiding as future ship/unship logic (`ewp_schema.sql:298–331`); F26 remains open (`STATUS.md:117`). | **Keep both fields and index.** Storage exists; the feature is incomplete. |
| Lumber remnant fields, `lumber_cut_map`, `lumber_config` / `drop_threshold_ft` | Only `lumber_cut_map` hit is the comment at `server.js:1236`; no app use of the remnant columns or lumber config; schema calls them dormant (`lumber_schema.sql:183–187,291–299`). | **Open N6 decision.** Keep if remnant reuse is planned; archive and retire only after confirming no data/external consumers and accepting the lost scaffolding. The cut-map table is superseded by the app algorithm; retaining it risks misleading maintainers. |
| `lumber_pack_ref`, `pieces_per_pack` | No app hits, no supplied seed INSERT, no SQL view/function reader; definition `lumber_schema.sql:306–314`. | Best whole-table retirement **candidate**, still **risky** until production rows and external usage are checked. |
| Four EWP generated `*_canon` columns | No active named app reads; `item_canon` has a comment-only hit at `server.js:5112`. Current SQL uses normalized keys or raw display. | Possible behavior-preserving removal after dependency/export inspection. At this size, save this for a later cleanup; raw display must remain. |
| `ewp_config.txt_value` | No app hits; app explicitly selects `num_value` (`server.js:4258`). | Keep pending a config-scope decision; avoid changing config shapes solely for visual uniformity. |
| `lumber_catalog.sku_code`, `description` | No `sku_code` app hits; catalog queries use key triples (`server.js:3158,3185,3330,3349`). | Retain useful catalog metadata unless the owner confirms it has no administrative value; “not selected by app” is insufficient reason to discard it. |
| `job_sync_import.window_start/window_end` | No app hits; import writes three other columns (`server.js:5765`); schema says v1 window is unknown (`011_job_sync.sql:39`). | Keep dormant source metadata with Job Sync until that feature is explicitly retired. |
| `ewp_commitment.optimize_run_id` / run index | Written at `server.js:4551,4657`, no named query filter; index at `ewp_schema.sql:101`. | Keep provenance column. Index retirement is a measurement candidate if no external run lookup uses it. |
| `lumber_stock_count.counted_by` | Inserted at `server.js:3453`. | Keep attribution; write-only audit information can still be valuable. |
| Job Sync tables/view | Real routes read/write them; `server.js:155–156,5538–6010` supplies the flag and implementation. | Dark/feature-gated, **not dead**. No deletion recommendation. |
| `public.schema_migrations` | Deliberately read by people, described at `012_schema_migrations.sql:4–8`. | Keep legacy history; use one explicit deployment authority for the rebuild. |
| Special-order series and LF threshold | Indirect reads via functions/views (`ewp_schema.sql:272–289`; `ewp_009...:258`), app calls at `server.js:4282,3902`. | Live dependencies; retain. |

**[risky / uncertain] Illustrative retirement DDL:** deliberately limited to the strongest candidate and not recommended for immediate execution.

```sql
-- [risky] OPTIONAL, after export, live dependency checks, and retirement decision.
-- No CASCADE: unexpected dependencies should stop the operation.
DROP TABLE lumber_dev.lumber_pack_ref;
```

There is deliberately no DDL dropping EWP remnants or the N6 lumber structures. Finishing F26 requires idempotent creation of the retained offcut exactly once per actual board consumption, correct item/span and arrival time, and reversal handling. If an offcut was already consumed or counted, blindly cancelling its receipt is insufficient. Existing `source_board_key = job|piece` also needs a decision about reused piece numbers across runs before adding a uniqueness constraint. [`ewp_schema.sql:325–331`; `app/server.js:4536–4555`; `reference/STATUS.md:117`.]

## 7. Supabase and Vercel boundary

### Pooling and transactional correctness

The current source can create **six pools**, with maxima 5 read + 3 write for each of three connection groups: 24 possible app-side connections per process when all are enabled. This is configured capacity, not observed usage. Fully qualified names allow collapsing these to one small pool per actual credential/privilege boundary rather than per family. [`app/server.js:217–257`.]

Do not rely on a startup `options=-c search_path=...` surviving or being honored by a transaction pooler. A missing object often produces an error; an identically named object on a different path can instead resolve incorrectly. Normal views bind underlying relations at creation, so the immediate runtime hazards are unqualified app SQL and runtime resolution inside functions—not every view dependency being reselected on every request. [E3; [PostgreSQL CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html), [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html).]

Current Supabase documentation recommends a transaction endpoint for serverless and identifies shared Supavisor versus dedicated PgBouncer endpoints. Verify the project's actual endpoint; “Supabase pooler” does not uniquely identify PgBouncer. Supabase's shared transaction mode does not support prepared statements. PgBouncer itself can support protocol-level prepared statements with suitable configuration, so that limitation should not be generalized to every PgBouncer installation. Keep parameterized queries; disable driver features that rely on persistent named prepared statements for the selected endpoint. [Sources checked 20 September 2026: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [PgBouncer features](https://www.pgbouncer.org/features.html).]

Use one checked-out client for `BEGIN`, all queries, `COMMIT`/`ROLLBACK`, and `release()` in `finally`. `SET LOCAL` can scope unavoidable settings to that transaction; a session-level connection hook cannot replace this. Preserve transaction-level advisory locks, which the app already uses, and avoid session-scoped locks across requests. Apply the same lock ordering to all operations affecting a board or count, rather than assuming a lock taken by the optimizer also protects unrelated writers. [`app/server.js:1468,1844–1857,4502,5325–5357`; [PgBouncer features](https://www.pgbouncer.org/features.html).]

Use global/module-level pools and Vercel's supported lifecycle handling (`attachDatabasePool` for the applicable runtime). Pool sizing needs measurement: Supabase's connection guide suggests starting at one, while Vercel Fluid compute cautions against a hard maximum of one because invocations share an instance. I recommend testing a small explicit bound against query wait time, concurrent requests, and the project connection budget instead of treating the older platform document's “1 or 2” as universal. [Sources: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Vercel connection pooling](https://vercel.com/kb/guide/connection-pooling-with-functions).]

For the implementation, budget connection/lock/statement timeouts below the request limit, keep optimizer CPU work outside long-held transactions where feasible, and revalidate inventory/version state atomically at commit. Preserve request idempotency across retries, including a retry after a successful commit whose response was lost. The existing row keys prevent some duplicates; a repeated import can still become a new revision, so request-level idempotency is a separate requirement. [`app/server.js:4536–4561`; `reference/STATUS.md:116` records preview/commit mismatch F25.]

Use encrypted, certificate-verified DB connections with credentials confined to the backend, and separate direct/session connections for migrations and restore work as appropriate to the selected endpoint. Test restore and ordinary queries with a deliberately restricted path. [Source: [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres).]

### Recommended initial access model: private database behind Vercel

**[behavior-preserving]** Retain separate read and write capabilities and no DELETE for normal application flows. Use an owner/migrator separate from runtime logins. Limit grants by table and operation; do not copy passwords or owner-level credentials from bootstrap scripts. The supplied `CHANGE_ME` values are placeholders, not deployable secrets. [`create_readonly_role.sql:9–19`; `create_write_role.sql:9–31`; `grant_*.sql`.]

```sql
-- [behavior-preserving] Private-backend access boundary, representative family.
-- Roles below are new NOLOGIN capability roles; provision login secrets separately.
CREATE ROLE inventory_reader NOLOGIN;
CREATE ROLE inventory_writer NOLOGIN;
GRANT inventory_reader TO inventory_writer;

REVOKE ALL ON SCHEMA hangers_dev FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA hangers_dev FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hangers_dev FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA hangers_dev TO inventory_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA hangers_dev TO inventory_reader;
GRANT EXECUTE ON FUNCTION hangers_dev.hanger_canon(text),
                          hangers_dev.hanger_demand_check(jsonb)
  TO inventory_reader;
GRANT USAGE ON SCHEMA public TO inventory_reader;
GRANT EXECUTE ON FUNCTION public.norm(text) TO inventory_reader;
GRANT INSERT, UPDATE ON hangers_dev.hanger_commitment,
                        hangers_dev.hanger_receipt,
                        hangers_dev.hanger_count_submission,
                        hangers_dev.hanger_threshold,
                        hangers_dev.hanger_special_order_sku
  TO inventory_writer;
GRANT INSERT ON hangers_dev.hanger_stock_count TO inventory_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA hangers_dev TO inventory_writer;
```

Apply an explicit, reviewed matrix to the other families, Job Sync, and audit, including transitive function/sequence dependencies. Keep business schemas out of Supabase's exposed Data API schemas; disable the Data API if unused. Configure default privileges for the **actual creating role**, especially function EXECUTE, rather than assuming default grants follow all future creators. Existing and future objects need separate checks. Supabase grants and RLS policies address different questions: permission to perform an operation versus which rows it may affect. [Sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL default privileges](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html); current default-privilege examples: `grant_ewp.sql:29–31`, `011_job_sync.sql:106–108`.]

The Vercel application must authenticate every shared-data request and enforce shop/office capabilities independently of `AUTH_MODE === 'tailscale'`. A database writer role is not an authenticated human. Direct `pg` connections do not automatically carry the browser's Supabase JWT into `auth.uid()`. If transaction-local actor context is used, derive it only from a token verified by the backend, never from an arbitrary request body. [E4; current client/byline behavior at `app/server.js:2335,2387,2690,4049`.]

### Alternative: browser/Data API access

**[risky]** If direct browser access is selected, design grants **and** RLS before exposure. All company inventory is shared operational data, so a generic “owner sees only their rows” rule would give incorrect inventory totals. Use trusted membership/capability policy appropriate to the one-client domain. Review/approval should be an atomic authorized operation, not permission for every authenticated user to UPDATE every field.

```sql
-- [risky] OPTIONAL fail-closed starting point for an API-exposed family.
-- With no policies this blocks ordinary RLS-subject access; it is not a usable UI.
ALTER TABLE hangers_dev.hanger_count_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE hangers_dev.hanger_stock_count ENABLE ROW LEVEL SECURITY;
ALTER VIEW hangers_dev.hanger_on_hand SET (security_invoker = true);
ALTER VIEW hangers_dev.hanger_availability SET (security_invoker = true);
```

This example assumes PostgreSQL 15+ and must extend to **every underlying table and nested view** before exposure. Policies, grants, and authorized procedures remain to be specified. Owners/BYPASSRLS roles and service-role access can bypass policies; do not run normal user operations through them and claim RLS protects those operations. A definer function needs explicit authorization, a restricted path, qualified references, and narrow EXECUTE grants. [Sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html), [CREATE FUNCTION](https://www.postgresql.org/docs/current/sql-createfunction.html).]

## 8. Migration implications and acceptance evidence

1. **Inventory the actual database before generating a migration.** Obtain a schema-only dump, server version, migration ledger, owners/grants/RLS, extensions, constraints, and dependencies. Profile normalized threshold duplicates; generated-key drift across every referencing table; negative/invalid values; missing dates/timestamps; lumber NULL retry keys; and the proposed retirement objects' rows. Do not infer live state from the historical filename ledger. [`012_schema_migrations.sql:19–24,45–77`; §1.]
2. **Build a clean target endpoint, not an unexamined replay of historical corrections.** Use final definitions and approved catalog data. Do not seed `plate_baseline.sql` into a migrated live dataset or run 016 again over copied history. Its DELETE and renaming destroy provenance that 019 cannot reconstruct. Its comment that the deleted rows were zero describes a particular historical state, not a universally true predicate. [`016...:14–20,32–51`; `019...:142–146`; `plate_baseline.sql:29–87`.]
3. **Preserve raw input, IDs, revisions, and retry keys.** Load base columns so stored generated columns are recomputed with the reviewed rules; compare old/new keys rather than assuming recomputation is harmless. Restore identity values deliberately and reseed sequences above the imported maxima. Export unknown and conflicting rows for resolution; do not silently collapse them. [E5, E10; identity and unique-key definitions in §2.]
4. **Apply qualification-only changes separately from correctness changes.** Compare outputs before/after with the same data and input parameters. Any arithmetic difference during this phase is a failure, including lost special orders, converted units, forecast rows, or negative balances. Then activate timestamp/validation changes with their deliberately different expectations. [§2–4.]
5. **Resolve historical time ambiguity and the cutover baseline.** Agree the yard timezone and observation procedure, backfill only reliable times, then reconcile physical stock. Preserve unresolved date-only history honestly. Bring ship/unship, forecast retirement, count review, remnant generation, and audit into their required transaction boundaries. [E1, E2, E7, E9.]
6. **Coordinate a write freeze and compare the final copy.** For this brief's small database, I think a scheduled short write freeze and final export/import is preferable to adding dual-write complexity. If downtime is unacceptable, design explicit catch-up/reconciliation rather than allowing two independent writers. Keep verified backup and source rollback access. After target-only writes begin, rollback needs those writes reconciled; an old dump alone loses them.
7. **Deploy with transactional error handling and restore rehearsal.** DDL, data corrections, assertions, and migration recording must share a transaction where supported. Stop on errors. Operations such as concurrent index creation require a separate deployment step. Maintain one authoritative migration runner and preserve the old ledger as provenance. A “recorded filename” is not a checksum or proof of successful atomic execution. [E10; `schema/README.md:27–38,100–118`.]

Minimum acceptance scenarios for the implementation:

| Scenario | Required evidence |
|---|---|
| Morning count / later same-day consumption, all families | Timestamp calculation deducts it once; consume-before-count is not deducted twice; exact-cutoff convention is explicit. |
| Delayed count approval | Events between observation and approval remain represented. Omitted items are not zeroed. |
| Direct built/shipped INSERT; reversal and repeat request | Valid timestamp required; unauthorized/direct post-build cancel remains blocked; retry does not move the event time or duplicate credits. |
| EWP multiple cuts on one board; mixed job categories | One board consumed, category-specific forecast suppression preserved; special-order and awaiting-delivery do not enter physical reservations prematurely. |
| Receipt arrival / reversal / interrupted request | Receipt, sourcing transitions, forecast effects where applicable, and audit commit or roll back together. |
| Threshold aliases; cleared and zero thresholds | No fan-out or scalar-subquery error; NULL and zero retain distinct meanings; EWP boundary stays `<` unless explicitly changed. |
| Partial and duplicate count submissions | Atomic approval; distinct identities preserved; duplicate handling explicit; historical raw payload retained. F6's documented `wontfix` status is not silently reopened as a proven live bug. |
| MT18HS, MT18AHS, M18SHS; box/pack/pallet receiving | Final identities remain distinct; count/receipt factors and unknown pallet values are respected. |
| F26 implementation | One qualifying offcut credit per physical consumption; no credit merely for reserving a board; reversal and already-used/count-incorporated remnants handled. |
| Two serverless instances and pooled backend switching | Fully qualified calls work with restricted/default paths; same-client transactions and locks hold; retries are idempotent. |
| Shop, office, unauthenticated, backend and direct API users | Correct capabilities and self-approval policy; no anonymous table access; privileged bypasses are understood; audit actor comes from verified identity. |
| Backup/restore into a fresh target | Dependencies, generated keys, grants, sequences, view outputs, and functions survive restoration. |

These are proposed acceptance checks, **not tests reported as passed**. This review performed source inspection, object/line recounts, dependency/name searches, and current vendor-document verification. `psql` and `postgres` were unavailable (`command -v psql; command -v postgres` returned no executable), so neither the supplied DDL nor these illustrative proposals received a PostgreSQL execution test.

## 9. Information needed before implementation

| Priority | Decision or evidence needed | Why it matters / working recommendation |
|---|---|---|
| Before F11 cutover | Yard timezone; when physical counts are observed; whether stock moves during counting; who records actual ship/build time; delayed entry and reversal policy | Timestamps fix ordering only if they describe reality. Preserve legacy dates and use a reconciled cutoff for unknown history. |
| Before F26 completion | When remnants become physically available; minimum retained length; board identity across optimizer runs; reversal after reuse | Keep the existing EWP fields. The app currently supplies the DB-configured drop threshold (`server.js:4253–4260`), so do not select 8 feet just because the standalone engine defaults to it. |
| Before N6 cleanup | Keep lumber remnant reuse on the roadmap, or retire it? | Leave fields/config/cut-map in place until decided; if retired, export any data and remove misleading interfaces deliberately. |
| Before auth/access rollout | Private Vercel-only DB or browser Data API; shop/office roles; self-approval exceptions; plate parity; audit scope and retention | Recommended first target is private DB access with verified Supabase identities at the backend. Do not inherit Tailscale-only conditions. |
| Before policy normalization | Should EWP reorder at equality? May each EWP threshold type be cleared? Why plate revision default 0? | Preserve current values/operators until answered. These do not block qualification or performance work. |
| Before migration generation | Live schema-only dump, migrations/grants/version, data-quality counts and dependency/consumer inventory | Establishes which DDL is necessary and whether proposed constraints or retirement lose data. No production credentials are needed for the review document. |
| Before purchasing/count parity sign-off | Verify the two MT18HS pack factors against actual packaging; resolve any unrecoverable historical HS/AHS assignments | Migration 020 records the factors as assumed, and 019 records prior spelling provenance loss. Do not guess a data correction. |

## 10. Reproduction commands

Run from the workspace root. These are read-only evidence commands; they do not apply any SQL.

```bash
# Establish scope and spot the four date-only comparisons.
rg --files schema-review-package
rg -n 'base_at::date' schema-review-package/schema/*_schema.sql

# Check alleged unused names against the entire supplied application surface.
rg -n 'lumber_cut_map|lumber_config|lumber_pack_ref|pieces_per_pack|is_remnant|source_board_key|source_cut_key|size_canon|item_canon|txt_value|sku_code|window_start|window_end|optimize_run_id|counted_by|lvl_drop_threshold_ft' \
  schema-review-package/app/server.js schema-review-package/app/src

# Check indirect SQL readers and definitions too; exclude historical/verification SQL.
rg -n 'lumber_pack_ref|lumber_cut_map|lumber_config|size_canon|item_canon|txt_value|sku_code|window_start|window_end|ewp_special_order_series|ewp_lvl_depth_threshold' \
  schema-review-package/schema/*.sql

# Transaction, authorization, and connection dependencies.
rg -n 'new Pool|search_path|ALLOW_SELF_APPROVAL|FOR UPDATE|advisory_xact_lock|shipped_date =|MAX\(revision\)' \
  schema-review-package/app/server.js
```

Object recount (observed output: 36 tables, 11 views, 15 functions):

```python
from pathlib import Path
import re
from collections import defaultdict, Counter

objects = defaultdict(set)
for path in sorted(Path('schema-review-package/schema').glob('*.sql')):
    schema = 'public'
    for line in path.read_text().splitlines():
        if line.lstrip().startswith('--'):
            continue
        match = re.match(r'SET search_path (?:TO|=)\s*(\w+)', line)
        if match:
            schema = match[1]
        match = re.match(
            r'CREATE (?:OR REPLACE )?(TABLE|VIEW|FUNCTION) '
            r'(?:IF NOT EXISTS )?([\w.]+)', line)
        if match:
            kind, name = match.groups()
            objects[kind].add(name if '.' in name else schema + '.' + name)
for kind, names in objects.items():
    print(kind, len(names), dict(sorted(Counter(
        name.split('.')[0] for name in names).items())))
```

Line-count method for these supplied baselines (not a general SQL parser): remove line comments and blanks; respect single-quoted strings and `$$` bodies while identifying complete statements; classify complete `INSERT` statements as seed, everything else as structural. UPDATE seed maintenance remains structural under this stated convention. Result: hanger 202/0; plate 227/76; EWP 371/25; lumber 282/83, expressed as structural/seed.

```python
from pathlib import Path
import re

for family in ('hanger', 'plate', 'ewp', 'lumber'):
    text = (Path('schema-review-package/schema') /
            (family + '_schema.sql')).read_text()
    clean = re.sub(r'--[^\n]*', '', text)
    statements, start, i, quote = [], 0, 0, None
    while i < len(clean):
        if quote:
            if quote == "'" and clean.startswith("''", i):
                i += 2
                continue
            if clean.startswith(quote, i):
                i += len(quote)
                quote = None
                continue
            i += 1
            continue
        if clean[i] == "'":
            quote = "'"
        elif clean.startswith('$$', i):
            quote = '$$'
            i += 2
            continue
        elif clean[i] == ';':
            statements.append(clean[start:i+1])
            start = i + 1
        i += 1
    statements.append(clean[start:])
    seed = structural = 0
    for statement in statements:
        lines = sum(bool(line.strip()) for line in statement.splitlines())
        if statement.lstrip().startswith('INSERT INTO'):
            seed += lines
        else:
            structural += lines
    print(family, structural, seed)
```

Repeated-object numerator audit: count nonblank/comment-stripped lines in the following definition intervals, including only the listed adjacent index/ALTER lines. This exposes the counting convention rather than suggesting all of these lines should be merged.

| Family | Commitment | Receipt | Count | On hand | Threshold | Availability | Submission | Sum |
|---|---|---|---|---|---|---|---|---:|
| Hanger | 95–116: 22 | 129–146: 18 | 155–163: 9 | 169–203: 35 | 220–225: 6 | 232–248: 17 | 358–371: 12 | 119 |
| Plate | 84–103: 20 | 133–148: 16 | 156–164: 9 | 171–205: 35 | 217–222: 6 | 229–246: 17 | 387–401: 13 | 116 |
| EWP | 56–101: 33 | 115–134: 20 | 145–155: 11 | 178–215: 38 | 164–171: 8 | 220–238: 19 | 349–361: 12 | 141 |
| Lumber | 95–135: 30 | 168–192: 22 | 204–213: 10 | 220–267: 48 | 277–283: 7 | 483–504: 21 | 619–633: 12 | 150 |

All intervals refer to `schema/<family>_schema.sql`. Counting `CHECK (` in comment-stripped versions of those four files plus `011_job_sync.sql` gives 16; reading the clauses distinguishes the fourteen enum checks from EWP's on-hand key and preset-JSON structural checks. These file counts must not be presented as measurements of the deployed database.
