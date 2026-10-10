-- Step 3, part 3 (#81), groups D to F: one branch and one PR after PR #89
-- (owner, Q129). 005 is on Production, so every change to it lands here.
-- Group D (stories 77–79): an entry saved soon after a count asks "Was this
-- before or after the count?" (design Q4/Q26, Q34; S3, S71).
-- Group F (stories 83–88): the month-end record, further down. Group E
-- needed no database change.
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- Times the rows action p_log_id just wrote by the person's answer, and
-- answers what its log row records of it (stories 77, 78). Each of receive,
-- correct and trim calls it after writing its rows, at the moment
-- inv.replaced_at gave them; a new kind of entry (a build, a shipment) must
-- call it the same way, or it is never asked.
-- The counts asked about (design Q4/Q26; owner, Q145): each count of one of
-- the entry's items' families that started inside the working-day window and
-- is not rejected or discarded, oldest first. A spot check counts only the
-- items it has a line for (Q103), so one that leaves every item of the entry
-- out is not asked about; Q33 still asks its approver.
-- p_timing is { before: a count's id }: the entry takes that count's moment,
-- which the count holds (inv.on_hand_at adds only rows after it), so on hand
-- does not change; or { after: the latest count's id }: the entry keeps the
-- save's moment. An entry with no count near it needs no answer, nor does
-- one entered again (p_replaces). A refusal sends the counts back (IV409),
-- so the page shows the choices from what is true now.
CREATE FUNCTION inv.time_entry(p_log_id bigint, p_replaces bigint, p_timing jsonb) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_counts jsonb;
  v_id jsonb := coalesce(p_timing -> 'before', p_timing -> 'after');
  v_pick jsonb;
BEGIN
  -- Entered again, it keeps the original's moment and its answer (story 79).
  IF p_replaces IS NOT NULL AND p_timing IS NOT NULL THEN
    RAISE EXCEPTION 'An entry entered again keeps the time of the one it replaces.' USING ERRCODE = 'IV400';
  ELSIF p_replaces IS NOT NULL THEN
    RETURN '{}';
  END IF;
  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', c.id, 'family_name', f.name, 'kind', c.kind, 'counted_at', c.counted_at) ORDER BY c.counted_at, c.id)
    INTO v_counts
    FROM inv.counts c
    JOIN inv.families f ON f.code = c.family
   CROSS JOIN (SELECT inv.working_day_window_start(pg_catalog.now()) AS since) w
   WHERE c.status IN ('draft', 'waiting', 'approved') AND c.counted_at >= w.since
     AND EXISTS (SELECT FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id
                  WHERE g.action_id = p_log_id AND i.family = c.family
                    AND (c.kind = 'monthly' OR EXISTS (SELECT FROM inv.count_lines l
                                                        WHERE l.count_id = c.id AND l.item_id = g.item_id)));
  IF v_counts IS NULL AND p_timing IS NULL THEN
    RETURN '{}';
  ELSIF p_timing IS NULL THEN
    RAISE EXCEPTION 'Was this before or after the count? Pick one, then save again.'
      USING ERRCODE = 'IV409', DETAIL = pg_catalog.jsonb_build_object('counts', v_counts)::text;
  END IF;
  IF NOT inv.is_whole_above_zero(v_id) OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_timing)) <> 1 THEN
    RAISE EXCEPTION 'Answer before or after with a count from the list.' USING ERRCODE = 'IV400';
  END IF;
  -- After is after the latest count: one that started since the screen
  -- asked makes the answer stale, as does a count no longer asked about.
  SELECT e INTO v_pick FROM pg_catalog.jsonb_array_elements(v_counts) e WHERE e -> 'id' = v_id;
  IF v_pick IS NULL OR (p_timing ? 'after' AND v_pick <> v_counts -> -1) THEN
    RAISE EXCEPTION 'The counts changed since this screen asked. Pick again, then save.'
      USING ERRCODE = 'IV409', DETAIL = pg_catalog.jsonb_build_object('counts', coalesce(v_counts, '[]'))::text;
  END IF;
  IF p_timing ? 'before' THEN
    UPDATE inv.ledger SET effective_at = (v_pick ->> 'counted_at')::timestamptz WHERE action_id = p_log_id;
  END IF;
  RETURN pg_catalog.jsonb_build_object('timed',
    pg_catalog.jsonb_build_object('before', p_timing ? 'before', 'counted_at', v_pick -> 'counted_at'));
END
$$;

-- 004's inv.correct with p_timing added (group D); otherwise as 004.
DROP FUNCTION inv.correct(bigint, uuid, bigint, numeric, bigint, text, bigint);

-- Inventory → Overview → an item → Correct on hand: changes its on hand by
-- p_quantity pieces, + or −, with a reason (S46, story 44). The moment it
-- takes effect is the save's, or, near a count, the one p_timing answers
-- (inv.time_entry). p_replaces: a correction this one replaces
-- (inv.replaced_at), or null.
CREATE FUNCTION inv.correct(
  p_actor bigint, p_key uuid, p_item_id bigint, p_quantity numeric, p_reason_id bigint, p_note text,
  p_replaces bigint DEFAULT NULL, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_timed jsonb;
  v_id bigint;
  v_at timestamptz;
  f inv.families;
  r inv.reasons;
  v_note text := nullif(inv.tidy(p_note), '');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'correct', 'ledger', NULL,
                        pg_catalog.jsonb_build_object('item_id', p_item_id, 'quantity', p_quantity,
                                                      'reason_id', p_reason_id, 'note', p_note, 'replaces', p_replaces, 'timing', p_timing));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_at := inv.replaced_at(a.log_id, p_replaces);
  SELECT fam.* INTO f FROM inv.items i JOIN inv.families fam ON fam.code = i.family WHERE i.id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick the item from the catalog.' USING ERRCODE = 'IV400';
  END IF;
  IF p_quantity IS NULL OR p_quantity = 0 OR p_quantity <> pg_catalog.trunc(p_quantity) THEN
    RAISE EXCEPTION 'Type the change in pieces: a whole number other than 0, such as 12 or -3.' USING ERRCODE = 'IV400';
  END IF;
  r := inv.checked_reason(p_reason_id, 'A correction');
  IF r.text = 'Damaged – scrapped' AND p_quantity > 0 THEN
    RAISE EXCEPTION '"%" takes pieces away: type a number below 0.', r.text USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND p_quantity < 0 THEN
    RAISE EXCEPTION '"%" adds pieces: type a number above 0.', r.text USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Type the job number in the note, so the return can be traced.' USING ERRCODE = 'IV400';
  ELSIF r.text = 'Returned from job site' AND NOT f.returnable THEN
    RAISE EXCEPTION '% does not come back from a job site: it is used up on the job.', f.name USING ERRCODE = 'IV422';
  END IF;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (p_item_id, p_quantity, 'correction', v_at, a.log_id, r.id, v_note)
  RETURNING id INTO v_id;
  v_timed := inv.time_entry(a.log_id, p_replaces, p_timing);
  RETURN inv.finish_action(a.log_id, v_id, NULL, inv.correction_json(v_id) || inv.replaced_json(a.log_id, p_replaces) || v_timed);
END
$$;

GRANT EXECUTE ON FUNCTION inv.correct(bigint, uuid, bigint, numeric, bigint, text, bigint, jsonb) TO inv_app;

-- 004's inv.receive with p_timing added (group D); otherwise as 004.
DROP FUNCTION inv.receive(bigint, uuid, bigint, integer, bigint, text, jsonb, bigint);

-- Inventory → Receive → Receive (stories 33–41): a delivery against a PO
-- (p_po_id and the version the screen read; refused when stale, so one
-- delivery is not entered twice from two screens) or without one
-- (p_supplier_id). One save: a refused line leaves nothing saved (S21).
-- The moment it takes effect is the save's, or, near a count, the one
-- p_timing answers (inv.time_entry).
--   p_lines     [{po_line_id, item_id, quantity, packs, pack_size, pack_kind, loose}];
--               quantity in pieces; po_line_id blank for a line not on the PO.
--   p_replaces  a receipt line this receipt replaces (inv.replaced_at), or null.
--   p_timing    the answer to "before or after the count?" (inv.time_entry), or null.
CREATE FUNCTION inv.receive(
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

GRANT EXECUTE ON FUNCTION inv.receive(bigint, uuid, bigint, integer, bigint, text, jsonb, bigint, jsonb) TO inv_app;

-- 004's inv.trim with p_timing added (group D); otherwise as 004.
DROP FUNCTION inv.trim(bigint, uuid, bigint, numeric, numeric, text, boolean, bigint);

-- Inventory → Overview → an LVL item → Trim: p_boards weathered boards of
-- the item cut down to p_length_ft, one usable piece from each, the cut-off
-- thrown away (stories 47–48; owner, Q35–Q37). Two correction rows, − on the
-- long item and + on the short one, in one action, so a trim is complete or
-- refused (design, "A trim or swap is complete"). The short item is the same
-- product and depth; if the catalog has no such length, the trim adds it as
-- Non-Stock (Q21), so a leftover length is not taken for a special order.
-- A retired length is put back in use, but only when p_unretire says the
-- screen told the person so (owner, Q39); a stale screen is refused.
-- The reason is the one kept for a trim (inv.reasons.entry), looked up here:
-- inv.checked_reason refuses it everywhere else. EWP has no names until step
-- 5, so only LVL is trimmed for now (inv.families.trimmable). p_replaces: a
-- trim this one replaces (inv.replaced_at), or null. p_timing: the answer to
-- "before or after the count?" (inv.time_entry), or null.
CREATE FUNCTION inv.trim(
  p_actor bigint, p_key uuid, p_item_id bigint, p_length_ft numeric, p_boards numeric, p_note text, p_unretire boolean,
  p_replaces bigint DEFAULT NULL, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_timed jsonb;
  v_id bigint;
  v_at timestamptz;
  v_unretired boolean := false;
  long inv.items;
  short inv.items;
  wanted inv.items;
  f inv.families;
  v_added boolean := false;
  v_reason inv.reasons;
  v_note text := nullif(inv.tidy(p_note), '');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'trim', 'ledger', NULL,
                        pg_catalog.jsonb_build_object('item_id', p_item_id, 'length_ft', p_length_ft,
                                                      'boards', p_boards, 'note', p_note, 'unretire', p_unretire,
                                                      'replaces', p_replaces, 'timing', p_timing));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  v_at := inv.replaced_at(a.log_id, p_replaces);
  SELECT * INTO long FROM inv.items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick the item from the catalog.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO f FROM inv.families WHERE code = long.family;
  IF NOT f.trimmable THEN
    RAISE EXCEPTION '% items are not trimmed. A trim is for a weathered LVL board.', f.name USING ERRCODE = 'IV422';
  END IF;
  IF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_length_ft)) OR p_length_ft >= long.length_ft THEN
    RAISE EXCEPTION 'Pick a length shorter than %′.', long.length_ft USING ERRCODE = 'IV400';
  END IF;
  IF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_boards)) THEN
    RAISE EXCEPTION 'Type how many boards: a whole number above 0, such as 1 or 3.' USING ERRCODE = 'IV400';
  END IF;
  -- The short item is the long one at the new length: same product and depth.
  wanted := long;
  wanted.length_ft := p_length_ft;
  SELECT * INTO short FROM inv.items i WHERE inv.same_item(i, wanted);
  IF NOT FOUND THEN
    -- Two trims to a new length at once: the second finds the item the first added.
    BEGIN
      INSERT INTO inv.items (family, product, size, length_ft, stocking)
      VALUES (wanted.family, wanted.product, wanted.size, wanted.length_ft, 'Non-Stock')
      RETURNING * INTO short;
      v_added := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO short FROM inv.items i WHERE inv.same_item(i, wanted);
    END;
  END IF;
  IF NOT short.active AND NOT coalesce(p_unretire, false) THEN
    RAISE EXCEPTION '% is retired. Pick the length again: the trim puts it back in use.', inv.item_label(short)
      USING ERRCODE = 'IV422';
  ELSIF NOT short.active THEN
    UPDATE inv.items SET active = true WHERE id = short.id;
    v_unretired := true;
  END IF;
  SELECT * INTO v_reason FROM inv.reasons WHERE entry = 'trim';
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (long.id, -p_boards, 'correction', v_at, a.log_id, v_reason.id, v_note)
  RETURNING id INTO v_id;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reason_id, note)
  VALUES (short.id, p_boards, 'correction', v_at, a.log_id, v_reason.id, v_note);
  v_timed := inv.time_entry(a.log_id, p_replaces, p_timing);
  RETURN inv.finish_action(a.log_id, v_id, NULL, pg_catalog.jsonb_build_object(
    'id', v_id, 'item', inv.item_label(long), 'to_item', inv.item_label(short), 'length_ft', short.length_ft,
    'boards', p_boards, 'note', v_note, 'item_added', v_added, 'item_unretired', v_unretired)
    || inv.replaced_json(a.log_id, p_replaces) || v_timed);
