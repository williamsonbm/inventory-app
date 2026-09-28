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

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

const { migrate } = require('../src/db/migrate.js');

const ADMIN_URL = process.env.TEST_DATABASE_URL;

// One database per test, named for this process so parallel test files and
// leftovers from an interrupted run never collide.
let created = 0;
const databases = [];

function urlFor(database, user) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (user) url.username = user;
  return url.toString();
}

async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function freshDatabase({ migrated = true } = {}) {
  assert.ok(ADMIN_URL,
    'TEST_DATABASE_URL is not set. Run pg-test-up in the pod; CI sets it in test.yml.');
  const name = `inv_test_${process.pid}_${++created}`;
  const admin = await connect(ADMIN_URL);
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  databases.push(name);
  if (migrated) await migrate(urlFor(name));
  return name;
}

after(async () => {
  if (!ADMIN_URL) return;
  const admin = await connect(ADMIN_URL);
  try {
    for (const name of databases) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
});

// Runs `fn` with a client connected to `database` as `user` (the owner when
// omitted), and always disconnects.
async function as(database, user, fn) {
  const client = await connect(urlFor(database, user));
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Adds the first person as the owner and returns them, so a test can act as them.
async function firstUser(db) {
  return as(db, null, async (owner) => {
    const { rows: [{ person }] } = await owner.query(
      'SELECT inv.add_first_user($1, $2) AS person', [' Ann@Example.com ', ' Ann Lee ']);
    return person;
  });
}

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
      owner.query('SELECT inv.add_first_user($1, $2)', ['bob@example.com', 'Bob Ray']),
      /already has people/);
  });
});

const APP = 'inv_app';

// Calls one of the app's functions as the app's login and returns its answer.
async function call(db, fn, ...args) {
  return as(db, APP, async (app) => {
    const params = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows: [{ result }] } = await app.query(`SELECT inv.${fn}(${params}) AS result`, args);
    return result;
  });
}

async function logRows(db) {
  return as(db, APP, async (app) =>
    (await app.query('SELECT * FROM inv.activity_log ORDER BY id')).rows);
}

test('the app adds a person, and one log row says who did it and what changed', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), ' Bob@Example.COM ', ' Bob Ray ');
  assert.deepEqual(bob, { id: bob.id, email: 'bob@example.com', name: 'Bob Ray', active: true, admin: false, version: 1 });

  const log = await logRows(db);
  assert.equal(log.length, 2, 'the setup row and this one');
  assert.equal(Number(log[1].actor_id), ann.id);
  assert.equal(log[1].action, 'add user');
  assert.equal(Number(log[1].target_id), bob.id);
  assert.equal(log[1].old_value, null);
  assert.deepEqual(log[1].new_value, bob);
});

// Asserts that `promise` is refused with the SQLSTATE `code`, and returns the error.
async function refused(promise, code, label) {
  const err = await promise.then(
    () => assert.fail(`${label}: expected a refusal with ${code}, but it succeeded`),
    (e) => e);
  assert.equal(err.code, code, `${label}: ${err.message}`);
  return err;
}

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
    await refused(call(db, 'add_user', ann.id, crypto.randomUUID(), email, name), 'IV400', label);
  }
  assert.equal((await logRows(db)).length, 1, 'no refusal leaves a log row');
});

test('a rename is logged was → now, and a rename from a stale version is refused with the current row', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');

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
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
  const bobAdd = (await logRows(db)).at(-1);

  const removed = await call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 1);
  assert.deepEqual(removed, { ...bob, active: false, version: 2 });
  assert.equal((await logRows(db)).at(-1).action, 'remove user');

  await refused(call(db, 'add_user', bob.id, crypto.randomUUID(), 'cy@example.com', 'Cy Doe'),
    'IV403', 'a removed person acting');
  await refused(call(db, 'remove_user', ann.id, crypto.randomUUID(), bob.id, 2),
    'IV422', 'removing someone already removed');
  assert.deepEqual((await logRows(db)).find((r) => r.id === bobAdd.id), bobAdd,
    'the removed person\'s history is unchanged');

  const back = await call(db, 'reactivate_user', ann.id, crypto.randomUUID(), bob.id, 2);
  assert.deepEqual(back, { ...bob, active: true, version: 3 });
  assert.equal((await logRows(db)).at(-1).action, 'reactivate user');
  await refused(call(db, 'reactivate_user', ann.id, crypto.randomUUID(), bob.id, 3),
    'IV422', 're-activating someone already active');
});

test('only an admin changes the user list', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
  const key = () => crypto.randomUUID();
  for (const [label, fn, ...args] of [
    ['add', 'add_user', 'cy@example.com', 'Cy Doe'],
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
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
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
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
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
  const first = await call(db, 'add_user', ann.id, key, 'bob@example.com', 'Bob Ray');
  const again = await call(db, 'add_user', ann.id, key, 'bob@example.com', 'Bob Ray');
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
  const sql = 'SELECT inv.add_user($1, $2, $3, $4) AS result';
  const args = [ann.id, key, 'bob@example.com', 'Bob Ray'];
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

test('the app runs only its six functions; the Planner and backup logins run none', async () => {
  const db = await freshDatabase();
  const APP_FUNCTIONS = ['add_user', 'grant_admin', 'reactivate_user', 'remove_user', 'rename_user', 'revoke_admin'];
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

test('a backup taken by the backup login restores into an empty database (S51)', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
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
    const cy = await call(empty, 'add_user', ann.id, crypto.randomUUID(), 'cy@example.com', 'Cy Doe');
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
  const added = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray');
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
