-- #130 (spec #127): an item is "On order" while a line with no amount waits
-- for it. Source: spec #127, owner J229. Every name is fully qualified (#28).
--
-- Reach: inv.item_figures gains one column, on_order, after the others; no
-- row changes. CREATE OR REPLACE keeps the view's grants.
-- Recovery: the column changes no row, and code reverted to before #130
-- ignores it. To remove it (CREATE OR REPLACE cannot drop a column): DROP
-- VIEW inv.lvl_depth_figures, inv.item_figures; rerun 011's inv.item_figures
-- and 004's inv.lvl_depth_figures; rerun 007's grant on both (inv_app's
-- comes from 001's default privileges).

-- 011's view, with on_order: true while any open line of the item has no
-- amount (017). Incoming counts such a line as 0. Otherwise as 011.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.available < 0 THEN 'Short'
            WHEN d.available <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder,
       d.counted_at, d.committed, d.available, d.on_order
  FROM (SELECT a.*,
               CASE WHEN a.family = 'lvl'
                    THEN pg_catalog.sum(a.available * a.length_ft) OVER (PARTITION BY a.family, a.size)::integer END AS depth_lf
          FROM (SELECT f.*, f.on_hand - f.committed AS available
                  FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                               coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                               pg_catalog.bool_or(l.id IS NOT NULL AND l.ordered IS NULL) AS on_order,
                               inv.on_hand_at(i.id, 'infinity') AS on_hand,
                               (SELECT b.counted_at FROM inv.base_count(i.id, 'infinity') b) AS counted_at,
                               coalesce(jc.committed, 0) AS committed
                          FROM inv.items i
                          LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                          LEFT JOIN inv.job_committed() jc ON jc.item_id = i.id
                         GROUP BY i.id, jc.committed) f) a) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;
