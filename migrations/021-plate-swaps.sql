-- Step 4 (#106): a swap on a built job's plate line. Source:
-- docs/database-design.md Q36; spec #96, stories 43–45 and Implementation
-- Decisions; owner J319–J322. Every name is fully qualified (#28).
--
-- Reach: one new action, one new built-in reason (Substitution) with its
-- entry value, ledger_job_check and the ledger's reason check widened so a
-- job's build row may carry that reason (and only that one, by a trigger)
-- and then may give pieces back,
-- inv.checked_reason redefined to refuse that reason elsewhere,
-- inv.job_to_consume and inv.job_settled redefined to leave a swap out of
-- what a job consumed, and a new function. No existing row changes meaning:
-- no build row has a reason today, so every row passes both the old and the
-- new rules, and every job consumes and settles as before.
-- Recovery: before any swap is saved, rerun 012's ledger_job_check, 004's
-- reason check (as ledger_check4, dropping ledger_reason_check), 017's
-- inv.checked_reason, 011's inv.job_to_consume and 015's inv.job_settled,
-- drop inv.swap_plate and the check_build_reason trigger and function,
-- delete the reason and the action, then restore 017's
-- reasons_entry_check (entry IN ('trim', 'import', 'receive')). After one
-- is, its build rows are what on hand and the job's consumption read; keep
-- them.

INSERT INTO inv.actions (name, admin_only) VALUES ('swap plate', false);

ALTER TABLE inv.reasons DROP CONSTRAINT reasons_entry_check;
ALTER TABLE inv.reasons ADD CONSTRAINT reasons_entry_check CHECK (entry IN ('trim', 'import', 'receive', 'swap'));
-- Reason text is unique whatever its capitals (003), and Settings can add
-- one, so a person may have added "Substitution" already. Stop with words
-- that say what to do, not a bare duplicate-key error.
DO $$
DECLARE
  v_text text := (SELECT text FROM inv.reasons WHERE pg_catalog.lower(text) = 'substitution');
BEGIN
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'A reason "%" is already in the app; 021 adds the built-in reason Substitution. Rename that reason in the database (its rows keep it), then run 021 again.', v_text;
  END IF;
END
$$;
INSERT INTO inv.reasons (text, built_in, entry) VALUES ('Substitution', true, 'swap');

-- A swap is two of the job's build rows saved together, each with the
-- reason Substitution (Q36): +N gives the planned plate back, −N takes the
-- plate used. So a build row may carry a reason, and one that gives pieces
-- back must. A ship row still only takes pieces off.
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_job_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_job_check
  CHECK (CASE WHEN kind = 'build' THEN job_id IS NOT NULL AND (quantity < 0 OR reason_id IS NOT NULL)
              WHEN kind = 'ship' THEN job_id IS NOT NULL AND quantity < 0
              ELSE job_id IS NULL OR kind = 'reversal' END);
-- 004 left its reason check unnamed; Postgres named it ledger_check4.
-- Deliberately checked by its text before the drop, not dropped by name
-- alone: a database whose numbering differs would lose another check
-- (ledger_check2 is "a receipt adds pieces") and keep this one.
DO $$
BEGIN
  IF pg_catalog.pg_get_constraintdef((SELECT oid FROM pg_catalog.pg_constraint
                                       WHERE conrelid = 'inv.ledger'::regclass AND conname = 'ledger_check4'))
     IS DISTINCT FROM 'CHECK (((kind = ''correction''::text) = (reason_id IS NOT NULL)))' THEN
    RAISE EXCEPTION 'inv.ledger''s ledger_check4 is not 004''s reason check; stop and look.';
  END IF;
END
$$;
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_check4;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_reason_check
  CHECK (CASE kind WHEN 'correction' THEN reason_id IS NOT NULL WHEN 'build' THEN true ELSE reason_id IS NULL END);

-- What a job consumed leaves out a build row whose reason is the swap's
-- (inv.job_to_consume, inv.job_settled), so a build row with any other
-- reason would be counted as neither. The reason check above cannot read
-- inv.reasons; this trigger holds the rest, whatever writes the row
-- (PR #155 review F4). inv.swap_plate sets the reason itself.
CREATE FUNCTION inv.check_build_reason() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM inv.reasons WHERE id = NEW.reason_id AND entry = 'swap') THEN
    RAISE EXCEPTION 'A job''s build row with a reason is a swap, so its reason is Substitution.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER check_build_reason BEFORE INSERT ON inv.ledger
  FOR EACH ROW WHEN (NEW.kind = 'build' AND NEW.reason_id IS NOT NULL) EXECUTE FUNCTION inv.check_build_reason();

-- 017's inv.checked_reason, refusing the reason a swap sets; otherwise as 017.
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
  ELSIF r.entry = 'swap' THEN
    RAISE EXCEPTION '"%" is set by a swap on a job. Use Substitute… on the job''s Plates tab.', r.text USING ERRCODE = 'IV422';
  END IF;
  RETURN r;
END
$$;

-- Jobs → the job → Plates → Substitute… (stories 43–45): job p_number, as
-- its screen showed it at p_version, used p_quantity of plate p_used in
-- place of plate p_planned. Saves +p_quantity of p_planned and
-- −p_quantity of p_used as the job's build rows, reason Substitution, at
-- the save's moment or the one p_timing answers (inv.time_entry), with one
-- activity-log row, and moves the job's version. Answers the job as its log
-- row records it, with the swap: { planned, used, quantity }, by label.
CREATE FUNCTION inv.swap_plate(p_actor bigint, p_key uuid, p_number text, p_version integer,
                               p_planned bigint, p_used bigint, p_quantity numeric, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_job inv.jobs;
  v_was jsonb;
  v_planned inv.items;
  v_used inv.items;
  v_consumed integer;
  v_reason bigint := (SELECT id FROM inv.reasons WHERE entry = 'swap');
BEGIN
  a := inv.claim_action(p_actor, p_key, 'swap plate', 'jobs', NULL,
                        pg_catalog.jsonb_build_object('number', p_number, 'version', p_version, 'planned', p_planned,
                                                      'used', p_used, 'quantity', p_quantity, 'timing', p_timing));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(p_number)) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % is not in the app.', p_number USING ERRCODE = 'IV400';
  END IF;
  v_was := inv.job_state(v_job);
  IF p_version IS DISTINCT FROM v_job.version THEN
    RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number
      USING ERRCODE = 'IV409', DETAIL = v_was::text;
  ELSIF v_job.status <> 'built' THEN
    RAISE EXCEPTION 'Job % is %. Only a built job takes a swap.', v_job.number, v_job.status USING ERRCODE = 'IV422';
  ELSIF NOT inv.is_whole_above_zero(pg_catalog.to_jsonb(p_quantity)) THEN
    RAISE EXCEPTION 'Type the pieces swapped: a whole number above 0.' USING ERRCODE = 'IV400';
  ELSIF p_planned = p_used THEN
    RAISE EXCEPTION 'Pick a plate other than the planned one.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO v_planned FROM inv.items WHERE id = p_planned;
  SELECT * INTO v_used FROM inv.items WHERE id = p_used;
  IF v_planned.id IS NULL OR v_used.id IS NULL THEN
    RAISE EXCEPTION 'Pick the plates from the catalog.' USING ERRCODE = 'IV400';
  ELSIF v_planned.family <> 'plates' OR v_used.family <> 'plates' THEN
    RAISE EXCEPTION '% is not a plate. Pick a plate.',
      inv.item_label(CASE WHEN v_planned.family <> 'plates' THEN v_planned ELSE v_used END) USING ERRCODE = 'IV400';
  ELSIF NOT v_used.active THEN
    RAISE EXCEPTION '% is retired. Pick a plate in use.', inv.item_label(v_used) USING ERRCODE = 'IV422';
  END IF;
  -- Never more than the job consumed of the planned plate (Q36): its build
  -- and ship rows, and their reversals, swaps included. The job is locked,
  -- so two swaps at once count one after the other.
  v_consumed := (SELECT coalesce(-pg_catalog.sum(g.quantity), 0) FROM inv.ledger g WHERE g.job_id = v_job.id AND g.item_id = p_planned);
  IF p_quantity > v_consumed THEN
    RAISE EXCEPTION 'Job % consumed % of %, so at most % can be swapped.', v_job.number, v_consumed,
      inv.item_label(v_planned), v_consumed USING ERRCODE = 'IV422';
  END IF;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id, reason_id)
  VALUES (p_planned, p_quantity, 'build', pg_catalog.now(), a.log_id, v_job.id, v_reason),
         (p_used, -p_quantity, 'build', pg_catalog.now(), a.log_id, v_job.id, v_reason);
  UPDATE inv.jobs SET version = version + 1 WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_state(v_job) || pg_catalog.jsonb_build_object('swap',
    pg_catalog.jsonb_build_object('planned', inv.item_label(v_planned), 'used', inv.item_label(v_used),
                                  'quantity', p_quantity)) || inv.time_entry(a.log_id, NULL, p_timing));
