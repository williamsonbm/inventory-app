-- #91: LVL comes only in the depths the company carries. Source: #91
-- (owner, 2026-10-10: a fixed list; the database refuses any other depth;
-- Add item and Rename pick from it; a new depth is a code change) and owner
-- Q22 (2026-11-03): 9-1/2, 11-7/8, 14, 16, 18, 20 and 24, no 22 (#81: the
-- company no longer carries 22″). Written as the LVL items store them, with
-- no inch mark. Every name is fully qualified (#28).
--
-- Reach: two new functions, a CHECK on inv.items (LVL rows only) and on
-- inv.lvl_depth_thresholds, and inv.new_item redefined to refuse another
-- depth with a plain message. No row changes: the block below stops first
-- if any row holds another depth. On 2026-11-03 Preview and Production
-- held only listed depths.
-- Recovery: drop the constraints items_lvl_depth_check and
-- lvl_depth_thresholds_known_depth_check, rerun 003's inv.new_item (as CREATE OR
-- REPLACE), then drop inv.check_lvl_depth and inv.lvl_depths.

-- The LVL depths, in screen order. No other depth is added, as an item or
-- a threshold: the tables' CHECKs are the guarantee, and
-- inv.check_lvl_depth gives the plain message first.
CREATE FUNCTION inv.lvl_depths() RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT '{9-1/2,11-7/8,14,16,18,20,24}'::text[] $$;

CREATE FUNCTION inv.check_lvl_depth(p_size text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_size IS NULL OR NOT p_size = ANY (inv.lvl_depths()) THEN
    RAISE EXCEPTION 'LVL comes % deep.',
      inv.word_list(ARRAY(SELECT d || '″' FROM pg_catalog.unnest(inv.lvl_depths()) WITH ORDINALITY AS u(d, n) ORDER BY n), 'or')
      USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- A row with another depth would make the CHECKs below fail with a bare
-- constraint error. Stop with words that say which rows and what to do.
DO $$
DECLARE
  v_bad text := (
    SELECT pg_catalog.string_agg(DISTINCT '"' || d || '"', ', ')
      FROM (SELECT size AS d FROM inv.items WHERE family = 'lvl'
            UNION ALL SELECT depth FROM inv.lvl_depth_thresholds) x
     WHERE NOT d = ANY (inv.lvl_depths()));
BEGIN
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LVL items or thresholds have the depth %, which is not one of %. Change those rows to a listed depth in the database (retired items too), then run 023 again.',
      v_bad, pg_catalog.array_to_string(inv.lvl_depths(), ', ');
  END IF;
END
$$;

ALTER TABLE inv.items ADD CONSTRAINT items_lvl_depth_check
  CHECK (family <> 'lvl' OR size = ANY (inv.lvl_depths()));
ALTER TABLE inv.lvl_depth_thresholds ADD CONSTRAINT lvl_depth_thresholds_known_depth_check
  CHECK (depth = ANY (inv.lvl_depths()));

-- 003's, with LVL's depth checked as lumber's size is.

-- Builds a new item from its family and identity, refusing what cannot be
-- one, without saving it. Shared by inv.add_item and inv.import_catalog, so
-- a person and the import are refused the same things.
-- p_identity names the item with exactly its family's identity fields
-- (inv.families.identity): {sku}, {size, grade, length_ft} or
-- {product, size, length_ft}. Text is tidied, and a run of blanks inside a SKU
-- becomes one space ("MT18HS  3x8" in the web app is MT18HS 3x8). A length is
-- a whole number of feet.
CREATE OR REPLACE FUNCTION inv.new_item(p_family text, p_identity jsonb) RETURNS inv.items
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
  v_given text[];
  v_length jsonb := p_identity -> 'length_ft';
  i inv.items;
BEGIN
  SELECT * INTO f FROM inv.families WHERE code = p_family;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no family "%".', p_family USING ERRCODE = 'IV400';
  END IF;
  IF f.identity IS NULL THEN
    RAISE EXCEPTION '% items cannot be added yet.', f.name USING ERRCODE = 'IV422';
  END IF;
  -- The fields given, leaving out blanks, so "  " is the same as missing.
  SELECT coalesce(pg_catalog.array_agg(key ORDER BY key), '{}') INTO v_given
    FROM pg_catalog.jsonb_each(coalesce(p_identity, '{}'))
   WHERE value <> 'null' AND coalesce(inv.tidy(value #>> '{}'), '') <> '';
  IF NOT (v_given @> f.identity AND v_given <@ f.identity) THEN
    RAISE EXCEPTION '% items are named by: %.', f.name, pg_catalog.array_to_string(f.identity, ', ')
      USING ERRCODE = 'IV400';
  END IF;
  IF v_length IS NOT NULL AND NOT (pg_catalog.jsonb_typeof(v_length) = 'number'
     AND v_length::numeric = pg_catalog.trunc(v_length::numeric) AND v_length::numeric > 0) THEN
    RAISE EXCEPTION 'A length is a whole number of feet above 0.' USING ERRCODE = 'IV400';
  END IF;
  i.family := p_family;
  i.sku := pg_catalog.regexp_replace(inv.tidy(p_identity ->> 'sku'), '[\s\u00a0]+', ' ', 'g');
  i.product := inv.tidy(p_identity ->> 'product');
  i.size := inv.tidy(p_identity ->> 'size');
  i.grade := inv.tidy(p_identity ->> 'grade');
  i.length_ft := (v_length::numeric)::integer;
  IF p_family = 'lumber' THEN
    PERFORM inv.check_lumber_size(i.size);
    -- A grade typed in other capitals takes the spelling already in use, from
    -- the buying options first, then from the lumber items: "dss" is DSS.
    i.grade := coalesce(
      (SELECT l.grade FROM inv.lumber_purchasable_lengths l
        WHERE pg_catalog.lower(l.grade) = pg_catalog.lower(i.grade) ORDER BY l.grade LIMIT 1),
      (SELECT x.grade FROM inv.items x
        WHERE x.family = 'lumber' AND pg_catalog.lower(x.grade) = pg_catalog.lower(i.grade) ORDER BY x.id LIMIT 1),
      i.grade);
  ELSIF p_family = 'lvl' THEN
    PERFORM inv.check_lvl_depth(i.size);
  END IF;
  RETURN i;
END
$$;

GRANT EXECUTE ON FUNCTION inv.lvl_depths() TO inv_app;
