-- #182 (#178 stories 1, 13, 14, 16, 36): a job's LVL is committed as the
-- boards of its LVL plan, saved with the sheet, as lumber's cut plan is
-- (010, 014). Source: #178 Implementation Decisions ("Job lines", "Saved
-- plan"). Every name is fully qualified (#28).
--
-- Reach: one new table, inv.lvl_cut_plans, and the functions
-- inv.lvl_available and inv.is_same_sheet; the Planner login may read the
-- saved LVL plans and the LVL settings (#181) and run inv.lvl_available.
-- inv.sheet_fingerprint, inv.is_current_sheet and inv.commit_sheet
-- replaced (CREATE OR REPLACE keeps their grants). A sheet with no LVL
-- fingerprints as before. A job committed before 025 from a sheet with LVL
-- keeps its lines (no data step, story 36), and its same sheet dropped
-- again is still its sheet (inv.is_same_sheet), so a built job does not
-- consume its LVL again (PR #190 review, finding 1); a changed one is a
-- revised sheet and its LVL is planned as boards. No existing row changes.
-- Recovery: before any job is committed with an LVL plan, rerun 010's
-- inv.sheet_fingerprint, 014's inv.is_current_sheet and 015's
-- inv.commit_sheet (as CREATE OR REPLACE) and drop inv.is_same_sheet,
-- inv.lvl_cut_plans and inv.lvl_available. After one is, its sheet's LVL
-- lines are the plan's boards; keep the table.

-- The LVL plan of one saved sheet, worked out at commit (src/jobs/jobs.js,
-- lvlLines) and never worked out again, so the boards the yard was told to
-- pull do not move when on hand changes (story 14). plan is one entry per
-- board, [{item_id, depth, length_ft, source, pieces_ft, remainder_ft,
-- kept_ft, reason}, …]: source is 'on hand', 'buy' or 'at length' (a piece
-- no purchasable length holds, bought at its length; one entry per piece,
-- with the reason the check shows).
-- demand is the sheet's LVL pieces the plan was worked out from, so a sheet
-- with the same LVL lines keeps the plan (J138).
CREATE TABLE inv.lvl_cut_plans (
  sheet_id bigint PRIMARY KEY REFERENCES inv.job_sheets (id),
  plan     jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(plan) = 'array' AND pg_catalog.jsonb_array_length(plan) > 0),
  demand   jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(demand) = 'array')
);

CREATE TRIGGER refuse_edit BEFORE UPDATE OR DELETE ON inv.lvl_cut_plans
  FOR EACH ROW EXECUTE FUNCTION inv.refuse_sheet_edit();

-- The Planner's "Already handled" reads a sheet as the check does (020),
-- so it plans the sheet's LVL too.
GRANT SELECT ON inv.lvl_cut_plans, inv.lvl_depth_settings TO inv_planner;

