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
// migrations. The signing secret is new on each start, so a restart signs
// everyone out. With no one on the list yet, it prints the command that adds
// the first admin.
//
// Glue, NOT UNIT-TESTED: it only wires existing pieces together. Checked by
// starting it and signing in (PR #79). The app itself is tested through
// test/support/app.js, which builds it the same way.
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createApp } = require('./app.js');
const { openDatabase } = require('./db/database.js');
const { migrate } = require('./db/migrate.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE = 'inv_local';

function urlFor(server, user) {
  const url = new URL(server);
  url.pathname = `/${DATABASE}`;
  if (user) url.username = user;
  return url.toString();
}

async function main() {
  const server = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';

  const admin = new Client({ connectionString: server });
  await admin.connect().catch(() => {
    throw new Error(`No Postgres answers at ${new URL(server).host}. Start it (README, "Run it"), then npm start again.`);
  });
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [DATABASE]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  const applied = await migrate(urlFor(server));
  if (applied.length) console.log(`applied: ${applied.join(', ')}`);

  // The app connects as its own login, as on Vercel, so it has the same rights.
  const database = openDatabase(urlFor(server, 'inv_app'));
  const app = createApp({ database, sessionSecret: crypto.randomBytes(32).toString('base64url') });
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

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
