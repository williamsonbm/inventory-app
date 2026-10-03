// `npm start`: the whole app on this computer, for trying it by hand (#77).
// The same app Vercel runs (src/app.js), connected to a local practice
// database instead of Supabase: `inv_local` on the Postgres that
// TEST_DATABASE_URL names, or else the one at 127.0.0.1:5432. Its data never
// leaves this computer.
//
// On the owner's computer that is a Postgres container (README, "Run it").
// The pod has its own network, separate from the computer's, so the pod's
// test Postgres cannot be reached from the computer, and a browser on the
// computer cannot reach an app started in the pod (checked 2026-09-29).
//
// Each start creates the database if it is missing and applies any new
// migrations. The signing secret is kept in .local-session-secret (not in
// git), so a restart keeps everyone signed in. With no one on the list yet,
// it prints the command that adds the first admin.
//
// `npm run reset-local` builds the database again from the migrations, for
// a migration that changed after it was applied. It keeps the people and
// their passwords, and imports the test catalog (test/port-fixtures and
// test/import-fixtures) as the first admin. Everything else is lost. It runs
// only on this computer's Postgres.
//
// NOT UNIT-TESTED: it drops and builds the database by its fixed name on the
// Postgres the tests also use, and then serves the app; a test of it would
// drop the database a person is trying the app on. Checked by hand instead
// (PR #83): a reset keeps the people, and a reset that finds the people file
// of a reset that stopped takes the people from it. The app itself is tested
// through test/support/app.js, which builds it the same way. TEST_CATALOG is
// exported for test/import.test.js, which imports the same files.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createApp } = require('./app.js');
const { openDatabase } = require('./db/database.js');
const { migrate } = require('./db/migrate.js');
const { importCatalog } = require('./db/import-catalog.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE = 'inv_local';
const SECRET_FILE = path.join(__dirname, '..', '.local-session-secret');
const PEOPLE_FILE = path.join(__dirname, '..', '.local-people.json');
const FIXTURES = path.join(__dirname, '..', 'test');
const TEST_CATALOG = {
  plates: path.join(FIXTURES, 'port-fixtures', 'stock', 'plate-stock-20260902.csv'),
  hangers: path.join(FIXTURES, 'port-fixtures', 'stock', 'hanger-stock-20260902.csv'),
  lumber: path.join(FIXTURES, 'port-fixtures', 'stock', 'lumber-stock-20260902.csv'),
  ewp: path.join(FIXTURES, 'import-fixtures', 'ewp-on-hand-20260930.csv'),
  specialOrder: path.join(FIXTURES, 'import-fixtures', 'special-order.csv'),
  lvlDepthThresholds: path.join(FIXTURES, 'import-fixtures', 'lvl-depth-thresholds.csv'),
};

function urlFor(server, user) {
  const url = new URL(server);
  url.pathname = `/${DATABASE}`;
  if (user) url.username = user;
  return url.toString();
}

// The same secret on every start, made once, so a restart signs no one out.
function sessionSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}

