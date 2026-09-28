-- Step 2 (#77): the people who use the app, and the log of every change.
-- Source: docs/database-design.md, tables 1 and 2 and "Rules the database enforces".
-- Every name is fully qualified, inside function bodies too (#28).
--
-- Refusals carry their own SQLSTATE, so the app can tell them apart without
-- reading message text:
--   IV400  a value is impossible (blank name, address without one @, duplicate address)
--   IV403  the person acting is not an active user, or not an admin where one is needed
--   IV409  the row changed since it was read; DETAIL is the current row as JSON
--   IV410  a retry key already used for a different request
--   IV422  a rule refuses the change (last active admin, already removed, setup done)
-- At REPEATABLE READ or SERIALIZABLE a clash with another save can arrive as
-- 40001 (could not serialize) instead; the app runs at READ COMMITTED.

-- Text with its leading and trailing blanks removed: spaces, tabs, line breaks
-- and the non-breaking space (U+00A0) a pasted address often carries.
-- btrim removes only plain spaces, so a name of one tab would pass it.
CREATE FUNCTION inv.tidy(p text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.regexp_replace(p, '^[\s\u00a0]+|[\s\u00a0]+$', '', 'g') $$;

-- An address with exactly one @ and no blanks. The table's CHECK and
-- inv.check_person both use it, so the plain refusal and the backstop agree.
CREATE FUNCTION inv.is_email(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT p ~ '^[^@\s\u00a0]+@[^@\s\u00a0]+$' $$;

CREATE TABLE inv.users (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Stored lowercase and unique, so one address never has two entries however
  -- it is capitalized. Exactly one @.
  email   text NOT NULL UNIQUE
          CHECK (email = pg_catalog.lower(inv.tidy(email)) AND inv.is_email(email)),
  name    text NOT NULL CHECK (name = inv.tidy(name) AND name <> ''),
  active  boolean NOT NULL DEFAULT true,
  -- An admin manages the user list; everyone else uses the rest of the app.
  -- Departure, named: #72 says "There is one role"; the owner added this on 2026-09-28.
  admin   boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1
);

-- Every action the log can record, and whether only an admin may take it.
-- inv.claim_action reads it, so the role is decided in one place for every
-- change. A new action is a new row, and admin_only has no default, so each
-- new action must say which it is. Deliberately a table (a departure, named:
-- the 24th). It
-- replaces a CHECK list on activity_log.action and a role check that each
-- function had to remember to call.
CREATE TABLE inv.actions (
  name       text PRIMARY KEY,
  admin_only boolean NOT NULL
);

INSERT INTO inv.actions (name, admin_only) VALUES
  ('add user', true), ('rename user', true), ('remove user', true),
  ('re-activate user', true), ('grant admin', true), ('revoke admin', true);

CREATE TABLE inv.activity_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  retry_key    uuid NOT NULL UNIQUE,
  request_hash bytea NOT NULL,     -- SHA-256 of the call's arguments; see inv.claim_action
  actor_id     bigint NOT NULL REFERENCES inv.users (id),
  at           timestamptz NOT NULL DEFAULT pg_catalog.now(),
  action       text NOT NULL REFERENCES inv.actions (name),
  target_table text NOT NULL,
  target_id    bigint,
  old_value    jsonb,
  new_value    jsonb
);

-- Every save of an editable row moves its version on by one, so a screen that
-- read an older version is refused (S41). One trigger per editable table, not
-- a hand-written bump in each function, which a later function could forget.
-- Each trigger names the columns a person edits, so a column the app keeps for
-- itself (part 2's last sign-in time) does not refuse an open screen's save.
CREATE FUNCTION inv.bump_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER bump_version BEFORE UPDATE OF name, active, admin ON inv.users
  FOR EACH ROW EXECUTE FUNCTION inv.bump_version();

-- The database never leaves no active admin, whatever changes a person's
-- active or admin flag, so nobody can lock everyone out of the user list.
CREATE FUNCTION inv.keep_an_admin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Deliberately FOR UPDATE, not a plain read: at REPEATABLE READ a plain read sees the
  -- view taken before the change's table lock, where an admin just removed by
  -- another save still looks active. Locking that row refuses such a save.
  PERFORM FROM inv.users WHERE active AND admin LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That would leave no active admin; make someone else an admin first.'
      USING ERRCODE = 'IV422';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER keep_an_admin AFTER UPDATE OF active, admin ON inv.users
  FOR EACH STATEMENT EXECUTE FUNCTION inv.keep_an_admin();

-- The shape every function returns for a person, and logs as was → now.
CREATE FUNCTION inv.user_json(u inv.users) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', u.id, 'email', u.email, 'name', u.name, 'active', u.active, 'admin', u.admin,
    'version', u.version)
$$;

-- The one-time setup: the owner adds the first person, as an admin, over the
-- direct connection, before anyone can sign in to reach Settings → Users.
CREATE FUNCTION inv.add_first_user(p_email text, p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  u inv.users;
  v_email text := pg_catalog.lower(inv.tidy(p_email));
BEGIN
  -- Two setups at once would both see an empty table without the lock.
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM inv.users) THEN
    RAISE EXCEPTION 'The database already has people; add more in Settings → Users.'
      USING ERRCODE = 'IV422';
  END IF;
  PERFORM inv.check_person(v_email, p_name);
  INSERT INTO inv.users (email, name, admin) VALUES (v_email, inv.tidy(p_name), true)
  RETURNING * INTO u;
  INSERT INTO inv.activity_log
    (retry_key, request_hash, actor_id, action, target_table, target_id, new_value)
  VALUES (pg_catalog.gen_random_uuid(),
          pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.jsonb_build_object('email', p_email, 'name', p_name)::text, 'UTF8')),
          u.id, 'add user', 'users', u.id, inv.user_json(u));
  RETURN inv.user_json(u);
END
$$;

-- Starts every change and makes a retry act once (S22, S52).
-- 1. A retry key already in the log is a retry: if the same person asked for
--    the same action with the same request, it returns that action's outcome
--    (earlier) and no log id; anything else with that key is refused (IV410).
--    This comes before the checks below, so a change that removed the caller
--    or took their admin away still answers its own retry.
-- 2. A new key: the actor must be active, and an admin for an admin-only
--    action; then the action's log row is inserted, claiming the key. In a
--    function that takes no table lock first, the UNIQUE retry_key decides a
--    race: the second call waits on the first one's row, then finds it. (The
--    functions on people lock inv.users first, so for them the lock decides.)
-- p_request is the call's own arguments; only its SHA-256 is kept, so it may
-- include a password hash (part 2) without the log holding one.
-- Not callable by the app: it would let the app write log rows of its own.
CREATE FUNCTION inv.claim_action(
  p_actor bigint, p_key uuid, p_action text, p_target_table text, p_target_id bigint,
  p_request jsonb, OUT log_id bigint, OUT earlier jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_hash bytea := pg_catalog.sha256(pg_catalog.convert_to(p_request::text, 'UTF8'));
  v_admin_only boolean;
  v_actor inv.users;
  v_done inv.activity_log;
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'A retry key is required.' USING ERRCODE = 'IV400';
  END IF;
  SELECT * INTO v_done FROM inv.activity_log WHERE retry_key = p_key;
  IF NOT FOUND THEN
    SELECT admin_only INTO v_admin_only FROM inv.actions WHERE name = p_action;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown action: %.', p_action;  -- a bug in a function, not a user error
    END IF;
    -- Deliberately FOR SHARE, not a plain read: the actor cannot be removed,
    -- or lose admin, until this action commits.
    SELECT * INTO v_actor FROM inv.users WHERE id = p_actor FOR SHARE;
    IF NOT coalesce(v_actor.active, false) THEN
      RAISE EXCEPTION 'Only an active user can make changes.' USING ERRCODE = 'IV403';
    END IF;
    IF v_admin_only AND NOT v_actor.admin THEN
      RAISE EXCEPTION 'Only an admin can do this.' USING ERRCODE = 'IV403';
    END IF;
    INSERT INTO inv.activity_log (retry_key, request_hash, actor_id, action, target_table, target_id)
    VALUES (p_key, v_hash, p_actor, p_action, p_target_table, p_target_id)
    ON CONFLICT (retry_key) DO NOTHING
    RETURNING id INTO log_id;
    IF log_id IS NOT NULL THEN RETURN; END IF;
    -- A call with the same key committed while this one waited.
    SELECT * INTO v_done FROM inv.activity_log WHERE retry_key = p_key;
  END IF;
  IF v_done.actor_id IS DISTINCT FROM p_actor OR v_done.action IS DISTINCT FROM p_action
     OR v_done.request_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'This retry key was already used for a different request.'
      USING ERRCODE = 'IV410';
  END IF;
  earlier := v_done.new_value;
END
$$;

-- Ends every change: records what it touched, was → now, on its log row.
CREATE FUNCTION inv.finish_action(p_log_id bigint, p_target_id bigint, p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  UPDATE inv.activity_log
     SET target_id = p_target_id, old_value = p_old, new_value = p_new
   WHERE id = p_log_id
  RETURNING new_value
$$;

-- Refuses an impossible name or address with a plain message. The table's
-- CHECKs stay as the backstop.
CREATE FUNCTION inv.check_person(p_email text, p_name text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_name IS NULL OR inv.tidy(p_name) = '' THEN
    RAISE EXCEPTION 'A name is required.' USING ERRCODE = 'IV400';
  END IF;
  IF p_email IS NULL OR NOT inv.is_email(p_email) THEN
    RAISE EXCEPTION 'An email address needs exactly one @ and no spaces.' USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- Settings → Users → Add.
CREATE FUNCTION inv.add_user(p_actor bigint, p_key uuid, p_email text, p_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  u inv.users;
  v_email text := pg_catalog.lower(inv.tidy(p_email));
BEGIN
  -- Deliberately a whole-table lock for every change to people, not row locks:
  -- the "always one active admin" trigger reads every row, and with row locks
  -- two removals would each wait on the other's row and deadlock; mixing row
  -- locks with that one table lock can also deadlock a rename against a removal.
  -- Changes to people are a few a year, so waiting costs nothing. This is for
  -- inv.users only: busy tables (ledger, counts, jobs) must not copy it.
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;
  a := inv.claim_action(p_actor, p_key, 'add user', 'users', NULL,
                        pg_catalog.jsonb_build_object('email', p_email, 'name', p_name));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.check_person(v_email, p_name);
  IF EXISTS (SELECT FROM inv.users WHERE email = v_email) THEN
    RAISE EXCEPTION '% is already on the list.', v_email USING ERRCODE = 'IV400';
  END IF;
  INSERT INTO inv.users (email, name) VALUES (v_email, inv.tidy(p_name))
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, NULL, inv.user_json(u));
END
$$;

-- Reads the person a change is about, refusing it when their row has changed
-- since the screen read it (S41). The refusal's DETAIL is the current row, so
-- the screen can show what the other save did.
CREATE FUNCTION inv.user_at_version(p_id bigint, p_version integer) RETURNS inv.users
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  u inv.users;
BEGIN
  SELECT * INTO u FROM inv.users WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  IF p_version IS DISTINCT FROM u.version THEN
    RAISE EXCEPTION 'Someone else changed % since you opened this screen.', u.name
      USING ERRCODE = 'IV409', DETAIL = inv.user_json(u)::text;
  END IF;
  RETURN u;
END
$$;

-- Settings → Users → change a name.
CREATE FUNCTION inv.rename_user(p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_name text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  was inv.users;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see inv.add_user
  a := inv.claim_action(p_actor, p_key, 'rename user', 'users', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version, 'name', p_name));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.user_at_version(p_id, p_version);
  PERFORM inv.check_person(was.email, p_name);
  UPDATE inv.users SET name = inv.tidy(p_name)
   WHERE id = p_id
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, inv.user_json(was), inv.user_json(u));
END
$$;

-- Remove and re-activate differ only in the direction of one flag.
CREATE FUNCTION inv.set_user_active(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action text := CASE WHEN p_active THEN 're-activate user' ELSE 'remove user' END;
  a record;
  was inv.users;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see inv.add_user
  a := inv.claim_action(p_actor, p_key, v_action, 'users', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.user_at_version(p_id, p_version);
  IF was.active = p_active THEN
    RAISE EXCEPTION '% is already %.', was.name, CASE WHEN p_active THEN 'active' ELSE 'removed' END
      USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.users SET active = p_active
   WHERE id = p_id
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, inv.user_json(was), inv.user_json(u));
END
$$;

-- Settings → Users → Remove. The person's history stays; they cannot sign in or act.
CREATE FUNCTION inv.remove_user(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_user_active(p_actor, p_key, p_id, p_version, false) $$;

-- Settings → Users → Re-activate.
CREATE FUNCTION inv.reactivate_user(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_user_active(p_actor, p_key, p_id, p_version, true) $$;

-- Making someone an admin and taking it away differ only in the flag's direction.
-- Deliberately a near copy of inv.set_user_active rather than one function for
-- both flags: the shared body would branch on the flag in its action name, its
-- "already" refusal and a CASE per column in its UPDATE, so each line would
-- read two ways; two 20-line functions read one way each.
CREATE FUNCTION inv.set_user_admin(
  p_actor bigint, p_key uuid, p_id bigint, p_version integer, p_admin boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_action text := CASE WHEN p_admin THEN 'grant admin' ELSE 'revoke admin' END;
  a record;
  was inv.users;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see inv.add_user
  a := inv.claim_action(p_actor, p_key, v_action, 'users', p_id,
                        pg_catalog.jsonb_build_object('id', p_id, 'version', p_version));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  was := inv.user_at_version(p_id, p_version);
  IF was.admin = p_admin THEN
    RAISE EXCEPTION '% is already %.', was.name, CASE WHEN p_admin THEN 'an admin' ELSE 'not an admin' END
      USING ERRCODE = 'IV422';
  END IF;
  UPDATE inv.users SET admin = p_admin
   WHERE id = p_id
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, inv.user_json(was), inv.user_json(u));
END
$$;

-- Settings → Users → Make admin.
CREATE FUNCTION inv.grant_admin(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_user_admin(p_actor, p_key, p_id, p_version, true) $$;

-- Settings → Users → Remove admin.
CREATE FUNCTION inv.revoke_admin(p_actor bigint, p_key uuid, p_id bigint, p_version integer)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT inv.set_user_admin(p_actor, p_key, p_id, p_version, false) $$;

-- The three logins. Roles belong to the whole server, not one database, so
-- each is created only if missing. They are made without a password: the
-- owner sets each one outside the repository (ALTER ROLE ... PASSWORD), and
-- until then no password sign-in can succeed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'inv_app') THEN
    CREATE ROLE inv_app LOGIN;       -- the app: reads tables, changes them only through functions
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'inv_planner') THEN
    CREATE ROLE inv_planner LOGIN;   -- the Planner: reads only (ADR 0001); step 3 grants what it reads
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'inv_backup') THEN
    CREATE ROLE inv_backup LOGIN;    -- the nightly pg_dump: reads everything, writes nothing
  END IF;
END
$$;

REVOKE ALL ON SCHEMA inv FROM PUBLIC;
GRANT USAGE ON SCHEMA inv TO inv_app, inv_planner, inv_backup;

GRANT SELECT ON ALL TABLES IN SCHEMA inv TO inv_app, inv_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA inv TO inv_backup;
-- Tables from later migrations get the same reads, so a new table can never
-- fail the nightly backup for want of a grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA inv GRANT SELECT ON TABLES TO inv_app, inv_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA inv GRANT SELECT ON SEQUENCES TO inv_backup;

-- Postgres lets everyone run a new function; here nobody may unless named.
-- A later migration must REVOKE on its own new functions too: a per-schema
-- default cannot take this right away (checked 2026-09-28), and the test of
-- which functions each login may run fails until it does.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.add_user(bigint, uuid, text, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.rename_user(bigint, uuid, bigint, integer, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.remove_user(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.reactivate_user(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.grant_admin(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.revoke_admin(bigint, uuid, bigint, integer) TO inv_app;