END
$$;

GRANT EXECUTE ON FUNCTION inv.trim(bigint, uuid, bigint, numeric, numeric, text, boolean, bigint, jsonb) TO inv_app;

-- "A second person approves a count" starts off (owner, Q148, 2026-10-09),
-- a departure from the design's S5 and 005's seed: Approve already asks once
-- more before it is final (story 73), so a person approves a count they
-- worked on unless an admin switches the rule on. Only where no admin has
-- changed the setting yet (version 1).
UPDATE inv.settings SET value = 'false' WHERE name = 'count_approval_by_another' AND version = 1;

-- Inventory → Count → a draft → Discard (owner, Q149, 2026-10-09): a draft
-- nobody will finish otherwise stays on the Counts list, and asks every
-- entry of its family "before or after?" for a working day. Discarded, it
-- stays on the record, as a rejected count does (S75), and changes nothing.
-- A discarded count was never submitted.
ALTER TABLE inv.counts
  DROP CONSTRAINT counts_status_check,
  ADD CONSTRAINT counts_status_check CHECK (status IN ('draft', 'waiting', 'approved', 'rejected', 'discarded')),
  DROP CONSTRAINT counts_check1,
  ADD CONSTRAINT counts_submitted_check CHECK ((status IN ('draft', 'discarded')) = (submitted_at IS NULL));

