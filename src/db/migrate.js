// Applies the numbered SQL files in migrations/ that a database has not had
// yet, in order, each in its own transaction with its bookkeeping row (#77).
// The same runner builds the live database and every test database, so both
// are built by the same files in the same order.
//
// Run it over the direct connection (port 5432) with the owner's login, never
// through the transaction-mode pooler: a migration is a long session of DDL.
//
// Deliberately our own ~40 lines instead of the Supabase CLI's migrations: the
// CLI needs itself and Docker in the pod, and the pod has neither.
//
// Usage: DIRECT_DATABASE_URL=postgres://... node src/db/migrate.js
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE_NAME = /^\d{3}-[a-z0-9-]+\.sql$/;

async function migrate(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS inv;
      CREATE TABLE IF NOT EXISTS inv.schema_migrations (name text PRIMARY KEY);`);
    const { rows } = await client.query('SELECT name FROM inv.schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => FILE_NAME.test(f)).sort();
    const done = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO inv.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `migration ${file} failed, nothing from it was applied: ${err.message}`;
        throw err;
      }
      done.push(file);
    }
    return done;
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  const url = process.env.DIRECT_DATABASE_URL;
  if (!url) {
    console.error('DIRECT_DATABASE_URL is not set (the direct connection, port 5432, owner login).');
    process.exit(1);
  }
  migrate(url).then(
    (done) => console.log(done.length ? `applied: ${done.join(', ')}` : 'nothing to apply'),
    (err) => { console.error(err.message); process.exit(1); },
  );
}
