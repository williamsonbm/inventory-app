-- Step 3, part 1 (#81): the item catalog and its Settings.
-- Source: docs/database-design.md, "Step 3 — inventory", tables 3–7 and 15–17.
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- The material families. Fixed rows; the app never adds one.
-- identity lists the fields that name one of the family's items, so families
-- differ in data, not in a branch per family. EWP has none yet, so no EWP
-- item can be added: EWP stays out of Inventory until step 5 (Q28). Step 5
-- sets it to the web app's key, the item text and its length ({product,
-- length_ft}; hanger-web-app/sql/ewp_schema.sql keys a board by item and span).
-- pack_kinds lists the kinds of pack size the family's items come in, in
-- screen order, smallest first (owner, 2026-10-02): hangers in cartons
-- (Simpson's word for a hanger pack), plates in bands of 20 ("pack"), boxes
-- and pallets, lumber and engineered wood in packs.
CREATE TABLE inv.families (
  code       text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  identity   text[],
  pack_kinds text[] NOT NULL
);

INSERT INTO inv.families (code, name, identity, pack_kinds) VALUES
  ('plates',  'Plates',  '{sku}',                    '{pack,box,pallet}'),
  ('hangers', 'Hangers', '{sku}',                    '{carton}'),
  ('lumber',  'Lumber',  '{size,grade,length_ft}',   '{pack}'),
  ('lvl',     'LVL',     '{product,size,length_ft}', '{pack}'),
  ('ewp',     'EWP',     NULL,                       '{pack}');

-- "a, b and c" or "a, b or c", for a refusal that lists what is allowed.
CREATE FUNCTION inv.word_list(p_words text[], p_last text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN pg_catalog.cardinality(p_words) < 2 THEN p_words[1]
              ELSE pg_catalog.array_to_string(p_words[1:pg_catalog.cardinality(p_words) - 1], ', ')
                   || ' ' || p_last || ' ' || p_words[pg_catalog.cardinality(p_words)] END
$$;

-- The lumber sizes the yard handles, in screen order (owner, 2026-10-02).
-- No other size is added, as an item, a buying option or a redirect: the
-- tables' CHECKs are the guarantee, and inv.check_lumber_size gives the
-- plain message first.
CREATE FUNCTION inv.lumber_sizes() RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT '{2x4,2x6,2x8,2x10,2x12}'::text[] $$;

CREATE FUNCTION inv.check_lumber_size(p_size text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_size IS NULL OR NOT p_size = ANY (inv.lumber_sizes()) THEN
    RAISE EXCEPTION 'Lumber comes in %.', inv.word_list(inv.lumber_sizes(), 'and') USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- The catalog: one row per item, never deleted (S62).
CREATE TABLE inv.items (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  family    text NOT NULL REFERENCES inv.families (code),
  sku       text CHECK (sku = inv.tidy(sku) AND sku <> ''),          -- plates, hangers
  product   text CHECK (product = inv.tidy(product) AND product <> ''),  -- LVL: "2.1 RigidLam LVL 1-3/4"
  size      text CHECK (size = inv.tidy(size) AND size <> ''),        -- lumber: "2x4"; LVL: the depth, "11-7/8"
  grade     text CHECK (grade = inv.tidy(grade) AND grade <> '' AND pg_catalog.strpos(grade, '|') = 0),  -- lumber: "#2"
  length_ft integer CHECK (length_ft > 0),                            -- lumber, LVL: whole feet
  -- S43: set only by a person. S38: a new item starts Special Order.
  stocking  text NOT NULL DEFAULT 'Special Order'
            CHECK (stocking IN ('Stocked', 'Non-Stock', 'Special Order')),
  -- In the item's own pieces. Blank is "not set", never "reorder at 0" (S39).
  -- LVL items have none: LVL thresholds are per depth, in linear feet (Q16).
  threshold integer CHECK (threshold >= 0),
  note      text CHECK (note = inv.tidy(note) AND note <> ''),  -- S61: e.g. weathered, kept for now
  active    boolean NOT NULL DEFAULT true,
  version   integer NOT NULL DEFAULT 1,
  CHECK (family <> 'lvl' OR threshold IS NULL),
  CHECK (family <> 'lumber' OR size = ANY (inv.lumber_sizes()))
);

-- S19: one family never holds the same item twice; blanks count as equal,
-- and so do capitals, as for suppliers and reasons: "lus28" is LUS28.
-- inv.same_item is the same rule for a lookup.
CREATE UNIQUE INDEX items_name_key ON inv.items (family, pg_catalog.lower(sku), pg_catalog.lower(product),
  pg_catalog.lower(size), pg_catalog.lower(grade), length_ft) NULLS NOT DISTINCT;

CREATE TRIGGER bump_version BEFORE UPDATE OF sku, product, size, grade, length_ft, stocking, threshold, note, active
  ON inv.items
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- An item fills exactly the name fields its family lists, whatever writes the
-- row: a family with none (EWP until step 5) holds no items. inv.new_item
-- gives the plain message first; this is the guarantee. A trigger, not a
-- CHECK, because the fields are data in inv.families.
CREATE FUNCTION inv.check_item_identity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_filled text[];
BEGIN
  SELECT coalesce(pg_catalog.array_agg(key ORDER BY key), '{}') INTO v_filled
    FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(NEW))
   WHERE key IN ('sku', 'product', 'size', 'grade', 'length_ft') AND value <> 'null';
  IF NOT EXISTS (SELECT 1 FROM inv.families f
                  WHERE f.code = NEW.family AND v_filled @> f.identity AND v_filled <@ f.identity) THEN
    RAISE EXCEPTION 'A % item fills exactly its family''s name fields.', NEW.family USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_identity BEFORE INSERT OR UPDATE OF family, sku, product, size, grade, length_ft
  ON inv.items
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_identity();

-- Known pack, box, carton and pallet sizes per item (Q13), shown as a choice
-- on receipts and counts. Each receipt and count line keeps its own copy of
-- the size it used, so correcting a size here changes no line already saved.
-- An item has at most one size of each kind its family comes in
-- (inv.families.pack_kinds; owner, 2026-10-02, replacing S74's "several
-- sizes"). An item with no pallet row has an unknown pallet size, never a
-- guessed one (S18).
CREATE TABLE inv.pack_sizes (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES inv.items (id),
  kind    text NOT NULL,
  pieces  integer NOT NULL CHECK (pieces > 0),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (item_id, kind)
);

CREATE TRIGGER bump_version BEFORE UPDATE OF pieces ON inv.pack_sizes
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- A pack size is a kind its item's family comes in, whatever writes the row,
-- with the plain message a person sees. A trigger, not a CHECK, because the
-- kinds are data in inv.families. An item that does not exist is left to
-- the foreign key.
CREATE FUNCTION inv.check_pack_size_kind() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = NEW.item_id;
  IF FOUND AND NOT coalesce(NEW.kind = ANY (f.pack_kinds), false) THEN
    RAISE EXCEPTION 'A pack size for % is a %.', f.name, inv.word_list(f.pack_kinds, 'or') USING ERRCODE = 'IV400';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_kind BEFORE INSERT OR UPDATE OF item_id, kind ON inv.pack_sizes
  FOR EACH ROW EXECUTE FUNCTION inv.check_pack_size_kind();

-- LVL reorder thresholds, per depth in linear feet (Q16): LVL items carry
-- none of their own. A depth gets its row on its first save. Blank is "not
-- set" (24", which the company buys only to order).
CREATE TABLE inv.lvl_depth_thresholds (
  depth        text PRIMARY KEY CHECK (depth = inv.tidy(depth) AND depth <> ''),  -- as on the LVL items: "11-7/8"
  threshold_lf integer CHECK (threshold_lf >= 0),
  version      integer NOT NULL DEFAULT 1
);

CREATE TRIGGER bump_version BEFORE UPDATE OF threshold_lf ON inv.lvl_depth_thresholds
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- Picked on each PO, so a supplier's name is spelled one way (Q22).
-- Unique whatever the capitals, so "boise cascade" cannot sit beside "Boise Cascade".
CREATE TABLE inv.suppliers (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name    text NOT NULL CHECK (name = inv.tidy(name) AND name <> ''),
  version integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX suppliers_name_key ON inv.suppliers (pg_catalog.lower(name));

CREATE TRIGGER bump_version BEFORE UPDATE OF name ON inv.suppliers
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- The reasons picked for a correction, an unmatched count line or a closed
-- PO line. A reason is retired, never deleted, so old records keep it (S42).
-- built_in marks the five the app itself uses; those cannot be retired, or
-- the step that uses one (a trim, the cutover import) would have none.
CREATE TABLE inv.reasons (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text     text NOT NULL CHECK (text = inv.tidy(text) AND text <> ''),
  active   boolean NOT NULL DEFAULT true,
  built_in boolean NOT NULL DEFAULT false,
  version  integer NOT NULL DEFAULT 1,
  CHECK (active OR NOT built_in)
);

CREATE UNIQUE INDEX reasons_text_key ON inv.reasons (pg_catalog.lower(text));

CREATE TRIGGER bump_version BEFORE UPDATE OF active ON inv.reasons
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

INSERT INTO inv.reasons (text, built_in) VALUES
  ('Returned from job site', true), ('Damaged – scrapped', true), ('Weathered – trimmed', true),
  ('Remake', true), ('Opening balance (web app)', true);

-- The Planner's lumber buying options, shared by every computer and logged
-- (S37), replacing each browser's own copy (lumberMenu.v1). One row per size
-- and grade: the stock lengths the yard buys, in whole feet, ascending. An
-- empty list is a group not bought.
-- The page names a group "size|grade" and splits it there, so the grade
-- holds no "|" (no size on the list does).
CREATE TABLE inv.lumber_purchasable_lengths (
  size    text NOT NULL CHECK (size = ANY (inv.lumber_sizes())),
  grade   text NOT NULL CHECK (grade = inv.tidy(grade) AND grade <> '' AND pg_catalog.strpos(grade, '|') = 0),
  -- Whole feet above 0; none means the group is not bought.
  lengths integer[] NOT NULL
          CHECK (0 < ALL (lengths) AND pg_catalog.array_position(lengths, NULL) IS NULL),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (size, grade)
);
-- Capitals do not make a second group, as for items: "2x4 dss" is 2x4 DSS.
CREATE UNIQUE INDEX lumber_purchasable_lengths_name_key
  ON inv.lumber_purchasable_lengths (size, pg_catalog.lower(grade));

CREATE TRIGGER bump_version BEFORE UPDATE OF lengths ON inv.lumber_purchasable_lengths
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- Seed: the engine's default menu (DEFAULT_LUMBER_MENU in src/lumber/lumberMenu.js,
-- 2026-08-25), so day one gives the same buy list as today. From here on the
-- table is the source; catalog.test.js compares the two.
INSERT INTO inv.lumber_purchasable_lengths (size, grade, lengths) VALUES
  ('2x4', '#2', '{6,7,8,10,12,14,16,20}'),
  ('2x4', '#1', '{10,12,14,16,20}'),
  ('2x4', 'DSS', '{10,12,14,16}'),
  ('2x4', 'MSR2400', '{10,12,14,16}'),
  ('2x6', '#2', '{10,12,14,16}'),
  ('2x6', 'DSS', '{10,12,14,16}'),
  ('2x6', 'MSR2400', '{10,12,14,16}'),
  ('2x8', 'DSS', '{10,12,14,16}'),
  ('2x8', 'MSR2400', '{10,12,14,16}'),
  ('2x10', '#1', '{10,12,14,16}'),
  ('2x10', 'DSS', '{10,12,14,16}'),
  ('2x12', 'MSR2400', '{10,12,14,16}');

-- "Buy this size's to_grade instead of its from_grade." A blank to_grade is a
-- redirect cleared. Deliberately no strength check here: the engine's
-- GRADE_STRENGTH_ORDER is the one copy of that rule, and resolveRedirects
-- drops a redirect it refuses with a warning at plan time. A second copy in
-- SQL could disagree with it.
-- Grades follow the buying options' rules: no "|" (the page splits
-- "size|grade" there), and capitals do not make a second redirect.
CREATE TABLE inv.lumber_grade_redirects (
  size       text NOT NULL CHECK (size = ANY (inv.lumber_sizes())),
  from_grade text NOT NULL CHECK (from_grade = inv.tidy(from_grade) AND from_grade <> ''
                                  AND pg_catalog.strpos(from_grade, '|') = 0),
  to_grade   text CHECK (to_grade = inv.tidy(to_grade) AND to_grade <> '' AND pg_catalog.strpos(to_grade, '|') = 0
                         AND pg_catalog.lower(to_grade) <> pg_catalog.lower(from_grade)),
  version    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (size, from_grade)
);
CREATE UNIQUE INDEX lumber_grade_redirects_name_key
  ON inv.lumber_grade_redirects (size, pg_catalog.lower(from_grade));

CREATE TRIGGER bump_version BEFORE UPDATE OF to_grade ON inv.lumber_grade_redirects
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

INSERT INTO inv.actions (name, admin_only) VALUES ('add item', false), ('rename item', true), ('edit item', false), ('retire item', false), ('un-retire item', false),
  ('add pack size', false), ('change pack size', false), ('set LVL depth threshold', false),
  ('add supplier', false), ('rename supplier', false),
  ('add reason', false), ('retire reason', false), ('un-retire reason', false),
  ('set lumber lengths', false), ('set grade redirect', false), ('remove lumber group', false),
  ('import catalog', true);

-- The shape every function returns for an item, and logs as was → now.
CREATE FUNCTION inv.item_json(i inv.items) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', i.id, 'family', i.family, 'sku', i.sku, 'product', i.product, 'size', i.size, 'grade', i.grade,
    'length_ft', i.length_ft, 'stocking', i.stocking, 'threshold', i.threshold, 'note', i.note,
    'active', i.active, 'version', i.version)