INSERT INTO inv.actions (name, admin_only) VALUES ('discard count', false);

-- 005's guarantee, with a discarded count kept as it is too.
CREATE OR REPLACE FUNCTION inv.check_count_decided() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status IN ('approved', 'rejected', 'discarded') THEN
    RAISE EXCEPTION 'This count is % and stays as it is.', CASE WHEN TG_OP = 'DELETE' THEN 'on the record' ELSE OLD.status END
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

-- Only the person who started the draft, or an admin, discards it; a count
-- waiting for approval is rejected instead (story 74).
CREATE FUNCTION inv.discard_count(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  c inv.counts;
  was jsonb;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'discard count', 'counts', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO c FROM inv.counts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That count is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  was := inv.count_json(p_id);
  IF p_version IS DISTINCT FROM c.version THEN
    RAISE EXCEPTION 'Someone else changed this count since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  IF c.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft is discarded. A count waiting for approval is rejected instead.' USING ERRCODE = 'IV422';
  END IF;
  IF c.counted_by <> p_actor AND NOT (SELECT admin FROM inv.users WHERE id = p_actor) THEN
    RAISE EXCEPTION 'Only the person who started this count, or an admin, can discard it.' USING ERRCODE = 'IV403';
  END IF;
  UPDATE inv.counts SET status = 'discarded', version = version + 1 WHERE id = p_id;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.count_json(p_id));
