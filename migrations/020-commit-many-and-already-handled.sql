-- #103 (spec #96, stories 3–5, 49–50): many sheets commit in one action, and
-- the Planner lists the jobs already handled. Source: spec #96, owner
-- J297–J299. Every name is fully qualified (#28).
--
-- Reach: a new function for inv_app, inv.commit_jobs. The Planner's login,
-- inv_planner, may read the job tables and run inv.is_current_sheet and the
-- new inv.jobs_handled; it still writes no row (ADR 0001). No row changes;
-- no existing function changes.
-- Recovery: drop inv.commit_jobs and inv.jobs_handled; revoke inv_planner's
-- SELECT on inv.jobs, inv.job_sheets, inv.job_lines and
-- inv.lumber_cut_plans, and its EXECUTE on inv.is_current_sheet.

-- Jobs → commit many sheets (stories 3–5): commits the sheets p_jobs (a list
-- of what inv.commit_job takes, with no version or date choice) in one
-- transaction, so one refusal saves none (S21). Each job gets its own
-- activity-log row, retried by the one key the screen sent (inv.sub_key).
-- A revised sheet, or a cancelled job's, commits on its own, with its change
-- screen (J298); the current sheet of a committed or built job is unchanged,
-- and a shipped job's is refused by inv.commit_sheet with who shipped it.
-- Answers { jobs: [each job as inv.commit_job answers it] }.
CREATE FUNCTION inv.commit_jobs(p_actor bigint, p_key uuid, p_jobs jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r jsonb;
  n integer;
  v_job inv.jobs;
  v_out jsonb := '[]';
BEGIN
  IF pg_catalog.jsonb_typeof(p_jobs) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_jobs) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Pick 1 to 50 sheets to commit.' USING ERRCODE = 'IV400';
  END IF;
  FOR r, n IN SELECT e, o FROM pg_catalog.jsonb_array_elements(p_jobs) WITH ORDINALITY AS x(e, o) LOOP
    SELECT * INTO v_job FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper(inv.tidy(r ->> 'number'));
    IF v_job.status = 'cancelled' THEN
      RAISE EXCEPTION 'Job % was %: commit its sheet on its own.', v_job.number, inv.job_handled(v_job) USING ERRCODE = 'IV422';
    ELSIF v_job.status IN ('committed', 'built') AND NOT inv.is_current_sheet(r) THEN
      RAISE EXCEPTION 'Job % is already in the app, and this is a revised sheet: commit it on its own.', v_job.number
        USING ERRCODE = 'IV422';
    END IF;
    v_out := v_out || pg_catalog.jsonb_build_array(
      inv.commit_sheet(p_actor, inv.sub_key(p_key, n::integer), r - 'version' - 'keep_date', false));
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('jobs', v_out);
END
$$;

GRANT EXECUTE ON FUNCTION inv.commit_jobs(bigint, uuid, jsonb) TO inv_app;

-- The Planner's "Already handled" (story 49, J299): of the job numbers
-- p_numbers, as dropped sheets carry them, each job already committed,
-- built or shipped, with who and when (inv.job_handled). Deliberately a
-- SECURITY DEFINER function, not SELECT on inv.activity_log and inv.users
-- for inv_planner: inv.users holds every password hash.
CREATE FUNCTION inv.jobs_handled(p_numbers text[])
RETURNS TABLE (sheet_number text, number text, name text, status text, handled text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT n, j.number, j.name, j.status, inv.job_handled(j)
    FROM pg_catalog.unnest(p_numbers) AS n
    JOIN inv.jobs j ON pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy(n))
   WHERE j.status IN ('committed', 'built', 'shipped')
$$;

-- The Planner reads the job tables (#96, "Planner"): a sheet already
-- handled says whether it differs from the job's current one, read the way
-- the check before a commit reads it (src/jobs/jobs.js, alreadyHandled).
GRANT SELECT ON inv.jobs, inv.job_sheets, inv.job_lines, inv.lumber_cut_plans TO inv_planner;
GRANT EXECUTE ON FUNCTION inv.is_current_sheet(jsonb), inv.jobs_handled(text[]) TO inv_planner;