-- The LVL boards job p_number may plan (#182, story 7), per active item:
-- on hand − committed by other jobs, never below 0, so two jobs never plan
-- the same board (inv.commit_sheet checks a new plan against it again);
-- this job's own committed boards count as free. As inv.job_committed
-- (011), it runs as its owner and answers only totals, so the Planner
-- login reads no job line.
CREATE FUNCTION inv.lvl_available(p_number text)
RETURNS TABLE (item_id bigint, size text, length_ft integer, quantity integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.id, i.size, i.length_ft, GREATEST(f.available + coalesce(own.quantity, 0), 0)::integer
    FROM inv.items i
    JOIN inv.item_figures f ON f.item_id = i.id
    LEFT JOIN (SELECT c.item_id, pg_catalog.sum(c.quantity) AS quantity
                 FROM inv.jobs j CROSS JOIN LATERAL inv.job_to_consume(j, 'shipped') c
                WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy(p_number))
                  AND j.status IN ('committed', 'built') AND c.live
                GROUP BY c.item_id) own ON own.item_id = i.id
   WHERE i.family = 'lvl' AND i.active
$$;

GRANT EXECUTE ON FUNCTION inv.lvl_available(text) TO inv_app, inv_planner;

-- As 010, with the sheet's LVL pieces (p_job.lvl.demand) when it has any:
-- the sheet's own LVL lines, not the boards planned for them, so the same
-- sheet is found again after on hand or the LVL settings change.
CREATE OR REPLACE FUNCTION inv.sheet_fingerprint(p_job jsonb) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_array(
    inv.tidy(p_job ->> 'name'), (p_job ->> 'delivery_date')::date,
    (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(s.item_id, s.quantity) ORDER BY s.item_id)
       FROM inv.sheet_lines(p_job -> 'lines') AS s))
    || CASE WHEN coalesce(pg_catalog.jsonb_array_length(p_job -> 'lumber' -> 'demand'), 0) > 0
            THEN pg_catalog.jsonb_build_array(p_job -> 'lumber' -> 'demand') ELSE '[]' END
    || CASE WHEN coalesce(pg_catalog.jsonb_array_length(p_job -> 'lvl' -> 'demand'), 0) > 0
            THEN pg_catalog.jsonb_build_array('lvl', p_job -> 'lvl' -> 'demand') ELSE '[]' END)::text, 'UTF8'))
$$;

-- Whether p_job, as inv.commit_job takes it, is the sheet saved as s: its
-- fingerprint, or, for a sheet saved before 025 with no LVL plan (story
-- 36), the same LVL pieces as s's LVL lines, per depth and length, and the
-- fingerprint 010 gave s with those lines (PR #190 review, finding 1). It
-- reads s's own lines, deliberately, not the catalog's items for each
-- piece: an item added or retired since would read an unchanged built job
-- as revised and consume its LVL again.
CREATE FUNCTION inv.is_same_sheet(s inv.job_sheets, p_job jsonb) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.fingerprint = inv.sheet_fingerprint(p_job)
      OR coalesce(pg_catalog.jsonb_array_length(p_job -> 'lvl' -> 'demand') > 0
                  AND NOT EXISTS (SELECT 1 FROM inv.lvl_cut_plans p WHERE p.sheet_id = s.id)
                  AND (SELECT old.pieces @> (p_job -> 'lvl' -> 'demand') AND (p_job -> 'lvl' -> 'demand') @> old.pieces
                              AND s.fingerprint = inv.sheet_fingerprint((p_job - 'lvl')
                                    || pg_catalog.jsonb_build_object('lines', coalesce(p_job -> 'lines', '[]') || coalesce(old.lines, '[]')))
                         FROM (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('depth', g.size, 'length_ft', g.length_ft, 'quantity', g.quantity)) AS pieces,
                                      (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item_id', l.item_id, 'quantity', l.quantity))
                                         FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id
                                        WHERE l.sheet_id = s.id AND i.family = 'lvl') AS lines
                                 FROM (SELECT i.size, i.length_ft, pg_catalog.sum(l.quantity) AS quantity
                                         FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id
                                        WHERE l.sheet_id = s.id AND i.family = 'lvl'
                                        GROUP BY i.size, i.length_ft) g) old), false)
$$;

-- 014's, through inv.is_same_sheet.
CREATE OR REPLACE FUNCTION inv.is_current_sheet(p_job jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((SELECT inv.is_same_sheet(s, p_job)
                     FROM inv.jobs j JOIN inv.job_sheets s ON s.job_id = j.id
                    WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy(p_job ->> 'number'))
                    ORDER BY s.revision DESC LIMIT 1), false)
$$;