END
$$;

GRANT EXECUTE ON FUNCTION inv.discard_count(bigint, uuid, bigint, integer) TO inv_app;

-- Group F (stories 83–88): the month-end record, its revisions and its
-- CSV, and last counted in the one calculation (#81 "Database").

-- A month-end record's revisions (design table 14, S11; stories 85, 86):
-- an approved monthly count is revision 1, and each correction adds the
-- next number, shared by every item it changes, with one why. A row holds
-- an item's corrected quantity, in pieces; the item may be one the count
-- missed. Was is the previous revision's figure, and who and when come from
-- the action's log row. The count and its lines never change, so the
-- original stays.
CREATE TABLE inv.count_corrections (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id  bigint NOT NULL REFERENCES inv.counts (id),
  revision  integer NOT NULL CHECK (revision >= 2),
  item_id   bigint NOT NULL REFERENCES inv.items (id),
  quantity  integer NOT NULL CHECK (quantity >= 0),
  why       text NOT NULL CHECK (why = inv.tidy(why) AND why <> ''),
  action_id bigint NOT NULL REFERENCES inv.activity_log (id),
  UNIQUE (count_id, item_id, revision)
);

CREATE INDEX count_corrections_item_idx ON inv.count_corrections (item_id);

-- Only a month-end record is corrected, and only with an item of its
-- family, whatever writes the row.
CREATE FUNCTION inv.check_count_correction() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM inv.counts c JOIN inv.items i ON i.family = c.family
                  WHERE c.id = NEW.count_id AND c.status = 'approved' AND c.kind = 'monthly' AND i.id = NEW.item_id) THEN
    RAISE EXCEPTION 'Only an approved monthly count is corrected, with items of its family.' USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_correction BEFORE INSERT ON inv.count_corrections
  FOR EACH ROW EXECUTE FUNCTION inv.check_count_correction();

