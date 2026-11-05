-- #185: a job's LVL remainders back on hand at Built, out again at
-- Un-build. Source: docs/database-design.md #125 (3), S49; spec #178,
-- stories 21–26, 33, 35, 39, 41; owner #185 Q41–Q43. Every name is fully
-- qualified (#28).
--
-- Reach: a new ledger kind 'remainder' linked to its job, the kind and job
-- checks widened for it, one remainder row per item per build (a unique
-- index), inv.mark_jobs redefined to put the remainders of the job's saved
-- LVL plan back on hand when it consumes the job's LVL, and the functions
-- inv.lvl_plan_today, inv.job_remainders and inv.item_at_length;
-- inv.job_to_give_back redefined so Un-build and Un-ship take the
-- remainders back out, inv.reverse_entry so Reverse refuses them, and
-- inv.job_settled so a job's remainders are not what it consumed. No existing
-- row changes meaning: no row has the new kind, so every row passes both
-- the old and the new rules, and every job is marked as before but for its
-- remainders.
-- Recovery: before any job is built with an LVL plan, rerun 022's
-- ledger_kind_check and ledger_job_check, 011's inv.mark_jobs and 022's
-- inv.job_to_give_back and inv.reverse_entry, and 021's inv.job_settled
-- (as CREATE OR REPLACE); drop the index ledger_remainder_once and the new
-- functions. After one is, its remainder rows are what on hand reads; keep
-- them.

-- A remainder adds a board back to on hand for one job's build; its
-- reversal, at Un-build, carries the job too (012).
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_kind_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_kind_check
  CHECK (kind IN ('receipt', 'correction', 'reversal', 'build', 'ship', 'return', 'remainder'));
ALTER TABLE inv.ledger DROP CONSTRAINT ledger_job_check;
ALTER TABLE inv.ledger ADD CONSTRAINT ledger_job_check
  CHECK (CASE WHEN kind = 'build' THEN job_id IS NOT NULL AND (quantity < 0 OR reason_id IS NOT NULL)
              WHEN kind = 'ship' THEN job_id IS NOT NULL AND quantity < 0
              WHEN kind IN ('return', 'remainder') THEN job_id IS NOT NULL AND quantity > 0
              ELSE job_id IS NULL OR kind = 'reversal' END);

-- Credited once (S49): a build's remainders at one length are one row, so
-- a second writer of the same build's remainders is refused.
CREATE UNIQUE INDEX ledger_remainder_once ON inv.ledger (action_id, item_id) WHERE kind = 'remainder';

-- Saved LVL plan p_plan (025) of job p_job with each board's kept_ft as
-- the length its remainder goes back on hand at, rounded down to an even
-- foot as the yard counts (story 22); null, scrap, otherwise (story 23).
-- Within 1/16″ of an even foot counts as it, judged in sixteenths, so
-- exactly 1/16″ short does too (PR #192 review, finding 4): 192 is
-- sixteenths in 1 ft, 384 in 2 ft (src/lvl/planLvlCuts.js,
-- SIXTEENTHS_PER_FT). Before the job consumes its LVL, a remainder is kept
-- at or above today's shortest remainder kept for its depth (Q42). After,
-- as Built (or Shipped from committed) put it back (Q46): the job's
-- remainder rows not reversed give the shortest length kept at each depth,
-- as the setting was then. Another job may have used one since; the row
-- still counts.
-- Its boards and pieces stay as saved. What Built puts back on hand
-- (inv.job_remainders) and what the check and the pull list print
-- (src/jobs/jobs.js, FAMILIES) read it, so they agree;
-- src/lvl/planLvlCuts.js judges a plan not yet saved the same way.
-- Deliberately SECURITY DEFINER, as inv.job_committed (011): the Planner's
-- "Already handled" reads saved plans. The alternative, a grant of SELECT
-- on inv.ledger to inv_planner, lets the Planner read every entry, with
-- its person, reason and quantity. The cost: the function trusts the
-- status and id in the p_job row, so inv_planner can learn whether a job
-- has a remainder row at or below a length at a depth (second PR #192
-- review). For a built job, "Already handled" shows nearly as much.
CREATE FUNCTION inv.lvl_plan_today(p_plan jsonb, p_job inv.jobs) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_agg(b || pg_catalog.jsonb_build_object('kept_ft',
           CASE WHEN CASE WHEN p_job.status IN ('built', 'shipped')
                          THEN EXISTS (SELECT FROM inv.ledger g JOIN inv.items ri ON ri.id = g.item_id
                                        WHERE g.job_id = p_job.id AND g.kind = 'remainder'
                                          AND NOT EXISTS (SELECT FROM inv.ledger x WHERE x.reverses_id = g.id)
                                          AND ri.size = b ->> 'depth' AND ri.length_ft <= k.even_ft)
                          ELSE k.even_ft >= s.shortest_remainder_kept_ft END
                THEN k.even_ft END) ORDER BY n)
    FROM pg_catalog.jsonb_array_elements(p_plan) WITH ORDINALITY AS x(b, n)
   CROSS JOIN LATERAL (SELECT (pg_catalog.floor((pg_catalog.round((b ->> 'remainder_ft')::numeric * 192) + 1) / 384) * 2)::integer AS even_ft) k
    LEFT JOIN inv.lvl_depth_settings s ON s.depth = b ->> 'depth'
$$;

-- The boards job p_job's saved LVL plan puts back on hand when marking it
-- p_to consumes its LVL (stories 21, 22): at Built, or at Shipped from
-- committed. Per board item and kept length, how many. Nothing for a job
-- with no plan. inv.mark_jobs writes them; the confirmation lists them
-- (src/jobs/jobs.js, toConsume, Q41).
CREATE FUNCTION inv.job_remainders(p_job inv.jobs, p_to text)
RETURNS TABLE (item_id bigint, length_ft integer, quantity integer)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (b ->> 'item_id')::bigint, (b ->> 'kept_ft')::integer, pg_catalog.count(*)::integer
    FROM inv.lvl_cut_plans p
   CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(inv.lvl_plan_today(p.plan, p_job)) b
   WHERE p.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = p_job.id ORDER BY s.revision DESC LIMIT 1)
     AND b ->> 'kept_ft' IS NOT NULL
     AND EXISTS (SELECT FROM inv.job_to_consume(p_job, p_to) c JOIN inv.items ci ON ci.id = c.item_id
                  WHERE c.live AND ci.family = 'lvl')
   GROUP BY 1, 2
$$;

GRANT EXECUTE ON FUNCTION inv.lvl_plan_today(jsonb, inv.jobs) TO inv_app, inv_planner;
GRANT EXECUTE ON FUNCTION inv.job_remainders(inv.jobs, text) TO inv_app;

-- Item p_item at length p_length_ft: the same product and depth. A length
-- the catalog lacks is added as Non-Stock (Q21); two writers at once find
-- the one added first. 006's inv.trim and 022's inv.record_return hold the
-- same rule inline; the next migration to redefine either can call this.
CREATE FUNCTION inv.item_at_length(p_item inv.items, p_length_ft integer) RETURNS inv.items
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_wanted inv.items := p_item;
  v_item inv.items;
BEGIN
  v_wanted.length_ft := p_length_ft;
  SELECT * INTO v_item FROM inv.items i WHERE inv.same_item(i, v_wanted);
  IF NOT FOUND THEN
    BEGIN
      INSERT INTO inv.items (family, product, size, length_ft, stocking)
      VALUES (v_wanted.family, v_wanted.product, v_wanted.size, v_wanted.length_ft, 'Non-Stock')
      RETURNING * INTO v_item;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_item FROM inv.items i WHERE inv.same_item(i, v_wanted);
    END;
  END IF;
  RETURN v_item;
END
$$;

-- 011's inv.mark_jobs, putting back on hand the remainders of the job's
-- saved LVL plan when the mark consumes its LVL (stories 21, 22, 24),
-- with the build's own log row (S49): at Built, or at Shipped from
-- committed, which consumes the LVL then. Otherwise as 011.
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
  k record;
  v_kept inv.items;
  v_ids bigint[];     -- the remainders' items and pieces, one entry per board item and length
  v_qty integer[];
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
    v_ids := '{}';
    v_qty := '{}';
    FOR k IN SELECT * FROM inv.job_remainders(v_job, p_to) LOOP
      v_kept := inv.item_at_length((SELECT i FROM inv.items i WHERE i.id = k.item_id), k.length_ft);
      IF NOT v_kept.active THEN
        RAISE EXCEPTION '% is retired, and job % puts a remainder back on hand at that length. Un-retire it, then mark the job %.',
          inv.item_label(v_kept), v_job.number, p_to USING ERRCODE = 'IV422';
      END IF;
      v_ids := v_ids || v_kept.id;
      v_qty := v_qty || k.quantity;
    END LOOP;
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
    SELECT c.item_id, -c.quantity, CASE p_to WHEN 'built' THEN 'build' ELSE 'ship' END, pg_catalog.now(), a.log_id, v_job.id
      FROM inv.job_to_consume(v_job, p_to) c WHERE c.live;
    -- One row per item: boards of two lengths can leave remainders of one item.
    INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
    SELECT r.id, pg_catalog.sum(r.quantity), 'remainder', pg_catalog.now(), a.log_id, v_job.id
      FROM ROWS FROM (pg_catalog.unnest(v_ids), pg_catalog.unnest(v_qty)) AS r(id, quantity) GROUP BY r.id;
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

-- 022's inv.job_to_give_back, with the remainders of the job's build
-- (story 25): the step that gives back the job's LVL boards takes them back
-- out, with the build's other rows. Otherwise as 022.
CREATE OR REPLACE FUNCTION inv.job_to_give_back(p_job inv.jobs, p_action text)
RETURNS SETOF inv.ledger
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT g.*
    FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id JOIN inv.families f ON f.code = i.family
   WHERE g.job_id = p_job.id AND g.kind IN ('build', 'ship', 'remainder') AND p_action <> 'cancel job'
     AND NOT ((SELECT inv.undo_to(p_job, p_action)) = 'built' AND f.consumed_when = 'built')
     AND NOT EXISTS (SELECT FROM inv.ledger v WHERE v.reverses_id = g.id)
$$;

-- 022's inv.reverse_entry, refusing a remainder row as it refuses its
-- build's rows: Un-build and Un-ship own it (story 25). Otherwise as 022.
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
  ELSIF o.kind IN ('build', 'ship', 'remainder') THEN
    -- The job's Un-build and Un-ship own its build and ship rows: they give
    -- back what the job consumed and move its status. Reversed here, the
    -- pieces would be back on hand while the job still reads built or shipped.
    -- A remainder shares its build's log row, so Reverse would undo the
    -- whole build with it (#185).
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

-- 021's inv.job_settled, with a job's remainder rows, and their reversals,
-- left out of what it consumed (PR #192 review, finding 1). A remainder is
-- a board put back, not one the job gave back. Deliberately not 021's
-- sum of every row of the job: with it, a revised sheet on the built job
-- that takes its own remainder consumed it twice.
-- inv.job_to_consume needs no change: it counts LVL only while the job is
-- committed, when each of its remainder rows has its reversal, so they sum
-- to 0. 021's comment stands for the rest.
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
             AND coalesce(o.kind, g.kind) <> 'remainder'
             AND NOT EXISTS (SELECT FROM inv.reasons r
                              WHERE r.id = coalesce(o.reason_id, g.reason_id) AND r.entry = 'swap')
           GROUP BY g.item_id) x
   GROUP BY x.item_id
$$;
