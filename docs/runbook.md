# Runbook — the database, sign-in and backups

The owner's steps outside the code, for step 2 (#77). Each step says what to type and what a
good result looks like. Secrets (passwords, the signing secret, connection strings with a
password in them) never go into this repository, an issue or a chat.

**Two facts for every command from the pod** (#77, comment of 2026-09-29):

- **Use the Session pooler (port 5432)** for migrations, the first-user setup, backups and
  restores. The pod has no IPv6 route, and the project's direct address
  (`db.<project-ref>.supabase.co`) has only an IPv6 address. On the pooler the user name is
  `<login>.<project-ref>`, for example `postgres.<project-ref>`.
- **The connection string needs Supabase's CA certificate.** Download it from Database
  Settings → SSL Configuration and add `sslmode=verify-full&sslrootcert=<path to the file>`.
  (`pg` 8.23 treats `sslmode=require` as `verify-full`.)

Below, `$OWNER_URL` stands for that Session-pooler string with the `postgres` login.

## Go-live steps, in order

Steps 1 to 4 were done on 2026-09-29 for migration 001: Postgres is in the pod image, the
Supabase project exists, migration 001 is applied, and the three logins have passwords.

1. **Postgres in the pod image.** Done.
2. **The Supabase project** in East US (North Virginia), with "Enable Data API"
   and "Automatically expose new tables" off, and "Enable automatic RLS" off. Done.

   **It is on the Free plan for now** (owner, 2026-09-30), not the $25 Pro plan that
   `docs/database-design.md` (Q10) plans for go-live. Supabase's pricing page, checked
   2026-09-30, gives the Free plan's limits: "Free projects are paused after 1 week of
   inactivity", automatic backups "Not included", and a "Limit of 2 active projects". A
   paused project stops answering, so sign-in fails until it is restored from the
   dashboard. Move to Pro before go-live.
3. **Run the migrations.** It applies only the files the database does not have yet, each in
   its own transaction.

   ```sh
   DIRECT_DATABASE_URL="$OWNER_URL" node src/db/migrate.js
   ```

   Good result: `applied: 002-passwords.sql` (001 is already there). A failure prints
   `migration <file> failed, nothing from it was applied` and changes nothing.
4. **Passwords for the three database logins** (`inv_app`, `inv_planner`, `inv_backup`): one
   `ALTER ROLE <login> PASSWORD '...'` each, in Supabase's SQL editor. Done.
5. **Vercel's environment variables** (Production, and Preview if previews should work):

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The **Transaction** pooler string (port **6543**), with the `inv_app` login (`inv_app.<project-ref>` on the pooler) and its password. **No `sslmode`** in it: the app sets SSL from the next variable, and `pg` lets settings in the string override it. |
   | `DATABASE_CA_CERT` | The whole text of Supabase's CA certificate file, `-----BEGIN CERTIFICATE-----` line included. |
   | `SESSION_SECRET` | At least 32 random characters. Make one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. |

   The app refuses to start without the first two, and throws if the secret is shorter than 32
   characters. **A deploy made before these are set fails at start-up.**

   *Not checked:* that the pooler accepts `inv_app.<project-ref>` as a user name for a login the
   migration created. Supabase documents the `<login>.<project-ref>` form; the first sign-in
   proves it.
6. **The first person**, as an admin, with a temporary password. It refuses to run once anyone
   exists.

   ```sh
   DIRECT_DATABASE_URL="$OWNER_URL" node src/db/add-first-user.js
   ```

   Then sign in to the app. It asks you to choose your own password before anything else.
7. **Checks**, in Supabase's SQL editor. Each should answer as shown.

   ```sql
   -- Supabase's browser roles have no way into the app's schema: f, f
   SELECT pg_catalog.has_schema_privilege('anon', 'inv', 'USAGE'),
          pg_catalog.has_schema_privilege('authenticated', 'inv', 'USAGE');

   -- The app's login can only read tables: no rows
   SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'inv_app' AND privilege_type <> 'SELECT';
   ```

   And in the dashboard: Settings → API shows the Data API off.
8. **Check that sign-in is quick on Vercel.** The password check is slow on purpose, so that a
   stolen copy of the hashes is hard to guess; in the pod one check takes a median of 162 ms
   (2026-09-29). Sign in once on the deployed app. If it is noticeably slow (several seconds),
   lower `N` in `src/auth/password.js`: old hashes keep working, because each hash carries its
   own settings. Done 2026-09-29: sign-in felt fast.

   **Do not judge this by the duration in Vercel's log.** On 2026-09-29 the log showed
   6,814 ms for `POST /api/sign-in`, but the page answered at once. The extra is about
   5 seconds, the same as `idleTimeoutMillis` in `src/db/database.js`. Probably Vercel counts
   the time until the idle database connections close, after the answer is sent. This is not
   proven.
9. **The nightly backup**: a private repository with the workflow, its secrets and the
   encryption public key, and the company drive chosen (#77, Backups). Not in this repository.
10. **One practice restore** (below), into an empty database, before go-live.

## Import the catalog

The one-time import of the web app's items, thresholds, stocking statuses and pack sizes (#81
part 1). It only adds: an item already in the catalog is skipped with its pack sizes, so a
second run changes nothing and never overwrites an edit made in the app. It is one save:
a refused row leaves nothing imported. Try it on the local practice database first
(`DIRECT_DATABASE_URL=postgres://postgres@127.0.0.1:5432/inv_local`).

1. **Get the files.** Keep them outside the repository.
   - From the web app's screens, the on-hand export of plates, hangers and lumber, and the EWP
     export with "hide non-stocked" **unticked** (with it ticked, the export is empty). Only the
     LVL rows of the EWP export are read.
   - `special-order.csv`, from the web app's read-only login. The schema names are those in the
     web app's own schema files; check them before you run it.

     ```sql
     SELECT 'plates' AS family, sku_display AS sku FROM plates_dev.plate_special_order_sku WHERE active
     UNION ALL
     SELECT 'hangers', sku_display FROM hangers_dev.hanger_special_order_sku WHERE active;
     ```

   - `lvl-depth-thresholds.csv`, written by hand from the answer to
     `SELECT depth, threshold_lf FROM ewp_lvl_depth_threshold`. The web app writes a depth as
     `11-78`; this file writes it as on the product name, `11-7/8`. A depth with no threshold
     (24″) has a blank value, and its LVL items become Special Order. No 22″ line: the company
     no longer keeps that depth. The import refuses a depth that no LVL item has, and saves
     nothing.

     ```csv
     depth,threshold_lf
     9-1/2,1200
     11-7/8,960
     14,720
     16,720
     18,480
     20,480
     24,
     ```

     These are the web app's starting values; the live ones may differ.
2. **Run it** with the owner login over the direct connection, naming the admin the activity
   log shows as the importer:

   ```sh
   DIRECT_DATABASE_URL="$OWNER_URL" node src/db/import-catalog.js you@example.com \
     plates.csv hangers.csv lumber.csv ewp.csv special-order.csv lvl-depth-thresholds.csv
   ```

3. **Read what it printed**: how many items, pack sizes and LVL thresholds it added and skipped,
   a line for each item it skipped because it was already in the catalog, and a line for each
   thing it left out (NAILED, the per-length LVL thresholds it dropped, a
   Special Order SKU missing from its export). Then check a few items in Inventory → Overview.

## Sign everyone out

Sign out in the app ends that person's session on every computer, and removing a person does
the same. To sign **everyone** out, for example after a lost laptop, change `SESSION_SECRET` in
Vercel to a new random value and redeploy. Every cookie signed with the old secret is refused, so everyone signs in again.
Passwords do not change.

To sign out **one** person, an admin sets a temporary password for them in Settings → Users.
That signs them out on every computer.

## Someone forgot their password

An admin opens Settings → Users, clicks **Reset password** on the person's row, and
tells them the temporary password in person. It also lifts a lock from wrong guesses. At their
next sign-in they choose their own.

If **no admin can sign in**: a lock from wrong guesses ends by itself after 15 minutes. If every
admin has forgotten their password, the owner makes a hash in the pod and stores it with SQL.
This change is **not** in the activity log, so note it somewhere. Keep at least two admins (#77)
so it is never needed.

```sh
node -e "require('./src/auth/password.js').hashPassword(process.argv[1]).then(console.log)" 'a temporary password'
```

```sql
UPDATE inv.users
   SET password_hash = '<the printed hash>', password_temporary = true,
       password_changed_at = pg_catalog.clock_timestamp(), wrong_passwords = 0, locked_until = NULL
 WHERE email = 'admin@example.com';
```

## Restore a backup

The test suite runs this same restore on every run (`test/database.test.js`, "a backup taken
by the backup login restores into an empty database"), so the commands below are proven on a
local Postgres 17. On Supabase they are proven by the practice restore (step 10).

1. **Get the dump.** Download the night's file from the company drive and decrypt it with the
   private key. The tool is chosen with the backup repository (step 9).
2. **Choose the target.** An empty database: a new Supabase project in the same region, or a
   scratch database for the practice restore. Never restore over the live database.
3. **On a new server, create the three logins first.** Logins belong to the whole server, and
   the dump carries their rights but not the logins themselves:

   ```sql
   CREATE ROLE inv_app LOGIN;
   CREATE ROLE inv_planner LOGIN;
   CREATE ROLE inv_backup LOGIN;
   ```

4. **Restore.** `$TARGET_URL` is the target's Session-pooler string with the owner login.

   ```sh
   pg_restore --exit-on-error --dbname="$TARGET_URL" backup.dump
   ```

   `pg_restore` must be the same Postgres major version as the server, or newer.
5. **On a new server, close new functions again.** The dump does not carry this database-wide
   setting from migration 001:

   ```sql
   ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
   ```

6. **Check it.** Row counts per table, and the newest activity-log row, against what the drive's
   copy should hold:

   ```sql
   SELECT (SELECT count(*) FROM inv.users) AS users,
          (SELECT count(*) FROM inv.activity_log) AS log_rows,
          (SELECT max(at) FROM inv.activity_log) AS newest_change;
   ```

7. **Point the app at it** (a real restore only): set the three login passwords (go-live step
   4), then change `DATABASE_URL` and `DATABASE_CA_CERT` in Vercel and redeploy. People sign
   in with their usual passwords, which the dump carries.