-- What an approved count found of an item: its newest correction, or its
-- lines added up; null when the count has neither (it left the item out).
-- p_below gives it as it stood before that revision: a correction's was.
-- Deliberately plpgsql, as is inv.base_count: Postgres keeps a plpgsql
-- function's plans for the session, but plans a SQL function with SET
-- search_path again on every call, and inv.item_figures calls these once
-- per item. As SQL, the Overview's figures took 2.4 s, not 0.6 s (3,000
-- items, a year of monthly counts; without group F: 0.24 s).
CREATE FUNCTION inv.count_found(p_count_id bigint, p_item_id bigint, p_below integer DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN coalesce(
    (SELECT x.quantity FROM inv.count_corrections x WHERE x.count_id = p_count_id AND x.item_id = p_item_id
        AND x.revision < coalesce(p_below, 2147483647)
      ORDER BY x.revision DESC LIMIT 1),
    (SELECT pg_catalog.sum(l.quantity) FROM inv.count_lines l WHERE l.count_id = p_count_id AND l.item_id = p_item_id));
END
$$;

-- An item's latest approved count up to p_at that includes it, by moment:
-- the count, when it was counted, and what it found of the item, at its
-- newest revision (design, "How the numbers are calculated"). On hand
-- starts from it, and its moment is the item's last counted, so the two
-- never disagree. A count includes an item it has a line or a correction
-- for. No row when no approved count includes the item.
CREATE FUNCTION inv.base_count(p_item_id bigint, p_at timestamptz)
RETURNS TABLE (count_id bigint, counted_at timestamptz, quantity bigint)
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT b.id, b.counted_at, inv.count_found(b.id, p_item_id)
    FROM (SELECT c.id, c.counted_at
            FROM inv.counts c
           WHERE c.status = 'approved' AND c.counted_at <= p_at
             AND c.id IN (SELECT l.count_id FROM inv.count_lines l WHERE l.item_id = p_item_id
                          UNION ALL
                          SELECT x.count_id FROM inv.count_corrections x WHERE x.item_id = p_item_id)
           ORDER BY c.counted_at DESC, c.id DESC
           LIMIT 1) b;
END
$$;

-- 005's, starting from inv.base_count.
CREATE OR REPLACE FUNCTION inv.on_hand_at(p_item_id bigint, p_at timestamptz) RETURNS integer
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH base AS (SELECT * FROM inv.base_count(p_item_id, p_at))
  SELECT (coalesce((SELECT quantity FROM base), 0)
          + coalesce((SELECT pg_catalog.sum(g.quantity) FROM inv.ledger g
                       WHERE g.item_id = p_item_id AND g.effective_at <= p_at
                         AND g.effective_at > coalesce((SELECT counted_at FROM base), '-infinity')
                         AND NOT EXISTS (SELECT FROM inv.count_reflected r
                                          WHERE r.count_id = (SELECT count_id FROM base)
                                            AND r.ledger_id IN (g.id, g.reverses_id))), 0))::integer
$$;

-- 005's view, with last counted (counted_at) added at the end, as CREATE OR
-- REPLACE VIEW requires. The Overview and the month-end CSV read it.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.on_hand < 0 THEN 'Short'
            WHEN d.on_hand <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder,
       d.counted_at
  FROM (SELECT f.*,
               CASE WHEN f.family = 'lvl'
                    THEN pg_catalog.sum(f.on_hand * f.length_ft) OVER (PARTITION BY f.family, f.size)::integer END AS depth_lf
          FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                       coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                       inv.on_hand_at(i.id, 'infinity') AS on_hand,
                       (SELECT b.counted_at FROM inv.base_count(i.id, 'infinity') b) AS counted_at
                  FROM inv.items i
                  LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                 GROUP BY i.id) f) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;