// Every person in the old database, each as a JSON row, or none when there
// is no old database or no people table yet (3D000, 42P01). Any other
// failure stops the reset before it drops anything.
async function readPeople(server) {
  const client = new Client({ connectionString: urlFor(server) });
  try {
    await client.connect();
    return (await client.query('SELECT pg_catalog.to_jsonb(u) AS u FROM inv.users u ORDER BY id')).rows.map((r) => r.u);
  } catch (err) {
    if (err.code === '3D000' || err.code === '42P01') return [];
    throw new Error(`The people could not be read, so nothing was reset: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}

// The people to put back after a reset. Before anything is dropped they are
// saved to PEOPLE_FILE (not in git, and readable only by this computer's
// user, because it holds their password hashes); the file is deleted once
// they are back. So a file found here means the last reset stopped part-way,
// on a migration that does not apply: its people are the ones to keep, even
// if someone was added by hand since.
async function keepPeople(server) {
  try {
    const people = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));
    console.log(`The last reset did not finish, so the people come from ${path.basename(PEOPLE_FILE)} (${people.length}).`);
    return people;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`${path.basename(PEOPLE_FILE)} could not be read, so nothing was reset: ${err.message}`);
    }
  }
  const people = await readPeople(server);
  fs.writeFileSync(PEOPLE_FILE, JSON.stringify(people), { mode: 0o600 });
  return people;
}

// Puts the people back into the new database, with their ids and passwords,
// all or none. Only the columns both versions have are copied; a new column
// takes its default.
async function restorePeople(server, people) {
  if (!people.length) return;
  const client = new Client({ connectionString: urlFor(server) });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'inv' AND table_name = 'users'`);
    const columns = rows.map((r) => r.column_name).filter((c) => c in people[0]);
    const list = columns.map((c) => `"${c}"`).join(', ');
    for (const person of people) {
      await client.query(`INSERT INTO inv.users (${list}) OVERRIDING SYSTEM VALUE
        SELECT ${list} FROM pg_catalog.jsonb_populate_record(NULL::inv.users, $1)`, [person]);
    }
    await client.query(`SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('inv.users', 'id'),
      (SELECT pg_catalog.max(id) FROM inv.users))`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`The people could not be put back; they are kept in ${path.basename(PEOPLE_FILE)}: ${err.message}`);
  } finally {
    await client.end();
  }
}

async function main() {
  const server = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
  const reset = process.argv.includes('--reset');
  const host = new URL(server).hostname;
  if (reset && !['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error(`npm run reset-local drops a database, so it runs only on this computer's Postgres, not on ${host}.`);
  }

  const admin = new Client({ connectionString: server });
  await admin.connect().catch(() => {
    throw new Error(`No Postgres answers at ${new URL(server).host}. Start it (README, "Run it"), then npm start again.`);
  });
  let people = [];
  try {
    if (reset) {
      people = await keepPeople(server);
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    }
    const { rowCount } = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [DATABASE]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  const applied = await migrate(urlFor(server)).catch((err) => {
    if (reset) {
      err.message += `\nThe people are kept in ${path.basename(PEOPLE_FILE)}. Fix the migration, then run npm run reset-local again.`;
    }
    throw err;
  });
  if (applied.length) console.log(`applied: ${applied.join(', ')}`);
  if (reset) {
    await restorePeople(server, people);
    fs.rmSync(PEOPLE_FILE, { force: true });
    const first = people.find((p) => p.active && p.admin);
    if (first) {
      const report = await importCatalog(urlFor(server), TEST_CATALOG, first.email);
      console.log(`People kept: ${people.length}. Test catalog imported: ${report.added.items} items.`);
    } else {
      console.log('No admin to import the test catalog as. Add the first admin, then npm run reset-local again.');
    }
  }

  // The app connects as its own login, as on Vercel, so it has the same rights.
  const database = openDatabase(urlFor(server, 'inv_app'));
  const app = createApp({ database, sessionSecret: sessionSecret() });
  const [{ n }] = await database.read('SELECT count(*)::int AS n FROM inv.users');

  app.listen(PORT, HOST, () => {
    console.log(`Inventory app, local database "${DATABASE}"  →  http://${HOST}:${PORT}`);
    if (!n) {
      console.log('No one can sign in yet. Add the first admin in another terminal:');
      console.log(`  DIRECT_DATABASE_URL='${urlFor(server)}' node src/db/add-first-user.js`);
    }
    console.log('Ctrl-C to stop.');
  }).on('error', (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use — another copy of the app (or something else) is running on it.`
      : `The app could not start: ${err.message}`);
    process.exit(1);
  });
}

// The test catalog is also what test/import.test.js imports, so a renamed
// fixture fails a test instead of breaking `npm run reset-local` unseen.
module.exports = { TEST_CATALOG };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
