// =============================================================
// database.test.js — what the database itself enforces (#77, seam 2).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds its own fresh database with the migration runner, then
// calls the database's functions directly as one of its logins: the app's,
// the Planner's or the backup's. The app's own checks (#77 part 2) would
// refuse most bad input before it got here, so only this seam proves what the
// database refuses on its own.
//
// Needs a real Postgres of the Supabase project's major version, named by
// TEST_DATABASE_URL (the pod image sets it; CI sets it in test.yml). Without
// it the tests fail, never skip, so a green run always means they ran.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  urlFor, connect, freshDatabase, as, HASH, APP, firstUser, call, logRows, refused,
} = require('./support/database.js');

test('the owner adds the first person, logged as their own addition', async () => {
  const db = await freshDatabase();
  const person = await firstUser(db);
  await as(db, null, async (owner) => {
    assert.deepEqual(person, { id: person.id, email: 'ann@example.com', name: 'Ann Lee', active: true, admin: true, version: 1 });

    const { rows: log } = await owner.query('SELECT * FROM inv.activity_log');
    assert.equal(log.length, 1);
    // pg returns a bigint column as a string; the JSON carries a number.
    assert.equal(Number(log[0].actor_id), person.id, 'the first person adds themselves');
    assert.equal(log[0].action, 'add user');
    assert.equal(log[0].old_value, null);
    assert.deepEqual(log[0].new_value, person);
  });
});

test('the first-person setup refuses to run once anyone exists', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  await as(db, null, async (owner) => {
    await assert.rejects(
      owner.query('SELECT inv.add_first_user($1, $2, $3)', ['bob@example.com', 'Bob Ray', HASH]),
      /already has people/);
  });
});

test('the app adds a person, and one log row says who did it and what changed', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), ' Bob@Example.COM ', ' Bob Ray ', HASH);
  assert.deepEqual(bob, { id: bob.id, email: 'bob@example.com', name: 'Bob Ray', active: true, admin: false, version: 1 });

  const log = await logRows(db);
  assert.equal(log.length, 2, 'the setup row and this one');
  assert.equal(Number(log[1].actor_id), ann.id);
  assert.equal(log[1].action, 'add user');
  assert.equal(Number(log[1].target_id), bob.id);
  assert.equal(log[1].old_value, null);
  assert.deepEqual(log[1].new_value, bob);
});

test('impossible people are refused: blank name, no @, two @, a duplicate in other capitals', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const cases = [
    ['a blank name', 'bob@example.com', '   '],
    ['a name of only tabs and line breaks', 'bob@example.com', '\t\n'],
    ['a name of only a non-breaking space', 'bob@example.com', '\u00a0'],
    ['an address with no @', 'bob.example.com', 'Bob Ray'],
    ['an address with two @', 'bob@@example.com', 'Bob Ray'],
    ['an address already listed, in other capitals', 'ANN@Example.com', 'Ann Again'],
    ['an address already listed, with a non-breaking space after it', 'ann@example.com\u00a0', 'Ann Again'],
  ];
  for (const [label, email, name] of cases) {
    await refused(call(db, 'add_user', ann.id, crypto.randomUUID(), email, name, HASH), 'IV400', label);
  }
  assert.equal((await logRows(db)).length, 1, 'no refusal leaves a log row');
});

test('a rename is logged was → now, and a rename from a stale version is refused with the current row', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);

  const renamed = await call(db, 'rename_user', ann.id, crypto.randomUUID(), bob.id, 1, 'Robert Ray');
  assert.deepEqual(renamed, { ...bob, name: 'Robert Ray', version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'rename user');
  assert.deepEqual(last.old_value, bob);
  assert.deepEqual(last.new_value, renamed);

  // A second screen still holding version 1 must not overwrite the rename.
  const err = await refused(
    call(db, 'rename_user', ann.id, crypto.randomUUID(), bob.id, 1, 'Bobby Ray'), 'IV409', 'a stale version');
  assert.deepEqual(JSON.parse(err.detail), renamed, 'the refusal carries the current row');
  await refused(
    call(db, 'rename_user', ann.id, crypto.randomUUID(), bob.id, 2, '  '), 'IV400', 'a blank new name');
});