-- 015's inv.commit_sheet, with LVL as lumber is: p_job.lvl is {demand,
-- plan}; lines holds no LVL item, the sheet's LVL lines are the plan's
-- boards, and the plan is saved with the sheet. The current sheet is found
-- by inv.is_same_sheet. A new LVL plan is refused when it pulls more
-- on-hand boards of an item than are available to the job now, under the
-- lock (two commits planned the same board, or on hand changed since the
-- check); a plan kept by a job that holds its boards (committed or built)
-- is not, as a board it pulls that is gone shows Short (story 34). A
-- cancelled job's kept plan is checked: cancelling freed its boards (PR
-- #190 review, finding 4). 015's comment stands.
CREATE OR REPLACE FUNCTION inv.commit_sheet(p_actor bigint, p_key uuid, p_job jsonb, p_deduct boolean, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_number text := inv.tidy(p_job ->> 'number');
  v_plan jsonb := p_job -> 'lumber' -> 'plan';
  v_lvl jsonb := p_job -> 'lvl' -> 'plan';
  v_lines jsonb := coalesce(p_job -> 'lines', '[]');
  v_date date := (p_job ->> 'delivery_date')::date;
  v_edited boolean := false;
  v_boards jsonb;
  v_fingerprint bytea;
  v_same boolean;
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
  IF v_lvl IS NOT NULL AND (pg_catalog.jsonb_typeof(v_lvl) <> 'array' OR pg_catalog.jsonb_array_length(v_lvl) = 0
                            OR pg_catalog.jsonb_typeof(p_job -> 'lvl' -> 'demand') IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'The sheet''s LVL plan is not a list of boards.' USING ERRCODE = 'IV400';
  END IF;
  v_boards := inv.plan_lines(coalesce(v_plan, '[]'));
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) AS l JOIN inv.items i ON i.id::text = l ->> 'item_id'
              WHERE i.family = 'lumber')
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_boards) AS l
                  JOIN inv.items i ON i.id::text = l ->> 'item_id' WHERE i.family <> 'lumber') THEN
    RAISE EXCEPTION 'Lumber lines come from the cut plan, and the cut plan holds only lumber.' USING ERRCODE = 'IV400';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) AS l JOIN inv.items i ON i.id::text = l ->> 'item_id'
              WHERE i.family = 'lvl')
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(coalesce(v_lvl, '[]')) AS b
                  LEFT JOIN inv.items i ON i.id::text = b ->> 'item_id' WHERE i.family IS DISTINCT FROM 'lvl') THEN
    RAISE EXCEPTION 'LVL lines come from the LVL plan, and the LVL plan holds only LVL.' USING ERRCODE = 'IV400';
  END IF;
  -- One line per board of the LVL plan; inv.sheet_lines sums them per item.
  v_lines := v_lines || v_boards || coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item_id', b -> 'item_id', 'quantity', 1))
                                                FROM pg_catalog.jsonb_array_elements(v_lvl) AS b), '[]');
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
    v_same := inv.is_same_sheet(v_current, p_job);
    IF v_same AND v_job.status IN ('committed', 'built') AND NOT p_deduct
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
             WHEN v_job.status = 'shipped' AND NOT v_same THEN '; un-ship it first'
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

  IF v_lvl @> '[{"source": "on hand"}]'
     AND NOT (v_job.status IN ('committed', 'built')
              AND EXISTS (SELECT 1 FROM inv.lvl_cut_plans WHERE sheet_id = v_current.id AND plan = v_lvl))
     AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lvl) AS b
                   LEFT JOIN inv.lvl_available(v_number) f ON f.item_id = (b ->> 'item_id')::bigint
                  WHERE b ->> 'source' = 'on hand'
                  GROUP BY b ->> 'item_id', f.quantity
                 HAVING pg_catalog.count(*) > coalesce(f.quantity, 0)) THEN
    RAISE EXCEPTION 'The LVL boards planned for job % are no longer all available; check the sheet again.', v_number
      USING ERRCODE = 'IV409';
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
  IF v_lvl IS NOT NULL THEN
    INSERT INTO inv.lvl_cut_plans (sheet_id, plan, demand) VALUES (v_sheet, v_lvl, p_job -> 'lvl' -> 'demand');
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
