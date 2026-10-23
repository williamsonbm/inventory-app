-- Step 4 (#98): committed and available in the one calculation. Source:
-- docs/database-design.md, "How the numbers are calculated"; spec #96.
-- Every name is fully qualified (#28).
--
-- Reach: one view redefined; no table or row changes.
-- Recovery: rerun 006's definition of inv.item_figures.
--
-- committed, for each item: the current sheet's quantity on every job that
-- is still committed, for a family live in Inventory. A family not live
-- keeps its job lines but is not tracked yet, so it shows no change (J4).
-- Jobs have no EWP lines (J13), so EWP shows no change either. Until #100
-- adds Build and Ship, no job is built and none has consumed anything; #100
-- subtracts what each job consumed, never below zero, before the sum.
-- available = on hand − committed. Reorder and an LVL depth's linear feet
-- now read available, as 004's comment said they would.
-- The jobs tables are read inline, not through a function, so the view
-- reads them as its owner and the Planner login needs no new grant.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.available < 0 THEN 'Short'
            WHEN d.available <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder,
       d.counted_at, d.committed, d.available
  FROM (SELECT a.*,
               CASE WHEN a.family = 'lvl'
                    THEN pg_catalog.sum(a.available * a.length_ft) OVER (PARTITION BY a.family, a.size)::integer END AS depth_lf
          FROM (SELECT f.*, f.on_hand - f.committed AS available
                  FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                               coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                               inv.on_hand_at(i.id, 'infinity') AS on_hand,
                               (SELECT b.counted_at FROM inv.base_count(i.id, 'infinity') b) AS counted_at,
                               (SELECT coalesce(pg_catalog.sum(jl.quantity), 0)::integer
                                  FROM inv.jobs j
                                  JOIN inv.job_sheets s ON s.job_id = j.id
                                   AND s.revision = (SELECT pg_catalog.max(revision) FROM inv.job_sheets WHERE job_id = j.id)
                                  JOIN inv.job_lines jl ON jl.sheet_id = s.id
                                 WHERE j.status = 'committed' AND jl.item_id = i.id
                                   AND (SELECT live FROM inv.families WHERE code = i.family)) AS committed
                          FROM inv.items i
                          LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                         GROUP BY i.id) f) a) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;