END
$$;

GRANT EXECUTE ON FUNCTION inv.swap_plate(bigint, uuid, text, integer, bigint, bigint, numeric, jsonb) TO inv_app;

-- 011's inv.job_to_consume, leaving a swap out of what the job consumed
-- (owner J322): its rows, and their reversals, count as the planned plate
-- consumed. Deliberately not the plain sum of the job's rows: a job
-- cancelled after a swap keeps its rows (012), so when its sheet is
-- committed again, Built or Shipped would take the swapped pieces of the
-- planned plate a second time. The cost: a sheet that newly adds the plate
-- used takes it in full. Un-build reverses the swap with the rest, so
-- Built again still consumes the sheet as planned (J321). inv.job_settled,
-- below, counts the same way (J325).
CREATE OR REPLACE FUNCTION inv.job_to_consume(p_job inv.jobs, p_to text)
RETURNS TABLE (item_id bigint, quantity integer, live boolean)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.item_id, l.quantity - c.consumed, f.live
    FROM inv.job_lines l
    JOIN inv.items i ON i.id = l.item_id
    JOIN inv.families f ON f.code = i.family
   CROSS JOIN LATERAL (SELECT coalesce(-pg_catalog.sum(g.quantity), 0)::integer AS consumed
                         FROM inv.ledger g LEFT JOIN inv.ledger o ON o.id = g.reverses_id
                        WHERE g.job_id = p_job.id AND g.item_id = l.item_id
                          AND NOT EXISTS (SELECT FROM inv.reasons r
                                           WHERE r.id = coalesce(o.reason_id, g.reason_id) AND r.entry = 'swap')) c
   WHERE l.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = p_job.id ORDER BY s.revision DESC LIMIT 1)
     AND CASE WHEN p_to = 'built' THEN f.consumed_when = 'built'
              WHEN p_job.status = 'built' THEN f.consumed_when = 'shipped'
              ELSE true END
     AND l.quantity > c.consumed
