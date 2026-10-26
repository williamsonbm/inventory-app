-- Step 4 (#100): Built, Shipped and Deduct directly. Source:
-- docs/database-design.md, "Rules the database enforces"; spec #96,
-- Implementation Decisions. Every name is fully qualified (#28).
--
-- Reach: two new columns with defaults (jobs.version, families.
-- consumed_when), one on the ledger (job_id, empty on every row today), the
-- ledger's kind list widened, inv.time_entry, inv.reverse_entry and
-- inv.item_figures redefined, and new functions. No existing row changes
-- meaning: no job is built or shipped before this file, so Committed and
-- Available read the same.
-- Recovery: before any job is marked, rerun 009's view, 006's inv.time_entry
-- and 004's inv.reverse_entry. After one is, its build and ship ledger rows
-- are what on hand reads; keep them.

INSERT INTO inv.actions (name, admin_only) VALUES ('mark built', false), ('mark shipped', false);

-- The job's version, for a stale screen (Q48): every change of status moves it.
ALTER TABLE inv.jobs ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE TRIGGER bump_version BEFORE UPDATE OF status ON inv.jobs
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- When a job consumes a family (CONTEXT.md, Built and Shipped): plates,
-- lumber and LVL are cut in the shop or yard, so Built; the rest at Shipped.
ALTER TABLE inv.families ADD COLUMN consumed_when text CHECK (consumed_when IN ('built', 'shipped'));
UPDATE inv.families SET consumed_when = CASE WHEN code IN ('plates', 'lumber', 'lvl') THEN 'built' ELSE 'shipped' END;
ALTER TABLE inv.families ALTER COLUMN consumed_when SET NOT NULL;

-- A build or ship row takes pieces off on hand for one job. What a job
-- consumed is the sum of its rows (design, table 20), never stored on its lines.
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_kind_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_kind_check
  CHECK (kind IN ('receipt', 'correction', 'reversal', 'build', 'ship'));
ALTER TABLE inv.ledger ADD COLUMN job_id bigint REFERENCES inv.jobs (id);
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_job_check
  CHECK ((kind IN ('build', 'ship')) = (job_id IS NOT NULL) AND (job_id IS NULL OR quantity < 0));
CREATE INDEX ledger_job_idx ON inv.ledger (job_id, item_id);

-- 004's inv.reverse_entry, refusing a job's build or ship row; 004's
-- comment stands. Un-build and Un-ship undo those (#101).
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
  ELSIF o.job_id IS NOT NULL THEN
    -- Its reversal would carry no job (ledger_job_check), so the job would
    -- still read the pieces as consumed: on hand back up, committed not.
    RAISE EXCEPTION 'A job''s Built or Shipped cannot be reversed here.' USING ERRCODE = 'IV422';
  END IF;
  FOR g IN SELECT x.* FROM inv.ledger x
            WHERE x.action_id = o.action_id AND x.kind <> 'reversal' AND (x.id = o.id OR o.receipt_id IS NULL)
            ORDER BY x.id FOR UPDATE LOOP
    BEGIN
      INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, po_line_id, reverses_id, note)
      VALUES (g.item_id, -g.quantity, 'reversal', g.effective_at, p_log_id, g.po_line_id, g.id, p_note)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'That entry is already reversed.' USING ERRCODE = 'IV422';
    END;
    -- A receipt line's PO now has less received, so a screen that read it
    -- before is stale (S41, owner Q76).
    UPDATE inv.purchase_orders SET version = version + 1
     WHERE id = (SELECT po_id FROM inv.po_lines WHERE id = g.po_line_id);
    v_first := coalesce(v_first, v_id);
  END LOOP;
  RETURN v_first;
END
$$;

-- One action's own retry key for each part of it: the n-th job of a batch,
-- each with its own activity-log row (#96), all retried by the one key the
-- screen sent.
CREATE FUNCTION inv.sub_key(p_key uuid, n integer) RETURNS uuid
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.md5(p_key::text || '/' || n)::uuid
$$;

-- What marking job p_job p_to ('built' or 'shipped') consumes, per item on
-- its current sheet: the line's quantity less what the job already consumed,
-- when above zero. Built consumes the families consumed when built; Shipped
-- from committed every family (J5), and from built only the families
-- consumed when shipped: Built settled the others, consumed or not. live: the
-- family is live in Inventory; a line of one that is not is shown, never
-- consumed (J4), so a family that goes live after Built is not consumed again
-- at Shipped. Committed (inv.item_figures) is what Shipped would consume of
-- the live families.
CREATE FUNCTION inv.job_to_consume(p_job inv.jobs, p_to text)
RETURNS TABLE (item_id bigint, quantity integer, live boolean)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT l.item_id, l.quantity - c.consumed, f.live
    FROM inv.job_lines l
    JOIN inv.items i ON i.id = l.item_id
    JOIN inv.families f ON f.code = i.family
   CROSS JOIN LATERAL (SELECT coalesce(-pg_catalog.sum(g.quantity), 0)::integer AS consumed
                         FROM inv.ledger g WHERE g.job_id = p_job.id AND g.item_id = l.item_id) c
   WHERE l.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = p_job.id ORDER BY s.revision DESC LIMIT 1)
     AND CASE WHEN p_to = 'built' THEN f.consumed_when = 'built'
              WHEN p_job.status = 'built' THEN f.consumed_when = 'shipped'
              ELSE true END
     AND l.quantity > c.consumed
$$;

GRANT EXECUTE ON FUNCTION inv.job_to_consume(inv.jobs, text) TO inv_app;

-- Committed per item, for inv.item_figures: for each job committed or built,
-- what Shipped would consume of a live family. inv.item_figures calls it as
-- whoever reads the view, so it runs as its owner and answers only the
-- totals: the Planner login reads no job and no job line (007), and the
-- Planner run reads committed from the view as 009 made it.
CREATE FUNCTION inv.job_committed()
RETURNS TABLE (item_id bigint, committed integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT c.item_id, pg_catalog.sum(c.quantity)::integer
    FROM inv.jobs j CROSS JOIN LATERAL inv.job_to_consume(j, 'shipped') c
   WHERE j.status IN ('committed', 'built') AND c.live
   GROUP BY c.item_id
$$;

GRANT EXECUTE ON FUNCTION inv.job_committed() TO inv_app, inv_planner;

-- 006's inv.time_entry for the rows of several actions at once: a batch of
-- jobs asks "before or after the count?" once, about every count near any of
-- its rows, and one answer times them all. Otherwise as 006.
CREATE FUNCTION inv.time_entries(p_log_ids bigint[], p_replaces bigint, p_timing jsonb) RETURNS jsonb
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
                  WHERE g.action_id = ANY (p_log_ids) AND i.family = c.family
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
    UPDATE inv.ledger SET effective_at = (v_pick ->> 'counted_at')::timestamptz WHERE action_id = ANY (p_log_ids);
  END IF;
  RETURN pg_catalog.jsonb_build_object('timed',
    pg_catalog.jsonb_build_object('before', p_timing ? 'before', 'counted_at', v_pick -> 'counted_at'));
END
$$;

-- 006's comment stands; the body is now inv.time_entries for one action.
CREATE OR REPLACE FUNCTION inv.time_entry(p_log_id bigint, p_replaces bigint, p_timing jsonb) RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.time_entries(ARRAY[p_log_id], p_replaces, p_timing)
$$;

-- A job as an activity-log row records a change of its status.
CREATE FUNCTION inv.job_state(j inv.jobs) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object('number', j.number, 'name', j.name, 'status', j.status, 'version', j.version)
$$;

-- Jobs → Built or Shipped (stories 15–17, 20–22): marks the jobs p_jobs
-- ([{number, version}, …], as the board showed them) p_to, 'built' or
-- 'shipped', in one transaction, so one refusal saves none (S21). Each job
-- gets its own activity-log row and consumes what inv.job_to_consume says,
-- in the families live in Inventory (J4), at the save's moment or the one
-- p_timing answers (inv.time_entries). Allowed: committed → built (a job with
-- a line of a family consumed when built), committed or built → shipped (#96,
-- "Database rules"). Answers { jobs: [each job as its log row records it] }.
CREATE FUNCTION inv.mark_jobs(p_actor bigint, p_key uuid, p_to text, p_jobs jsonb, p_timing jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r jsonb;
  n integer;
  a record;
  v_request jsonb := pg_catalog.jsonb_build_object('jobs', p_jobs, 'timing', p_timing);
  v_job inv.jobs;
  v_was jsonb;
  v_done jsonb := '[]';   -- [{log, id, was, now}] of the jobs marked now
  v_earlier jsonb := '[]';
  v_timed jsonb;
  v_out jsonb := '[]';
BEGIN
  IF pg_catalog.jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_jobs) = 0 THEN
    RAISE EXCEPTION 'Pick the jobs to mark %.', p_to USING ERRCODE = 'IV400';
  END IF;
  -- Deliberately every job of the batch locked first, in id order, not each
  -- in the loop in the order the screen sent: two batches of the same jobs
  -- in different orders would each hold one the other waits for, and one
  -- would end in a bare deadlock error instead of waiting its turn.
  PERFORM FROM inv.jobs
   WHERE pg_catalog.upper(number) IN (SELECT pg_catalog.upper(inv.tidy(e ->> 'number')) FROM pg_catalog.jsonb_array_elements(p_jobs) e)
   ORDER BY id FOR UPDATE;
  FOR r, n IN SELECT e, o FROM pg_catalog.jsonb_array_elements(p_jobs) WITH ORDINALITY AS x(e, o) LOOP
    a := inv.claim_action(p_actor, inv.sub_key(p_key, n::integer), 'mark ' || p_to, 'jobs', NULL, v_request);
    -- One transaction: a retry finds every job of its batch done, or none.
    IF a.log_id IS NULL THEN
      v_earlier := v_earlier || pg_catalog.jsonb_build_array(a.earlier);
      CONTINUE;
    END IF;
    SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(r ->> 'number')) FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Job % is not in the app.', r ->> 'number' USING ERRCODE = 'IV400';
    END IF;
    v_was := inv.job_state(v_job);
    IF v_done @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', v_job.id)) THEN
      RAISE EXCEPTION 'Job % is in the list twice.', v_job.number USING ERRCODE = 'IV400';
    ELSIF r -> 'version' IS DISTINCT FROM pg_catalog.to_jsonb(v_job.version) THEN
      RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number
        USING ERRCODE = 'IV409', DETAIL = v_was::text;
    ELSIF NOT (v_job.status = 'committed' OR (v_job.status = 'built' AND p_to = 'shipped')) THEN
      RAISE EXCEPTION 'Job % is %, so it cannot be marked %.', v_job.number, v_job.status, p_to USING ERRCODE = 'IV422';
    ELSIF p_to = 'built' AND NOT EXISTS (SELECT FROM inv.job_to_consume(v_job, p_to)) THEN
      RAISE EXCEPTION 'Job % has no plates, lumber or LVL to build; mark it shipped.', v_job.number USING ERRCODE = 'IV422';
    END IF;
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
    SELECT c.item_id, -c.quantity, CASE p_to WHEN 'built' THEN 'build' ELSE 'ship' END, pg_catalog.now(), a.log_id, v_job.id
      FROM inv.job_to_consume(v_job, p_to) c WHERE c.live;
    UPDATE inv.jobs SET status = p_to WHERE id = v_job.id RETURNING * INTO v_job;
    v_done := v_done || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'log', a.log_id, 'id', v_job.id, 'was', v_was, 'now', inv.job_state(v_job)));
  END LOOP;
  IF pg_catalog.jsonb_array_length(v_earlier) > 0 THEN
    RETURN pg_catalog.jsonb_build_object('jobs', v_earlier);
  END IF;
  v_timed := inv.time_entries((SELECT pg_catalog.array_agg((d ->> 'log')::bigint) FROM pg_catalog.jsonb_array_elements(v_done) d),
                              NULL, p_timing);
  FOR r IN SELECT d FROM pg_catalog.jsonb_array_elements(v_done) d LOOP
    v_out := v_out || pg_catalog.jsonb_build_array(
      inv.finish_action((r ->> 'log')::bigint, (r ->> 'id')::bigint, r -> 'was', (r -> 'now') || v_timed));
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('jobs', v_out);
END
$$;

