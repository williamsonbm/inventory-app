-- Step 4 (#101): Cancel, Un-build and Un-ship. Source: spec #96,
-- Implementation Decisions ("Database rules"); owner J85–J87. Every name is
-- fully qualified (#28).
--
-- Reach: three new actions; ledger_job_check and inv.check_reversal
-- redefined so a reversal carries the job of the row it reverses;
-- inv.job_handled redefined to name who cancelled, un-built or un-shipped
-- (and, for the last two, that they did);
-- new functions. No existing row changes meaning: 011 allowed no reversal
-- with a job, so every row today passes both the old and the new rule.
-- Recovery: before any job is un-built or un-shipped, rerun 011's
-- ledger_job_check and inv.job_handled and 004's inv.check_reversal. After
-- one is, its reversal rows are what on hand and the job's consumption
-- read; keep them.

INSERT INTO inv.actions (name, admin_only) VALUES ('cancel job', false), ('un-build', false), ('un-ship', false);

-- A build or ship row takes pieces off on hand for one job (011). Its
-- reversal gives them back to that job too, so what the job consumed (the
-- sum of its rows, inv.job_to_consume) drops by the same pieces.
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_job_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_job_check
  CHECK (CASE WHEN kind IN ('build', 'ship') THEN job_id IS NOT NULL AND quantity < 0
              ELSE job_id IS NULL OR kind = 'reversal' END);

-- 004's inv.check_reversal, now mirroring the job too: a reversal carries
-- the job of the row it reverses, and only that one. 004's comment stands:
-- the same moment (S27), and never a reversal of a reversal.
CREATE OR REPLACE FUNCTION inv.check_reversal() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  o inv.ledger;
BEGIN
  SELECT * INTO o FROM inv.ledger WHERE id = NEW.reverses_id;
  IF o.kind = 'reversal' OR (NEW.item_id, NEW.quantity, NEW.effective_at, NEW.po_line_id, NEW.job_id)
       IS DISTINCT FROM (o.item_id, -o.quantity, o.effective_at, o.po_line_id, o.job_id) THEN
    RAISE EXCEPTION 'A reversal must mirror an entry that is not a reversal.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- Where p_action ('cancel job', 'un-build' or 'un-ship') takes job p_job
-- (#96, "Database rules"): Cancel to cancelled, final (no Un-cancel);
-- Un-build to committed; Un-ship to built, or to committed for a job with no
-- plates, lumber or LVL on its current sheet (J85): a job shipped from
-- committed keeps those consumed, as if built.
CREATE FUNCTION inv.undo_to(p_job inv.jobs, p_action text) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN p_action = 'cancel job' THEN 'cancelled'
              WHEN p_action = 'un-ship' AND EXISTS (
                SELECT FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id JOIN inv.families f ON f.code = i.family
                 WHERE l.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = p_job.id ORDER BY s.revision DESC LIMIT 1)
                   AND f.consumed_when = 'built')
              THEN 'built' ELSE 'committed' END
$$;

-- The ledger rows of job p_job that p_action gives back: Cancel none, so
-- what the job consumed stays consumed and the rest leaves Committed (S25);
-- Un-build and Un-ship every row not yet reversed, but for the families a
-- built job keeps consumed. Each reversal mirrors its row, at its moment
-- (S27), so neither gives back more than the job consumed (story 26).
CREATE FUNCTION inv.job_to_give_back(p_job inv.jobs, p_action text)
RETURNS SETOF inv.ledger
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT g.*
    FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id JOIN inv.families f ON f.code = i.family
   WHERE g.job_id = p_job.id AND g.kind <> 'reversal' AND p_action <> 'cancel job'
     AND NOT ((SELECT inv.undo_to(p_job, p_action)) = 'built' AND f.consumed_when = 'built')
     AND NOT EXISTS (SELECT FROM inv.ledger v WHERE v.reverses_id = g.id)
$$;

GRANT EXECUTE ON FUNCTION inv.undo_to(inv.jobs, text), inv.job_to_give_back(inv.jobs, text) TO inv_app;

-- Jobs → Cancel, Un-build or Un-ship (stories 23–26): p_action on job
-- p_number, as the board showed it at p_version, one job at a time (J86),
-- with one activity-log row. Cancel acts on a job committed or built,
-- Un-build on one built, Un-ship on one shipped; each takes it to
-- inv.undo_to and gives back inv.job_to_give_back. Answers the job as its
-- log row records it.
CREATE FUNCTION inv.undo_job(p_actor bigint, p_key uuid, p_action text, p_number text, p_version integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_job inv.jobs;
  v_was jsonb;
BEGIN
  a := inv.claim_action(p_actor, p_key, p_action, 'jobs', NULL,
                        pg_catalog.jsonb_build_object('number', p_number, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(p_number)) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % is not in the app.', p_number USING ERRCODE = 'IV400';
  END IF;
  v_was := inv.job_state(v_job);
  IF p_version IS DISTINCT FROM v_job.version THEN
    RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number
      USING ERRCODE = 'IV409', DETAIL = v_was::text;
  ELSIF v_job.status <> ALL (CASE p_action WHEN 'cancel job' THEN '{committed,built}'::text[]
                                           WHEN 'un-build' THEN '{built}' ELSE '{shipped}' END) THEN
    RAISE EXCEPTION 'Job % is %, so it cannot be %.', v_job.number, v_job.status,
      CASE p_action WHEN 'cancel job' THEN 'cancelled' WHEN 'un-build' THEN 'un-built' ELSE 'un-shipped' END
      USING ERRCODE = 'IV422';
  END IF;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, reverses_id, job_id)
  SELECT g.item_id, -g.quantity, 'reversal', g.effective_at, a.log_id, g.id, g.job_id
    FROM inv.job_to_give_back(v_job, p_action) g ORDER BY g.id;
  UPDATE inv.jobs SET status = inv.undo_to(v_job, p_action) WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_state(v_job));
END
$$;

-- 011's inv.job_handled, now naming who cancelled, un-built or un-shipped
-- the job when that brought it to its status, and, for Un-build and Un-ship,
-- what they did: "built (un-shipped by Bob Ray on October 26, 2026)", as
-- Bob did not build the job (J92). 011's comment stands.
CREATE OR REPLACE FUNCTION inv.job_handled(p_job inv.jobs) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_job.status || CASE l.action WHEN 'un-build' THEN ' (un-built' WHEN 'un-ship' THEN ' (un-shipped' ELSE '' END
         || ' by ' || u.name || ' on ' || pg_catalog.to_char(l.at AT TIME ZONE 'America/New_York', 'FMMonth FMDD, YYYY')
         || CASE WHEN l.action IN ('un-build', 'un-ship') THEN ')' ELSE '' END
    FROM inv.activity_log l JOIN inv.users u ON u.id = l.actor_id
   WHERE l.target_table = 'jobs' AND l.target_id = p_job.id
     AND l.action IN ('commit job', 'mark built', 'mark shipped', 'cancel job', 'un-build', 'un-ship')
   ORDER BY l.id DESC LIMIT 1
$$;

CREATE FUNCTION inv.cancel_job(p_actor bigint, p_key uuid, p_number text, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.undo_job(p_actor, p_key, 'cancel job', p_number, p_version)
$$;

CREATE FUNCTION inv.unbuild_job(p_actor bigint, p_key uuid, p_number text, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.undo_job(p_actor, p_key, 'un-build', p_number, p_version)
$$;

CREATE FUNCTION inv.unship_job(p_actor bigint, p_key uuid, p_number text, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.undo_job(p_actor, p_key, 'un-ship', p_number, p_version)
$$;

GRANT EXECUTE ON FUNCTION inv.cancel_job(bigint, uuid, text, integer), inv.unbuild_job(bigint, uuid, text, integer), inv.unship_job(bigint, uuid, text, integer) TO inv_app;