test('remove and re-activate are logged; a removed person cannot act, and their history stays', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const bobAdd = (await logRows(db)).at(-1);

  const removed = await call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 1);
  assert.deepEqual(removed, { ...bob, active: false, version: 2 });
  assert.equal((await logRows(db)).at(-1).action, 'remove user');

  await refused(call(db, 'add_user', bob.id, crypto.randomUUID(), 'cy@example.com', 'Cy Doe', HASH),
    'IV403', 'a removed person acting');
  await refused(call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 2),
    'IV422', 'removing someone already removed');
  assert.deepEqual((await logRows(db)).find((r) => r.id === bobAdd.id), bobAdd,
    'the removed person\'s history is unchanged');

  const back = await call(db, 'reactivate_user', ann.id, crypto.randomUUID(), bob.id, 2);
  assert.deepEqual(back, { ...bob, active: true, version: 3 });
  assert.equal((await logRows(db)).at(-1).action, 're-activate user');
  await refused(call(db, 'reactivate_user', ann.id, crypto.randomUUID(), bob.id, 3),
    'IV422', 're-activating someone already active');
});

test('only an admin changes the user list', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const key = () => crypto.randomUUID();
  for (const [label, fn, ...args] of [
    ['add', 'add_user', 'cy@example.com', 'Cy Doe', HASH],
    ['rename', 'rename_user', ann.id, 1, 'Ann B'],
    ['remove', 'remove_user', ann.id, 1],
    ['re-activate', 'reactivate_user', ann.id, 1],
    ['make admin', 'grant_admin', bob.id, 1],
    ['take admin away', 'revoke_admin', ann.id, 1],
  ]) {
    await refused(call(db, fn, bob.id, key(), ...args), 'IV403', `a non-admin trying to ${label}`);
  }
  assert.equal((await logRows(db)).length, 2, 'no refusal leaves a log row');
});

test('making someone an admin and taking it away are logged was → now', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const made = await call(db, 'grant_admin', ann.id, crypto.randomUUID(), bob.id, 1);
  assert.deepEqual(made, { ...bob, admin: true, version: 2 });
  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'grant admin');
  assert.deepEqual(log.old_value, bob);
  assert.deepEqual(log.new_value, made);

  // The new admin can now change the list, and can take Ann's admin away.
  const annAfter = await call(db, 'revoke_admin', bob.id, crypto.randomUUID(), ann.id, 1);
  assert.equal(annAfter.admin, false);
  assert.equal((await logRows(db)).at(-1).action, 'revoke admin');
  await refused(call(db, 'grant_admin', bob.id, crypto.randomUUID(), bob.id, 2),
    'IV422', 'making an admin an admin again');
});

test('the last active admin cannot be removed or lose admin, not even by themselves', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  await refused(call(db, 'remove_user', ann.id, crypto.randomUUID(), ann.id, 1),
    'IV422', 'removing the last active admin');
  await refused(call(db, 'revoke_admin', ann.id, crypto.randomUUID(), ann.id, 1),
    'IV422', 'taking admin from the last active admin');
  // A non-admin is not protected by the rule: removing Bob is fine.
  await call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 1);
});

test('a retry with the same key acts once and answers what the first call answered', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const key = crypto.randomUUID();
  const first = await call(db, 'add_user', ann.id, key, 'bob@example.com', 'Bob Ray', HASH);
  const again = await call(db, 'add_user', ann.id, key, 'bob@example.com', 'Bob Ray', HASH);
  assert.deepEqual(again, first);
  assert.equal((await logRows(db)).length, 2, 'the setup row and one add');

  await refused(call(db, 'remove_user', ann.id, key, first.id, 1),
    'IV410', 'the same key for a different action');
});