-- inv.item_figures reads them, as the app's login.
GRANT EXECUTE ON FUNCTION inv.base_count(bigint, timestamptz) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.count_found(bigint, bigint, integer) TO inv_app;

-- A month-end record (stories 83, 85–87): an approved monthly count, at its
-- newest revision, in the shape the Month-end page, the CSV and the log
-- read. identity names the family's identity fields, in order, and each
-- line carries them (the CSV's first columns); quantity is the item's
-- figure at the newest revision. Lines keep the count's order; an item a
-- correction added comes after them. revisions lists each correction: who,
-- when, why, and was → now for each item it changed (was is null for an
-- item the count missed). Null for any other count.
CREATE FUNCTION inv.month_end_json(p_id bigint) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', c.id, 'family', c.family, 'family_name', f.name, 'closes', pg_catalog.to_char(c.closes, 'YYYY-MM'),
    'counted_at', c.counted_at, 'identity', pg_catalog.to_jsonb(f.identity),
    'revision', coalesce((SELECT pg_catalog.max(revision) FROM inv.count_corrections WHERE count_id = c.id), 1),
    'lines', (SELECT coalesce(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                  'item_id', i.id, 'item', inv.item_label(i), 'sku', i.sku, 'product', i.product, 'size', i.size,
                  'grade', i.grade, 'length_ft', i.length_ft))
                || pg_catalog.jsonb_build_object('quantity', inv.count_found(c.id, i.id)) ORDER BY o.first), '[]')
                FROM (SELECT item_id, pg_catalog.min(rank) AS first
                        FROM (SELECT item_id, ARRAY[0, id] AS rank FROM inv.count_lines WHERE count_id = c.id
                              UNION ALL
                              SELECT item_id, ARRAY[1, id] FROM inv.count_corrections WHERE count_id = c.id) r
                       GROUP BY item_id) o
                JOIN inv.items i ON i.id = o.item_id),
    'revisions', (SELECT coalesce(pg_catalog.jsonb_agg(v ORDER BY v -> 'revision'), '[]') FROM (
                    SELECT pg_catalog.jsonb_build_object('revision', x.revision, 'by', u.name, 'at', a.at, 'why', pg_catalog.min(x.why),
                             'changes', pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                               'item_id', x.item_id, 'item', inv.item_label(i),
                               'was', inv.count_found(c.id, x.item_id, x.revision),
                               'now', x.quantity) ORDER BY x.id)) AS v
                      FROM inv.count_corrections x
                      JOIN inv.activity_log a ON a.id = x.action_id
                      JOIN inv.users u ON u.id = a.actor_id
                      JOIN inv.items i ON i.id = x.item_id
                     WHERE x.count_id = c.id
                     GROUP BY x.revision, a.id, u.name) r))
    FROM inv.counts c JOIN inv.families f ON f.code = c.family
   WHERE c.id = p_id AND c.status = 'approved' AND c.kind = 'monthly'
$$;

GRANT EXECUTE ON FUNCTION inv.month_end_json(bigint) TO inv_app;

INSERT INTO inv.actions (name, admin_only) VALUES ('correct month-end', true);

