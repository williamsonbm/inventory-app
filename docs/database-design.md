# Database design — steps 2–4

Decided by the owner in the schema grilling of 2026-09-27, and checked by two independent reviewers: a cold review in the grilling session, and an outside reviewer in three passes (a blind review, a check of the first review, and a check of the fixes). This file is the source for the step 2, 3 and 4 specs. Q-numbers name the grilling's questions; each decision below is complete without them. S-numbers name the situations in the list below.

**Bottom line.** One shared ledger (the list of every change in quantity) for the families in Inventory, one item catalog, and small tables around them: 22 tables for steps 2–4 (item 17 is two tables), each serving named situations below. On hand and Reorder are calculated from the records, never stored. A count is true when taken (ADR 0002): its moment is when counting starts, and any entry made within one working day of a count asks "before or after the count?" Nothing is ever deleted. EWP stays out of Inventory until step 5; LVL is in from step 3. The SQL at the end is illustrative, not for running. Each step's own spec (`/to-spec`) turns this into work.

The goal is the owner's three-part test (2026-09-27), which replaces #9's "fewest tables":
1. Every table serves at least one situation on the list below.
2. Each fact is stored in one place only.
3. Every rule the database can enforce, it enforces.

---

### Decisions

| # | Decision |
|---|---|
| Q1, Q3 | The situation list below. **Now** = build now; **Later** = step 5 adds it without changing a table built now. |
| Q4, Q26 | **An entry made after a count.** When a person enters a build, shipment, Deduct directly, receipt, return or correction, and an affected item was counted **within the last working day** (draft, waiting or approved) — since the same time on the previous working day, with weekends skipped, so on Monday at 8:00 the window reaches back to Friday at 8:00, the app asks: "Was this before or after the count at 8:00?" *Before* times the entry just before the count's moment, so on hand does not change; *after* times it now. The window is a setting (one working day, weekends skipped). Holidays are not skipped; the list shown before each count still guards them. A person never types a clock time. Un-build, Un-ship and reversals are not asked: they take the time of the entry they undo. This answers #72's "may a person enter the real time?": **no, only before or after.** |
| Q25 | **A count's moment is when counting starts**: when someone prints or opens the count sheet. Before printing, the app lists that family's jobs not yet marked built and POs with deliveries not yet received ("enter anything already done or already in the yard"). Entries made during the count are treated as after it. **At approval (Q33)**, for every count line whose item was touched by **any** entry made during the count (build, shipment, receipt, return, correction), the app lists those entries and asks, **for each one**, "Was this item counted after this entry?" — no exact match needed. *Yes* marks that entry as already reflected in the count; on hand then leaves it out (see *On hand* below). No time box on the paper sheet. |
| Q34 | When **several counts** of an item fall inside the one-working-day window, the before-or-after question lists them all: "Before the 8:00 count / between 8:00 and 10:00 / after 10:00". |
| Q5 | **One shared ledger**, not one per family. Every family's on hand is a whole count of pieces of one catalog item (eaches; lumber pieces of size + grade + length; EWP and LVL boards of item + length). Linear feet are calculated. |
| Q6 | S54 (partial shipment) needs nothing: job suffixes (44444R, 44444F, 44444J, 44444L) already let parts ship separately. |
| Q7, Q11, Q29 | **Returns** from the job site: a return entry linked to the job; the job's shipped record is not edited. Only **hangers, EWP and LVL** can be returned; the database refuses plates and lumber. Returned LVL is entered at its actual length. EWP is cut by the customer, who pays for it, so only whole, uncut EWP boards return. A return from a job not in the app is a **correction** with the reason "Returned from job site" and the job number in its note. No cap on return size (returns are rare). |
| Q8 | Damaged material is scrapped through a **correction** with the reason "Damaged – scrapped". |
| Q26 | **Weathered EWP and LVL only.** A **trim** (a weathered 16′ board cut down to a usable 12′) is one entry: −1 of the long item, +1 of the short one, reason "Weathered – trimmed", saved together. Weathered material kept for now stays in on hand with a **note on the item**. Remakes (extra plates or lumber for a truss built wrong) get no entry of their own: the next count shows them as unmatched with the reason "Remake". |
| Q9 | S57 (wrong item delivered) is closed; a kept item is a receipt without a PO (S16). |
| Q10 | Backups: Supabase's $25 plan (daily, 7 days) **plus a nightly `pg_dump` stored outside Supabase** on a company-owned cloud drive, and one practice restore before go-live. The mechanism belongs to the step 2 spec. |
| Q12 | A users table (never deleted), and an activity log written in the same save as each change; the app's database role can insert log rows but never update or delete them. |
| Q13 | **Pack sizes:** one list of known pack, box and pallet sizes per item, shown as a dropdown on receipts and counts; a new size can be added on the spot (logged). Each receipt and count line keeps its own copy of the size used. A plate item with no pallet size listed has an **unknown** pallet size, never a guessed one. |
| Q13, Q23 | Not carried over from the web app: lumber cut map, lumber pack reference, EWP duplicate `*_canon` columns, `ewp_config.txt_value`, Job Sync tables. Lumber offcuts are **not tracked for now** (later without rework). |
| Q14, Q19 | A lumber PO line names **size + grade + length** (required) and an amount in linear feet; **pack size is optional**. Receipts record what arrived. S58 (over-delivery) is closed: receiving what arrived covers it. If a PO without a length ever appears, the length becomes optional — no rework. |
| Q15 | **Reorder is flagged at or below the threshold**, for every family. This is the web app's rule for hangers, plates and lumber since 2026-06-11 (`hanger-web-app/sql/_archive/004_reorder_at_threshold.sql`); its EWP and LVL checks still use *under* (`hanger-web-app/sql/ewp_schema.sql:235`, `:784`), so for EWP and LVL this is a deliberate change. |
| — | The Overview column is named **Reorder**, not Level: Short / Low / OK. |
| — | **Stocking status labels** on screen and in the glossary: **Stocked**, **Non-Stock**, **Special Order** (capitalized). |
| Q16, Q35 | LVL thresholds stay **per depth, in linear feet**. The LVL Overview row per depth shows **Low** against that threshold, and **Short** when **any length** at that depth is short, naming it ("Short: 16′ (−6)"). LVL items carry no threshold of their own. |
| Q17, Q20 | Times are stored as exact moments (`timestamptz`) and shown in **Eastern Time with daylight saving** (`America/New_York`). "Within one working day" and "a count on July 1 closes June" are worked out in Eastern Time. |
| Q18 | **Moving the web app's data: opening balance.** Move the catalog, thresholds, pack sizes, open POs and open jobs; the office counts every family on day one, and that count is on hand. Open jobs already built get their build entries timed before the day-one count, so they can still be un-built. History before the move stays readable in the web app, plus a CSV export. |
| Q21 | An item created by a return or a trim starts **Non-Stock**; any other new item starts **Special Order**. |
| Q22 | A **suppliers** list in Settings, picked on each PO. |
| Q27 | **A revised sheet for a built job:** for plates, lumber and LVL, confirming the revision consumes whatever the new sheet needs **beyond what the job has already consumed** of each item (new quantity − consumed, when above zero), and the change screen says so. What was already consumed stays consumed even if the new sheet needs less (built history is frozen, story 38). Refusing the revision would force Un-build → Build, which deducts everything twice when a count falls in between. |
| Q28, Q26 | **EWP stays out of Inventory until step 5** (Planner only). **LVL is in Inventory from step 3**: it is a fixed-length buy, not optimized (#9), consumed at Built. |
| Q36 | **Substitutions.** When the shop runs out of a plate and uses the next size up, it is recorded as a **swap** on the job: the job's consumption moves from the planned plate to the plate actually used — +N back for the planned plate and −N for the plate used, both recorded as the job's build entries, saved together, reason "Substitution", and asked "before or after the count?" like any entry. The job's record then shows what it really consumed, so a later revised sheet (Q27) and Un-build both treat it correctly. A swap is allowed only after the job is built, and never for more than the job has consumed of the planned plate. It is entered in **Jobs → the job → its family tab → Substitute…** on the line that changed, and appears in the job's History. |
| Q30 | On hand may go **below zero** (a shipment entered before its receipt); it shows in red. |
| — | **Nothing is lost** (owner, after Q29). Nothing is ever deleted. **Approving a count** and **cancelling a job** are final, with a warning first; the way back is a correction (revision 2) or re-committing the sheet. Every other action has a reverse (table below). No Un-cancel button. |

**How each action is undone**

| Action | Undo |
|---|---|
| Commit | Cancel |
| Cancel | Final (warning). Commit the sheet again. |
| Built, Shipped, Deduct directly | Un-build, Un-ship |
| Revised sheet | Commit the earlier sheet again |
| Receipt, correction, return, trim | Reverse it; the original stays, marked reversed |
| Approve a count | Final (warning). Correct it: revision 2. |
| Reject a count | Recount |
| Close a PO line | Re-open it |
| Retire a reason, remove a user, retire an item | Un-retire, re-activate |
| Setting, threshold, stocking status, pack size | Edit again (logged) |

---

### The situation list

Sources: #72 stories, the schema review's §8, ADR 0001/0002, #9, and this grilling.

| ID | Situation | When | Served by |
|---|---|---|---|
| S1 | Count 8:00, build 11:00, approve 14:00: on hand includes the build, once | Now | ledger, counts |
| S2 | Build 7:00, count 8:00: the build is not deducted twice | Now | ledger, counts |
| S3 | Built 10:00, counted 11:00, entered 15:00: the before/after question | Now | ledger, settings |
| S4 | Recount of one item changes only that item; uncounted items are not zeroed | Now | counts |
| S5 | Counter cannot approve their own count | Now | counts |
| S6 | A rejected count never affects on hand | Now | counts |
| S7 | A draft count has no effect until approved | Now | counts |
| S8 | Same count submitted twice, or two waiting counts of one item | Now | counts, action keys |
| S9 | Each unmatched item needs a reason, unless it had nothing recorded before the count (Q118, 2026-10-08) | Now | count lines, reasons |
| S10 | A count taken July 3 is labeled "closes June" | Now | counts |
| S11 | Month-end correction adds a revision; original kept; later count still decides on hand | Now | count corrections |
| S12 | A PO shows as incoming; the buy list does not reorder it | Now | POs |
| S13 | Delivery in different pack sizes than expected, entered as delivered | Now | receipts, pack sizes |
| S14 | Partial delivery: PO Partial, rest still incoming | Now | POs, receipts |
| S15 | Undelivered line closed with a reason | Now | PO lines, reasons |
| S16 | Receive without a PO (including a kept wrong item) | Now | receipts |
| S17 | A receipt entered by mistake is reversed | Now | ledger |
| S18 | Plates counted in packs, received in pallets; unknown pallet size stays unknown | Now | pack sizes |
| S19 | MT18HS, MT18AHS, M18SHS stay three items | Now | items |
| S20 | Committing the same sheet twice deducts once | Now | job sheets |
| S21 | One failure in a batch of 50 saves none | Now | (one transaction) |
| S22 | A double click or retry acts once | Now | action keys |
| S23 | One Built click consumes plates, lumber, LVL; Shipped the rest | Now | families, ledger |
| S24 | Deduct directly | Now | jobs, ledger |
| S25 | Cancel returns only unconsumed material | Now | job lines |
| S26 | Un-build and Un-ship | Now | ledger |
| S27 | Un-ship after a later approved count leaves on hand unchanged | Now | ledger (reversal timing) |
| S28 | A sheet for an already-handled job is refused with who/when | Now | jobs |
| S29 | A revised sheet replaces unconsumed lines; built/shipped history unchanged | Now | job sheets, job lines |
| S30 | A changed sheet for a shipped job is refused | Now | jobs |
| S31 | Delivery date edited; a revised sheet with another date asks which to keep | Now | jobs |
| S32 | Lumber cut plan saved at commit | Now | lumber cut plan |
| S33 | EWP lines on a committed job marked "waiting for optimizer" | Now | job lines |
| S34 | A Planner run changes no row | Now | (reads only) |
| S35 | Planner lists "Already handled" jobs with who/when | Now | jobs, activity log |
| S36 | Planner shows when each item was last counted | Now | counts |
| S37 | Lumber purchasable lengths and grade redirects shared and logged | Now | lumber settings |
| S38 | A new item starts Special Order with no threshold (Non-Stock if from a return or trim) | Now | items |
| S39 | A blank threshold and a threshold of 0 differ | Now | items |
| S40 | Impossible values refused (pack size 0, negative threshold, bad date) | Now | constraints |
| S41 | Two people edit the same thing: the second save is refused | Now | version columns |
| S42 | A used reason can be retired, not deleted | Now | reasons |
| S43 | Only a person changes stocking status | Now | items |
| S44 | Only listed addresses sign in; a removed person's history stays | Now | users |
| S45 | The activity log answers who did what and when | Now | activity log |
| S46 | A correction to on hand needs a reason | Now | ledger, reasons |
| S47 | Three cuts from one board consume one board | Later | EWP cut plan |
| S48 | LVL available now vs available after forecast | Later | EWP demand |
| S49 | An offcut is credited once per board actually used (F26) | Later | ledger link |
| S50 | A board awaiting delivery is not on hand yet | Later | PO line state |
| S51 | A backup restores into an empty database | Now | operations |
| S52 | Two server copies at once give correct numbers | Now | #28 rules, locks |
| S53 | The web app's data moves over (opening balance) | Now | migration |
| S54 | Partial shipment — closed, covered by job suffixes | — | — |
| S55 | Material returned from the job site (hangers, EWP, LVL only) | Now (EWP later) | ledger, families |
| S56 | Damaged material scrapped | Now | ledger (correction), reasons |
| S57 | Wrong item delivered — closed, covered by S16 | — | — |
| S58 | More delivered than ordered — closed, covered by S13/S14 | — | — |
| S59 | Extra material used for a remake — closed, the next count catches it ("Remake") | — | — |
| S60 | A weathered board trimmed to a shorter usable length | Now for LVL, Later for EWP | ledger, items |
| S61 | Weathered material kept, with a note | Now for LVL, Later for EWP | items |
| S62 | Nothing is lost: approving a count and cancelling warn first; everything else has a reverse | Now | all (no DELETE) |
| S63 | A build during a count, for an item counted after the build (Q25) | Now | counts, ledger |
| S64 | A cancelled job's sheet is committed again | Now | job sheets |
| S65 | A sheet reverted to an earlier revision's content is accepted | Now | job sheets |
| S66 | A revised sheet adds plate lines to a built job (Q27) | Now | job lines, ledger |
| S67 | A shipment takes on hand below zero; shown in red | Now | (calculation) |
| S68 | A return from a job shipped before the move | Now | ledger (correction) |
| S69 | A Special Order item received in excess shows its extras (Q32) | Now | items (calculation) |
| S70 | A receipt (or any entry) made during a count, for an item counted after it (Q33) | Now | counts, ledger |
| S71 | Two counts of one item within one working day; the later one is rejected (Q34) | Now | ledger, counts |
| S72 | LVL: enough linear feet at a depth, but short at one length (Q35) | Now | (calculation) |
| S73 | The shop substitutes the next plate size up (Q36) | Now | ledger (swap) |
| S74 | One item counted or received in two pack sizes (a box of 100 and a band of 20) | Now | count lines, ledger |
| S75 | An approved count's line is edited directly — refused; only a correction changes it | Now | counts (lock) |

---

### The tables

Schema name is chosen at slice time (never a `*_dev` name). Every object is fully qualified (#28).

**Step 2 — logins and connection**

1. **users** — sign-in identity (Supabase auth user id, unique), email (unique), name, active. Never deleted. *S44, S5.*
2. **activity_log** — one row per user action: who, when, action, what it touched, was → now, and the action's **retry key** (unique), so a double click or retry of *any* action acts once. Written in the same transaction as the change. Insert-only for the app role. *S22, S35, S37, S45.*

**Step 3 — inventory**

3. **families** — five fixed rows: consumed at *built* or *shipped*; can be returned; in Inventory yet (EWP: no, until step 5); the unit an amount is ordered in. *S23, S55, Q28.*
4. **items** — the catalog: family, identity (SKU; or size + grade + length; or item + length) unique per family, stocking status, threshold (blank, or ≥ 0; always blank for LVL), a free-text note, active, version. *S19, S38, S39, S43, S41, S61.*
5. **pack_sizes** — item, kind (pack, box or pallet), pieces (> 0), version. Unique per item + kind + pieces. *S13, S18.*
6. **lvl_depth_thresholds** — depth, threshold in LF (≥ 0), version. *Q16.*
7. **suppliers** — name (unique), version. *Q22.*
8. **purchase_orders** — number, supplier, date, version. Who entered it comes from the activity log. *S12, S14.*
9. **po_lines** — item, amount ordered (lumber in LF; everything else in eaches), optional pack size, closed + reason (required when closed), re-openable, version. *S12, S14, S15.*
10. **receipts** — optional PO, supplier, Bill of Lading or tracking number. Who received it comes from the activity log. Its lines are ledger rows. *S13, S14, S16.*
11. **ledger** — one row per change in quantity. Item and its family (tied to the item's family, so family rules can be checked); signed whole-number quantity (never 0; above 0 for receipts and returns); kind (receipt, build, ship, return, correction, reversal); **effective_at**; the action it belongs to (who entered it and when come from the activity log, not repeated here); reason (required for corrections); links to the receipt and PO line, the job and item, or the row it reverses; for receipt lines, packs × pack size + loose, which must add up to the quantity. One item may have several receipt lines, one per pack size. A trim or a swap is two correction rows in one action. *S1–S3, S16, S17, S23, S26, S27, S46, S55, S56, S60.*
12. **counts** — family, kind (monthly or spot check), status (draft, waiting, approved, rejected), month label (at most one approved monthly count per family per month), **counted_at** (when counting started), **submitted_at**, **approved_at**, counted by, approved by (≠ counted by). Times must be in order. Once approved, the count and its lines cannot be edited. *S1–S8, S10, S63, S75.*
13. **count_lines** — item, packs × pack size + loose = counted quantity (0 allowed: an empty rack), reason when unmatched, and the entries during the count confirmed as already reflected (Q33). One item may have several lines, one per pack size; they add up. The app's expected number is **calculated at approval** and then **kept**, as the record of what the approver saw; an entry marked "before" later does not change it. *S4, S9, S63, S74, story 79.*
14. **count_corrections** — a corrected quantity for an item on an approved count: revision number (one per correction of the count, shared by every item it changes: "June 2026, revision 2"), item (may be an item not on the original count), new quantity, why, and the action it belongs to (who and when come from the activity log). *Was* is the previous revision's figure. *S11.*
15. **reasons** — text, retired flag, version. Never deleted once used. *S9, S15, S42, S46, S56.*
16. **settings** — single values (the one-working-day window), with version. *Q4, S41.*
17. **lumber_purchasable_lengths** and **lumber_grade_redirects** — the Planner's buying options, shared and logged. *S37.*

**Step 4 — jobs**

18. **jobs** — full number with suffix (unique), name, status (committed, built, shipped, cancelled), delivery date and override flag, version. Includes, from the move, jobs that are open. *S24, S25, S28, S30, S31.*
19. **job_sheets** — job, revision number, content fingerprint, the action it belongs to (who and when come from the activity log). A revision and its lines cannot be edited once saved. A sheet identical to the **current** revision of an open job is a no-op; the same content after a cancel, or a return to an earlier revision's content, is a new revision. *S20, S29, S30, S64, S65.*
20. **job_lines** — sheet revision, item, quantity, EWP "waiting for optimizer". What is consumed is **not stored here**: it is read from the ledger's build and ship rows for the job and item, so it carries over to every later revision and to a re-commit after a cancel. *S25, S29, S33, S66.*
21. **lumber_cut_plans** — the cut plan saved at commit, per sheet revision. *S32.*

**Step 5 — later without rework**
EWP in Inventory (the families flag), EWP cut plan with board grouping (S47), EWP demand for the LVL forecast (S48), an offcut's source-board link on the ledger (S49), awaiting-delivery state on PO lines (S50), EWP trims and notes (S60, S61), EWP board sizes per series and depth (story 90). Each is a new table, a new nullable column or a flag change; none changes a table above.

---

### How the numbers are calculated (never stored)

- **On hand** of an item = its figure on the latest approved count that includes it (by `counted_at`; the latest correction revision if there is one) + every ledger row for that item with `effective_at` after that `counted_at`, **except** the entries that count's approval marked as already reflected in that item's line (Q33). With no approved count, the sum of all its ledger rows. Uncounted items keep their previous baseline (S4). May be below zero (S67).
- **Committed**, for each open job and item = the **current** sheet revision's quantity − what the job has consumed of that item (its build and ship rows, including swaps, net of their reversals), never below zero. Only families the job has not yet reached count: a built job commits nothing for plates, lumber and LVL. **Available** = on hand − committed.
- **Consumption when EWP is not in Inventory:** shipping a job skips its EWP lines (no ledger rows) instead of refusing the job.
- **Incoming** = for each open PO line, ordered − received, **never below zero**; for lumber, ordered LF − (pieces received × length); a reversed receipt stays linked to its PO line, so reversing it restores incoming.
- **Reorder**: *Short* when available < 0; *Low* when 0 ≤ available ≤ threshold; otherwise *OK*. LVL: *Low* compares linear feet per depth; *Short* is checked per length (Q35). Incoming is shown beside Reorder, not netted into it. The Planner's buy list does subtract incoming (story 62) — a Planner calculation for the step 3 spec, not a table.
- **Linear feet** = pieces × length.
- **A reversal** (un-build, un-ship, reversed receipt) carries the **effective_at of the row it reverses**, the same item and the opposite quantity. So an un-ship after a later count is hidden by that count, and on hand does not change (S27); without a later count, the two rows cancel out.

### Rules the database enforces

- Quantities are whole numbers. A ledger entry is never 0, and receipts and returns are above 0; a count line may be 0. Pack sizes > 0; thresholds ≥ 0 or blank; LVL items have no threshold.
- Receipt lines: packs and pack size are both filled or both blank, and whenever packs or loose is filled, packs × pack size + loose = quantity.
- A receipt line's item matches its PO line's item.
- A correction has a reason; a closed PO line has a reason.
- A count's approver is not its counter; an approved count has all three times, in order; an approved count and its lines cannot be edited; at most one approved monthly count per family per month.
- Status changes follow the allowed paths (a shipped job returns to built only through Un-ship). Only active users can act.
- A return is refused for a family that cannot be returned (plates, lumber), and entries are refused for a family not yet in Inventory (EWP).
- A reversal mirrors the row it reverses (same item, opposite quantity, same effective time), and a row can be reversed once.
- Catalog identity is unique per family.
- An item is on at most one waiting count at a time (S8) — a trigger under a lock, since it spans two tables.
- A retry key is used once per action (S22).
- Every change is written by a database function that also writes its activity-log row in the same save; the app's database login can run those functions but cannot write to the tables directly. This makes the log complete and stops an existing action's retry key from being reused.
- Ledger links match the kind: a receipt line has a receipt, a build or ship row has a job, a return has a job. A trim or swap is complete — both rows, in one action — or refused. Un-build, Un-ship and swaps never give back more than the job consumed.
- An unmatched counted item has a reason before its count can be approved, unless the item had nothing recorded before the count: no approved count and no ledger entry (Q118).
- Status values are fixed lists; nothing is deleted: the app's database login has no DELETE or TRUNCATE (emptying a table) and does not own the tables. It cannot update ledger or activity-log rows.
- The Planner uses a separate **read-only** database login, so ADR 0001 (the Planner writes nothing) is enforced by the database.
- Every editable table has a version; each save states the version it read and is refused if the row has changed since (S41).

Three copies are deliberate, and the database keeps each one equal to its source: the family on a ledger row (so family rules can be checked; tied to the item by a foreign key), a receipt or count line's packs × pack size + loose next to its quantity (the observation as entered; checked to add up), and a count's own three times (ADR 0002 requires them).

Rules that need a second table (family checks, reversal mirroring, one waiting count per item) are enforced with a trigger or a composite foreign key, not a plain CHECK.

### Settled at the end of the grilling

- **Q31 — S8:** an item can be on at most one waiting count at a time; a second is refused with who holds it ("MT18HS is on Sam's count from July 1, waiting for approval"). A draft blocks nothing.
- **Q32 — Special Order with extras:** a Special Order item with **available above zero** shows "Special Order · N extra" and a "Change to Non-Stock" link in its Stocking cell — a note in the row, not a pop-up. It disappears when the extras are used. On hand above zero alone is normal (material waiting for its job) and shows nothing.

### Edits made with this design

- **#72** and **#2's entry for #9:** replace "fewest tables" with the three-part test; mark "Left to the database slice" answered here.
- **CONTEXT.md** and **#72 story 50 / Further Notes:** rename *Level* to *Reorder*; *Low* is **at or below** the threshold.
- **CONTEXT.md, Special Order:** "An item bought only for specific jobs. Any on hand is waiting for those jobs; anything more is extra, and the item may be changed to Non-Stock." Its _Not_ line becomes "nothing here is bought to keep" (was "on hand is zero here").
- **CONTEXT.md and #72 stories 53, 61:** the three statuses are written **Stocked**, **Non-Stock**, **Special Order**.
- **#72:** EWP stays out of Inventory until step 5 (story 3's family filter shows EWP only in the Planner until then).

<details><summary>Illustrative SQL — the ledger and counts (not for running)</summary>

```sql
CREATE TABLE inv.ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       bigint NOT NULL,
  family        text   NOT NULL,
  quantity      integer NOT NULL CHECK (quantity <> 0),
  kind          text NOT NULL CHECK (kind IN ('receipt','build','ship','return','correction','reversal')),
  effective_at  timestamptz NOT NULL,
  action_id     bigint NOT NULL REFERENCES inv.activity_log(id),
  reason_id     bigint REFERENCES inv.reasons(id),
  receipt_id    bigint REFERENCES inv.receipts(id),
  po_line_id    bigint REFERENCES inv.po_lines(id),
  job_id        bigint REFERENCES inv.jobs(id),
  reverses_id   bigint UNIQUE REFERENCES inv.ledger(id),
  packs         integer CHECK (packs >= 0),
  pack_size     integer CHECK (pack_size > 0),
  loose         integer CHECK (loose >= 0),
  FOREIGN KEY (item_id, family) REFERENCES inv.items (id, family),  -- needs UNIQUE (id, family) on items
  CHECK ((packs IS NULL) = (pack_size IS NULL)),
  CHECK ((packs IS NULL AND loose IS NULL) OR quantity = COALESCE(packs * pack_size, 0) + COALESCE(loose, 0)),
  CHECK (kind NOT IN ('receipt','return') OR quantity > 0),
  CHECK (kind <> 'correction' OR reason_id IS NOT NULL),
  CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
);
-- Triggers: reversal mirrors its row; returns only for returnable families;
-- no entries for families not yet in Inventory.

CREATE TABLE inv.counts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family        text NOT NULL REFERENCES inv.families(code),
  status        text NOT NULL CHECK (status IN ('draft','waiting','approved','rejected')),
  closes_month  date CHECK (closes_month = date_trunc('month', closes_month)),
  counted_at    timestamptz NOT NULL,
  submitted_at  timestamptz,
  approved_at   timestamptz,
  counted_by    bigint NOT NULL REFERENCES inv.users(id),
  approved_by   bigint REFERENCES inv.users(id),
  CHECK (approved_by IS NULL OR approved_by <> counted_by),
  CHECK (status <> 'approved' OR (submitted_at IS NOT NULL AND approved_at IS NOT NULL AND approved_by IS NOT NULL))
);
```
</details>