$$;

-- An item as people name it, for refusal messages: "MT18HS", "2x4 #2 16′",
-- "2.1 RigidLam LVL 1-3/4 x 11-7/8 26′".
CREATE FUNCTION inv.item_label(i inv.items) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.concat_ws(' ', i.sku, i.product || ' x ' || i.size,
                              CASE WHEN i.product IS NULL THEN i.size END, i.grade,
                              i.length_ft || '′')
$$;

-- Builds a new item from its family and identity, refusing what cannot be
-- one, without saving it. Shared by inv.add_item and inv.import_catalog, so
-- a person and the import are refused the same things.
-- p_identity names the item with exactly its family's identity fields
-- (inv.families.identity): {sku}, {size, grade, length_ft} or
-- {product, size, length_ft}. Text is tidied, and a run of blanks inside a SKU
-- becomes one space ("MT18HS  3x8" in the web app is MT18HS 3x8). A length is
-- a whole number of feet.
CREATE FUNCTION inv.new_item(p_family text, p_identity jsonb) RETURNS inv.items
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
  IF p_family = 'lumber' THEN PERFORM inv.check_lumber_size(i.size); END IF;
  RETURN i;
END
$$;

-- Refuses a threshold that is not blank or a whole number 0 or more (S39,
-- S40), and any threshold on an LVL item (Q16). p_threshold is the JSON
-- value as given, so 2.5 or "abc" is refused here rather than cast.
CREATE FUNCTION inv.check_threshold(p_family text, p_threshold jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_threshold IS NULL OR p_threshold = 'null' THEN RETURN; END IF;
  IF NOT (pg_catalog.jsonb_typeof(p_threshold) = 'number'
          AND p_threshold::numeric = pg_catalog.trunc(p_threshold::numeric) AND p_threshold::numeric >= 0) THEN
    RAISE EXCEPTION 'A threshold is a whole number, 0 or more, or blank.' USING ERRCODE = 'IV400';
  END IF;
  IF p_family = 'lvl' THEN
    RAISE EXCEPTION 'LVL thresholds are set per depth, in linear feet, not per length.'
      USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- Whether two rows name the same item: the rule of items_name_key, for a
-- lookup.
CREATE FUNCTION inv.same_item(a inv.items, b inv.items) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.family = b.family
     AND pg_catalog.lower(a.sku) IS NOT DISTINCT FROM pg_catalog.lower(b.sku)
     AND pg_catalog.lower(a.product) IS NOT DISTINCT FROM pg_catalog.lower(b.product)
     AND pg_catalog.lower(a.size) IS NOT DISTINCT FROM pg_catalog.lower(b.size)
     AND pg_catalog.lower(a.grade) IS NOT DISTINCT FROM pg_catalog.lower(b.grade)
     AND a.length_ft IS NOT DISTINCT FROM b.length_ft
$$;

-- Refuses a new name that another item already has, saying whether that
-- item is retired, so the person un-retires it rather than adding it again.
-- Called when an insert or update of an item breaks its unique name.
CREATE FUNCTION inv.refuse_name_in_use(v inv.items) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT FROM inv.items i WHERE NOT i.active AND inv.same_item(i, v)) THEN
    RAISE EXCEPTION '% is in the catalog but retired; un-retire it instead.', inv.item_label(v)
      USING ERRCODE = 'IV400';
  END IF;
  RAISE EXCEPTION '% is already in the catalog.', inv.item_label(v) USING ERRCODE = 'IV400';