CREATE FUNCTION inv.mark_built(p_actor bigint, p_key uuid, p_jobs jsonb, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.mark_jobs(p_actor, p_key, 'built', p_jobs, p_timing)
$$;

CREATE FUNCTION inv.mark_shipped(p_actor bigint, p_key uuid, p_jobs jsonb, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.mark_jobs(p_actor, p_key, 'shipped', p_jobs, p_timing)
$$;

GRANT EXECUTE ON FUNCTION inv.mark_built(bigint, uuid, jsonb, jsonb), inv.mark_shipped(bigint, uuid, jsonb, jsonb) TO inv_app;

-- Who brought job p_job to its status, and when, as a refusal says it:
-- "built by Ann Lee on October 26, 2026" (story 8, S28).
CREATE FUNCTION inv.job_handled(p_job inv.jobs) RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_job.status || ' by ' || u.name || ' on ' || pg_catalog.to_char(l.at AT TIME ZONE 'America/New_York', 'FMMonth FMDD, YYYY')
    FROM inv.activity_log l JOIN inv.users u ON u.id = l.actor_id
   WHERE l.target_table = 'jobs' AND l.target_id = p_job.id AND l.action IN ('commit job', 'mark built', 'mark shipped')
   ORDER BY l.id DESC LIMIT 1
$$;

-- 010's inv.commit_job, now inv.commit_sheet, refusing with inv.job_handled
-- (S28). p_deduct: for Deduct directly, a job already in the app is refused
-- even from the same sheet, which a commit answers as unchanged. 010's
-- comment stands: as 008, with lumber (#99). p_job: {number, name, delivery_date, lines:
-- [{item_id, quantity}, …], lumber: {demand, plan}}. lines holds no lumber
-- item: the sheet's lumber lines are the boards of lumber.plan, saved with
-- the sheet, so the lines and the plan cannot disagree.
CREATE FUNCTION inv.commit_sheet(p_actor bigint, p_key uuid, p_job jsonb, p_deduct boolean)
RETURNS jsonb
LANGUAGE plpgsql
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
    -- The same sheet again is a no-op for a committed job, unless this is a
    -- retry of the commit that saved it, which answers as that commit did
    -- (inv.claim_action). For a job built or shipped it is refused below with
    -- who handled it (S28, J75).
    IF v_current.fingerprint = v_fingerprint AND v_job.status = 'committed' AND NOT p_deduct
       AND NOT EXISTS (SELECT 1 FROM inv.activity_log WHERE retry_key = p_key) THEN
      RETURN inv.job_json(v_job, v_current.revision) || '{"unchanged": true}';
    END IF;
  END IF;

  a := inv.claim_action(p_actor, p_key, 'commit job', 'jobs', NULL, p_job);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;

  IF v_job.id IS NOT NULL THEN
    -- Revised sheets come with #104 (J7). Until then a different sheet for a
    -- job already in the app is refused with who committed it and when (story
    -- 8), and any sheet for a shipped job with who shipped it (S28).
    RAISE EXCEPTION 'Job % was already %.', v_job.number, inv.job_handled(v_job) ||
      CASE WHEN v_job.status <> 'committed' THEN '' WHEN p_deduct THEN '; mark it shipped on the Job board'
           ELSE ', from a different sheet' END USING ERRCODE = 'IV422';
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

CREATE OR REPLACE FUNCTION inv.commit_job(p_actor bigint, p_key uuid, p_job jsonb)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.commit_sheet(p_actor, p_key, p_job, false)
$$;

-- Jobs → Deduct directly (story 19): commits sheet p_job (inv.commit_sheet)
-- and marks it shipped (inv.mark_jobs) in one save, for a job already gone.
-- Two activity-log rows, commit job and mark shipped, so the job's history
-- reads as any other's. A job already in the app is refused with who
-- handled it and when (S28); a retry answers as the first save did.
CREATE FUNCTION inv.deduct_directly(p_actor bigint, p_key uuid, p_job jsonb, p_timing jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT inv.mark_jobs(p_actor, inv.sub_key(p_key, 2), 'shipped', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'number', inv.commit_sheet(p_actor, inv.sub_key(p_key, 1), p_job, true) -> 'number', 'version', 1)), p_timing) -> 'jobs' -> 0
$$;

GRANT EXECUTE ON FUNCTION inv.deduct_directly(bigint, uuid, jsonb, jsonb) TO inv_app;

-- 009's view, with committed read from inv.job_committed, so a built job
-- still commits its hangers but no longer its plates, lumber or LVL (#96,
-- "Committed and Available"). Otherwise as 009.
CREATE OR REPLACE VIEW inv.item_figures AS
SELECT d.item_id, d.incoming, d.on_hand, d.depth_lf,
       CASE WHEN d.available < 0 THEN 'Short'
            WHEN d.available <= d.threshold OR d.depth_lf <= t.threshold_lf THEN 'Low'
            ELSE 'OK' END AS reorder,
       d.counted_at, d.committed, d.available
  FROM (SELECT a.*,
               CASE WHEN a.family = 'lvl'
                    THEN pg_catalog.sum(a.available * a.length_ft) OVER (PARTITION BY a.family, a.size)::integer END AS depth_lf
          FROM (SELECT f.*, f.on_hand - f.committed AS available
                  FROM (SELECT i.id AS item_id, i.family, i.size, i.length_ft, i.threshold,
                               coalesce(pg_catalog.sum(GREATEST(l.ordered - inv.received(l.id), 0)), 0)::integer AS incoming,
                               inv.on_hand_at(i.id, 'infinity') AS on_hand,
                               (SELECT b.counted_at FROM inv.base_count(i.id, 'infinity') b) AS counted_at,
                               coalesce(jc.committed, 0) AS committed
                          FROM inv.items i
                          LEFT JOIN inv.po_lines l ON l.item_id = i.id AND l.closed_reason_id IS NULL
                          LEFT JOIN inv.job_committed() jc ON jc.item_id = i.id
                         GROUP BY i.id, jc.committed) f) a) d
  LEFT JOIN inv.lvl_depth_thresholds t ON d.family = 'lvl' AND t.depth = d.size;
