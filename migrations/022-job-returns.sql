-- Step 4 (#107): a return from the job site on a shipped job. Source:
-- docs/database-design.md Q7, Q11, Q29; spec #96, stories 43, 46, 47; owner
-- J330–J332. Every name is fully qualified (#28).
--
-- Reach: one new action, a new ledger kind 'return' linked to its job, the
-- kind and job checks widened for it, a trigger refusing a return of a
-- family that does not come back (plates, lumber), a trigger refusing a
-- shipped job with a return its way out of shipped, inv.reverse_entry
-- redefined to reverse a return, inv.job_to_give_back redefined to leave a
-- return out, and a new function. No existing row changes meaning: no row
-- has the new kind, so every row passes both the old and the new rules, and
-- every job gives back as before.
-- Recovery: before any return is saved, rerun 021's ledger_job_check, 011's
-- ledger_kind_check, 011's inv.reverse_entry and 012's
-- inv.job_to_give_back (both as CREATE OR REPLACE); drop inv.record_return
-- and the check_return_family and check_unship_return triggers and
-- functions; delete the action. After one is, its rows are what on hand
-- reads; keep them.

INSERT INTO inv.actions (name, admin_only) VALUES ('record return', false);

-- A return adds pieces back to on hand for one job; the job's ship rows
-- stand (Q7). Its reversal carries the job too (012).
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_kind_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_kind_check
  CHECK (kind IN ('receipt', 'correction', 'reversal', 'build', 'ship', 'return'));
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_job_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_job_check
  CHECK (CASE WHEN kind = 'build' THEN job_id IS NOT NULL AND (quantity < 0 OR reason_id IS NOT NULL)
              WHEN kind = 'ship' THEN job_id IS NOT NULL AND quantity < 0
              WHEN kind = 'return' THEN job_id IS NOT NULL AND quantity > 0
              ELSE job_id IS NULL OR kind = 'reversal' END);

-- Only hangers, EWP and LVL come back from a job site (Q7,
-- inv.families.returnable): plates and lumber are used up on the job. A
-- check cannot read inv.families; this trigger holds it, whatever writes the
-- row.
CREATE FUNCTION inv.check_return_family() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_item inv.items := (SELECT i FROM inv.items i WHERE i.id = NEW.item_id);
BEGIN
  IF NOT (SELECT f.returnable FROM inv.families f WHERE f.code = v_item.family) THEN
    RAISE EXCEPTION '% does not come back from a job site: it is used up on the job.', inv.item_label(v_item)
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_return_family BEFORE INSERT ON inv.ledger
  FOR EACH ROW WHEN (NEW.kind = 'return') EXECUTE FUNCTION inv.check_return_family();

-- Jobs → the job → Return… (stories 43, 46): job p_number, as its screen
-- showed it at p_version, got back p_quantity of item p_item_id from the job
-- site. Saves one return row on the job at the save's moment or the one
-- p_timing answers (inv.time_entry), with one activity-log row, and moves
-- the job's version. Answers the job as its log row records it, with the
-- return: { item, quantity }, by label.
CREATE FUNCTION inv.record_return(p_actor bigint, p_key uuid, p_number text, p_version integer,
                                  p_item_id bigint, p_quantity numeric, p_length_ft numeric DEFAULT NULL,
                                  p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_job inv.jobs;
  v_was jsonb;
  v_item inv.items;
  v_wanted inv.items;
  v_added boolean;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'record return', 'jobs', NULL,
                        pg_catalog.jsonb_build_object('number', p_number, 'version', p_version, 'item_id', p_item_id,
                                                      'quantity', p_quantity, 'length_ft', p_length_ft, 'timing', p_timing));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(p_number)) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % is not in the app.', p_number USING ERRCODE = 'IV400';
  END IF;
  v_was := inv.job_state(v_job);
  IF p_version IS DISTINCT FROM v_job.version THEN
    RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number
      USING ERRCODE = 'IV409', DETAIL = v_was::text;
  ELSIF v_job.status <> 'shipped' THEN
    -- Material that never left the yard goes back by Un-build or Cancel (J330).
    RAISE EXCEPTION 'Job % is %. Only a shipped job takes a return.', v_job.number, v_job.status USING ERRCODE = 'IV422';
  ELSIF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_quantity)) THEN
    RAISE EXCEPTION 'Type the pieces returned: a whole number above 0.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO v_item FROM inv.items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick the item from the catalog.' USING ERRCODE = 'IV400';
  ELSIF p_length_ft IS NOT NULL AND v_item.length_ft IS NULL THEN
    RAISE EXCEPTION 'Only LVL is returned at a length.' USING ERRCODE = 'IV400';
  ELSIF v_item.family = 'lvl' AND NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_length_ft)) THEN
    RAISE EXCEPTION 'Type the length returned in whole feet, above 0.' USING ERRCODE = 'IV400';
  ELSIF NOT v_item.active THEN
    -- Refused before a new length is added for it (PR #156 review F3).
    -- An item found at the new length is checked below.
    RAISE EXCEPTION '% is retired. Un-retire it before you record the return.', inv.item_label(v_item) USING ERRCODE = 'IV422';
  END IF;
  -- Returned LVL is entered at its actual length (Q11): the same product and
  -- depth at p_length_ft. A length the catalog lacks is added as Non-Stock
  -- (Q21), as a trim adds one; two returns at once find the one added first.
  IF p_length_ft IS NOT NULL AND p_length_ft <> v_item.length_ft THEN
    v_wanted := v_item;
    v_wanted.length_ft := p_length_ft;
    SELECT * INTO v_item FROM inv.items i WHERE inv.same_item(i, v_wanted);
    IF NOT FOUND THEN
      BEGIN
        INSERT INTO inv.items (family, product, size, length_ft, stocking)
        VALUES (v_wanted.family, v_wanted.product, v_wanted.size, v_wanted.length_ft, 'Non-Stock')
        RETURNING * INTO v_item;
        v_added := true;
      EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_item FROM inv.items i WHERE inv.same_item(i, v_wanted);
      END;
    END IF;
  END IF;
  IF NOT v_item.active THEN
    RAISE EXCEPTION '% is retired. Un-retire it before you record the return.', inv.item_label(v_item) USING ERRCODE = 'IV422';
  END IF;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
  VALUES (v_item.id, p_quantity, 'return', pg_catalog.now(), a.log_id, v_job.id);
  UPDATE inv.jobs SET version = version + 1 WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_state(v_job) || pg_catalog.jsonb_build_object('returned',
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('item', inv.item_label(v_item), 'quantity', p_quantity,
                                                               'added', v_added)))
    || inv.time_entry(a.log_id, NULL, p_timing));
