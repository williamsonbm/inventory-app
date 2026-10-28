-- #129 (spec #127): a lumber PO line may leave its amount ordered blank
-- ("Not known"). Source: spec #127, owner J218. Every name is fully
-- qualified (#28).
--
-- Reach: inv.po_lines.ordered may be blank, for a family whose amount is
-- optional (lumber) only, whatever writes the row. inv.checked_po_line takes
-- a blank lumber amount. inv.po_json gives each line `waiting`, and the PO's
-- status treats a blank amount as waiting. inv.receive closes a line with no
-- amount at its delivery with a new built-in reason, "Arrived, amount not
-- known", which no one picks by hand (inv.checked_reason). inv.edit_po may
-- give such a line an amount. Adds one reasons row; existing lines keep their
-- amounts. Same signatures, so inv_app keeps its grants.
-- Recovery: give every blank amount one, put back NOT NULL, drop the trigger,
-- its function and families.amount_optional, re-open the lines the reason
-- closed, delete the reason and its entry value, and rerun 004's and 016's
-- versions of the functions replaced here as CREATE OR REPLACE.

-- Whether a family's PO line may leave its amount ordered blank because the
-- supplier has not said how much will come (spec #127): lumber only.
ALTER TABLE inv.families ADD COLUMN amount_optional boolean NOT NULL DEFAULT false;
UPDATE inv.families SET amount_optional = true WHERE code = 'lumber';

ALTER TABLE inv.po_lines ALTER COLUMN ordered DROP NOT NULL;

-- A blank amount only for a family whose amount is optional, whatever
-- writes the row. inv.checked_po_line gives a person the words with the
-- line's number; this is the guarantee.
CREATE FUNCTION inv.check_po_line_amount() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  f inv.families;
BEGIN
  IF NEW.ordered IS NOT NULL THEN RETURN NEW; END IF;
  SELECT x.* INTO f FROM inv.items i JOIN inv.families x ON x.code = i.family WHERE i.id = NEW.item_id;
  IF NOT f.amount_optional THEN
    RAISE EXCEPTION 'A % PO line needs its amount ordered.', f.name USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_amount BEFORE INSERT OR UPDATE OF item_id, ordered ON inv.po_lines
  FOR EACH ROW EXECUTE FUNCTION inv.check_po_line_amount();

-- 004's inv.checked_po_line, with a blank amount taken for a family whose
-- amount is optional; otherwise as 004.
CREATE OR REPLACE FUNCTION inv.checked_po_line(n integer, r jsonb, p_was_item bigint) RETURNS inv.po_lines
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i inv.items;
  f inv.families;
  l inv.po_lines;
BEGIN
  SELECT * INTO i FROM inv.items
   WHERE id = CASE WHEN inv.is_whole_above_zero(r -> 'item_id') THEN (r ->> 'item_id')::bigint END;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Line %: pick the item from the catalog.', n USING ERRCODE = 'IV400';
  END IF;
  IF NOT i.active AND i.id IS DISTINCT FROM p_was_item THEN
    RAISE EXCEPTION 'Line %: % is retired. Un-retire it before you order it.', n, inv.item_label(i)
      USING ERRCODE = 'IV422';
  END IF;
  SELECT * INTO f FROM inv.families WHERE code = i.family;
  IF NOT (inv.is_whole_above_zero(r -> 'ordered') OR f.amount_optional AND NOT inv.is_given(r -> 'ordered')) THEN
    RAISE EXCEPTION 'Line %: the amount ordered is a whole number of % above 0%.', n, f.order_unit,
      CASE WHEN f.amount_optional THEN ', or blank when not known' ELSE '' END USING ERRCODE = 'IV400';
  END IF;
  IF coalesce(r -> 'pack_size', 'null') <> 'null' AND NOT inv.is_whole_above_zero(r -> 'pack_size') THEN
    RAISE EXCEPTION 'Line %: a pack size is a whole number of pieces above 0, or blank.', n USING ERRCODE = 'IV400';
  END IF;
  l.item_id := i.id;
  l.ordered := (r ->> 'ordered')::integer;
  l.pack_size := (r ->> 'pack_size')::integer;
  RETURN l;
END
$$;

-- 004's inv.po_json, with `waiting` on each line and the status read from
-- it; otherwise as 004. A line waits for a delivery (spec #127) while it
-- is open and either more is to arrive than has, or its amount is not
-- known. The PO's status and the pages read this one rule.
CREATE OR REPLACE FUNCTION inv.po_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lines AS (
    SELECT x.*, x.closed_reason IS NULL AND (x.ordered IS NULL OR x.received < x.ordered) AS waiting
      FROM (SELECT l.*, inv.item_label(i) AS item, r.text AS closed_reason, inv.received(l.id) AS received
              FROM inv.po_lines l JOIN inv.items i ON i.id = l.item_id
              LEFT JOIN inv.reasons r ON r.id = l.closed_reason_id
             WHERE l.po_id = p_id) x)
  SELECT pg_catalog.jsonb_build_object(
    'id', po.id, 'version', po.version, 'supplier_id', po.supplier_id, 'supplier', s.name,
    'number', po.number, 'po_date', po.po_date,
    'status', CASE WHEN NOT EXISTS (SELECT FROM lines WHERE waiting) THEN 'finished'
                   WHEN EXISTS (SELECT FROM lines WHERE received > 0) THEN 'partial'
                   ELSE 'ordered' END,
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', id, 'item_id', item_id, 'item', item, 'ordered', ordered, 'received', received,
                'pack_size', pack_size, 'closed_reason', closed_reason, 'waiting', waiting) ORDER BY id), '[]')
                FROM lines))
    FROM inv.purchase_orders po JOIN inv.suppliers s ON s.id = po.supplier_id
   WHERE po.id = p_id
