// The app's database connection (#77, #28): one pool per running copy of the
// app, and one way to make a change.
//
// Connect through Supabase's transaction-mode pooler (port 6543), over SSL with
// the certificate verified. On Vercel the certificate is text in an
// environment variable (`ca` below), because a file named by sslrootcert= is
// read only at connect time and is not part of the deployment. Then the
// connection string must not carry sslmode: pg lets the string's settings
// override these. Locally (the pod, over port 5432) the string may carry
// sslmode=verify-full&sslrootcert=<path> instead. A transaction-mode pooler drops
// session state between transactions, so this module uses none: no named
// prepared statements, no SET, no search_path (every name is fully qualified),
// no advisory locks, LISTEN/NOTIFY or temp tables.
const { Pool } = require('pg');
const { attachDatabasePool } = require('@vercel/functions');

// Only names of this shape reach the SQL text below; every value travels as a
// parameter.
const FUNCTION_NAME = /^[a-z_]+$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

// Marks a failure of the connection, not of the request, as `unreachable`:
// an error with no SQLSTATE (the network, a timeout), or one of the classes
// Postgres uses for a connection it cannot serve (08 connection, 53 out of
// resources, 57P shutting down). The app answers "not answering" for these.
function markUnreachable(err) {
  const code = err.code || '';
  if (!SQLSTATE.test(code) || /^(08|53|57P)/.test(code)) err.unreachable = true;
  return err;
}

function openDatabase(connectionString, { ca } = {}) {
  if (ca && /[?&]sslmode=/.test(connectionString)) {
    throw new Error('The connection string carries sslmode, which would override the CA certificate; remove it.');
  }
  const pool = new Pool({
    connectionString,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    // #28's starting point, not a measured number: tune max against measured waiting time.
    min: 1,
    max: 3,
    idleTimeoutMillis: 5000,
    // A database that does not answer is reported, never waited on for the
    // whole of Vercel's time limit.
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  // A connection that drops while idle raises an error on the pool; without a
  // listener that would end the process. The next request reports it instead.
  pool.on('error', (err) => console.error(`database connection dropped: ${err.message}`));
  // Lets Vercel keep the function alive until idle connections are closed.
  // Outside Vercel it does nothing.
  attachDatabasePool(pool);

  return {
    // One read, run as a single statement.
    async read(sql, params = []) {
      try {
        return (await pool.query(sql, params)).rows;
      } catch (err) {
        throw markUnreachable(err);
      }
    },

    // Runs inv.<name>(...args) in its own transaction and returns its answer.
    // Each database function writes its activity-log row in the same save.
    // An error that Postgres itself reported (it carries a SQLSTATE) means the
    // transaction did not commit. Any other error after the call was sent (a
    // dropped connection, a timeout) is marked `unconfirmed`: the save may or
    // may not have happened, and the page's retry key makes a retry safe.
    async save(name, args) {
      if (!FUNCTION_NAME.test(name)) throw new Error(`not a database function name: ${name}`);
      const params = args.map((_, i) => `$${i + 1}`).join(', ');
      const client = await pool.connect().catch((err) => { throw markUnreachable(err); });
      let broken;
      try {
        await client.query('BEGIN');
        const { rows: [{ result }] } = await client.query(`SELECT inv.${name}(${params}) AS result`, args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch((e) => { broken = e; });
        if (!SQLSTATE.test(err.code || '')) err.unconfirmed = true;
        throw markUnreachable(err);
      } finally {
        // A client that could not roll back is closed, not reused.
        client.release(broken);
      }
    },

    end: () => pool.end(),
  };
}

// The database functions' own refusals carry an IV code (migration 001).
function isRefusal(err) {
  return typeof err?.code === 'string' && err.code.startsWith('IV');
}

module.exports = { openDatabase, isRefusal };