END
$$;

GRANT EXECUTE ON FUNCTION inv.record_return(bigint, uuid, text, integer, bigint, numeric, numeric, jsonb) TO inv_app;

-- A shipped job with a return leaves shipped only once the return is
-- reversed (owner J332), so Un-ship never has to judge what came back:
-- deliberately refused, not undone with the rest, since the pieces really
-- came back and the job, shipped again, would not ship them twice. Held
-- here, whatever moves the status; inv.job_to_give_back, below, leaves a
-- return out, so Un-ship's own reversals do not get past it.
CREATE FUNCTION inv.check_unship_return() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT FROM inv.ledger g WHERE g.job_id = NEW.id AND g.kind = 'return'
                AND NOT EXISTS (SELECT FROM inv.ledger v WHERE v.reverses_id = g.id)) THEN
    RAISE EXCEPTION 'Job % has a return from the job site. Reverse it in the item''s History, then Un-ship.', NEW.number
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_unship_return BEFORE UPDATE OF status ON inv.jobs
  FOR EACH ROW WHEN (OLD.status = 'shipped' AND NEW.status <> 'shipped') EXECUTE FUNCTION inv.check_unship_return();

-- 011's inv.reverse_entry, now reversing a return too (Q55, J332): its
-- reversal carries the job, as Un-ship's do (012), so the job reads the
-- return as undone, and moves the job's version, so a screen that showed
-- the return standing is stale. A build or ship row, undone from its job, is
-- still refused here; 011's and 004's comments stand.
CREATE OR REPLACE FUNCTION inv.reverse_entry(p_log_id bigint, p_id bigint, p_note text) RETURNS bigint
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o inv.ledger;
  g inv.ledger;
  v_first bigint;
  v_id bigint;
BEGIN
  SELECT x.* INTO o FROM inv.ledger x WHERE x.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That entry is not in the records.' USING ERRCODE = 'IV400';
  END IF;
  IF o.kind = 'reversal' THEN
    RAISE EXCEPTION 'A reversal cannot be reversed. Enter the original again instead.' USING ERRCODE = 'IV422';
  ELSIF o.kind IN ('build', 'ship') THEN
    -- The job's Un-build and Un-ship own its build and ship rows: they give
    -- back what the job consumed and move its status. Reversed here, the
    -- pieces would be back on hand while the job still reads built or shipped.
    RAISE EXCEPTION 'A job''s Built or Shipped cannot be reversed here.' USING ERRCODE = 'IV422';
  END IF;
  FOR g IN SELECT x.* FROM inv.ledger x
            WHERE x.action_id = o.action_id AND x.kind <> 'reversal' AND (x.id = o.id OR o.receipt_id IS NULL)
            ORDER BY x.id FOR UPDATE LOOP
    BEGIN
      INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, po_line_id, reverses_id, note, job_id)
      VALUES (g.item_id, -g.quantity, 'reversal', g.effective_at, p_log_id, g.po_line_id, g.id, p_note, g.job_id)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'That entry is already reversed.' USING ERRCODE = 'IV422';
    END;
    -- A receipt line's PO now has less received, so a screen that read it
    -- before is stale (S41, owner Q76).
    UPDATE inv.purchase_orders SET version = version + 1
     WHERE id = (SELECT po_id FROM inv.po_lines WHERE id = g.po_line_id);
    -- A return's job, likewise (PR #156 review F1).
    UPDATE inv.jobs SET version = version + 1 WHERE id = g.job_id;
    v_first := coalesce(v_first, v_id);
  END LOOP;
  RETURN v_first;
END
$$;

-- 012's inv.job_to_give_back, giving back only build and ship rows: a
-- return is undone only by Reverse (J332). 012's comment stands for the rest.
CREATE OR REPLACE FUNCTION inv.job_to_give_back(p_job inv.jobs, p_action text)
RETURNS SETOF inv.ledger
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT g.*
    FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id JOIN inv.families f ON f.code = i.family
   WHERE g.job_id = p_job.id AND g.kind IN ('build', 'ship') AND p_action <> 'cancel job'
     AND NOT ((SELECT inv.undo_to(p_job, p_action)) = 'built' AND f.consumed_when = 'built')
     AND NOT EXISTS (SELECT FROM inv.ledger v WHERE v.reverses_id = g.id)
$$;