END
$$;

-- Inventory → Overview → + Add item, and "Add …" while receiving or counting.
CREATE FUNCTION inv.add_item(p_actor bigint, p_key uuid, p_family text, p_identity jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_new inv.items;
  i inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'add item', 'items', NULL,
                        pg_catalog.jsonb_build_object('family', p_family, 'identity', p_identity));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_new := inv.new_item(p_family, p_identity);
  BEGIN
    INSERT INTO inv.items (family, sku, product, size, grade, length_ft)
    VALUES (v_new.family, v_new.sku, v_new.product, v_new.size, v_new.grade, v_new.length_ft)
    RETURNING * INTO i;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_name_in_use(v_new);
  END;
  RETURN inv.finish_action(a.log_id, i.id, NULL, inv.item_json(i));
END
$$;

-- Reads and locks the item a change is about, refusing it when the item has
-- changed since the screen read it (S41). The refusal's DETAIL is the current
-- item, so the screen can show what the other save did. Deliberately a row
-- lock, not migration 001's table lock on inv.users: a table lock would make
-- every catalog save wait for every other one, and one item's lock is enough.
CREATE FUNCTION inv.item_at_version(p_id bigint, p_version integer) RETURNS inv.items
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
BEGIN
  SELECT * INTO i FROM inv.items WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That item is not in the catalog.' USING ERRCODE = 'IV400';
  END IF;
  IF p_version IS DISTINCT FROM i.version THEN
    RAISE EXCEPTION 'Someone else changed % since you opened this screen.', inv.item_label(i)
      USING ERRCODE = 'IV409', DETAIL = inv.item_json(i)::text;
  END IF;
  RETURN i;
