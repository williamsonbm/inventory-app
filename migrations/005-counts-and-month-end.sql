-- Step 3, part 3 (#81): counts and month-end. All of part 3 goes in this one
-- file, built over several sessions, applied once part 3 is complete (owner,
-- 2026-10-07, like 004). Group A (story 28) starts it: the working-day
-- setting, and the window function group D will call.
-- Source: docs/database-design.md, table 16 (settings); #81 story 28 and
-- "Changes made while building part 1", item 1 (story 28 moved here: no
-- migration before this one ever created inv.settings).
-- Follows migration 001: every change is a SECURITY DEFINER function that
-- starts with inv.claim_action and ends with inv.finish_action; every name is
-- fully qualified; every refusal carries an IV code (listed in 001).

-- Single named values, each with its own version (design table 16), so a
-- screen that read one setting can be refused a stale save without a table
-- lock on the others. value is deliberately jsonb, not integer: a later
-- setting need not be a number, and typing this one integer now would cost
-- a column-type migration to loosen later.
CREATE TABLE inv.settings (
  name    text PRIMARY KEY,
  value   jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1
);

CREATE TRIGGER bump_version BEFORE UPDATE OF value ON inv.settings
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- The window an entry made after a count asks "before or after?" for (design
-- Q4): a whole number of working days, weekends always skipped, holidays not.
-- Seeded 1, the design's default.
INSERT INTO inv.settings (name, value) VALUES ('working_day_window', '1');

CREATE FUNCTION inv.setting_json(s inv.settings) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('name', s.name, 'value', s.value, 'version', s.version) $$;

-- The moment the working-day window reaches back to, from p_at: p_at's clock
-- time, that many working days earlier, in America/New_York, weekends
-- skipped and holidays not (design Q4). Reads the setting itself, so group D
-- (the before-or-after question) only calls this, never inv.settings
-- directly. Monday 8:00 with the default 1 reaches back to Friday 8:00: one
-- day back lands on Sunday (skipped, still 1 to go), another lands on
-- Saturday (skipped, still 1 to go), another lands on Friday (a weekday, done).
CREATE FUNCTION inv.working_day_window_start(p_at timestamptz) RETURNS timestamptz
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_local timestamp := p_at AT TIME ZONE 'America/New_York';
  v_remaining integer;
BEGIN
  SELECT (value)::integer INTO v_remaining FROM inv.settings WHERE name = 'working_day_window';
  WHILE v_remaining > 0 LOOP
    v_local := v_local - interval '1 day';
    IF pg_catalog.date_part('dow', v_local) NOT IN (0, 6) THEN
      v_remaining := v_remaining - 1;
    END IF;
  END LOOP;
  RETURN v_local AT TIME ZONE 'America/New_York';
END
$$;

INSERT INTO inv.actions (name, admin_only) VALUES ('set working day window', true);

-- Settings → Inventory → Working day. Everyone reads the value (/api/working-day);
-- only an admin changes it (owner, Q101; #81 "Admin-only actions").
CREATE FUNCTION inv.set_working_day_window(p_actor bigint, p_key uuid, p_version integer, p_days numeric)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.settings;
  s inv.settings;
BEGIN
  a := inv.claim_action(p_actor, p_key, 'set working day window', 'settings', NULL,
                        pg_catalog.jsonb_build_object('version', p_version, 'days', p_days));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  SELECT * INTO was FROM inv.settings WHERE name = 'working_day_window' FOR UPDATE;
  IF p_version IS DISTINCT FROM was.version THEN
    RAISE EXCEPTION 'Someone else changed the working-day window since you opened this screen.'
      USING ERRCODE = 'IV409', DETAIL = inv.setting_json(was)::text;
  END IF;
  IF p_days IS NULL OR p_days <> pg_catalog.trunc(p_days) OR p_days < 1 THEN
    RAISE EXCEPTION 'The working-day window is a whole number of days, 1 or more.' USING ERRCODE = 'IV400';
  END IF;
  UPDATE inv.settings SET value = pg_catalog.to_jsonb(p_days::integer) WHERE name = 'working_day_window'
  RETURNING * INTO s;
  RETURN inv.finish_action(a.log_id, NULL, inv.setting_json(was), inv.setting_json(s));
END
$$;

GRANT EXECUTE ON FUNCTION inv.set_working_day_window(bigint, uuid, integer, numeric) TO inv_app;
