-- #128 (spec #127): a Finished PO takes no receipt. Source: owner J188,
-- J193, J197. Every name is fully qualified (#28).
--
-- Reach: inv.receive refuses a receipt against a PO that inv.po_json calls
-- finished when the receipt is saved (IV422), even from a screen opened
-- before it finished; a receipt without a PO, and one that brings more than
-- ordered on a line still waiting (S58), are unchanged. Same signature, so
-- inv_app keeps its grant. No row changes.
-- Recovery: rerun 006's CREATE FUNCTION inv.receive as CREATE OR REPLACE.

-- 006's inv.receive with the Finished check added; otherwise as 006.

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
    -- gets this message, not "Someone else changed this PO".
    PERFORM FROM inv.purchase_orders WHERE id = p_po_id FOR UPDATE;
    IF inv.po_json(p_po_id) ->> 'status' = 'finished' THEN
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
  v_timed := inv.time_entry(a.log_id, p_replaces, p_timing);
  RETURN inv.finish_action(a.log_id, v_receipt, NULL,
    inv.receipt_json(v_receipt) || pg_catalog.jsonb_build_object('pack_sizes_added', v_added) || inv.replaced_json(a.log_id, p_replaces) || v_timed);
END
$$;
