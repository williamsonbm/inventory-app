-- Step 3, part 3 (#81): a fix from the PR #92 review (F2). A new file, not
-- 007: the owner's own database has already run 007 (Q166).

-- Whether an item had nothing recorded up to p_at (005, Q118): no ledger
-- entry and no approved count that includes it. 005 missed an item that a
-- month-end correction added to a record (story 86): it has a figure from
-- that count's moment, so a later Unmatched count needs a reason. "A count
-- includes the item" is inv.base_count's rule (007), so on hand, last
-- counted and this never disagree.
CREATE OR REPLACE FUNCTION inv.nothing_before(p_item_id bigint, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT FROM inv.ledger WHERE item_id = p_item_id AND effective_at <= p_at)
     AND NOT EXISTS (SELECT FROM inv.base_count(p_item_id, p_at))
$$;
