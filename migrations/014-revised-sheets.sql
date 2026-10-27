-- Step 4 (#120): a revised sheet for an open job. Source: spec #96, stories
-- 27, 28, 32, 34 and Implementation Decisions ("Revisions"); design table 19
-- (S29, S65); owner J136–J138. Every name is fully qualified (#28).
--
-- Reach: one new column, lumber_cut_plans.demand (null on every row today),
-- inv.commit_sheet redefined, and a new function. A different sheet for a committed job,
-- refused until now, is saved as its next revision. Built, shipped and
-- cancelled jobs, and Deduct directly for a job already in the app, are
-- refused as before (#121). No existing row changes meaning. A job whose
-- plan was saved before 014 has no demand, so a sheet for it, revised or
-- not, is planned again on the check screen; the same sheet still commits
-- as unchanged.
-- Recovery: before any job is revised, rerun 011's inv.commit_sheet and drop
-- the column and inv.is_current_sheet. After one is, its revision is the
-- job's current sheet; keep it.

-- The sheet's own lumber lines, p_job.lumber.demand, saved with the plan
-- worked out from them (J138): a revised sheet whose lumber lines are the
-- same keeps the plan, so a change of buying options does not show as a
-- change of lumber (src/jobs/jobs.js, matchSheet).
ALTER TABLE inv.lumber_cut_plans ADD COLUMN demand jsonb;

-- 011's inv.commit_sheet, now saving a different sheet for a committed job
-- as its next revision (J7, S29): the revision's lines replace the job's (a
-- committed job has consumed nothing), its name is the job's, and it moves
-- the job's version. p_job carries the version the change screen saw and,
-- when the sheet's delivery date differs from the job's, keep_date: true
-- keeps the job's date, false takes the sheet's (story 34). A return to an
-- earlier revision's content is a new revision too (S65): only the current
-- revision answers "unchanged". 011's comment stands for the rest.
CREATE OR REPLACE FUNCTION inv.commit_sheet(p_actor bigint, p_key uuid, p_job jsonb, p_deduct boolean)
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
    -- As 011: the current sheet again is a no-op for a committed job,
    -- unless this is a retry of the commit that saved it.
    IF v_current.fingerprint = v_fingerprint AND v_job.status = 'committed' AND NOT p_deduct
       AND NOT EXISTS (SELECT 1 FROM inv.activity_log WHERE retry_key = p_key) THEN
      RETURN inv.job_json(v_job, v_current.revision) || '{"unchanged": true}';
    END IF;
  END IF;

  a := inv.claim_action(p_actor, p_key, 'commit job', 'jobs', NULL, p_job);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;

  IF v_job.id IS NOT NULL THEN
    -- Revised sheets for built, shipped and cancelled jobs come with #121.
    -- Until then any sheet for one is refused with who handled the job
    -- (S28), and Deduct directly refuses a job already in the app.
    IF v_job.status <> 'committed' OR p_deduct THEN
      RAISE EXCEPTION 'Job % was already %.', v_job.number, inv.job_handled(v_job) ||
        CASE WHEN v_job.status = 'committed' THEN '; mark it shipped on the Job board' ELSE '' END USING ERRCODE = 'IV422';
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
    v_revision := v_current.revision + 1;
    -- delivery_date is set even when unchanged: being in the SET list fires
    -- 013's bump_version trigger, so a screen opened before the revision is
    -- refused (Q48).
    UPDATE inv.jobs SET name = inv.tidy(p_job ->> 'name'), delivery_date = v_date, delivery_date_edited = v_edited
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
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_json(v_job, v_revision)
    || CASE WHEN v_was IS NULL THEN '{}' ELSE pg_catalog.jsonb_build_object('delivery_date', v_job.delivery_date) END);
END
$$;

-- Whether sheet p_job, as inv.commit_job takes it, is the current revision
-- of its job, so the check before a commit says what the commit will:
-- unchanged, or a revised sheet (src/jobs/jobs.js, checkSheet). False for a
-- job not in the app.
CREATE FUNCTION inv.is_current_sheet(p_job jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((SELECT s.fingerprint = inv.sheet_fingerprint(p_job)
                     FROM inv.jobs j JOIN inv.job_sheets s ON s.job_id = j.id
                    WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy(p_job ->> 'number'))
                    ORDER BY s.revision DESC LIMIT 1), false)
$$;

GRANT EXECUTE ON FUNCTION inv.is_current_sheet(jsonb) TO inv_app;