$$;

-- The reason a line with no amount closes itself with at its first delivery
-- (spec #127). Built in, like "Weathered – trimmed": only inv.receive sets it.
ALTER TABLE inv.reasons DROP CONSTRAINT reasons_entry_check;
ALTER TABLE inv.reasons ADD CONSTRAINT reasons_entry_check CHECK (entry IN ('trim', 'import', 'receive'));
INSERT INTO inv.reasons (text, built_in, entry) VALUES ('Arrived, amount not known', true, 'receive');

-- 004's inv.checked_reason, refusing the reason a delivery sets; otherwise as 004.
CREATE OR REPLACE FUNCTION inv.checked_reason(p_id bigint, what text) RETURNS inv.reasons
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r inv.reasons;
BEGIN
  SELECT * INTO r FROM inv.reasons WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% needs a reason from the list.', what USING ERRCODE = 'IV400';
  END IF;
  IF NOT r.active THEN
    RAISE EXCEPTION '"%" is retired. Pick a reason in use.', r.text USING ERRCODE = 'IV400';
  END IF;
  IF r.entry = 'trim' THEN
    RAISE EXCEPTION '"%" is for a trim. Use Trim on the LVL item.', r.text USING ERRCODE = 'IV422';
  ELSIF r.entry = 'import' THEN
    RAISE EXCEPTION '"%" is for the cutover import only.', r.text USING ERRCODE = 'IV422';
  ELSIF r.entry = 'receive' THEN
    RAISE EXCEPTION '"%" is set by a delivery on a line with no amount.', r.text USING ERRCODE = 'IV422';
  END IF;
  RETURN r;
END
$$;

-- 016's inv.receive, closing a line with no amount at its delivery and
-- naming it in `closed_lines`; otherwise as 016.
CREATE OR REPLACE FUNCTION inv.receive(
  p_actor bigint, p_key uuid, p_po_id bigint, p_po_version integer, p_supplier_id bigint, p_bol text, p_lines jsonb,
  p_replaces bigint DEFAULT NULL, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_timed jsonb;
  v_receipt bigint;
  v_at timestamptz;
  v_added jsonb := '[]';
  g inv.ledger;
  r jsonb;
  n integer;
  v_last integer;  -- the PO's last line number; a line not on the PO comes after it
  v_closed jsonb;  -- the no-amount lines this delivery closed, for the Activity Log
  v_reason inv.reasons;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'receive', 'receipts', NULL,
                        pg_catalog.jsonb_build_object('po_id', p_po_id, 'po_version', p_po_version,
                                                      'supplier_id', p_supplier_id, 'bol', p_bol, 'lines', p_lines,
                                                      'replaces', p_replaces, 'timing', p_timing));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF p_po_id IS NOT NULL AND p_supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'A receipt against a PO takes its PO''s supplier.' USING ERRCODE = 'IV400';
  ELSIF p_po_id IS NOT NULL THEN
    -- Before the version check, so a screen opened before the PO finished
    -- gets this message, not "Someone else changed this PO". Deliberately
    -- its own lock before the status is read, not only inv.po_at_version's:
    -- without it, of two receipts saved at once, the second reads the status
    -- before the first commits and gets "Someone else changed this PO".
    -- A Reverse and enter again of a line on this PO is let in (owner, J208).
    PERFORM FROM inv.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF inv.po_json(p_po_id) ->> 'status' = 'finished'
       AND NOT EXISTS (SELECT FROM inv.ledger replaced JOIN inv.po_lines l ON l.id = replaced.po_line_id
                        WHERE replaced.id = p_replaces AND l.po_id = p_po_id) THEN
      RAISE EXCEPTION 'This PO is finished. Nothing more is expected on it. For a late extra delivery, Edit the PO to a larger amount, Re-open a line, or Receive without a PO.'
        USING ERRCODE = 'IV422';
    END IF;
    PERFORM inv.po_at_version(p_po_id, p_po_version);
  ELSIF NOT EXISTS (SELECT FROM inv.suppliers WHERE id = p_supplier_id) THEN
    RAISE EXCEPTION 'Pick the supplier from the list.' USING ERRCODE = 'IV400';
  END IF;
  -- After the PO's check: reversing a line it replaces on the same PO moves
  -- that PO on too, and must not make this screen look stale (Q76).
  v_at := inv.replaced_at(a.log_id, p_replaces);
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A receipt lists its lines.' USING ERRCODE = 'IV400';
  END IF;
  -- A line with no pieces, packs or loose filled in is a PO line nothing
  -- arrived on this time, and is skipped. "Line n" is the number the Receive
  -- page shows (owner, Q74): a PO line's own number, closed lines counted,
  -- as on the PO list; a line not on the PO, numbered on after the PO's last.
  IF NOT EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(p_lines) e WHERE NOT inv.is_blank_receipt_line(e)) THEN
    RAISE EXCEPTION 'Nothing to receive. Fill in the pieces that arrived.' USING ERRCODE = 'IV400';
  END IF;
  INSERT INTO inv.receipts (po_id, supplier_id, bol)
  VALUES (p_po_id, p_supplier_id, nullif(inv.tidy(p_bol), '')) RETURNING id INTO v_receipt;
  v_last := (SELECT pg_catalog.count(*) FROM inv.po_lines WHERE po_id = p_po_id);
  FOR r, n IN
    SELECT e, coalesce(inv.po_line_number(l.id), v_last + pg_catalog.count(*) FILTER (WHERE l.id IS NULL) OVER (ORDER BY e_n)::integer)
      FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS x(e, e_n)
      LEFT JOIN inv.po_lines l
        ON l.po_id = p_po_id AND l.id = CASE WHEN inv.is_whole_above_zero(e -> 'po_line_id') THEN (e ->> 'po_line_id')::bigint END
     ORDER BY e_n LOOP
    CONTINUE WHEN inv.is_blank_receipt_line(r);
    g := inv.checked_receipt_line(n, r, p_po_id);
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, receipt_id, po_line_id,
                            packs, pack_size, pack_kind, loose)
    VALUES (g.item_id, g.quantity, 'receipt', v_at, a.log_id, v_receipt, g.po_line_id,
            g.packs, g.pack_size, g.pack_kind, g.loose);
    -- Story 19 = B (owner, 2026-10-03): a size typed for a kind the item has
    -- no size of becomes its size on file, logged with this receipt. One it
    -- has already stays; only Settings → Pack sizes changes that.
    IF g.pack_size IS NOT NULL THEN
      INSERT INTO inv.pack_sizes (item_id, kind, pieces) VALUES (g.item_id, g.pack_kind, g.pack_size)
      ON CONFLICT (item_id, kind) DO NOTHING;
      IF FOUND THEN
        v_added := v_added || pg_catalog.jsonb_build_object(
          'item', (SELECT inv.item_label(i) FROM inv.items i WHERE i.id = g.item_id), 'kind', g.pack_kind, 'pieces', g.pack_size);
      END IF;
    END IF;
  END LOOP;
  -- A line with no amount closes itself at a delivery (spec #127), in this
  -- save, so the PO is Finished when nothing else waits. Re-open lets it
  -- take another, after which it closes itself again.
  SELECT * INTO v_reason FROM inv.reasons WHERE entry = 'receive';
  WITH closed AS (
    UPDATE inv.po_lines l SET closed_reason_id = v_reason.id
     WHERE l.po_id = p_po_id AND l.ordered IS NULL AND l.closed_reason_id IS NULL
       AND EXISTS (SELECT FROM inv.ledger x WHERE x.receipt_id = v_receipt AND x.po_line_id = l.id)
    RETURNING l.id)
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'po_line', inv.po_line_number(c.id), 'reason', v_reason.text) ORDER BY c.id), '[]')
    INTO v_closed
    FROM closed c;
  v_timed := inv.time_entry(a.log_id, p_replaces, p_timing);
  RETURN inv.finish_action(a.log_id, v_receipt, NULL,
    inv.receipt_json(v_receipt) || pg_catalog.jsonb_build_object('pack_sizes_added', v_added, 'closed_lines', v_closed)
    || inv.replaced_json(a.log_id, p_replaces) || v_timed);