-- Inventory → Month-end → a record → Correct (stories 85, 86; S11): the
-- next revision of the record. Admin only (#81, "Admin-only actions").
--   p_revision  the revision the screen read; an older one is refused (S41).
--   p_why       why, required, one for the whole revision.
--   p_lines     [{item_id, quantity}], quantity in pieces; an item the
--               count missed may be added. A line that matches the record
--               is not part of the revision; none changed is refused.
CREATE FUNCTION inv.correct_month_end(p_actor bigint, p_key uuid, p_id bigint, p_revision integer, p_why text, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  c inv.counts;
  i inv.items;
  was jsonb;
  r jsonb;
  n integer;
  v_why text := inv.tidy(p_why);
  v_seen bigint[] := '{}';
BEGIN
  a := inv.claim_action(p_actor, p_key, 'correct month-end', 'counts', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'revision', p_revision, 'why', p_why, 'lines', p_lines));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO c FROM inv.counts WHERE id = p_id FOR UPDATE;
  was := inv.month_end_json(p_id);
  IF was IS NULL THEN
    RAISE EXCEPTION 'Only an approved monthly count is a month-end record.' USING ERRCODE = 'IV422';
  END IF;
  IF p_revision IS DISTINCT FROM (was ->> 'revision')::integer THEN
    RAISE EXCEPTION 'Someone else corrected this month-end record since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = was::text;
  END IF;
  IF coalesce(v_why, '') = '' THEN
    RAISE EXCEPTION 'Say why the record is corrected.' USING ERRCODE = 'IV400';
  END IF;
  IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A correction lists its items.' USING ERRCODE = 'IV400';
  END IF;
  FOR r, n IN SELECT x, o FROM pg_catalog.jsonb_array_elements(p_lines) WITH ORDINALITY AS e(x, o) LOOP
    i := NULL;
    IF inv.is_whole_above_zero(r -> 'item_id') THEN
      SELECT * INTO i FROM inv.items WHERE id = (r ->> 'item_id')::bigint AND family = c.family;
    END IF;
    IF i.id IS NULL THEN
      RAISE EXCEPTION 'Line %: pick a % item from the catalog.', n, was ->> 'family_name' USING ERRCODE = 'IV400';
    END IF;
    IF i.id = ANY (v_seen) THEN
      RAISE EXCEPTION '% is listed twice.', inv.item_label(i) USING ERRCODE = 'IV400';
    END IF;
    v_seen := v_seen || i.id;
    IF NOT inv.is_whole_zero_or_more(r -> 'quantity') THEN
      RAISE EXCEPTION '%: the quantity is a whole number of pieces, 0 or more.', inv.item_label(i) USING ERRCODE = 'IV400';
    END IF;
    IF inv.count_found(p_id, i.id) IS DISTINCT FROM (r ->> 'quantity')::bigint THEN
      INSERT INTO inv.count_corrections (count_id, revision, item_id, quantity, why, action_id)
      VALUES (p_id, p_revision + 1, i.id, (r ->> 'quantity')::integer, v_why, a.log_id);
    END IF;
  END LOOP;
  RETURN inv.finish_action(a.log_id, p_id, was, inv.month_end_json(p_id));
END
$$;

GRANT EXECUTE ON FUNCTION inv.correct_month_end(bigint, uuid, bigint, integer, text, jsonb) TO inv_app;

-- A monthly count is submitted only for a month that has no month-end
-- record yet (owner, Q142): the counter learns it at Submit, while the month
-- can still be changed on the sheet (story 65), not at Approve. The page
-- warns from the start; inv.decide_count and counts_one_approved_monthly
-- still guard approval.
CREATE FUNCTION inv.check_month_open() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'monthly' AND EXISTS (
       SELECT FROM inv.counts WHERE family = NEW.family AND closes = NEW.closes AND kind = 'monthly' AND status = 'approved') THEN
    RAISE EXCEPTION '% already has an approved monthly count closing %. Change the month before you submit.',
      (SELECT name FROM inv.families WHERE code = NEW.family), pg_catalog.to_char(NEW.closes, 'FMMonth YYYY')
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_month_open BEFORE UPDATE OF status ON inv.counts
  FOR EACH ROW WHEN (NEW.status = 'waiting' AND OLD.status <> 'waiting')
  EXECUTE FUNCTION inv.check_month_open();

-- From the PR #92 review (F2).
-- Whether an item had nothing recorded up to p_at (005, Q118): no ledger
-- entry and no approved count that includes it. 005 missed an item that a
-- month-end correction added to a record (story 86): it has a figure from
-- that count's moment, so a later Unmatched count needs a reason. "A count
-- includes the item" is inv.base_count's rule (above), so on hand, last
-- counted and this never disagree.
CREATE OR REPLACE FUNCTION inv.nothing_before(p_item_id bigint, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT FROM inv.ledger WHERE item_id = p_item_id AND effective_at <= p_at)
     AND NOT EXISTS (SELECT FROM inv.base_count(p_item_id, p_at))
$$;
