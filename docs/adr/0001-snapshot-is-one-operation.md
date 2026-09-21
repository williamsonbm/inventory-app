# ADR 0001 — The snapshot is one operation, writes nothing, and produces a file

- **Status:** Accepted — 2026-09-06
- **Date:** 2026-09-06
- **Deciders:** repo owner
- **Resolves:** #4
- **Related:** `hanger-web-app` ADR 0004 and ADR 0005 (substance carried forward), issues #3, #9, #13

> This is **this repo's** ADR 0001. The web app has its own ADR 0001 about Job Sync. They are
> different documents.

## Context

Three separate descriptions of the same thing existed before this ticket.

- Issue #3 settled an **open-orders look-ahead**: a rolling two-to-four week window, re-read in
  full each time, writing nothing.
- Web app **ADR 0004** designed a **snapshot**: drop in material sheets for jobs two to three
  weeks out, read what to buy, discard. Store nothing.
- The **materials planner** is that design, built and in use. Web app ADR 0005 moved it out of the
  web app and into a standalone tool, keeping ADR 0004's substance unchanged.

Same input, same output, same window, same refusal to write. The only real difference is who picks
the jobs. Carrying three names for one computation into the merged app would repeat the mistake
that made the word *stock* unusable in this project.

Merging also puts this computation back beside the live ledger, which is exactly where ADR 0004
judged it too dangerous to sit. That judgement still holds, so the protection has to be explicit
rather than a side effect of living in a separate program.

## Decision

**One operation, named *snapshot*.** The open-orders look-ahead is the same operation with the job
list chosen for you rather than dropped by hand.

1. **It writes nothing to the database.** No projection tables, no flags on existing rows, and no
   receipt rows either.
2. **Its output is a buy list on screen and a purchase report as a file** — XLSX to work with, PDF
   to print and keep. The report shows summary rows, with a user toggle to add the contributing
   jobs and their per-job quantities.
3. **The baseline is `available`** (on hand minus committed), unchanged from ADR 0004.
4. **Already-optimized jobs are excluded**, unless their material content has changed, and are
   listed in a section of their own rather than dropped without explanation. Material content means
   quantities, lengths, and which lines exist. A wording change is not a revision.
5. **For i-joists the length search stays, and a non-stock flag is added.** The search chooses
   which stock lengths to buy for a single job, or for a small batch of same-series, same-depth
   jobs. The search keys on series and depth. Arbitrary or mixed-series batching is not required,
   and the batch stays small enough for the hosting limit. The flag marks items that are not
   restocked, also keyed by series and depth. LVL and rim board are fixed-length buys, not
   searched. These are different questions for different people and neither replaces the other.

   > **Superseded 2026-09-21 by #9 ("For each material family, which implementation wins?").**
   > This item first read: "For EWP the length search stays. The search answers which stock
   > lengths to buy across a batch of jobs." The owner confirmed that planning is one job at a
   > time, with an occasional small same-series batch, so the multi-job sweep is retired. Two
   > facts from the grilling narrow the search: i-joists carry many series that share depths
   > (PJI-40, PJI-65, PJI-80, TJI and more), so the search and the flag key on series and depth;
   > and LVL is a single series, so it is not searched. The optimizer's integration is deferred
   > to its own later spec. This record sets the policy only. It does not schedule that build.

## Alternatives considered

**1. Two front doors — a planning mode and a committing mode.** The handoff's plan, and reasonable
when written. Made obsolete by #3: once the stored forecast is gone, there is no committing mode
left for hangers, plates or lumber to be a door to. Keeping two doors would mean labelling one of
them for a thing the app no longer does.

**2. Write `awaiting-delivery` receipt rows from the buy list.** Considered seriously. It would stop
the next snapshot recommending material already on order, which ADR 0005 called the error a
purchasing tool most has to avoid. **Rejected: no database writes at all.** The gap is covered
because receipts are entered by a person today, and a snapshot reads them live, so an entered PO is
already visible to the next run. The cost is that a PO nobody has entered stays invisible.

**3. Compare against on hand rather than available.** Rejected, and the reason is easy to miss.
After #3, hangers, plates and lumber have nothing in their committed column, so their `available`
and `on hand` show the same number. The two rules look interchangeable today. They stop being
interchangeable the moment commitments return, which the owner expects, and the failure is silent:
the app would tell you to buy material already promised to a job.

**4. Decide stocking status from the yard.** Rejected. If the label is derived from the count, an
item changes between *non-stock* and *special order* on its own as leftovers are used and replaced,
with nobody deciding anything and the report reading differently each week. Stocking status is a
setting a person maintains. See `CONTEXT.md`.

## Consequences

- **The purchase report is a record of one moment, not a live document.** Two runs cannot be
  compared inside the app; they are two files.
- **`available` equals `on hand` for hangers, plates and lumber** until commitments return. This is
  arithmetic, not a definition. Code must keep the subtraction even while it subtracts zero.
- **A PO that has not been entered in Receipts is invisible to the snapshot.** Accepted, and the
  direct result of rejecting alternative 2.
- **Count age has to be shown.** A live number is not a true number: `CONTEXT.md` in the web app
  records that on hand is factually true only at a count and drifts downward between counts,
  because shop and counter consumption is never recorded. The snapshot carries `counted_at` per SKU
  into its output rather than one date for the whole run.
- **The web app's ADR 0004 and ADR 0005 cannot be marked superseded from here**, because sibling
  repos are read-only in this repo. Their substance is carried forward above. Updating those files
  is the owner's call.

## What this does not decide

- **Whether stocking rules live per product or per depth.** Settled in discussion as per product,
  with depth as a default that a product rule overrides — recorded here only as context. It belongs
  to issue #9, which is explicitly about which implementation wins per family.
- **The definitions of *non-stock* and *special order*.** Vocabulary, so they live in `CONTEXT.md`.
- **Who runs a snapshot, and how often.** Weekly or as needed; not a decision this ADR fixes.

## Verification

Not yet built. On build, a snapshot run over real sheets must leave every commitment, receipt and
count table with an **unchanged row count**. That assertion is the whole safety argument and
belongs in the test suite, exactly as ADR 0004 required of its own version.
