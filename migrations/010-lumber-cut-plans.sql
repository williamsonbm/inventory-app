-- Step 4 (#99): a job's lumber lines and the lumber cut plan saved with its
-- sheet. Source: docs/database-design.md, table 21; spec #96, story 13.
-- Every name is fully qualified (#28).
--
-- Reach: one new table; inv.sheet_fingerprint and inv.commit_job replaced.
-- A sheet with no lumber and no LVL fingerprints as before, so a job committed
-- from it still finds its own sheet unchanged; a job committed before 010
-- from a sheet with lumber or LVL finds that sheet different (Production had
-- no jobs when 010 was written). No existing row changes.
-- Recovery: nothing to restore; the table holds only what Jobs writes.

-- The cut plan of one saved sheet, worked out at commit with the Planner's
-- lumber planning (src/jobs/jobs.js) and never worked out again, so the pull
-- list prints what was committed after the buying options change (S32).
-- plan is [{label, draws: [{item_id, stock_length_ft, boards,
-- required_length_ft, contents, waste_ft}, …]}, …], one entry per size and
-- grade; the sheet's lumber lines are its boards per item.
CREATE TABLE inv.lumber_cut_plans (
  sheet_id bigint PRIMARY KEY REFERENCES inv.job_sheets (id),
  plan     jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(plan) = 'array' AND pg_catalog.jsonb_array_length(plan) > 0)
);

CREATE TRIGGER refuse_edit BEFORE UPDATE OR DELETE ON inv.lumber_cut_plans
  FOR EACH ROW EXECUTE FUNCTION inv.refuse_sheet_edit();

-- A plan's boards as sheet lines, [{item_id, quantity}, …].
CREATE FUNCTION inv.plan_lines(p_plan jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item_id', d -> 'item_id', 'quantity', d -> 'boards')), '[]')
    FROM pg_catalog.jsonb_array_elements(p_plan) AS g, pg_catalog.jsonb_array_elements(g -> 'draws') AS d
$$;

-- As 008, with the sheet's lumber pieces (p_job.lumber.demand) when it has
-- any: the sheet's own lumber lines, not the boards planned for them, so
-- the same sheet is found again after the buying options change.
CREATE OR REPLACE FUNCTION inv.sheet_fingerprint(p_job jsonb) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_array(
    inv.tidy(p_job ->> 'name'), (p_job ->> 'delivery_date')::date,
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.item_id, s.quantity) ORDER BY s.item_id)
       FROM inv.sheet_lines(p_job -> 'lines') AS s))
    || CASE WHEN coalesce(pg_catalog.jsonb_array_length(p_job -> 'lumber' -> 'demand'), 0) > 0
            THEN pg_catalog.jsonb_build_array(p_job -> 'lumber' -> 'demand') ELSE '[]' END)::text, 'UTF8'))
$$;

-- As 008, with lumber (#99). p_job: {number, name, delivery_date, lines:
-- [{item_id, quantity}, …], lumber: {demand, plan}}. lines holds no lumber
-- item: the sheet's lumber lines are the boards of lumber.plan, saved with
-- the sheet, so the lines and the plan cannot disagree.
CREATE OR REPLACE FUNCTION inv.commit_job(p_actor bigint, p_key uuid, p_job jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_number text := inv.tidy(p_job ->> 'number');
  v_plan jsonb := p_job -> 'lumber' -> 'plan';
  v_lines jsonb := coalesce(p_job -> 'lines', '[]');
  v_boards jsonb;
  v_fingerprint bytea;
  v_job inv.jobs;
  v_current inv.job_sheets;
  v_by text;
  v_at timestamptz;
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

  -- Deliberately a table lock, not a row lock: two first commits of one new
  -- job number have no row to lock yet, and without it the second fails on
  -- the unique number with a bare error instead of finding the first. A job
  -- is committed a few times a day, so the wait costs nothing; reads go on.
  LOCK TABLE inv.jobs IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(v_number);
  IF FOUND THEN
    SELECT * INTO v_current FROM inv.job_sheets WHERE job_id = v_job.id ORDER BY revision DESC LIMIT 1;
    -- The same sheet again is a no-op, unless this is a retry of the commit
    -- that saved it, which answers as that commit did (inv.claim_action).
    IF v_current.fingerprint = v_fingerprint AND v_job.status IN ('committed', 'built')
       AND NOT EXISTS (SELECT 1 FROM inv.activity_log WHERE retry_key = p_key) THEN
      RETURN inv.job_json(v_job, v_current.revision) || '{"unchanged": true}';
    END IF;
  END IF;

  a := inv.claim_action(p_actor, p_key, 'commit job', 'jobs', NULL, p_job);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;

  IF v_job.id IS NOT NULL THEN
    -- Revised sheets come with #104 (J7). Until then a different sheet for a
    -- job already in the app is refused with who committed it and when (story 8).
    SELECT u.name, l.at INTO v_by, v_at
      FROM inv.activity_log l JOIN inv.users u ON u.id = l.actor_id
     WHERE l.id = v_current.action_id;
    RAISE EXCEPTION 'Job % was already committed by % on %, from a different sheet.', v_job.number, v_by,
      pg_catalog.to_char(v_at AT TIME ZONE 'America/New_York', 'FMMonth FMDD, YYYY') USING ERRCODE = 'IV422';
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

  INSERT INTO inv.jobs (number, name, delivery_date)
  VALUES (v_number, inv.tidy(p_job ->> 'name'), (p_job ->> 'delivery_date')::date)
  RETURNING * INTO v_job;
  INSERT INTO inv.job_sheets (job_id, revision, fingerprint, action_id)
  VALUES (v_job.id, 1, v_fingerprint, a.log_id)
  RETURNING id INTO v_sheet;
  INSERT INTO inv.job_lines (sheet_id, item_id, quantity)
  SELECT v_sheet, s.item_id, s.quantity FROM inv.sheet_lines(v_lines) AS s;
  IF v_plan IS NOT NULL THEN
    INSERT INTO inv.lumber_cut_plans (sheet_id, plan) VALUES (v_sheet, v_plan);
  END IF;
  RETURN inv.finish_action(a.log_id, v_job.id, NULL, inv.job_json(v_job, 1));
END
$$;