END
$$;

-- 004's inv.edit_po, giving an amount to a line that closed itself at a
-- delivery with no amount; otherwise as 004.
CREATE OR REPLACE FUNCTION inv.edit_po(
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
     WHERE po_id = p_id AND id = CASE WHEN inv.is_whole_above_zero(r -> 'id') THEN (r ->> 'id')::bigint END;
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
    -- A line that closed itself at a delivery with no amount may be given
    -- one (spec #127): it waits again only when more is to come than came.
    -- PO edit rule 4 (inv.check_po_line_received) still holds.
    IF old.closed_reason_id IS NOT NULL THEN
      IF (l.item_id, l.ordered, l.pack_size) IS NOT DISTINCT FROM (old.item_id, old.ordered, old.pack_size) THEN
        CONTINUE;
      END IF;
      IF (l.item_id, l.pack_size) IS DISTINCT FROM (old.item_id, old.pack_size)
         OR NOT EXISTS (SELECT FROM inv.reasons WHERE id = old.closed_reason_id AND entry = 'receive') THEN
        RAISE EXCEPTION 'Line %: that line is closed. Re-open it before you change it.', n USING ERRCODE = 'IV422';
      END IF;
      UPDATE inv.po_lines SET ordered = l.ordered,
             closed_reason_id = CASE WHEN inv.received(id) < l.ordered THEN NULL ELSE closed_reason_id END
       WHERE id = old.id;
      CONTINUE;
    END IF;
    UPDATE inv.po_lines SET item_id = l.item_id, ordered = l.ordered, pack_size = l.pack_size WHERE id = old.id;
  END LOOP;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.po_json(p_id));
END
$$;
