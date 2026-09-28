-- Step 2 (#77): the people who use the app, and the log of every change.
-- Source: docs/database-design.md, tables 1 and 2 and "Rules the database enforces".
-- Every name is fully qualified, inside function bodies too (#28).
--
-- Refusals carry their own SQLSTATE, so the app can tell them apart without
-- reading message text:
--   IV400  a value is impossible (blank name, address without one @, duplicate address)
--   IV403  the person acting is not an active user, or not an admin where one is needed
--   IV409  the row changed since it was read; DETAIL is the current row as JSON
--   IV410  a retry key already used for a different action
--   IV422  a rule refuses the change (last active admin, already removed, setup done)

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

CREATE TABLE inv.activity_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  retry_key    uuid NOT NULL UNIQUE,
  actor_id     bigint NOT NULL REFERENCES inv.users (id),
  at           timestamptz NOT NULL DEFAULT pg_catalog.now(),
  action       text NOT NULL
               CHECK (action IN ('add user', 'rename user', 'remove user', 'reactivate user',
                                 'grant admin', 'revoke admin')),
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
  INSERT INTO inv.activity_log (retry_key, actor_id, action, target_table, target_id, new_value)
  VALUES (pg_catalog.gen_random_uuid(), u.id, 'add user', 'users', u.id, inv.user_json(u));
  RETURN inv.user_json(u);
END
$$;

-- Starts every change: refuses an actor who is not active, then claims the
-- retry key by inserting the action's log row. In a function that takes no
-- table lock first, the UNIQUE retry_key decides a race: a second call with
-- the same key waits on the first one's row, then finds it. (The functions on
-- people lock inv.users first, so for them the lock decides.) Returns the new
-- row's id, or, when the key was already used for this same action, NULL and
-- that action's outcome, so a retry acts once and answers what the first call
-- answered (S22, S52).
-- Not callable by the app: it would let the app write log rows of its own.
CREATE FUNCTION inv.claim_action(
  p_actor bigint, p_key uuid, p_action text, p_target_table text, p_target_id bigint,
  OUT log_id bigint, OUT earlier jsonb)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_key IS NULL THEN
    RAISE EXCEPTION 'A retry key is required.' USING ERRCODE = 'IV400';
  END IF;
  -- FOR SHARE: the actor cannot be removed until this action commits.
  PERFORM FROM inv.users WHERE id = p_actor AND active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only an active user can make changes.' USING ERRCODE = 'IV403';
  END IF;
  INSERT INTO inv.activity_log (retry_key, actor_id, action, target_table, target_id)
  VALUES (p_key, p_actor, p_action, p_target_table, p_target_id)
  ON CONFLICT (retry_key) DO NOTHING
  RETURNING id INTO log_id;
  IF log_id IS NULL THEN
    SELECT l.new_value INTO earlier
      FROM inv.activity_log l
     WHERE l.retry_key = p_key AND l.actor_id = p_actor AND l.action = p_action
       AND l.target_table = p_target_table
       AND (p_target_id IS NULL OR l.target_id = p_target_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'This retry key was already used for a different action.'
        USING ERRCODE = 'IV410';
    END IF;
  END IF;
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

-- Refuses a change to the user list by anyone but an admin.
CREATE FUNCTION inv.require_admin(p_actor bigint) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM inv.users WHERE id = p_actor AND admin) THEN
    RAISE EXCEPTION 'Only an admin can change the user list.' USING ERRCODE = 'IV403';
  END IF;
END
$$;

-- Refuses a change that would leave no active admin, so nobody can lock
-- everyone out of the user list. `was` is the person as they were read.
CREATE FUNCTION inv.keep_an_admin(was inv.users) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT (was.active AND was.admin) THEN RETURN; END IF;
  -- FOR UPDATE, not a plain read: at REPEATABLE READ a plain read sees the
  -- view taken before the table lock, where an admin just removed by another
  -- save still looks active. Locking that row refuses such a save instead.
  PERFORM FROM inv.users WHERE active AND admin AND id <> was.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '% is the last active admin; make someone else an admin first.', was.name
      USING ERRCODE = 'IV422';
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
  -- "never remove the last active person" reads every row, and row locks
  -- would let two removals each see the other still active; mixing row locks
  -- with that one table lock can also deadlock a rename against a removal.
  -- Changes to people are a few a year, so waiting costs nothing. This is for
  -- inv.users only: busy tables (ledger, counts, jobs) must not copy it.
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;
  a := inv.claim_action(p_actor, p_key, 'add user', 'users', NULL);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.require_admin(p_actor);
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
  a := inv.claim_action(p_actor, p_key, 'rename user', 'users', p_id);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.require_admin(p_actor);
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
  v_action text := CASE WHEN p_active THEN 'reactivate user' ELSE 'remove user' END;
  a record;
  was inv.users;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see inv.add_user
  a := inv.claim_action(p_actor, p_key, v_action, 'users', p_id);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.require_admin(p_actor);
  was := inv.user_at_version(p_id, p_version);
  IF was.active = p_active THEN
    RAISE EXCEPTION '% is already %.', was.name, CASE WHEN p_active THEN 'active' ELSE 'removed' END
      USING ERRCODE = 'IV422';
  END IF;
  IF NOT p_active THEN PERFORM inv.keep_an_admin(was); END IF;
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
  a := inv.claim_action(p_actor, p_key, v_action, 'users', p_id);
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.require_admin(p_actor);
  was := inv.user_at_version(p_id, p_version);
  IF was.admin = p_admin THEN
    RAISE EXCEPTION '% is already %.', was.name, CASE WHEN p_admin THEN 'an admin' ELSE 'not an admin' END
      USING ERRCODE = 'IV422';
  END IF;
  IF NOT p_admin THEN PERFORM inv.keep_an_admin(was); END IF;
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
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inv FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inv.add_user(bigint, uuid, text, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.rename_user(bigint, uuid, bigint, integer, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.remove_user(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.reactivate_user(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.grant_admin(bigint, uuid, bigint, integer) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.revoke_admin(bigint, uuid, bigint, integer) TO inv_app;