// For people, the whole-table lock (see inv.add_user) is what makes the second
// call wait; the UNIQUE retry key is the guard only for a function that takes
// no such lock, and step 3's first one needs its own race test.
test('two connections racing with the same retry key make one change (S22, S52)', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const key = crypto.randomUUID();
  const sql = 'SELECT inv.add_user($1, $2, $3, $4, $5) AS result';
  const args = [ann.id, key, 'bob@example.com', 'Bob Ray', HASH];
  const one = await connect(urlFor(db, APP));
  const two = await connect(urlFor(db, APP));
  try {
    // The first copy's save is still open when the second copy's arrives.
    await one.query('BEGIN');
    const first = (await one.query(sql, args)).rows[0].result;
    const second = two.query(sql, args);
    // Commit only once the second call is inside the database, waiting on the first.
    await as(db, null, async (owner) => {
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query(`
          SELECT 1 FROM pg_catalog.pg_stat_activity
           WHERE datname = $1 AND usename = $2 AND wait_event_type = 'Lock'`, [db, APP]);
        if (rows.length) break;
        assert.ok(tries < 500, 'the second call never reached the database');
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    await one.query('COMMIT');
    assert.deepEqual((await second).rows[0].result, first);
  } finally {
    await one.end();
    await two.end();
  }
  const log = await logRows(db);
  assert.equal(log.filter((r) => r.action === 'add user').length, 2, 'the setup row and one add');
  const people = await as(db, APP, async (app) => (await app.query('SELECT * FROM inv.users')).rows);
  assert.equal(people.length, 2);
});

const LOGINS = [APP, 'inv_planner', 'inv_backup'];

// Every table in the schema, read from the catalog, so a table added by a
// later migration is swept without anyone remembering to list it.
async function tables(db) {
  return as(db, null, async (owner) => (await owner.query(`
    SELECT c.relname AS name,
           -- Not an identity column: Postgres refuses SET id = id before it checks rights.
           (SELECT a.attname FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attidentity = ''
             ORDER BY a.attnum LIMIT 1) AS first_column
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'inv' AND c.relkind = 'r' ORDER BY 1`)).rows);
}

test('no login can insert, update, delete or empty any table (S62)', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  const all = await tables(db);
  assert.ok(all.length >= 3, `the sweep found the tables: ${all.map((t) => t.name)}`);
  for (const login of LOGINS) {
    await as(db, login, async (client) => {
      for (const { name, first_column: col } of all) {
        for (const sql of [
          `INSERT INTO inv.${name} DEFAULT VALUES`,
          `UPDATE inv.${name} SET ${col} = ${col}`,
          `DELETE FROM inv.${name}`,
          `TRUNCATE inv.${name}`,
        ]) {
          await refused(client.query(sql), '42501', `${login}: ${sql}`);
        }
      }
    });
  }
});

test('the app runs only its granted functions; the Planner and backup logins run none', async () => {
  const db = await freshDatabase();
  const APP_FUNCTIONS = ['add_item', 'add_pack_size', 'add_reason', 'add_supplier', 'add_user', 'change_pack_size', 'change_password', 'close_po_line', 'correct',
    'edit_item', 'edit_po', 'enter_po', 'grant_admin', 'item_label', 'lumber_sizes', 'po_json', 'po_line_number', 'reactivate_user', 'receive', 'received',
    'record_password_check', 'remove_lumber_group', 'remove_user', 'rename_item', 'rename_supplier', 'rename_user', 'reopen_po_line', 'retire_item', 'retire_reason', 'reverse', 'revoke_admin',
    'set_grade_redirect', 'set_lumber_lengths', 'set_lvl_depth_threshold', 'set_password', 'set_working_day_window',
    'sign_out', 'tidy', 'trim', 'unretire_item', 'unretire_reason'];
  const rows = await as(db, null, async (owner) => (await owner.query(`
    SELECT p.proname AS name,
           pg_catalog.has_function_privilege('inv_app', p.oid, 'EXECUTE') AS app,
           pg_catalog.has_function_privilege('inv_planner', p.oid, 'EXECUTE') AS planner,
           pg_catalog.has_function_privilege('inv_backup', p.oid, 'EXECUTE') AS backup
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'inv' ORDER BY 1`)).rows);
  assert.ok(rows.length > APP_FUNCTIONS.length, 'the sweep found the private functions too');
  assert.deepEqual(rows.filter((r) => r.app).map((r) => r.name), APP_FUNCTIONS);
  assert.deepEqual(rows.filter((r) => r.planner || r.backup).map((r) => r.name), []);
});

test('the backup login reads every table; the Planner login reads none yet', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  for (const { name } of await tables(db)) {
    await as(db, 'inv_backup', (c) => c.query(`SELECT * FROM inv.${name}`));
    await as(db, 'inv_planner', (c) =>
      refused(c.query(`SELECT * FROM inv.${name}`), '42501', `inv_planner reading ${name}`));
  }
});

