-- #199: a board a committed job's LVL plan cuts from the remainder of
-- another board of the same plan is not committed on its own. Source:
-- owner #199 Q85, Q86 (rule a). Every name is fully qualified (#28).
--
-- Reach: the new function inv.job_commits; 011's inv.job_committed and
-- 025's inv.lvl_available redefined to read it, so committed, available
-- and the reorder flag (inv.item_figures) change for such a board, and
-- for no other; so do the jobs behind an item, the Cancel confirmation and
-- the jobs a count lists (src/inventory/item-jobs.js, src/jobs/jobs.js).
-- inv_app may run inv.same_item, which inv.job_commits calls when the app
-- reads it: it compares two items and reads nothing. No row is written or changes meaning; Built, Shipped,
-- Un-build and the saved plans are as before.
-- Recovery: rerun 011's inv.job_committed and 025's inv.lvl_available
-- (as CREATE OR REPLACE), then drop inv.job_commits and revoke inv_app's
-- EXECUTE on inv.same_item.

-- What job p_job commits of each item: what Shipped would consume
-- (inv.job_to_consume), less the boards of its saved LVL plan cut from the
-- remainder of a board before them, never below 0. Only a board before it
-- can leave the remainder a board is cut from: a plan opens a board only
-- for a piece no board before it still fits. Each remainder covers one board,
-- at the length inv.lvl_plan_today keeps it at, so it matches what Built
-- puts back. After Un-build, a revised job's 28′ cut from its own 48′
-- remainder is consumed and put back at the next Built, 0 in all, so it
-- is committed 0. A remainder that today's shortest remainder kept makes
-- scrap covers no board, as Built then consumes the board from on hand.
-- Deliberately in plan order, not the count of remainders per item: with
-- the count, a board pulled from on hand before a board whose remainder is
-- its length (26′ from a 28′, then 20′ from a 48′) reads not committed,
-- and another job can plan the board this job's pull list says to pull.
-- How: per item, in plan order, each board and then its remainder; at each
-- board, the item's boards so far less its remainders before. The largest
-- of these is the boards no remainder is left for; the rest are covered.
CREATE FUNCTION inv.job_commits(p_job inv.jobs)
RETURNS TABLE (item_id bigint, quantity integer, live boolean)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH board AS (
    SELECT x.n, i.id AS item_id, k.id AS kept_id
      FROM inv.lvl_cut_plans p
     CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(inv.lvl_plan_today(p.plan, p_job)) WITH ORDINALITY AS x(b, n)
      JOIN inv.items i ON i.id = (x.b ->> 'item_id')::bigint
      LEFT JOIN inv.items k ON x.b ->> 'kept_ft' IS NOT NULL
                           AND inv.same_item(k, pg_catalog.jsonb_populate_record(i, pg_catalog.jsonb_build_object('length_ft', x.b -> 'kept_ft')))
     WHERE p.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = p_job.id ORDER BY s.revision DESC LIMIT 1)),
  step AS (
    SELECT item_id, n, 1 AS boards, 0 AS remainders FROM board
     UNION ALL
    SELECT kept_id, n, 0, 1 FROM board WHERE kept_id IS NOT NULL),
  covered AS (
    SELECT t.item_id, (pg_catalog.sum(t.boards) - GREATEST(pg_catalog.max(t.excess) FILTER (WHERE t.boards = 1), 0))::integer AS quantity
      FROM (SELECT item_id, boards,
                   pg_catalog.sum(boards - remainders) OVER (PARTITION BY item_id ORDER BY n, remainders ROWS UNBOUNDED PRECEDING) AS excess
              FROM step) t
     GROUP BY t.item_id)
  SELECT c.item_id, c.quantity - coalesce(v.quantity, 0), c.live
    FROM inv.job_to_consume(p_job, 'shipped') c
    LEFT JOIN covered v ON v.item_id = c.item_id
   WHERE c.quantity > coalesce(v.quantity, 0)
$$;

GRANT EXECUTE ON FUNCTION inv.job_commits(inv.jobs), inv.same_item(inv.items, inv.items) TO inv_app;

-- 011's inv.job_committed, reading inv.job_commits. Otherwise as 011.
CREATE OR REPLACE FUNCTION inv.job_committed()
RETURNS TABLE (item_id bigint, committed integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.item_id, pg_catalog.sum(c.quantity)::integer
    FROM inv.jobs j CROSS JOIN LATERAL inv.job_commits(j) c
   WHERE j.status IN ('committed', 'built') AND c.live
   GROUP BY c.item_id
$$;

-- 025's inv.lvl_available, the job's own committed boards read from
-- inv.job_commits as inv.job_committed reads them, so the boards counted
-- free are the ones counted committed. Otherwise as 025.
CREATE OR REPLACE FUNCTION inv.lvl_available(p_number text)
RETURNS TABLE (item_id bigint, size text, length_ft integer, quantity integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.size, i.length_ft, GREATEST(f.available + coalesce(own.quantity, 0), 0)::integer
    FROM inv.items i
    JOIN inv.item_figures f ON f.item_id = i.id
    LEFT JOIN (SELECT c.item_id, pg_catalog.sum(c.quantity) AS quantity
                 FROM inv.jobs j CROSS JOIN LATERAL inv.job_commits(j) c
                WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy(p_number))
                  AND j.status IN ('committed', 'built') AND c.live
                GROUP BY c.item_id) own ON own.item_id = i.id
   WHERE i.family = 'lvl' AND i.active
$$;
