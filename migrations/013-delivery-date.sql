-- Step 4 (#102): editing a job's delivery date. Source: spec #96, story 33
-- and Implementation Decisions ("Database rules": a retry key and the job's
-- version); owner J103. Every name is fully qualified (#28).
--
-- Reach: one new column with a default (jobs.delivery_date_edited, false
-- on every row today, the flag 008 deferred to #102), one new action, the
-- jobs version trigger widened to the delivery date, inv.item_label split
-- into its name and length (same text), and new functions.
-- No existing row changes meaning.
-- Recovery: before any date is edited, rerun 011's bump_version trigger and
-- drop the column. After one is, the edited dates are the jobs' own; keep them.

INSERT INTO inv.actions (name, admin_only) VALUES ('set delivery date', false);

-- Whether a person set the delivery date by hand, not the sheet (J103): the
-- job view says so, and a revised sheet with another date asks which to
-- keep (#104, story 34).
ALTER TABLE inv.jobs ADD COLUMN delivery_date_edited boolean NOT NULL DEFAULT false;

-- 011's trigger, now moving the version on a date edit too, so a screen
-- opened before it is refused (Q48).
DROP TRIGGER bump_version ON inv.jobs;
CREATE TRIGGER bump_version BEFORE UPDATE OF status, delivery_date ON inv.jobs
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- An item's name without its length, for the job view's lines (J105);
-- 003's inv.item_label is that name and the length, the same text as before.
CREATE FUNCTION inv.item_name(i inv.items) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.concat_ws(' ', i.sku, i.product || ' x ' || i.size,
                              CASE WHEN i.product IS NULL THEN i.size END, i.grade)
$$;

CREATE OR REPLACE FUNCTION inv.item_label(i inv.items) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.concat_ws(' ', inv.item_name(i), i.length_ft || '′')
$$;

GRANT EXECUTE ON FUNCTION inv.item_name(inv.items) TO inv_app;

-- A job as the log row of a delivery date edit records it.
CREATE FUNCTION inv.job_dated(j inv.jobs) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object('number', j.number, 'name', j.name, 'delivery_date', j.delivery_date, 'version', j.version)
$$;

-- Jobs → the job view's delivery date (story 33): sets job p_number's date
-- to p_date, or clears it with NULL, as the screen showed the job at
-- p_version, with one activity-log row, and marks it set by hand (J103).
-- Any job but a cancelled one. Answers the job as its log row records it.
CREATE FUNCTION inv.set_delivery_date(p_actor bigint, p_key uuid, p_number text, p_version integer, p_date date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  v_job inv.jobs;
  v_was jsonb;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set delivery date', 'jobs', NULL,
                        pg_catalog.jsonb_build_object('number', p_number, 'version', p_version, 'delivery_date', p_date));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(p_number)) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % is not in the app.', p_number USING ERRCODE = 'IV400';
  END IF;
  v_was := inv.job_dated(v_job);
  IF p_version IS DISTINCT FROM v_job.version THEN
    RAISE EXCEPTION 'Someone else changed job % since you opened this screen.', v_job.number
      USING ERRCODE = 'IV409', DETAIL = v_was::text;
  ELSIF v_job.status = 'cancelled' THEN
    RAISE EXCEPTION 'Job % is cancelled, so its delivery date cannot be changed.', v_job.number USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.jobs SET delivery_date = p_date, delivery_date_edited = true WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN inv.finish_action(a.log_id, v_job.id, v_was, inv.job_dated(v_job));
END
$$;

GRANT EXECUTE ON FUNCTION inv.set_delivery_date(bigint, uuid, text, integer, date) TO inv_app;
