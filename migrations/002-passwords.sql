-- Step 2, part 2 (#77): passwords, kept by the app itself.
-- The app hashes each password in Node (src/auth/password.js); the database
-- stores only the hash and never sees the password. Every name is fully
-- qualified, inside function bodies too (#28). Refusal codes: see 001.
--
-- Material change, named: adds seven columns to inv.users, replaces
-- inv.add_first_user and inv.add_user with versions that take a password hash,
-- replaces inv.set_user_active so a removal signs the person out, adds five
-- functions, and lets the app run inv.tidy. Reach: inv.users, which holds no row on the live
-- database yet (the first-user setup waits for this migration). If it did, the
-- NOT NULL password_hash would refuse the migration, and the runner applies
-- nothing from a file that fails. Recovery: none needed; nothing is deleted.

ALTER TABLE inv.users
  ADD COLUMN password_hash text NOT NULL CHECK (password_hash <> ''),
  -- Set by an admin or the setup command; until the person chooses their own,
  -- the app sends every page to "choose your password".
  ADD COLUMN password_temporary boolean NOT NULL DEFAULT true,
  -- A session cookie carries the value this had when it was issued; a cookie
  -- carrying an older one is refused, so a new password signs the person out
  -- everywhere else.
  ADD COLUMN password_changed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- The guessing limit: wrong passwords in a row, and the lock they cause.
  ADD COLUMN wrong_passwords integer NOT NULL DEFAULT 0 CHECK (wrong_passwords >= 0),
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN last_signed_in_at timestamptz,
  -- Sign-outs so far; the session cookie carries it (see inv.sign_out).
  ADD COLUMN sign_outs integer NOT NULL DEFAULT 0 CHECK (sign_outs >= 0);

-- Setting another person's temporary password is an admin's job; changing
-- one's own is everyone's.
INSERT INTO inv.actions (name, admin_only) VALUES
  ('set password', true), ('change password', false);

-- The first person now arrives with a temporary password.
DROP FUNCTION inv.add_first_user(text, text);
CREATE FUNCTION inv.add_first_user(p_email text, p_name text, p_password_hash text) RETURNS jsonb
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
  PERFORM inv.check_password_hash(p_password_hash);
  INSERT INTO inv.users (email, name, admin, password_hash)
  VALUES (v_email, inv.tidy(p_name), true, p_password_hash)
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

-- A missing hash is a bug in the app, but it is refused plainly all the same.
CREATE FUNCTION inv.check_password_hash(p_password_hash text) RETURNS void
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_password_hash IS NULL OR p_password_hash = '' THEN
    RAISE EXCEPTION 'A password is required.' USING ERRCODE = 'IV400';
  END IF;
END
$$;

-- Settings → Users → Add, now with a temporary password.
-- Deliberately, the hash is not part of the request the retry key checks
-- (the first argument to inv.claim_action's p_request). Each hash has a fresh
-- random salt, so a retry of the same add sends a different hash, and with the
-- hash in the request every retry would be refused as a different request.
DROP FUNCTION inv.add_user(bigint, uuid, text, text);
CREATE FUNCTION inv.add_user(p_actor bigint, p_key uuid, p_email text, p_name text, p_password_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  u inv.users;
  v_email text := pg_catalog.lower(inv.tidy(p_email));
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see 001's inv.add_user
  a := inv.claim_action(p_actor, p_key, 'add user', 'users', NULL,
                        pg_catalog.jsonb_build_object('email', p_email, 'name', p_name));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.check_person(v_email, p_name);
  PERFORM inv.check_password_hash(p_password_hash);
  IF EXISTS (SELECT FROM inv.users WHERE email = v_email) THEN
    RAISE EXCEPTION '% is already on the list.', v_email USING ERRCODE = 'IV400';
  END IF;
  INSERT INTO inv.users (email, name, password_hash) VALUES (v_email, inv.tidy(p_name), p_password_hash)
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, NULL, inv.user_json(u));
END
$$;

-- Settings → Users → Set a temporary password, for a person who forgot theirs.
-- It also lifts a guessing lock, and signs the person out everywhere.
-- No version check: a password is not one of the fields an open screen edits,
-- so it neither needs one nor moves one (see 001's bump_version trigger).
-- The log row carries the person, never the hash; the hash stays out of the
-- retry request too (see inv.add_user above).
CREATE FUNCTION inv.set_password(p_actor bigint, p_key uuid, p_id bigint, p_password_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see 001's inv.add_user
  a := inv.claim_action(p_actor, p_key, 'set password', 'users', p_id,
                        pg_catalog.jsonb_build_object('id', p_id));
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  PERFORM inv.check_password_hash(p_password_hash);
  UPDATE inv.users
     SET password_hash = p_password_hash, password_temporary = true,
         password_changed_at = pg_catalog.clock_timestamp(),
         wrong_passwords = 0, locked_until = NULL
   WHERE id = p_id
  RETURNING * INTO u;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That person is not on the list.' USING ERRCODE = 'IV400';
  END IF;
  RETURN inv.finish_action(a.log_id, u.id, NULL, inv.user_json(u));
END
$$;

-- Settings → Your password, and "choose your password" after a temporary one.
-- The app has already checked the current password; this stores the new hash
-- and signs the person out everywhere else (the app gives this computer a new
-- cookie). The hash stays out of the log and the retry request.
-- p_session_stamp is the password time the session cookie carries. If the
-- password changed after the app checked the session (an admin's reset, for
-- example), the change is refused, so the older session cannot undo the reset
-- (PR #79 review).
CREATE FUNCTION inv.change_password(p_actor bigint, p_key uuid, p_session_stamp text, p_password_hash text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  a record;
  u inv.users;
BEGIN
  LOCK TABLE inv.users IN SHARE ROW EXCLUSIVE MODE;  -- see 001's inv.add_user
  a := inv.claim_action(p_actor, p_key, 'change password', 'users', p_actor,
                        pg_catalog.jsonb_build_object());
  IF a.log_id IS NULL THEN RETURN a.earlier; END IF;
  IF (SELECT (EXTRACT(epoch FROM password_changed_at) * 1000000)::bigint::text
        FROM inv.users WHERE id = p_actor) IS DISTINCT FROM p_session_stamp THEN
    RAISE EXCEPTION 'Your password was changed somewhere else. Sign in again.' USING ERRCODE = 'IV422';
  END IF;
  PERFORM inv.check_password_hash(p_password_hash);
  UPDATE inv.users
     SET password_hash = p_password_hash, password_temporary = false,
         password_changed_at = pg_catalog.clock_timestamp()
   WHERE id = p_actor
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, NULL, inv.user_json(u));
END
$$;

-- Records one password check, after the app has made it: a sign-in
-- (p_sign_in), or the current password typed to change it. Answers 'right',
-- 'wrong' or 'locked'. The database decides the guessing limit, so two copies
-- of the app cannot each allow a guess the other counted: during a lock the
-- answer is 'locked', whatever the password, and the attempt is not counted;
-- a right password clears the count; the 5th wrong one in a row starts a
-- 15-minute lock and restarts the count. A removed person, or no person
-- (p_id NULL: an address nobody has, checked so it takes the same time), is
-- 'wrong'. Only a sign-in moves last_signed_in_at.
-- Not an activity-log entry: sign-ins are not changes (#77).
-- Deliberately one UPDATE, not a SELECT ... FOR UPDATE and then an UPDATE:
-- the second statement would ask for a stronger table lock while holding a
-- row lock, and could deadlock with a change to people, which takes its table
-- lock first and then reads the actor's row. The plain read after it takes
-- no stronger lock.
CREATE FUNCTION inv.record_password_check(p_id bigint, p_password_ok boolean, p_sign_in boolean)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ok boolean;
BEGIN
  UPDATE inv.users
     SET wrong_passwords = CASE WHEN p_password_ok OR wrong_passwords + 1 >= 5 THEN 0
                                ELSE wrong_passwords + 1 END,
         locked_until = CASE WHEN NOT p_password_ok AND wrong_passwords + 1 >= 5
                             THEN pg_catalog.now() + interval '15 minutes' END,
         last_signed_in_at = CASE WHEN p_password_ok AND p_sign_in THEN pg_catalog.now()
                                  ELSE last_signed_in_at END
   WHERE id = p_id AND active
     AND (locked_until IS NULL OR locked_until <= pg_catalog.now())
  RETURNING p_password_ok INTO v_ok;
  IF FOUND THEN
    RETURN CASE WHEN v_ok THEN 'right' ELSE 'wrong' END;
  END IF;
  IF EXISTS (SELECT FROM inv.users WHERE id = p_id AND active AND locked_until > pg_catalog.now()) THEN
    RETURN 'locked';
  END IF;
  RETURN 'wrong';
END
$$;

-- Sign out. The session cookie carries this count, and a cookie carrying an
-- older one is refused, so signing out ends the session on the server: a
-- copied cookie, or one a late answer puts back in the browser, stops
-- working. It signs the person out on every computer. Not an activity-log
-- entry, for the same reason as sign-ins.
CREATE FUNCTION inv.sign_out(p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ UPDATE inv.users SET sign_outs = sign_outs + 1 WHERE id = p_id $$;

-- 001's inv.set_user_active, with one change: removing a person also signs
-- them out everywhere, so re-activating them later does not bring back a
-- cookie they kept.
CREATE OR REPLACE FUNCTION inv.set_user_active(
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
  UPDATE inv.users
     SET active = p_active,
         sign_outs = sign_outs + CASE WHEN p_active THEN 0 ELSE 1 END
   WHERE id = p_id
  RETURNING * INTO u;
  RETURN inv.finish_action(a.log_id, u.id, inv.user_json(was), inv.user_json(u));
END
$$;

-- 001's default already closes every new function to everyone; these open
-- the ones the app calls. inv.tidy lets the app find an address by the same
-- trimming rule it was stored with.
GRANT EXECUTE ON FUNCTION inv.add_user(bigint, uuid, text, text, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.set_password(bigint, uuid, bigint, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.change_password(bigint, uuid, text, text) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.record_password_check(bigint, boolean, boolean) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.sign_out(bigint) TO inv_app;
GRANT EXECUTE ON FUNCTION inv.tidy(text) TO inv_app;