END
$$;

-- Inventory → Overview: an item's Stocking, Threshold or Note cell.
-- p_changes holds only the fields being changed: stocking, threshold, note.
-- A field given as null is set blank; a field left out keeps its value.
CREATE FUNCTION inv.edit_item(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.items;
  v_threshold jsonb := p_changes -> 'threshold';
  i inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'edit item', 'items', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'changes', p_changes));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.item_at_version(p_id, p_version);
  IF p_changes IS NULL OR p_changes = '{}'
     OR NOT (p_changes ?| ARRAY['stocking', 'threshold', 'note']
             AND p_changes - ARRAY['stocking', 'threshold', 'note'] = '{}') THEN
    RAISE EXCEPTION 'Only the stocking status, threshold and note can be changed here.'
      USING ERRCODE = 'IV400';
  END IF;
  IF p_changes ? 'stocking'
     AND coalesce(p_changes ->> 'stocking', '') NOT IN ('Stocked', 'Non-Stock', 'Special Order') THEN
    RAISE EXCEPTION 'The stocking status is Stocked, Non-Stock or Special Order.' USING ERRCODE = 'IV400';
  END IF;
  PERFORM inv.check_threshold(was.family, v_threshold);
  UPDATE inv.items
     SET stocking  = CASE WHEN p_changes ? 'stocking' THEN p_changes ->> 'stocking' ELSE stocking END,
         threshold = CASE WHEN p_changes ? 'threshold' THEN (p_changes ->> 'threshold')::integer ELSE threshold END,
         note      = CASE WHEN p_changes ? 'note' THEN NULLIF(inv.tidy(p_changes ->> 'note'), '') ELSE note END
   WHERE id = p_id
  RETURNING * INTO i;
  RETURN inv.finish_action(a.log_id, i.id, inv.item_json(was), inv.item_json(i));
END
$$;

-- Inventory → Overview → Rename: corrects an item's name (its identity
-- fields, as inv.add_item takes them). Admin-only (owner, 2026-10-01): a name
-- is how a material sheet finds its item, so a wrong one stops sheets matching.
-- Allowed only while nothing is recorded against the item; until receipts
-- and counts exist (#81 part 2), nothing can be. Part 2 adds that refusal.
CREATE FUNCTION inv.rename_item(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_identity jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.items;
  v inv.items;
  i inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'rename item', 'items', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'identity', p_identity));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.item_at_version(p_id, p_version);
  v := inv.new_item(was.family, p_identity);
  BEGIN
    UPDATE inv.items
       SET sku = v.sku, product = v.product, size = v.size, grade = v.grade, length_ft = v.length_ft
     WHERE id = p_id
    RETURNING * INTO i;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_name_in_use(v);
  END;
  RETURN inv.finish_action(a.log_id, i.id, inv.item_json(was), inv.item_json(i));
END
$$;

