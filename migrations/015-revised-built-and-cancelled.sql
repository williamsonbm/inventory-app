-- Step 4 (#121): revised sheets for built, shipped and cancelled jobs.
-- Source: spec #96, stories 14, 30, 31 and Implementation Decisions
-- ("Revisions"); design Q27, S30, S64, S66; owner J154–J157. Every name is
-- fully qualified (#28).
--
-- Reach: inv_app may run inv.job_handled and the new inv.job_settled;
-- inv.job_handled no longer names who saved a revision as who built,
-- shipped or cancelled the job. inv.commit_sheet and
-- inv.commit_job take p_timing, the answer to "before or after the count?",
-- so both are dropped and created again; the app as deployed before 015
-- calls inv.commit_job with three arguments, which p_timing's default still
-- takes. A different sheet for a built job, refused until now, is its next
-- revision and consumes the plates, lumber and LVL it needs beyond what
-- Built and the revisions since settled (inv.job_settled); the same sheet
-- for one is unchanged; a cancelled job's sheet
-- commits it again. No existing row changes meaning.
-- Recovery: before any built or cancelled job is revised, drop these two
-- functions and inv.job_settled, rerun 014's inv.commit_sheet, 011's
-- inv.commit_job and 012's inv.job_handled, grant inv_app EXECUTE on
-- inv.commit_job(bigint, uuid, jsonb) again (008 granted it; 011 does not),
-- and revoke inv_app's EXECUTE on inv.job_handled. After one is, its
-- revision and its build rows are the job's; keep them.

DROP FUNCTION inv.commit_job(bigint, uuid, jsonb);
DROP FUNCTION inv.commit_sheet(bigint, uuid, jsonb, boolean);

-- What Built and the revisions since settled of each line of built job
-- p_job: the most any of its sheets since Built asked, or what the job
-- consumed when that is more. A line of a family not live at Built is
-- settled though not consumed (J4, 011), so a revision consumes only beyond
-- it; and a line lowered, then raised again, is not consumed twice. The
-- sheets since Built are the one current at the job's last 'mark built'
-- and every later one. The check before a commit shows the same figures
-- (src/jobs/jobs.js, checkSheet).
CREATE FUNCTION inv.job_settled(p_job inv.jobs)
RETURNS TABLE (item_id bigint, quantity integer)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH built AS (
    SELECT pg_catalog.max(l.id) AS id FROM inv.activity_log l
     WHERE l.target_table = 'jobs' AND l.target_id = p_job.id AND l.action = 'mark built')
  SELECT x.item_id, pg_catalog.max(x.quantity)::integer
    FROM (SELECT l.item_id, l.quantity
            FROM inv.job_lines l JOIN inv.job_sheets s ON s.id = l.sheet_id
           WHERE s.job_id = p_job.id
             AND s.revision >= (SELECT pg_catalog.max(s2.revision) FROM inv.job_sheets s2, built b
                                 WHERE s2.job_id = p_job.id AND s2.action_id < b.id)
          UNION ALL
          SELECT g.item_id, -pg_catalog.sum(g.quantity) FROM inv.ledger g WHERE g.job_id = p_job.id GROUP BY g.item_id) x
   GROUP BY x.item_id
$$;

GRANT EXECUTE ON FUNCTION inv.job_settled(inv.jobs) TO inv_app;

-- 014's inv.commit_sheet, now taking a revised sheet for a built or a
-- cancelled job too. For a built job the revision then consumes, for each
-- live plate, lumber and LVL line, what it needs beyond what Built and the
-- revisions since settled (inv.job_settled, Q27, S66), timed by p_timing as
-- Built is; what was consumed stays consumed. A cancelled job's sheet, the same one too (S64),
-- is its next revision and puts it back to committed (story 14), keeping
-- what it consumed before the cancel. A sheet for a shipped job is refused,
-- a changed one with "un-ship it first" (S30). 014's comment stands for the
-- rest.
CREATE FUNCTION inv.commit_sheet(p_actor bigint, p_key uuid, p_job jsonb, p_deduct boolean, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_number text := inv.tidy(p_job ->> 'number');
  v_plan jsonb := p_job -> 'lumber' -> 'plan';
  v_lines jsonb := coalesce(p_job -> 'lines', '[]');
  v_date date := (p_job ->> 'delivery_date')::date;
  v_edited boolean := false;
  v_boards jsonb;
  v_fingerprint bytea;
  v_job inv.jobs;
  v_current inv.job_sheets;
  v_was jsonb;
  v_revision integer := 1;
  v_bad text;
  a record;
  v_sheet bigint;
  v_timed jsonb := '{}';
  v_settled jsonb;
BEGIN
  IF coalesce(v_number, '') = '' THEN
    RAISE EXCEPTION 'The sheet has no job number.' USING ERRCODE = 'IV400';
  END IF;
  IF pg_catalog.jsonb_typeof(v_lines) <> 'array'
     OR (v_plan IS NOT NULL AND (pg_catalog.jsonb_typeof(v_plan) <> 'array' OR pg_catalog.jsonb_array_length(v_plan) = 0
         OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_plan) AS g
                     WHERE pg_catalog.jsonb_typeof(g -> 'draws') IS DISTINCT FROM 'array'))) THEN
    RAISE EXCEPTION 'The sheet''s lines or its cut plan are not lists.' USING ERRCODE = 'IV400';
  END IF;
  v_boards := inv.plan_lines(coalesce(v_plan, '[]'));
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) AS l JOIN inv.items i ON i.id::text = l ->> 'item_id'
              WHERE i.family = 'lumber')
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_boards) AS l
                  JOIN inv.items i ON i.id::text = l ->> 'item_id' WHERE i.family <> 'lumber') THEN
    RAISE EXCEPTION 'Lumber lines come from the cut plan, and the cut plan holds only lumber.' USING ERRCODE = 'IV400';
  END IF;
  v_lines := v_lines || v_boards;
  IF pg_catalog.jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'Job % has no lines to commit.', v_number USING ERRCODE = 'IV400';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) AS l
              WHERE NOT (inv.is_whole_above_zero(l -> 'quantity') AND inv.is_whole_above_zero(l -> 'item_id'))) THEN
    RAISE EXCEPTION 'Each line names an item and a whole quantity above 0.' USING ERRCODE = 'IV400';
  END IF;
  v_fingerprint := inv.sheet_fingerprint(p_job);

  -- 011's table lock, for the reason given there.
  LOCK TABLE inv.jobs IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(v_number);
  IF FOUND THEN
    SELECT * INTO v_current FROM inv.job_sheets WHERE job_id = v_job.id ORDER BY revision DESC LIMIT 1;
    -- As 011: the current sheet again is a no-op for a committed or a built
    -- job (J157), unless this is a retry of the commit that saved it.
    IF v_current.fingerprint = v_fingerprint AND v_job.status IN ('committed', 'built') AND NOT p_deduct
       AND NOT EXISTS (SELECT 1 FROM inv.activity_log WHERE retry_key = p_key) THEN
      RETURN inv.job_json(v_job, v_current.revision) || '{"unchanged": true}';
    END IF;
  END IF;

  a := inv.claim_action(p_actor, p_key, 'commit job', 'jobs', NULL, p_job);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;

  IF v_job.id IS NOT NULL THEN
    -- A sheet for a shipped job is refused with who shipped it (S28), a
    -- changed one with what to do first (S30); Deduct directly refuses a
    -- job already in the app.
    IF v_job.status = 'shipped' OR p_deduct THEN
      RAISE EXCEPTION 'Job % was already %.', v_job.number, inv.job_handled(v_job) ||
        CASE WHEN v_job.status = 'committed' THEN '; mark it shipped on the Job board'
             WHEN v_job.status = 'shipped' AND v_current.fingerprint <> v_fingerprint THEN '; un-ship it first'
             ELSE '' END USING ERRCODE = 'IV422';
    END IF;
    IF NOT inv.is_whole_above_zero(p_job -> 'version') OR (p_job ->> 'version')::integer <> v_job.version THEN
      RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number USING ERRCODE = 'IV409';
    END IF;
    v_edited := v_job.delivery_date_edited;
    IF v_date IS DISTINCT FROM v_job.delivery_date THEN
      IF pg_catalog.jsonb_typeof(p_job -> 'keep_date') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Job % has another delivery date; choose which date to keep.', v_job.number USING ERRCODE = 'IV400';
      ELSIF (p_job ->> 'keep_date')::boolean THEN
        v_date := v_job.delivery_date;
      ELSE
        v_edited := false;
      END IF;
    END IF;
  END IF;

  -- Unknown and retired items refuse the whole sheet (J8).
  SELECT pg_catalog.string_agg(CASE WHEN i.id IS NULL THEN 'item ' || s.item_id ELSE inv.item_label(i) END, ', ' ORDER BY s.item_id) INTO v_bad
    FROM inv.sheet_lines(v_lines) AS s LEFT JOIN inv.items i ON i.id = s.item_id
   WHERE NOT coalesce(i.active, false);
  IF v_bad IS NOT NULL THEN
    -- DETAIL tells this refusal from "already committed": the server shows
    -- the lines with what fixes each only for this one (src/jobs/jobs.js).
    RAISE EXCEPTION 'Job % was not committed: % is not in the catalog or is retired.', v_number, v_bad
      USING ERRCODE = 'IV422', DETAIL = 'inactive items';
  END IF;

  IF v_job.id IS NULL THEN
    INSERT INTO inv.jobs (number, name, delivery_date)
    VALUES (v_number, inv.tidy(p_job ->> 'name'), v_date)
    RETURNING * INTO v_job;
  ELSE
    v_was := inv.job_json(v_job, v_current.revision) || pg_catalog.jsonb_build_object('delivery_date', v_job.delivery_date);
    -- Read before the new sheet is saved, as it would count itself.
    v_settled := (SELECT pg_catalog.jsonb_object_agg(t.item_id, t.quantity) FROM inv.job_settled(v_job) t);
    v_revision := v_current.revision + 1;
    -- delivery_date is set even when unchanged: being in the SET list fires
    -- 013's bump_version trigger, so a screen opened before the revision is
    -- refused (Q48).
    UPDATE inv.jobs SET name = inv.tidy(p_job ->> 'name'), delivery_date = v_date, delivery_date_edited = v_edited,
                        status = CASE status WHEN 'cancelled' THEN 'committed' ELSE status END
     WHERE id = v_job.id
    RETURNING * INTO v_job;
  END IF;
  INSERT INTO inv.job_sheets (job_id, revision, fingerprint, action_id)
  VALUES (v_job.id, v_revision, v_fingerprint, a.log_id)
  RETURNING id INTO v_sheet;
  INSERT INTO inv.job_lines (sheet_id, item_id, quantity)
  SELECT v_sheet, s.item_id, s.quantity FROM inv.sheet_lines(v_lines) AS s;
  IF v_plan IS NOT NULL THEN
    INSERT INTO inv.lumber_cut_plans (sheet_id, plan, demand) VALUES (v_sheet, v_plan, p_job -> 'lumber' -> 'demand');
  END IF;
  IF v_job.status = 'built' THEN
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
    SELECT l.item_id, coalesce((v_settled ->> l.item_id::text)::integer, 0) - l.quantity, 'build', pg_catalog.now(), a.log_id, v_job.id
      FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id
      JOIN inv.families f ON f.code = i.family AND f.consumed_when = 'built' AND f.live
     WHERE l.sheet_id = v_sheet AND l.quantity > coalesce((v_settled ->> l.item_id::text)::integer, 0);
    IF FOUND THEN
      v_timed := inv.time_entries(ARRAY[a.log_id], NULL, p_timing);
    END IF;
  END IF;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_json(v_job, v_revision)
    || CASE WHEN v_was IS NULL THEN '{}' ELSE pg_catalog.jsonb_build_object('delivery_date', v_job.delivery_date) END || v_timed);
END
$$;

-- 011's inv.commit_job, now passing p_timing on. 011's comment stands.
CREATE FUNCTION inv.commit_job(p_actor bigint, p_key uuid, p_job jsonb, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.commit_sheet(p_actor, p_key, p_job, false, p_timing)
$$;

GRANT EXECUTE ON FUNCTION inv.commit_job(bigint, uuid, jsonb, jsonb) TO inv_app;

-- 012's inv.job_handled, now skipping a revision ('commit job') unless the
-- job is committed: a revision of a built job does not make the person who
-- saved it its builder. 012's comment stands.
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
     AND (l.action <> 'commit job' OR p_job.status = 'committed')
   ORDER BY l.id DESC LIMIT 1
$$;

-- The check before a commit names who handled a shipped or cancelled job,
-- as the commit's refusal does (src/jobs/jobs.js, checkSheet).
GRANT EXECUTE ON FUNCTION inv.job_handled(inv.jobs) TO inv_app;
