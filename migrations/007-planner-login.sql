-- Step 3, part 4, PR A (#81): the Planner reads the database (stories 89–94).
-- The Planner's own login, inv_planner (migration 001), gets SELECT on
-- exactly what a Planner run reads and EXECUTE on the calculation's
-- functions, and nothing more (#81, "The Planner login"). It can change no
-- row: it runs no function that writes, and it holds no INSERT, UPDATE,
-- DELETE or TRUNCATE (test/database.test.js, S62). So a Planner run cannot
-- change inventory, and the database enforces it (ADR 0001, story 94).
-- Migration 001's default grants cover inv_app and inv_backup only, so each
-- grant here is explicit, and a table a later migration adds stays closed
-- to the Planner until it is named here or in a later migration.

-- Which families are live in Inventory, the catalog, and the plate pack
-- sizes the plate engine prices a shortfall with (#81 change item 3).
GRANT SELECT ON inv.families, inv.items, inv.pack_sizes TO inv_planner;

-- The lumber buying options a lumber plan runs with (S37).
GRANT SELECT ON inv.lumber_purchasable_lengths, inv.lumber_grade_redirects TO inv_planner;

-- The one calculation: on hand, Incoming and last counted. The view reads
-- items, PO lines and the LVL depth thresholds as its owner, but the
-- functions it calls run as the login that reads the view, so the Planner
-- needs EXECUTE on them and SELECT on every table they read: the ledger,
-- the counts with their lines, corrections and reflected entries, and the
-- PO lines with their items and families (inv.received).
GRANT SELECT ON inv.item_figures, inv.lvl_depth_thresholds, inv.po_lines, inv.ledger,
  inv.counts, inv.count_lines, inv.count_corrections, inv.count_reflected TO inv_planner;
GRANT EXECUTE ON FUNCTION inv.received(bigint), inv.on_hand_at(bigint, timestamptz),
  inv.base_count(bigint, timestamptz), inv.count_found(bigint, bigint, integer) TO inv_planner;
