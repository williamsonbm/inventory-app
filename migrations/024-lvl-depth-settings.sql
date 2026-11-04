-- #181: two settings per LVL depth, for planning a job's LVL as the yard
-- cuts it (#178 stories 28, 29, 31, 38): the lengths the yard buys, and the
-- shortest remainder it keeps. Nothing reads them for planning yet (#182).
-- One row per depth holds both, with one version (owner, L8), as a lumber
-- group's lengths are one row. Both are integer columns, because
-- node-postgres gives a numeric column as text ("10"), which planLvlCuts
-- refuses. Every name is fully qualified (#28).
--
-- Reach: one new table, seeded with a row per LVL depth. No existing row
-- changes.
-- Recovery: drop the table.

CREATE TABLE inv.lvl_depth_settings (
  depth text PRIMARY KEY CHECK (depth = ANY (inv.lvl_depths())),  -- as on the LVL items: "11-7/8"
  -- Whole feet, kept ascending by inv.set_lvl_purchasable_lengths; none means
  -- the depth is bought at the sheet's lengths.
  purchasable_lengths integer[] NOT NULL
    CHECK (0 < ALL (purchasable_lengths) AND pg_catalog.array_position(purchasable_lengths, NULL) IS NULL),
  -- An even length, as the yard counts (#178 story 22), and 2′ or more.
  shortest_remainder_kept_ft integer NOT NULL
    CHECK (shortest_remainder_kept_ft >= 2 AND shortest_remainder_kept_ft % 2 = 0),
  version integer NOT NULL DEFAULT 1
);

-- Seed (#181): 48′ for 9-1/2″ through 20″, none for 24″, which the company
-- buys only to order; 10′ kept for every depth.
INSERT INTO inv.lvl_depth_settings (depth, purchasable_lengths, shortest_remainder_kept_ft)
SELECT d, CASE WHEN d = '24' THEN '{}'::integer[] ELSE '{48}' END, 10
  FROM pg_catalog.unnest(inv.lvl_depths()) d;

INSERT INTO inv.actions (name, admin_only) VALUES ('set LVL purchasable lengths', false),
  ('set LVL shortest remainder kept', false);

CREATE TRIGGER bump_version BEFORE UPDATE OF purchasable_lengths, shortest_remainder_kept_ft ON inv.lvl_depth_settings
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

CREATE FUNCTION inv.lvl_depth_settings_json(s inv.lvl_depth_settings) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.to_jsonb(s)
$$;

-- As inv.item_at_version: lock one depth's settings, refusing a stale version.
CREATE FUNCTION inv.lvl_depth_settings_at_version(p_depth text, p_version integer)
RETURNS inv.lvl_depth_settings
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  s inv.lvl_depth_settings;
BEGIN
  SELECT * INTO s FROM inv.lvl_depth_settings WHERE depth = p_depth FOR UPDATE;
  IF p_version IS DISTINCT FROM s.version THEN
    RAISE EXCEPTION 'Someone else changed %″ since you opened this screen.', p_depth
      USING ERRCODE = 'IV409', DETAIL = inv.lvl_depth_settings_json(s)::text;
  END IF;
  RETURN s;
END
$$;

-- Planner → LVL → the stock-lengths panel: one depth's purchasable lengths,
-- the whole list, so adding and removing a length are the same save.
CREATE FUNCTION inv.set_lvl_purchasable_lengths(
  p_actor bigint, p_key uuid, p_depth text, p_version integer, p_lengths numeric[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lvl_depth_settings;
  s inv.lvl_depth_settings;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set LVL purchasable lengths', 'lvl_depth_settings', NULL,
                        pg_catalog.jsonb_build_object('depth', p_depth, 'version', p_version, 'lengths', p_lengths));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.check_lvl_depth(p_depth);
  IF p_lengths IS NULL OR EXISTS (SELECT FROM pg_catalog.unnest(p_lengths) n
                                   WHERE n IS NULL OR n <> pg_catalog.trunc(n) OR n NOT BETWEEN 1 AND 2147483647) THEN
    RAISE EXCEPTION 'A purchasable length is a whole number of feet above 0.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.lvl_depth_settings_at_version(p_depth, p_version);
  UPDATE inv.lvl_depth_settings
     SET purchasable_lengths = (SELECT coalesce(pg_catalog.array_agg(DISTINCT n::integer ORDER BY n::integer), '{}')
                                  FROM pg_catalog.unnest(p_lengths) n)
   WHERE depth = p_depth RETURNING * INTO s;
  RETURN inv.finish_action(a.log_id, NULL, inv.lvl_depth_settings_json(was), inv.lvl_depth_settings_json(s));
END
$$;

-- Planner → LVL → the stock-lengths panel: one depth's shortest remainder kept.
CREATE FUNCTION inv.set_lvl_shortest_remainder_kept(
  p_actor bigint, p_key uuid, p_depth text, p_version integer, p_ft numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lvl_depth_settings;
  s inv.lvl_depth_settings;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set LVL shortest remainder kept', 'lvl_depth_settings', NULL,
                        pg_catalog.jsonb_build_object('depth', p_depth, 'version', p_version, 'ft', p_ft));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.check_lvl_depth(p_depth);
  IF p_ft IS NULL OR p_ft <> pg_catalog.trunc(p_ft) OR p_ft NOT BETWEEN 2 AND 2147483647 OR p_ft % 2 <> 0 THEN
    RAISE EXCEPTION 'The shortest remainder kept is an even number of feet, 2 or more.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.lvl_depth_settings_at_version(p_depth, p_version);
  UPDATE inv.lvl_depth_settings SET shortest_remainder_kept_ft = p_ft::integer
   WHERE depth = p_depth RETURNING * INTO s;
  RETURN inv.finish_action(a.log_id, NULL, inv.lvl_depth_settings_json(was), inv.lvl_depth_settings_json(s));
END
$$;

GRANT EXECUTE ON FUNCTION inv.set_lvl_purchasable_lengths(bigint, uuid, text, integer, numeric[]) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.set_lvl_shortest_remainder_kept(bigint, uuid, text, integer, numeric) TO inv_app;
