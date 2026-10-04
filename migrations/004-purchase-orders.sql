-- Step 3, part 2 (#81): POs and receiving. All of part 2 goes in this one
-- file, built over several sessions and applied once part 2 is complete
-- (owner, 2026-10-03). It holds POs, the Incoming figure, and the switch
-- that makes a family live in Inventory.
-- Source: docs/database-design.md, "Step 3 — inventory", tables 3, 8 and 9,
-- and "How the numbers are calculated"; #81, "Live in Inventory".
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- Whether a family is live in Inventory (#81, "Live in Inventory: the
-- cutover switch"). Off for every family: the database refuses every PO line
-- for a family that is off, and later ledger entries and counts too, so
-- nothing lands in Production before the cutover. Only the owner's command
-- (src/db/switch-family-live.js) switches a family on, and nothing switches
-- one off: that would strand its records.
ALTER TABLE inv.families ADD COLUMN live boolean NOT NULL DEFAULT false;

-- What a family's PO line is ordered in (Q14): lumber in linear feet, every
-- other family in pieces.
ALTER TABLE inv.families ADD COLUMN order_unit text NOT NULL DEFAULT 'pieces'
  CHECK (order_unit IN ('pieces', 'linear feet'));
UPDATE inv.families SET order_unit = 'linear feet' WHERE code = 'lumber';
ALTER TABLE inv.families ALTER COLUMN order_unit DROP DEFAULT;

-- A PO as entered when the office orders (S12). Who entered it and when come
-- from its activity-log row (target purchase_orders, target_id its id).
CREATE TABLE inv.purchase_orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  supplier_id bigint NOT NULL REFERENCES inv.suppliers (id),
  number      text NOT NULL CHECK (number = inv.tidy(number) AND number <> ''),
  po_date     date NOT NULL,
  -- One version for the PO and its lines (S41), moved on by inv.po_at_version.
  -- Deliberately not a bump_version trigger per table, as on the catalog: a
  -- line is changed only with its PO, and one save must move the version
  -- once whether it changed the header, a line or both. Per-table triggers
  -- would give each line its own version, and an edit would send one per line.
  version     integer NOT NULL DEFAULT 1
);

-- One supplier's PO number is entered once, whatever the capitals, so a PO
-- typed in twice cannot count its material as incoming twice.
CREATE UNIQUE INDEX purchase_orders_number_key ON inv.purchase_orders (supplier_id, pg_catalog.lower(number));

-- What a PO orders: one row per line. ordered is in the family's order unit
-- (inv.families.order_unit): linear feet for lumber, pieces otherwise.
-- pack_size is the line's own copy of the pieces in one pack, if the PO
-- names one (Q13, Q14), so correcting a pack size changes no line.
-- A line is never deleted. One not wanted any more, or not delivered, is
-- closed with a reason (S15, story 39): closed_reason_id is set while it is
-- closed, so a closed line always has its reason. Re-opening clears it.
CREATE TABLE inv.po_lines (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id            bigint NOT NULL REFERENCES inv.purchase_orders (id),
  item_id          bigint NOT NULL REFERENCES inv.items (id),
  ordered          integer NOT NULL CHECK (ordered > 0),
  pack_size        integer CHECK (pack_size > 0),
  closed_reason_id bigint REFERENCES inv.reasons (id)
);

CREATE INDEX po_lines_po_idx ON inv.po_lines (po_id);
CREATE INDEX po_lines_item_idx ON inv.po_lines (item_id);

-- A row's item belongs to a live family, whatever writes the row, refused
-- with the words a person sees (story 57). A trigger, not a CHECK, because
-- the flag is in another table. Switching a family off is not offered, so a
-- row that passed stays true. An item that does not exist is left to the
-- foreign key.
CREATE FUNCTION inv.check_item_family_live() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = NEW.item_id;
  IF FOUND AND NOT f.live THEN
    RAISE EXCEPTION 'The % family is not live in Inventory yet, so it takes no POs, receipts or counts.', f.name
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_family_live BEFORE INSERT OR UPDATE OF item_id ON inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_item_family_live();

-- Every text a person types has a length limit (owner, 2026-10-03): about
-- twice the longest real value, or a published limit (a name 70, the UK
-- government full-name standard; an email 254, RFC 5321). A trigger, so it
-- holds whatever writes the row, 001-003's functions and imports included.
-- Its arguments are triples: column, limit, the words for the refusal. On an
-- update a column is checked only if it changed, so a longer value saved
-- before this migration never blocks another change to its row.
CREATE FUNCTION inv.check_lengths() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_new jsonb := pg_catalog.to_jsonb(NEW);
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN pg_catalog.to_jsonb(OLD) END;
  i integer := 0;
BEGIN
  WHILE i < TG_NARGS LOOP
    IF pg_catalog.char_length(v_new ->> TG_ARGV[i]) > TG_ARGV[i + 1]::integer
       AND (v_old ->> TG_ARGV[i]) IS DISTINCT FROM (v_new ->> TG_ARGV[i]) THEN
      RAISE EXCEPTION '% has at most % characters.', TG_ARGV[i + 2], TG_ARGV[i + 1] USING ERRCODE = 'IV400';
    END IF;
    i := i + 3;
  END LOOP;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.users FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('email', '254', 'An email address', 'name', '70', 'A name');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.items FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('sku', '30', 'A SKU', 'product', '60', 'An LVL product',
    'size', '10', 'An LVL depth', 'grade', '20', 'A grade', 'note', '200', 'A note');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.suppliers FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('name', '60', 'A supplier name');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.reasons FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('text', '60', 'A reason');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.lumber_purchasable_lengths FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('grade', '20', 'A grade');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.lumber_grade_redirects FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('from_grade', '20', 'A grade', 'to_grade', '20', 'A grade');
CREATE TRIGGER check_lengths BEFORE INSERT OR UPDATE ON inv.purchase_orders FOR EACH ROW
  EXECUTE FUNCTION inv.check_lengths('number', '20', 'A PO number');

-- The figures worked out from the records, never stored (#81, "Calculated
-- figures live in one place"): one row per item. The Overview reads it now;
-- the rest of part 2 adds on hand, available and reorder here, and part 4's
-- Planner reads the same view.
-- incoming (story 32) is in the family's order unit. For each PO line it is
-- open line, ordered − received, never below zero; until receiving is
-- built, each open line counts in full. A closed line counts nothing.
CREATE VIEW inv.item_figures AS
SELECT i.id AS item_id, coalesce(pg_catalog.sum(l.ordered), 0)::integer AS incoming
  FROM inv.items i
  LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
 GROUP BY i.id;

INSERT INTO inv.actions (name, admin_only) VALUES ('enter PO', false), ('edit PO', false),
  ('close PO line', false), ('re-open PO line', false), ('switch family live', true);

-- 001's inv.finish_action, with one change: a change whose record is the
-- same before and after, the version aside, is refused (owner, 2026-10-03).
-- One place for every edit, 003's and later parts' included, so the log
-- holds only changes (story 106) and the version stays where the screen read
-- it. An addition or a password action records no "before", so it never
-- meets this.
CREATE OR REPLACE FUNCTION inv.finish_action(p_log_id bigint, p_target_id bigint, p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_new jsonb;
BEGIN
  IF p_old - 'version' = p_new - 'version' THEN
    RAISE EXCEPTION 'Nothing changed, so nothing was saved.' USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.activity_log
     SET target_id = p_target_id, old_value = p_old, new_value = p_new
   WHERE id = p_log_id
  RETURNING new_value INTO v_new;
  RETURN v_new;
END
$$;

CREATE FUNCTION inv.family_json(f inv.families) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('name', f.name, 'live', f.live) $$;

-- The owner's command (#81 story 99), run by src/db/switch-family-live.js
-- over the direct connection, never by the app: the app's login cannot run
-- it. Logged like any change, with the admin the owner names as its actor;
-- an address that is not an active admin's is refused in those words, which
-- inv.claim_action's own refusal does not give.
CREATE FUNCTION inv.set_family_live(p_admin_email text, p_family text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.families;
  f inv.families;
  v_admin bigint := (SELECT id FROM inv.users
                      WHERE email = pg_catalog.lower(inv.tidy(p_admin_email)) AND active AND admin);
BEGIN
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'No active admin has the address %.', p_admin_email USING ERRCODE = 'IV403';
  END IF;
  a := inv.claim_action(v_admin, pg_catalog.gen_random_uuid(), 'switch family live', 'families', NULL,
         pg_catalog.jsonb_build_object('family', p_family));
  SELECT * INTO was FROM inv.families WHERE code = p_family FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no family "%".', p_family USING ERRCODE = 'IV400';
  END IF;
  -- EWP holds no items until step 5 (Q28), so it has nothing to be live with.
  IF was.identity IS NULL THEN
    RAISE EXCEPTION '% stays out of Inventory until step 5.', was.name USING ERRCODE = 'IV422';
  END IF;
  IF was.live THEN
    RAISE EXCEPTION '% is already live in Inventory.', was.name USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.families SET live = true WHERE code = p_family RETURNING * INTO f;
  RETURN inv.finish_action(a.log_id, NULL, inv.family_json(was), inv.family_json(f));
END
$$;

-- A PO with its supplier's name and its lines, in the shape every function
-- returns and logs, and the Receive page lists. Each line carries its item's
-- name, so the Activity Log names the item as it was at the time.
CREATE FUNCTION inv.po_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', po.id, 'version', po.version, 'supplier_id', po.supplier_id, 'supplier', s.name,
    'number', po.number, 'po_date', po.po_date,
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', l.id, 'item_id', l.item_id, 'item', inv.item_label(i), 'ordered', l.ordered,
                'pack_size', l.pack_size, 'closed_reason', r.text) ORDER BY l.id), '[]')
                FROM inv.po_lines l JOIN inv.items i ON i.id = l.item_id
                LEFT JOIN inv.reasons r ON r.id = l.closed_reason_id
               WHERE l.po_id = po.id))
    FROM inv.purchase_orders po JOIN inv.suppliers s ON s.id = po.supplier_id
   WHERE po.id = p_id