test('every function pins its search_path, and no login owns anything or holds special rights', async () => {
  const db = await freshDatabase();
  await as(db, null, async (owner) => {
    const unpinned = (await owner.query(`
      SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'inv'
         AND NOT coalesce('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false)`)).rows;
    assert.deepEqual(unpinned, [], 'a function without a pinned search_path (#28)');

    const owned = (await owner.query(`
      SELECT 'relation ' || relname AS object FROM pg_catalog.pg_class
       WHERE pg_catalog.pg_get_userbyid(relowner) = ANY ($1)
      UNION ALL SELECT 'function ' || proname FROM pg_catalog.pg_proc
       WHERE pg_catalog.pg_get_userbyid(proowner) = ANY ($1)
      UNION ALL SELECT 'schema ' || nspname FROM pg_catalog.pg_namespace
       WHERE pg_catalog.pg_get_userbyid(nspowner) = ANY ($1)`, [LOGINS])).rows;
    assert.deepEqual(owned, [], 'a login owns an object');

    const special = (await owner.query(`
      SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = ANY ($1)
         AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)`,
    [LOGINS])).rows;
    assert.deepEqual(special, [], 'a login holds a special right');
  });
});

// Every row of every table, keyed by table name, in a stable order.
async function contents(db) {
  const all = await tables(db);
  return as(db, null, async (owner) => {
    const out = {};
    for (const { name } of all) {
      out[name] = (await owner.query(`SELECT * FROM inv.${name} ORDER BY 1`)).rows;
    }
    return out;
  });
}

// This restores onto the same server, where the three logins already exist.
// The dump carries their grants but not the logins themselves, and not the
// database-wide default that closes new functions. So a restore onto a new
// server must create the three logins first, and run migration 001's
// ALTER DEFAULT PRIVILEGES line afterwards; the restore runbook (part 2) says
// so. Both checked 2026-09-28 on a second server (PR #78 review, finding 3).
test('a backup taken by the backup login restores into an empty database on the same server (S51)', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  await call(db, 'rename_user', ann.id, crypto.randomUUID(), bob.id, 1, 'Robert Ray');
  await call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 2);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-restore-'));
  try {
    const file = path.join(dir, 'backup.dump');
    // The nightly job's command, as the backup login. pg_dump refuses a server
    // newer than itself, so this also proves the pod's pg_dump fits the server.
    execFileSync('pg_dump', ['--format=custom', '--schema=inv', `--file=${file}`,
      `--dbname=${urlFor(db, 'inv_backup')}`], { stdio: 'pipe' });

    const empty = await freshDatabase({ migrated: false });
    execFileSync('pg_restore', ['--exit-on-error', `--dbname=${urlFor(empty)}`, file],
      { stdio: 'pipe' });

    // Stronger than #77's "row counts and the latest log row": every row matches.
    assert.deepEqual(await contents(empty), await contents(db));

    // The restored copy works, rights included: the app can make a change on it.
    const cy = await call(empty, 'add_user', ann.id, crypto.randomUUID(), 'cy@example.com', 'Cy Doe', HASH);
    assert.equal(cy.email, 'cy@example.com');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A transaction at REPEATABLE READ keeps the view it took at its first
// statement, which is before the function's table lock; the rule must still hold.
test('two removals at REPEATABLE READ cannot leave no active admin', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const bob = await call(db, 'grant_admin', ann.id, crypto.randomUUID(), added.id, 1);
  const sql = 'SELECT inv.remove_user($1, $2, $3, $4) AS result';
  const one = await connect(urlFor(db, APP));
  const two = await connect(urlFor(db, APP));
  try {
    await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await one.query('SELECT 1');  // both views are now fixed, with Ann and Bob active admins
    await two.query('SELECT 1');
    await one.query(sql, [ann.id, crypto.randomUUID(), bob.id, bob.version]);
    await one.query('COMMIT');
    const err = await two.query(sql, [ann.id, crypto.randomUUID(), ann.id, 1]).then(() => null, (e) => e);
    await two.query('ROLLBACK');
    assert.ok(err, 'the second removal must be refused');
    assert.ok(['IV422', '40001'].includes(err.code), `refused as the last admin or a stale view: ${err.code} ${err.message}`);
  } finally {
    await one.end();
    await two.end();
  }
  const active = await as(db, APP, async (app) =>
    (await app.query('SELECT count(*)::int AS n FROM inv.users WHERE active AND admin')).rows[0].n);
  assert.equal(active, 1);
});

// The retry key is looked up before the role is checked: a person who loses
// admin (or is removed) by this very change still gets its answer on a retry.
test('a retry after the change took away the caller\'s own admin answers what the first call answered', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  await call(db, 'grant_admin', ann.id, crypto.randomUUID(), added.id, 1);
  const key = crypto.randomUUID();
  const first = await call(db, 'revoke_admin', ann.id, key, ann.id, 1);
  assert.deepEqual(await call(db, 'revoke_admin', ann.id, key, ann.id, 1), first);
});