$$;

-- 015's inv.job_settled, counting a swap as job_to_consume does (owner
-- J325): its rows, and their reversals, are left out of what the job
-- consumed. Deliberately not 015's plain sum: with it, a revised sheet on
-- the built job settled a line of the plate used at what was swapped in,
-- and the same sheet committed again after a cancel did not, so the two
-- took different pieces for the same facts. The cost, as for Built: a
-- revised sheet that shows the swap as a line of the plate used takes that
-- plate a second time. The check before a commit reads this function
-- (src/jobs/jobs.js, checkSheet), so it shows the same figures. 015's
-- comment stands for the rest.
CREATE OR REPLACE FUNCTION inv.job_settled(p_job inv.jobs)
RETURNS TABLE (item_id bigint, quantity integer)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH built AS (
    SELECT pg_catalog.min(l.id) AS id FROM inv.activity_log l
     WHERE l.target_table = 'jobs' AND l.target_id = p_job.id AND l.action IN ('mark built', 'mark shipped')
       AND l.id > coalesce((SELECT pg_catalog.max(u.id) FROM inv.activity_log u
                             WHERE u.target_table = 'jobs' AND u.target_id = p_job.id
                               AND u.action IN ('un-build', 'cancel job', 'un-ship')
                               AND u.new_value ->> 'status' IN ('committed', 'cancelled')), 0))
  SELECT x.item_id, pg_catalog.max(x.quantity)::integer
    FROM (SELECT l.item_id, l.quantity
            FROM inv.job_lines l JOIN inv.job_sheets s ON s.id = l.sheet_id
           WHERE s.job_id = p_job.id
             AND s.revision >= (SELECT pg_catalog.max(s2.revision) FROM inv.job_sheets s2, built b
                                 WHERE s2.job_id = p_job.id AND s2.action_id < b.id)
          UNION ALL
          SELECT g.item_id, -pg_catalog.sum(g.quantity)
            FROM inv.ledger g LEFT JOIN inv.ledger o ON o.id = g.reverses_id
           WHERE g.job_id = p_job.id
             AND NOT EXISTS (SELECT FROM inv.reasons r
                              WHERE r.id = coalesce(o.reason_id, g.reason_id) AND r.entry = 'swap')
           GROUP BY g.item_id) x
   GROUP BY x.item_id
$$;