$$;

-- Reads and locks the PO a change is about, refusing it when the PO or any
-- of its lines has changed since the screen read it (S41), and moves its
-- version on: every change to a PO or its lines starts here. The refusal's
-- DETAIL is the current PO, so the screen can show what the other save did.
CREATE FUNCTION inv.po_at_version(p_id bigint, p_version integer) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_version integer;
  was jsonb;
BEGIN
  SELECT version INTO v_version FROM inv.purchase_orders WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That PO is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.po_json(p_id);
  IF p_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'Someone else changed this PO since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  UPDATE inv.purchase_orders SET version = version + 1 WHERE id = p_id;
  RETURN was;  -- the PO as it was, for the log
END
$$;

-- Reads the PO line a change is about, and its PO through inv.po_at_version
-- (refused when stale; its version moves on). Shared by close and re-open,
-- which differ only in the state they check and the reason they set.
CREATE FUNCTION inv.po_line_at_version(p_line_id bigint, p_po_version integer, OUT line inv.po_lines, OUT was jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  SELECT * INTO line FROM inv.po_lines WHERE id = p_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That PO line is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.po_at_version(line.po_id, p_po_version);
END
$$;

-- Inventory → Receive → a PO line → Close: the line no longer counts as
-- incoming (S15, story 39). The reason is picked from Settings → Reasons.
CREATE FUNCTION inv.close_po_line(p_actor bigint, p_key uuid, p_line_id bigint, p_po_version integer, p_reason_id bigint)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  x record;
  r inv.reasons;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'close PO line', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('line_id', p_line_id, 'po_version', p_po_version,
                                                      'reason_id', p_reason_id));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  x := inv.po_line_at_version(p_line_id, p_po_version);
  IF (x.line).closed_reason_id IS NOT NULL THEN
    RAISE EXCEPTION 'That line is already closed.' USING ERRCODE = 'IV422';
  END IF;
  SELECT * INTO r FROM inv.reasons WHERE id = p_reason_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Closing a line needs a reason from the list.' USING ERRCODE = 'IV400';
  END IF;
  IF NOT r.active THEN
    RAISE EXCEPTION '"%" is retired. Pick a reason in use.', r.text USING ERRCODE = 'IV400';
  END IF;
  UPDATE inv.po_lines SET closed_reason_id = r.id WHERE id = p_line_id;
  RETURN inv.finish_action(a.log_id, (x.line).po_id, x.was, inv.po_json((x.line).po_id));
