-- Step 4 (#97): jobs, their sheets and their lines, and committing a job.
-- Source: docs/database-design.md, tables 18–20 and "Rules the database
-- enforces"; spec #96. Every name is fully qualified (#28).
--
-- Reach: three new tables and one new function; no existing row changes.
-- Recovery: nothing to restore; the tables hold only what Jobs writes.
--
-- Three of table 18–20's columns wait for their readers (CODING-STANDARDS.md,
-- Readers): the job's version, with the first action that changes a job
-- (#100); the delivery date's override flag (#102); and EWP's "waiting for
-- optimizer" (step 5; EWP lines are left out of step 4, J13).

INSERT INTO inv.actions (name, admin_only) VALUES ('commit job', false);

-- One order, named by its full number with its suffix: 44444R and 44444F
-- are two jobs (CONTEXT.md, Job). Capitals are one job: "44444r" is 44444R.
CREATE TABLE inv.jobs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number        text NOT NULL CHECK (number = inv.tidy(number) AND number <> ''),
  name          text CHECK (name = inv.tidy(name) AND name <> ''),
  status        text NOT NULL DEFAULT 'committed' CHECK (status IN ('committed', 'built', 'shipped', 'cancelled')),
  delivery_date date
);

CREATE UNIQUE INDEX jobs_number_key ON inv.jobs (pg_catalog.upper(number));

-- One saved sheet of a job. The highest revision is the current one.
-- fingerprint is the SHA-256 of the sheet's lines (inv.sheet_fingerprint),
-- so the same sheet dropped again is found without comparing every line.
-- Who saved it and when come from the action's activity-log row.
CREATE TABLE inv.job_sheets (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      bigint NOT NULL REFERENCES inv.jobs (id),
  revision    integer NOT NULL CHECK (revision > 0),
  fingerprint bytea NOT NULL,
  action_id   bigint NOT NULL REFERENCES inv.activity_log (id),
  UNIQUE (job_id, revision)
);

CREATE INDEX job_sheets_action_idx ON inv.job_sheets (action_id);  -- the Activity Log's family filter

-- A job's latest log row, for the Job board's "last changed".
CREATE INDEX activity_log_target_idx ON inv.activity_log (target_table, target_id, id);

-- One item on a sheet, once: a sheet that lists an item in two sections
-- holds their sum. What the job consumed is never stored here; it is read
-- from the ledger (design, table 20).
CREATE TABLE inv.job_lines (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sheet_id bigint NOT NULL REFERENCES inv.job_sheets (id),
  item_id  bigint NOT NULL REFERENCES inv.items (id),
  quantity integer NOT NULL CHECK (quantity > 0),  -- the item's own pieces, whole
  UNIQUE (sheet_id, item_id)
);

CREATE INDEX job_lines_item_idx ON inv.job_lines (item_id);

-- A saved sheet and its lines are never edited (design, table 19), whatever
-- writes the row. A revised sheet is a new revision.
CREATE FUNCTION inv.refuse_sheet_edit() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'A saved job sheet cannot be changed; a revised sheet is a new revision.' USING ERRCODE = 'IV422';
END
$$;

CREATE TRIGGER refuse_edit BEFORE UPDATE OR DELETE ON inv.job_sheets
  FOR EACH ROW EXECUTE FUNCTION inv.refuse_sheet_edit();
CREATE TRIGGER refuse_edit BEFORE UPDATE OR DELETE ON inv.job_lines
  FOR EACH ROW EXECUTE FUNCTION inv.refuse_sheet_edit();

CREATE FUNCTION inv.job_json(j inv.jobs, p_revision integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'number', j.number, 'name', j.name, 'revision', p_revision)
$$;

-- The lines of a sheet, one per item with quantities summed, as the rows
-- inv.job_lines holds. p_lines is [{item_id, quantity}, …].
CREATE FUNCTION inv.sheet_lines(p_lines jsonb, OUT item_id bigint, OUT quantity integer)
RETURNS SETOF record
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (l ->> 'item_id')::bigint, pg_catalog.sum((l ->> 'quantity')::integer)::integer
    FROM pg_catalog.jsonb_array_elements(p_lines) AS l
   GROUP BY 1
$$;

CREATE FUNCTION inv.sheet_fingerprint(p_lines jsonb) RETURNS bytea
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.sha256(pg_catalog.convert_to(
    coalesce(pg_catalog.string_agg(s.item_id || ':' || s.quantity, ',' ORDER BY s.item_id), ''), 'UTF8'))
    FROM inv.sheet_lines(p_lines) AS s
$$;

-- Commits one job from its sheet (stories 1, 2, 6, 7, 9–11).
-- p_job: {number, name, delivery_date, lines: [{item_id, quantity}, …]}. The
-- server reads the file and matches its lines to items (src/jobs/sheet.js);
-- this function refuses again what the server refuses, as the guarantee.
-- A line of a family not live in Inventory is kept like any other (J4).
-- The same sheet for an open job changes nothing and writes no log row (S20).
CREATE FUNCTION inv.commit_job(p_actor bigint, p_key uuid, p_job jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_number text := inv.tidy(p_job ->> 'number');
  v_lines jsonb := coalesce(p_job -> 'lines', '[]');
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
  IF pg_catalog.jsonb_typeof(v_lines) <> 'array' OR pg_catalog.jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'Job % has no lines to commit.', v_number USING ERRCODE = 'IV400';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) AS l
              WHERE NOT (inv.is_whole_above_zero(l -> 'quantity') AND inv.is_whole_above_zero(l -> 'item_id'))) THEN
    RAISE EXCEPTION 'Each line names an item and a whole quantity above 0.' USING ERRCODE = 'IV400';
  END IF;
  v_fingerprint := inv.sheet_fingerprint(v_lines);

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
    RAISE EXCEPTION 'Job % was not committed: % is not in the catalog or is retired.', v_number, v_bad
      USING ERRCODE = 'IV422';
  END IF;

  INSERT INTO inv.jobs (number, name, delivery_date)
  VALUES (v_number, inv.tidy(p_job ->> 'name'), (p_job ->> 'delivery_date')::date)
  RETURNING * INTO v_job;
  INSERT INTO inv.job_sheets (job_id, revision, fingerprint, action_id)
  VALUES (v_job.id, 1, v_fingerprint, a.log_id)
  RETURNING id INTO v_sheet;
  INSERT INTO inv.job_lines (sheet_id, item_id, quantity)
  SELECT v_sheet, s.item_id, s.quantity FROM inv.sheet_lines(v_lines) AS s;
  RETURN inv.finish_action(a.log_id, v_job.id, NULL, inv.job_json(v_job, 1));
END
$$;

GRANT EXECUTE ON FUNCTION inv.commit_job(bigint, uuid, jsonb) TO inv_app;
