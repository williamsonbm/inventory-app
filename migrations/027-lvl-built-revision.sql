-- #186: a revised sheet for a built job consumes only what is not settled.
-- Source: spec #178, story 27; owner #186 Q58–Q60. Every name is fully
-- qualified (#28).
--
-- Reach: inv.commit_sheet redefined. For a built job whose current sheet
-- has a saved LVL plan, the new plan must start with that plan's boards
-- (refused otherwise); the boards after them are the revision's own: only
-- they are checked against what is available, and, when LVL is live and
-- consumed at Built, their remainders go back on hand as 'remainder' rows
-- of the revision (kept at today's shortest remainder kept, Q60). Un-build
-- already takes those rows back out (026, inv.job_to_give_back). The new
-- function inv.put_back_remainders writes them, and 026's inv.mark_jobs is
-- redefined to call it, its rows and refusal as before. No existing row
-- changes meaning; every other sheet commits as under 025.
-- Recovery: rerun 025's inv.commit_sheet and 026's inv.mark_jobs (as
-- CREATE OR REPLACE), then drop inv.put_back_remainders. After a revision
-- has put a remainder back on hand, its row is what on hand reads; keep
-- it, and Un-build takes it out.

-- Puts back on hand, for job p_job under log row p_log_id, the remainders
-- p_remainders: [{item_id, length_ft, quantity}], each a board item and
-- the length its remainder is kept at, as inv.job_remainders gives them.
-- Each goes back as the item at that length (inv.item_at_length), one
-- 'remainder' row per item: boards of two lengths can leave remainders of
-- one item (ledger_remainder_once). A retired item at that length refuses,
-- saying to un-retire it, then p_redo. Nothing for no remainders.
CREATE FUNCTION inv.put_back_remainders(p_job inv.jobs, p_remainders jsonb, p_log_id bigint, p_redo text) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  k record;
  v_kept inv.items;
  v_ids bigint[] := '{}';
  v_qty integer[] := '{}';
BEGIN
  FOR k IN SELECT * FROM pg_catalog.jsonb_to_recordset(coalesce(p_remainders, '[]')) AS r(item_id bigint, length_ft integer, quantity integer) LOOP
    v_kept := inv.item_at_length((SELECT i FROM inv.items i WHERE i.id = k.item_id), k.length_ft);
    IF NOT v_kept.active THEN
      RAISE EXCEPTION '% is retired, and job % puts a remainder back on hand at that length. Un-retire it, then %.',
        inv.item_label(v_kept), p_job.number, p_redo USING ERRCODE = 'IV422';
    END IF;
    v_ids := v_ids || v_kept.id;
    v_qty := v_qty || k.quantity;
  END LOOP;
  INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
  SELECT r.id, pg_catalog.sum(r.quantity), 'remainder', pg_catalog.now(), p_log_id, p_job.id
    FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_qty)) AS r(id, quantity) GROUP BY r.id;
END
$$;

-- 026's inv.mark_jobs, putting the remainders back on hand through
-- inv.put_back_remainders, as a built job's revision does. Otherwise as 026.
CREATE OR REPLACE FUNCTION inv.mark_jobs(p_actor bigint, p_key uuid, p_to text, p_jobs jsonb, p_timing jsonb)
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
  v_remainders jsonb;
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
    -- Read before the consuming rows below, which leave nothing to consume.
    v_remainders := (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(k)) FROM inv.job_remainders(v_job, p_to) k);
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
    SELECT c.item_id, -c.quantity, CASE p_to WHEN 'built' THEN 'build' ELSE 'ship' END, pg_catalog.now(), a.log_id, v_job.id
      FROM inv.job_to_consume(v_job, p_to) c WHERE c.live;
    PERFORM inv.put_back_remainders(v_job, v_remainders, a.log_id, 'mark the job ' || p_to);
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

-- 025's inv.commit_sheet, with a built job's added LVL boards (Q59, Q60):
-- src/jobs/jobs.js (lvlLines) keeps the saved plan's boards first, as
-- saved, and adds the boards for the pieces they do not hold after them.
-- kept_ft is left out of the comparison: the saved plan answers it by
-- inv.lvl_plan_today. Deliberately the boards after the saved ones, not a
-- flag on each board the request sends: a flag is one more thing the
-- database would trust, and a wrong one would put back remainders of
-- boards Built already put back. The added boards' remainders are kept by
-- today's setting: inv.lvl_plan_today reads it for a committed job, so it
-- is given the job as committed. 025's comment stands for the rest.
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
  v_saved jsonb;      -- a built job's saved LVL plan, the boards it cut
  v_added jsonb;      -- the boards of v_lvl a commit takes: for a built job, those after v_saved
  v_today inv.jobs;
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

  v_added := v_lvl;
  IF v_job.status = 'built' AND v_lvl IS NOT NULL THEN
    SELECT p.plan INTO v_saved FROM inv.lvl_cut_plans p WHERE p.sheet_id = v_current.id;
    IF v_saved IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_saved) WITH ORDINALITY AS o(b, i)
                  WHERE (v_lvl -> (o.i - 1)::integer) - 'kept_ft' IS DISTINCT FROM o.b - 'kept_ft') THEN
        RAISE EXCEPTION 'The LVL plan for built job % does not keep the boards it cut.', v_number;
      END IF;
      v_added := (SELECT coalesce(pg_catalog.jsonb_agg(x.b ORDER BY x.i), '[]')
                    FROM pg_catalog.jsonb_array_elements(v_lvl) WITH ORDINALITY AS x(b, i)
                   WHERE x.i > pg_catalog.jsonb_array_length(v_saved));
    END IF;
  END IF;
  IF v_added @> '[{"source": "on hand"}]'
     AND NOT (v_job.status IN ('committed', 'built')
              AND EXISTS (SELECT 1 FROM inv.lvl_cut_plans WHERE sheet_id = v_current.id AND plan = v_lvl))
     AND EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_added) AS b
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
    -- The added boards' remainders back on hand, as 026's inv.mark_jobs
    -- puts back Built's, kept by today's shortest remainder kept: the
    -- setting a committed job's plan reads.
    IF v_saved IS NOT NULL AND EXISTS (SELECT FROM inv.families f WHERE f.code = 'lvl' AND f.consumed_when = 'built' AND f.live) THEN
      v_today := v_job;
      v_today.status := 'committed';
      PERFORM inv.put_back_remainders(v_job,
        (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item_id', g.item_id, 'length_ft', g.length_ft, 'quantity', g.quantity))
           FROM (SELECT (b ->> 'item_id')::bigint AS item_id, (b ->> 'kept_ft')::integer AS length_ft, pg_catalog.count(*) AS quantity
                   FROM pg_catalog.jsonb_array_elements(inv.lvl_plan_today(v_added, v_today)) AS b
                  WHERE b ->> 'kept_ft' IS NOT NULL GROUP BY 1, 2) g),
        a.log_id, 'commit the sheet again');
    END IF;
  END IF;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_json(v_job, v_revision)
    || CASE WHEN v_was IS NULL THEN '{}' ELSE pg_catalog.jsonb_build_object('delivery_date', v_job.delivery_date) END || v_timed);
END
$$;