test('a retry key reused for a different request is refused, never answered with the old result', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const key = crypto.randomUUID();
  const bob = await call(db, 'add_user', ann.id, key, 'bob@example.com', 'Bob Ray', HASH);
  await refused(call(db, 'add_user', ann.id, key, 'cy@example.com', 'Cy Doe', HASH),
    'IV410', 'the same key for another person to add');
  const renameKey = crypto.randomUUID();
  await call(db, 'rename_user', ann.id, renameKey, bob.id, 1, 'Robert Ray');
  await refused(call(db, 'rename_user', ann.id, renameKey, null, 1, 'Robert Ray'),
    'IV410', 'the same key with no person named');
  await refused(call(db, 'rename_user', ann.id, renameKey, bob.id, 1, 'Bobby Ray'),
    'IV410', 'the same key with another new name');
});

test('the owner\'s own direct update cannot leave no active admin either', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  await as(db, null, async (owner) =>
    refused(owner.query('UPDATE inv.users SET admin = false'), 'IV422', 'a direct update by the owner'));
});

// A removed person who is still marked admin is the only case where the
// active check, not the admin check, is what refuses (PR #78 review, finding 2).
test('a removed admin cannot act', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const bob = await call(db, 'grant_admin', ann.id, crypto.randomUUID(), added.id, 1);
  await call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, bob.version);
  await refused(call(db, 'add_user', bob.id, crypto.randomUUID(), 'cy@example.com', 'Cy Doe', HASH),
    'IV403', 'a removed admin adding a person');
});

// Finding 5: one person must not get another person's result by sending their key.
test('a retry key sent by another person is refused, even with the same request', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const bob = await call(db, 'grant_admin', ann.id, crypto.randomUUID(), added.id, 1);
  const key = crypto.randomUUID();
  await call(db, 'add_user', ann.id, key, 'cy@example.com', 'Cy Doe', HASH);
  await refused(call(db, 'add_user', bob.id, key, 'cy@example.com', 'Cy Doe', HASH),
    'IV410', 'another admin sending the same key and request');
});

// Finding 6: the owner's direct delete is held to the same rule as an update.
test('the owner\'s own direct delete cannot leave no active admin either', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  await call(db, 'grant_admin', ann.id, crypto.randomUUID(), added.id, 1);
  await as(db, null, async (owner) => {
    // Bob has never acted, so no log row refers to him and a delete can reach him.
    await owner.query('UPDATE inv.users SET admin = false WHERE id = $1', [ann.id]);
    await refused(owner.query('DELETE FROM inv.users WHERE id = $1', [added.id]),
      'IV422', 'deleting the only active admin');
  });
});

// Finding 4: a function a later migration adds is closed to every login until
// that migration grants it, so forgetting a REVOKE cannot open it.
test('a function added after migration 001 can be run by no login', async () => {
  const db = await freshDatabase();
  await as(db, null, (owner) => owner.query(
    'CREATE FUNCTION inv.later_fn() RETURNS int LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$'));
  for (const login of LOGINS) {
    await as(db, login, (c) =>
      refused(c.query('SELECT inv.later_fn()'), '42501', `${login} running a later function`));
  }
});

// The time of the latest password change, as the session cookie carries it.
async function passwordStamp(db, id) {
  return as(db, null, async (owner) => (await owner.query(
    'SELECT (EXTRACT(epoch FROM password_changed_at) * 1000000)::bigint::text AS stamp FROM inv.users WHERE id = $1',
    [id])).rows[0].stamp);
}

// PR #79 review, finding 2: an admin's reset between the app's check of the
// session and the save must win, not be overwritten by the older session.
test('a password change from a session older than the latest password change is refused', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const before = await passwordStamp(db, ann.id);
  await call(db, 'set_password', ann.id, crypto.randomUUID(), ann.id, 'an admin reset');
  await refused(call(db, 'change_password', ann.id, crypto.randomUUID(), before, HASH),
    'IV422', 'a change from the session before the reset');
  const done = await call(db, 'change_password', ann.id, crypto.randomUUID(), await passwordStamp(db, ann.id), HASH);
  assert.equal(done.id, ann.id);
});