-- Retire and un-retire differ only in the direction of one flag. A retired
-- item keeps its history (S62) and can come back.
CREATE FUNCTION inv.set_item_active(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action text := CASE WHEN p_active THEN 'un-retire item' ELSE 'retire item' END;
  a record;
  was inv.items;
  i inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, v_action, 'items', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.item_at_version(p_id, p_version);
  IF was.active = p_active THEN
    RAISE EXCEPTION '% is already %.', inv.item_label(was), CASE WHEN p_active THEN 'in use' ELSE 'retired' END
      USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.items SET active = p_active WHERE id = p_id RETURNING * INTO i;
  RETURN inv.finish_action(a.log_id, i.id, inv.item_json(was), inv.item_json(i));
END
$$;

-- Inventory → the item → Retire.
CREATE FUNCTION inv.retire_item(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_item_active(p_actor, p_key, p_id, p_version, false) $$;

-- Inventory → the item → Un-retire.
CREATE FUNCTION inv.unretire_item(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_item_active(p_actor, p_key, p_id, p_version, true) $$;

CREATE FUNCTION inv.pack_size_json(p inv.pack_sizes) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', p.id, 'item_id', p.item_id, 'kind', p.kind, 'pieces', p.pieces, 'version', p.version)
$$;

-- Refuses a pack size that is not a whole number of pieces above 0 (S40).
-- Takes numeric, so 2.5 is refused here rather than rounded by a cast.
CREATE FUNCTION inv.check_pieces(p_pieces numeric) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_pieces IS NULL OR p_pieces <> pg_catalog.trunc(p_pieces) OR p_pieces <= 0 THEN
    RAISE EXCEPTION 'A pack size is a whole number of pieces above 0.' USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- Settings → Pack sizes → Add, and "new size" while receiving or counting.
CREATE FUNCTION inv.add_pack_size(p_actor bigint, p_key uuid, p_item_id bigint, p_kind text, p_pieces numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  i inv.items;
  p inv.pack_sizes;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'add pack size', 'pack_sizes', NULL,
                        pg_catalog.jsonb_build_object('item_id', p_item_id, 'kind', p_kind, 'pieces', p_pieces));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO i FROM inv.items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That item is not in the catalog.' USING ERRCODE = 'IV400';
  END IF;
  PERFORM inv.check_pieces(p_pieces);
  BEGIN
    INSERT INTO inv.pack_sizes (item_id, kind, pieces) VALUES (p_item_id, p_kind, p_pieces::integer)
    RETURNING * INTO p;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '% already has a % size. Change it in its row.', inv.item_label(i), p_kind USING ERRCODE = 'IV400';
  END;
  RETURN inv.finish_action(a.log_id, p.id, NULL, inv.pack_size_json(p));
END
$$;

-- Settings → Pack sizes: correct or change a size's number of pieces.
CREATE FUNCTION inv.change_pack_size(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_pieces numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.pack_sizes;
  p inv.pack_sizes;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'change pack size', 'pack_sizes', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'pieces', p_pieces));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.pack_sizes WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That pack size does not exist.' USING ERRCODE = 'IV400';
  END IF;
  IF p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed this pack size since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = inv.pack_size_json(was)::text;
  END IF;
  PERFORM inv.check_pieces(p_pieces);
  UPDATE inv.pack_sizes SET pieces = p_pieces::integer WHERE id = p_id RETURNING * INTO p;
  RETURN inv.finish_action(a.log_id, p.id, inv.pack_size_json(was), inv.pack_size_json(p));
END
$$;

CREATE FUNCTION inv.lvl_depth_threshold_json(t inv.lvl_depth_thresholds) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object('depth', t.depth, 'threshold_lf', t.threshold_lf, 'version', t.version)
$$;

-- Settings → LVL thresholds (or the LVL row of the Overview). p_version is
-- null for a depth saved for the first time. p_lf null sets it blank.
CREATE FUNCTION inv.set_lvl_depth_threshold(
  p_actor bigint, p_key uuid, p_depth text, p_version integer, p_lf numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lvl_depth_thresholds;
  t inv.lvl_depth_thresholds;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set LVL depth threshold', 'lvl_depth_thresholds', NULL,
                        pg_catalog.jsonb_build_object('depth', p_depth, 'version', p_version, 'lf', p_lf));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF NOT EXISTS (SELECT FROM inv.items WHERE family = 'lvl' AND size = p_depth) THEN
    RAISE EXCEPTION 'No LVL item is % deep.', p_depth USING ERRCODE = 'IV400';
  END IF;
  IF p_lf IS NOT NULL AND (p_lf <> pg_catalog.trunc(p_lf) OR p_lf < 0) THEN
    RAISE EXCEPTION 'A threshold is a whole number of linear feet, 0 or more, or blank.'
      USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO was FROM inv.lvl_depth_thresholds WHERE depth = p_depth FOR UPDATE;
  IF FOUND IS DISTINCT FROM (p_version IS NOT NULL) OR p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed the % threshold since you opened this screen.', p_depth
      USING ERRCODE = 'IV409', DETAIL = coalesce(inv.lvl_depth_threshold_json(was)::text, 'null');
  END IF;
  IF was.depth IS NULL THEN
    BEGIN
      INSERT INTO inv.lvl_depth_thresholds (depth, threshold_lf) VALUES (p_depth, p_lf::integer)
      RETURNING * INTO t;
    EXCEPTION WHEN unique_violation THEN  -- another first save committed while this one ran
      RAISE EXCEPTION 'Someone else changed the % threshold since you opened this screen.', p_depth
        USING ERRCODE = 'IV409';
    END;
  ELSE
    UPDATE inv.lvl_depth_thresholds SET threshold_lf = p_lf::integer WHERE depth = p_depth RETURNING * INTO t;
  END IF;
  RETURN inv.finish_action(a.log_id, NULL,
                           CASE WHEN was.depth IS NOT NULL THEN inv.lvl_depth_threshold_json(was) END,
                           inv.lvl_depth_threshold_json(t));
END
$$;

CREATE FUNCTION inv.supplier_json(x inv.suppliers) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('id', x.id, 'name', x.name, 'version', x.version) $$;

-- Saves a supplier's name, new (p_id null) or renamed, refusing a blank or
-- a name already listed. Shared by add and rename, which differ only in the
-- row they start from.
CREATE FUNCTION inv.save_supplier(p_log_id bigint, p_id bigint, p_version integer, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  was inv.suppliers;
  x inv.suppliers;
BEGIN
  IF p_id IS NOT NULL THEN
    SELECT * INTO was FROM inv.suppliers WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That supplier is not on the list.' USING ERRCODE = 'IV400';
    END IF;
    IF p_version IS DISTINCT FROM was.version THEN
      RAISE EXCEPTION 'Someone else changed % since you opened this screen.', was.name
        USING ERRCODE = 'IV409', DETAIL = inv.supplier_json(was)::text;
    END IF;
  END IF;
  IF coalesce(inv.tidy(p_name), '') = '' THEN
    RAISE EXCEPTION 'A supplier needs a name.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    IF p_id IS NULL THEN
      INSERT INTO inv.suppliers (name) VALUES (inv.tidy(p_name)) RETURNING * INTO x;
    ELSE
      UPDATE inv.suppliers SET name = inv.tidy(p_name) WHERE id = p_id RETURNING * INTO x;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '% is already on the list.', inv.tidy(p_name) USING ERRCODE = 'IV400';
  END;
  RETURN inv.finish_action(p_log_id, x.id,
                           CASE WHEN p_id IS NOT NULL THEN inv.supplier_json(was) END, inv.supplier_json(x));
END
$$;

-- Settings → Suppliers → Add.
CREATE FUNCTION inv.add_supplier(p_actor bigint, p_key uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'add supplier', 'suppliers', NULL,
                        pg_catalog.jsonb_build_object('name', p_name));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  RETURN inv.save_supplier(a.log_id, NULL, NULL, p_name);
END
$$;

-- Settings → Suppliers → change a name.
CREATE FUNCTION inv.rename_supplier(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'rename supplier', 'suppliers', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'name', p_name));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  RETURN inv.save_supplier(a.log_id, p_id, p_version, p_name);
END
$$;

CREATE FUNCTION inv.reason_json(r inv.reasons) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', r.id, 'text', r.text, 'active', r.active, 'built_in', r.built_in, 'version', r.version)
$$;

-- Settings → Reasons → Add.
CREATE FUNCTION inv.add_reason(p_actor bigint, p_key uuid, p_text text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  r inv.reasons;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'add reason', 'reasons', NULL,
                        pg_catalog.jsonb_build_object('text', p_text));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF coalesce(inv.tidy(p_text), '') = '' THEN
    RAISE EXCEPTION 'A reason needs some text.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    INSERT INTO inv.reasons (text) VALUES (inv.tidy(p_text)) RETURNING * INTO r;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION '"%" is already on the list.', inv.tidy(p_text) USING ERRCODE = 'IV400';
  END;
  RETURN inv.finish_action(a.log_id, r.id, NULL, inv.reason_json(r));
END
$$;

-- Retire and un-retire differ only in the direction of one flag.
CREATE FUNCTION inv.set_reason_active(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action text := CASE WHEN p_active THEN 'un-retire reason' ELSE 'retire reason' END;
  a record;
  was inv.reasons;
  r inv.reasons;
BEGIN
  a := inv.claim_action(p_actor, p_key, v_action, 'reasons', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.reasons WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That reason is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  IF p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed "%" since you opened this screen.', was.text
      USING ERRCODE = 'IV409', DETAIL = inv.reason_json(was)::text;
  END IF;
  IF was.active = p_active THEN
    RAISE EXCEPTION '"%" is already %.', was.text, CASE WHEN p_active THEN 'in use' ELSE 'retired' END
      USING ERRCODE = 'IV422';
  END IF;
  IF was.built_in THEN
    RAISE EXCEPTION 'The app relies on "%", so it cannot be retired.', was.text USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.reasons SET active = p_active WHERE id = p_id RETURNING * INTO r;
  RETURN inv.finish_action(a.log_id, r.id, inv.reason_json(was), inv.reason_json(r));
END
$$;

-- Settings → Reasons → Retire.
CREATE FUNCTION inv.retire_reason(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_reason_active(p_actor, p_key, p_id, p_version, false) $$;

-- Settings → Reasons → Un-retire.
CREATE FUNCTION inv.unretire_reason(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_reason_active(p_actor, p_key, p_id, p_version, true) $$;

CREATE FUNCTION inv.lumber_lengths_json(l inv.lumber_purchasable_lengths) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'size', l.size, 'grade', l.grade, 'lengths', pg_catalog.to_jsonb(l.lengths), 'version', l.version)
$$;

CREATE FUNCTION inv.grade_redirect_json(r inv.lumber_grade_redirects) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'size', r.size, 'from_grade', r.from_grade, 'to_grade', r.to_grade, 'version', r.version)
$$;

-- Planner → Lumber → the stock-lengths panel: one size and grade's lengths.
-- p_version is null for a group saved for the first time.
CREATE FUNCTION inv.set_lumber_lengths(
  p_actor bigint, p_key uuid, p_size text, p_grade text, p_version integer, p_lengths numeric[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lumber_purchasable_lengths;
  l inv.lumber_purchasable_lengths;
  v_lengths integer[];
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set lumber lengths', 'lumber_purchasable_lengths', NULL,
                        pg_catalog.jsonb_build_object('size', p_size, 'grade', p_grade,
                                                      'version', p_version, 'lengths', p_lengths));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF coalesce(inv.tidy(p_size), '') = '' OR coalesce(inv.tidy(p_grade), '') = '' THEN
    RAISE EXCEPTION 'A lumber group needs a size and a grade.' USING ERRCODE = 'IV400';
  END IF;
  PERFORM inv.check_lumber_size(inv.tidy(p_size));
  IF p_lengths IS NULL OR EXISTS (SELECT FROM pg_catalog.unnest(p_lengths) n
                                   WHERE n IS NULL OR n <> pg_catalog.trunc(n) OR n <= 0) THEN
    RAISE EXCEPTION 'A stock length is a whole number of feet above 0.' USING ERRCODE = 'IV400';
  END IF;
  SELECT coalesce(pg_catalog.array_agg(DISTINCT n::integer ORDER BY n::integer), '{}') INTO v_lengths
    FROM pg_catalog.unnest(p_lengths) n;
  SELECT * INTO was FROM inv.lumber_purchasable_lengths
   WHERE size = inv.tidy(p_size) AND grade = inv.tidy(p_grade) FOR UPDATE;
  IF FOUND IS DISTINCT FROM (p_version IS NOT NULL) OR p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed % % since you opened this screen.', p_size, p_grade
      USING ERRCODE = 'IV409', DETAIL = coalesce(inv.lumber_lengths_json(was)::text, 'null');
  END IF;
  IF was.size IS NULL THEN
    SELECT * INTO l FROM inv.lumber_purchasable_lengths
     WHERE size = inv.tidy(p_size) AND pg_catalog.lower(grade) = pg_catalog.lower(inv.tidy(p_grade));
    IF FOUND THEN
      RAISE EXCEPTION '% % is already on the list as % %.', inv.tidy(p_size), inv.tidy(p_grade), l.size, l.grade
        USING ERRCODE = 'IV400';
    END IF;
    BEGIN
      INSERT INTO inv.lumber_purchasable_lengths (size, grade, lengths)
      VALUES (inv.tidy(p_size), inv.tidy(p_grade), v_lengths) RETURNING * INTO l;
    EXCEPTION WHEN unique_violation THEN  -- another first save committed while this one ran
      RAISE EXCEPTION 'Someone else changed % % since you opened this screen.', p_size, p_grade
        USING ERRCODE = 'IV409';
    END;
  ELSE
    UPDATE inv.lumber_purchasable_lengths SET lengths = v_lengths
     WHERE size = was.size AND grade = was.grade RETURNING * INTO l;
  END IF;
  RETURN inv.finish_action(a.log_id, NULL,
                           CASE WHEN was.size IS NOT NULL THEN inv.lumber_lengths_json(was) END,
                           inv.lumber_lengths_json(l));
END
$$;

-- Planner → Lumber: removes a size and grade added by mistake. Only a group
-- that is not bought (no length switched on) and that no redirect names, from
-- it or to it, so a buy list never loses a group it uses.
CREATE FUNCTION inv.remove_lumber_group(
  p_actor bigint, p_key uuid, p_size text, p_grade text, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lumber_purchasable_lengths;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'remove lumber group', 'lumber_purchasable_lengths', NULL,
                        pg_catalog.jsonb_build_object('size', p_size, 'grade', p_grade, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.lumber_purchasable_lengths
   WHERE size = inv.tidy(p_size) AND grade = inv.tidy(p_grade) FOR UPDATE;
  IF NOT FOUND OR was.version IS DISTINCT FROM p_version THEN
    RAISE EXCEPTION 'Someone else changed % % since you opened this screen.', p_size, p_grade
      USING ERRCODE = 'IV409', DETAIL = coalesce(inv.lumber_lengths_json(was)::text, 'null');
  END IF;
  IF pg_catalog.cardinality(was.lengths) > 0 THEN
    RAISE EXCEPTION '% % has lengths switched on. Switch them off before you remove it.', was.size, was.grade
      USING ERRCODE = 'IV422';
  END IF;
  IF EXISTS (SELECT FROM inv.lumber_grade_redirects r
              WHERE r.size = was.size AND r.to_grade IS NOT NULL
                AND pg_catalog.lower(was.grade) IN (pg_catalog.lower(r.from_grade), pg_catalog.lower(r.to_grade))) THEN
    RAISE EXCEPTION 'A redirect names % %. Clear it before you remove it.', was.size, was.grade
      USING ERRCODE = 'IV422';
  END IF;
  DELETE FROM inv.lumber_purchasable_lengths WHERE size = was.size AND grade = was.grade;
  RETURN inv.finish_action(a.log_id, NULL, inv.lumber_lengths_json(was), NULL);
END
$$;

-- Planner → Lumber → "Redirect to": p_to_grade null clears the redirect.
-- p_version is null for a size and grade redirected for the first time.
CREATE FUNCTION inv.set_grade_redirect(
  p_actor bigint, p_key uuid, p_size text, p_from_grade text, p_version integer, p_to_grade text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.lumber_grade_redirects;
  r inv.lumber_grade_redirects;
  v_to text := NULLIF(inv.tidy(p_to_grade), '');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set grade redirect', 'lumber_grade_redirects', NULL,
                        pg_catalog.jsonb_build_object('size', p_size, 'from_grade', p_from_grade,
                                                      'version', p_version, 'to_grade', p_to_grade));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF coalesce(inv.tidy(p_size), '') = '' OR coalesce(inv.tidy(p_from_grade), '') = '' THEN
    RAISE EXCEPTION 'A redirect needs a size and a grade.' USING ERRCODE = 'IV400';
  END IF;
  PERFORM inv.check_lumber_size(inv.tidy(p_size));
  IF pg_catalog.lower(v_to) = pg_catalog.lower(inv.tidy(p_from_grade)) THEN
    RAISE EXCEPTION 'A grade cannot be redirected to itself.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO was FROM inv.lumber_grade_redirects
   WHERE size = inv.tidy(p_size) AND pg_catalog.lower(from_grade) = pg_catalog.lower(inv.tidy(p_from_grade)) FOR UPDATE;
  IF FOUND IS DISTINCT FROM (p_version IS NOT NULL) OR p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed the % % redirect since you opened this screen.', p_size, p_from_grade
      USING ERRCODE = 'IV409', DETAIL = coalesce(inv.grade_redirect_json(was)::text, 'null');
  END IF;
  IF was.size IS NULL THEN
    BEGIN
      INSERT INTO inv.lumber_grade_redirects (size, from_grade, to_grade)
      VALUES (inv.tidy(p_size), inv.tidy(p_from_grade), v_to) RETURNING * INTO r;
    EXCEPTION WHEN unique_violation THEN  -- another first save committed while this one ran
      RAISE EXCEPTION 'Someone else changed the % % redirect since you opened this screen.', p_size, p_from_grade
        USING ERRCODE = 'IV409';
    END;
  ELSE
    UPDATE inv.lumber_grade_redirects SET to_grade = v_to
     WHERE size = was.size AND from_grade = was.from_grade RETURNING * INTO r;
  END IF;
  RETURN inv.finish_action(a.log_id, NULL,
                           CASE WHEN was.size IS NOT NULL THEN inv.grade_redirect_json(was) END,
                           inv.grade_redirect_json(r));
END
$$;

-- The owner's catalog import (#81, "How existing data comes in"), run by
-- src/db/import-catalog.js over the direct connection, never by the app: the
-- app's login cannot run it. One save: it all succeeds or nothing changes (S21).
-- It only adds. An item already in the catalog is skipped with its pack
-- sizes, so running it again never overwrites an edit made in the app. It
-- answers the counts added and skipped, and each skipped item by name (#81 story 96).
--   p_admin_email  the admin the activity log names as the importer
--   p_items        [{family, identity, stocking, threshold}]
--   p_pack_sizes   [{family, identity, kind, pieces}]
--   p_lvl_depths   [{depth, threshold_lf}]
CREATE FUNCTION inv.import_catalog(
  p_admin_email text, p_items jsonb, p_pack_sizes jsonb, p_lvl_depths jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  r jsonb;
  v inv.items;
  v_id bigint;
  v_added bigint[] := '{}';
  v_skipped text[] := '{}';
  v_lf jsonb;
  n_items int := 0; n_packs int := 0; n_depths int := 0;
  s_items int := 0; s_packs int := 0; s_depths int := 0;
BEGIN
  a := inv.claim_action(
         (SELECT id FROM inv.users WHERE email = pg_catalog.lower(inv.tidy(p_admin_email))),
         pg_catalog.gen_random_uuid(), 'import catalog', 'items', NULL,
         pg_catalog.jsonb_build_object('items', p_items, 'pack_sizes', p_pack_sizes, 'lvl_depths', p_lvl_depths));

  FOR r IN SELECT * FROM pg_catalog.jsonb_array_elements(coalesce(p_items, '[]')) LOOP
    v := inv.new_item(r ->> 'family', r -> 'identity');
    PERFORM inv.check_threshold(v.family, r -> 'threshold');
    IF coalesce(r ->> 'stocking', '') NOT IN ('Stocked', 'Non-Stock', 'Special Order') THEN
      RAISE EXCEPTION 'The stocking status is Stocked, Non-Stock or Special Order.' USING ERRCODE = 'IV400';
    END IF;
    INSERT INTO inv.items (family, sku, product, size, grade, length_ft, stocking, threshold)
    VALUES (v.family, v.sku, v.product, v.size, v.grade, v.length_ft, r ->> 'stocking', (r ->> 'threshold')::integer)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN s_items := s_items + 1; v_skipped := v_skipped || inv.item_label(v);
    ELSE n_items := n_items + 1; v_added := v_added || v_id;
    END IF;
  END LOOP;

  FOR r IN SELECT * FROM pg_catalog.jsonb_array_elements(coalesce(p_pack_sizes, '[]')) LOOP
    v := inv.new_item(r ->> 'family', r -> 'identity');
    SELECT id INTO v_id FROM inv.items i WHERE inv.same_item(i, v);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A pack size names %, which is not in the catalog.', inv.item_label(v) USING ERRCODE = 'IV400';
    END IF;
    PERFORM inv.check_pieces((r ->> 'pieces')::numeric);
    IF v_id = ANY (v_added) AND EXISTS (SELECT FROM inv.pack_sizes WHERE item_id = v_id AND kind = r ->> 'kind') THEN
      -- The item is new in this run, so its other size came from this list.
      RAISE EXCEPTION 'The pack sizes give % two % sizes.', inv.item_label(v), r ->> 'kind' USING ERRCODE = 'IV400';
    END IF;
    IF v_id = ANY (v_added) THEN
      INSERT INTO inv.pack_sizes (item_id, kind, pieces) VALUES (v_id, r ->> 'kind', (r ->> 'pieces')::integer)
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_id;
    ELSE
      v_id := NULL;
    END IF;
    IF v_id IS NULL THEN s_packs := s_packs + 1; ELSE n_packs := n_packs + 1; END IF;
  END LOOP;

  FOR r IN SELECT * FROM pg_catalog.jsonb_array_elements(coalesce(p_lvl_depths, '[]')) LOOP
    v_lf := r -> 'threshold_lf';
    IF coalesce(inv.tidy(r ->> 'depth'), '') = '' OR (v_lf IS NOT NULL AND v_lf <> 'null' AND NOT (
         pg_catalog.jsonb_typeof(v_lf) = 'number' AND v_lf::numeric = pg_catalog.trunc(v_lf::numeric)
         AND v_lf::numeric >= 0)) THEN
      RAISE EXCEPTION 'An LVL depth threshold needs a depth and a whole number of linear feet, 0 or more, or blank.'
        USING ERRCODE = 'IV400';
    END IF;
    -- A typing error ("11 7/8" for "11-7/8") would make that depth Special Order.
    IF NOT EXISTS (SELECT FROM inv.items WHERE family = 'lvl' AND size = inv.tidy(r ->> 'depth')) THEN
      RAISE EXCEPTION 'No LVL item has the depth "%". Check the LVL thresholds file.', inv.tidy(r ->> 'depth')
        USING ERRCODE = 'IV400';
    END IF;
    INSERT INTO inv.lvl_depth_thresholds (depth, threshold_lf)
    VALUES (inv.tidy(r ->> 'depth'), (r ->> 'threshold_lf')::integer)
    ON CONFLICT DO NOTHING
    RETURNING 1 INTO v_id;
    IF v_id IS NULL THEN s_depths := s_depths + 1; ELSE n_depths := n_depths + 1; END IF;
  END LOOP;

  RETURN inv.finish_action(a.log_id, NULL, NULL, pg_catalog.jsonb_build_object(
    'added', pg_catalog.jsonb_build_object('items', n_items, 'pack_sizes', n_packs, 'lvl_depth_thresholds', n_depths),
    'skipped', pg_catalog.jsonb_build_object('items', s_items, 'pack_sizes', s_packs, 'lvl_depth_thresholds', s_depths),
    'skipped_items', pg_catalog.to_jsonb(v_skipped)));
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.add_item(bigint, uuid, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.edit_item(bigint, uuid, bigint, integer, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.retire_item(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.unretire_item(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.add_pack_size(bigint, uuid, bigint, text, numeric) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.change_pack_size(bigint, uuid, bigint, integer, numeric) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.set_lvl_depth_threshold(bigint, uuid, text, integer, numeric) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.add_supplier(bigint, uuid, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.rename_supplier(bigint, uuid, bigint, integer, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.add_reason(bigint, uuid, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.retire_reason(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.unretire_reason(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.set_lumber_lengths(bigint, uuid, text, text, integer, numeric[]) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.set_grade_redirect(bigint, uuid, text, text, integer, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.remove_lumber_group(bigint, uuid, text, text, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.rename_item(bigint, uuid, bigint, integer, jsonb) TO inv_app;
-- The app reads the list for the size pickers (src/inventory/catalog.js).
GRANT EXECUTE ON FUNCTION inv.lumber_sizes() TO inv_app;