END
$$;

-- Inventory → Receive → a closed PO line → Re-open: it counts as incoming again.
CREATE FUNCTION inv.reopen_po_line(p_actor bigint, p_key uuid, p_line_id bigint, p_po_version integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  x record;
BEGIN
  a := inv.claim_action(p_actor, p_key, 're-open PO line', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('line_id', p_line_id, 'po_version', p_po_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  x := inv.po_line_at_version(p_line_id, p_po_version);
  IF (x.line).closed_reason_id IS NULL THEN
    RAISE EXCEPTION 'That line is already open.' USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.po_lines SET closed_reason_id = NULL WHERE id = p_line_id;
  RETURN inv.finish_action(a.log_id, (x.line).po_id, x.was, inv.po_json((x.line).po_id));
END
$$;

-- Whether a JSON value is a whole number above 0 that an integer column
-- holds (at most 2,147,483,647), so a mistyped huge number gets the plain
-- refusal, not Postgres's "out of range". Ids are checked with it too; none
-- comes near that.
CREATE FUNCTION inv.is_count(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(pg_catalog.jsonb_typeof(p) = 'number'
                  AND p::numeric = pg_catalog.trunc(p::numeric) AND p::numeric BETWEEN 1 AND 2147483647, false)
$$;

-- A PO's supplier, number and date as a person gives them, checked and
-- tidied, as a row not saved yet. Shared by inv.enter_po and inv.edit_po, so
-- both refuse the same things.
--   p_po_date  YYYY-MM-DD; deliberately text, checked here, because Postgres
--              would also read "yesterday", or 06/07/2026 by the connection's
--              DateStyle, which a shared pooler connection does not promise.
CREATE FUNCTION inv.checked_po(p_supplier_id bigint, p_number text, p_po_date text) RETURNS inv.purchase_orders
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  po inv.purchase_orders;
BEGIN
  IF NOT EXISTS (SELECT FROM inv.suppliers WHERE id = p_supplier_id) THEN
    RAISE EXCEPTION 'Pick the supplier from the list.' USING ERRCODE = 'IV400';
  END IF;
  po.supplier_id := p_supplier_id;
  po.number := inv.tidy(p_number);
  IF coalesce(po.number, '') = '' THEN
    RAISE EXCEPTION 'A PO needs its number.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    IF p_po_date ~ '^\d{4}-\d{2}-\d{2}$' THEN po.po_date := p_po_date::date; END IF;
  EXCEPTION WHEN datetime_field_overflow THEN  -- 2026-02-30
    NULL;
  END;
  IF po.po_date IS NULL THEN
    RAISE EXCEPTION 'A PO date is a real date, written like 2026-10-03.' USING ERRCODE = 'IV400';
  END IF;
  RETURN po;
END
$$;

-- Called when a save breaks purchase_orders_number_key.
CREATE FUNCTION inv.refuse_po_number_in_use(po inv.purchase_orders) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'PO % from % is already entered.', po.number,
    (SELECT name FROM inv.suppliers WHERE id = po.supplier_id) USING ERRCODE = 'IV400';
END
$$;

-- Line n of a PO as a person gives it ({item_id, ordered, pack_size}),
-- checked, as a row not saved yet. Shared by inv.enter_po and inv.edit_po.
-- p_was_item is the item the line already orders (null for a new line): a
-- retired item cannot come onto a PO, but a line whose item was retired
-- since it was entered still saves. A family not live in Inventory is
-- refused by the trigger on inv.po_lines when the line is saved.
CREATE FUNCTION inv.checked_po_line(n integer, r jsonb, p_was_item bigint) RETURNS inv.po_lines
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
  l inv.po_lines;
BEGIN
  SELECT * INTO i FROM inv.items
   WHERE id = CASE WHEN inv.is_count(r -> 'item_id') THEN (r ->> 'item_id')::bigint END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: pick the item from the catalog.', n USING ERRCODE = 'IV400';
  END IF;
  IF NOT i.active AND i.id IS DISTINCT FROM p_was_item THEN
    RAISE EXCEPTION 'Line %: % is retired. Un-retire it before you order it.', n, inv.item_label(i)
      USING ERRCODE = 'IV422';
  END IF;
  IF NOT inv.is_count(r -> 'ordered') THEN
    RAISE EXCEPTION 'Line %: the amount ordered is a whole number of % above 0.', n,
      (SELECT order_unit FROM inv.families WHERE code = i.family) USING ERRCODE = 'IV400';
  END IF;
  IF coalesce(r -> 'pack_size', 'null') <> 'null' AND NOT inv.is_count(r -> 'pack_size') THEN
    RAISE EXCEPTION 'Line %: a pack size is a whole number of pieces above 0, or blank.', n USING ERRCODE = 'IV400';
  END IF;
  l.item_id := i.id;
  l.ordered := (r ->> 'ordered')::integer;
  l.pack_size := (r ->> 'pack_size')::integer;
  RETURN l;
END
$$;

-- Inventory → Receive → Enter a PO (stories 29–31). One save: a refused line
-- leaves nothing saved (S21).
--   p_lines  [{item_id, ordered, pack_size}]; ordered in the item's family's
--            order unit; pack_size blank or pieces per pack.
CREATE FUNCTION inv.enter_po(
  p_actor bigint, p_key uuid, p_supplier_id bigint, p_number text, p_po_date text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  po inv.purchase_orders;
  l inv.po_lines;
  r jsonb;
  n integer;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'enter PO', 'purchase_orders', NULL,
                        pg_catalog.jsonb_build_object('supplier_id', p_supplier_id, 'number', p_number,
                                                      'po_date', p_po_date, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  po := inv.checked_po(p_supplier_id, p_number, p_po_date);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'A PO needs at least one line.' USING ERRCODE = 'IV400';
  END IF;
  BEGIN
    INSERT INTO inv.purchase_orders (supplier_id, number, po_date)
    VALUES (po.supplier_id, po.number, po.po_date) RETURNING id INTO po.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_po_number_in_use(po);
  END;
  FOR r, n IN SELECT e, e_n::integer FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n) LOOP
    l := inv.checked_po_line(n, r, NULL);
    INSERT INTO inv.po_lines (po_id, item_id, ordered, pack_size) VALUES (po.id, l.item_id, l.ordered, l.pack_size);
  END LOOP;
  RETURN inv.finish_action(a.log_id, po.id, NULL, inv.po_json(po.id));
END
$$;

-- Inventory → Receive → a PO → Edit: fixes its supplier, number and date,
-- and its open lines' item, amount and pack size, and adds lines (owner,
-- 2026-10-03). p_lines lists every open line, by id, plus any new line
-- without one; a closed line may be listed too, unchanged. A line is never
-- removed: one not wanted is closed with a reason (inv.close_po_line), and a
-- closed line is re-opened before it is changed. A save that changes nothing
-- is refused by inv.finish_action. Receiving adds its own limits on a line with receipts: its item
-- stays, and its amount never goes below what arrived.
CREATE FUNCTION inv.edit_po(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer,
  p_supplier_id bigint, p_number text, p_po_date text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was jsonb;
  po inv.purchase_orders;
  old inv.po_lines;
  l inv.po_lines;
  r jsonb;
  n integer;
  v_listed bigint[] := '{}';
  v_left_out inv.items;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'edit PO', 'purchase_orders', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'supplier_id', p_supplier_id,
                                                      'number', p_number, 'po_date', p_po_date, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.po_at_version(p_id, p_version);
  po := inv.checked_po(p_supplier_id, p_number, p_po_date);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An edit lists the PO''s lines.' USING ERRCODE = 'IV400';
  END IF;
  SELECT i.* INTO v_left_out FROM inv.po_lines x JOIN inv.items i ON i.id = x.item_id
   WHERE x.po_id = p_id AND x.closed_reason_id IS NULL
     AND NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_lines) e WHERE e ->> 'id' = x.id::text)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is left out. A line is never removed; close it instead.', inv.item_label(v_left_out)
      USING ERRCODE = 'IV422';
  END IF;
  BEGIN
    UPDATE inv.purchase_orders SET supplier_id = po.supplier_id, number = po.number, po_date = po.po_date
     WHERE id = p_id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM inv.refuse_po_number_in_use(po);
  END;
  FOR r, n IN SELECT e, e_n::integer FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n) LOOP
    IF coalesce(r -> 'id', 'null') = 'null' THEN
      l := inv.checked_po_line(n, r, NULL);
      INSERT INTO inv.po_lines (po_id, item_id, ordered, pack_size) VALUES (p_id, l.item_id, l.ordered, l.pack_size);
      CONTINUE;
    END IF;
    SELECT * INTO old FROM inv.po_lines
     WHERE po_id = p_id AND id = CASE WHEN inv.is_count(r -> 'id') THEN (r ->> 'id')::bigint END;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: that line is not on this PO.', n USING ERRCODE = 'IV400';
    END IF;
    IF old.id = ANY (v_listed) THEN
      RAISE EXCEPTION 'Line % repeats a line already listed.', n USING ERRCODE = 'IV400';
    END IF;
    v_listed := v_listed || old.id;
    l := inv.checked_po_line(n, r, old.item_id);
    -- A closed line comes back as it is: the Receive page lists every line,
    -- so "Line n" here is line n on the page and in the Activity Log.
    IF old.closed_reason_id IS NOT NULL THEN
      IF (l.item_id, l.ordered, l.pack_size) IS DISTINCT FROM (old.item_id, old.ordered, old.pack_size) THEN
        RAISE EXCEPTION 'Line %: that line is closed. Re-open it before you change it.', n USING ERRCODE = 'IV422';
      END IF;
      CONTINUE;
    END IF;
    UPDATE inv.po_lines SET item_id = l.item_id, ordered = l.ordered, pack_size = l.pack_size WHERE id = old.id;
  END LOOP;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.po_json(p_id));
END
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.enter_po(bigint, uuid, bigint, text, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.edit_po(bigint, uuid, bigint, integer, bigint, text, text, jsonb) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.close_po_line(bigint, uuid, bigint, integer, bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.reopen_po_line(bigint, uuid, bigint, integer) TO inv_app;
-- The app lists POs in the shape inv.enter_po answers with (src/inventory/catalog.js);
-- inv.po_json names each line's item with inv.item_label, so the app runs that too.
GRANT EXECUTE ON FUNCTION inv.po_json(bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.item_label(inv.items) TO inv_app;
