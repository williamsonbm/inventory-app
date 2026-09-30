// =============================================================
// test/support/database.js — a fresh test database per test (#77).
// Not a test file: node --test also loads it, finds no tests, and counts it
// as one passing file.
// =============================================================
// Shared by the database tests (seam 2) and the whole-app tests (seam 1).
// Needs a real Postgres of the Supabase project's major version, named by
// TEST_DATABASE_URL (the pod image sets it; CI sets it in test.yml). Without
// it the tests fail, never skip, so a green run always means they ran.
// =============================================================

const { after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const { migrate } = require('../../src/db/migrate.js');

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
  if (!ADMIN_URL || !databases.length) return;
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

// The database stores a password hash and never reads it, so any non-empty
// text stands in for one here. The app's own hashing is in password.test.js.
const HASH = 'a stand-in for a password hash';

// Adds the first person as the owner and returns them, so a test can act as them.
async function firstUser(db) {
  return as(db, null, async (owner) => {
    const { rows: [{ person }] } = await owner.query(
      'SELECT inv.add_first_user($1, $2, $3) AS person', [' Ann@Example.com ', ' Ann Lee ', HASH]);
    return person;
  });
}

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

// Asserts that `promise` is refused with the SQLSTATE `code`, and returns the error.
async function refused(promise, code, label) {
  const err = await promise.then(
    () => assert.fail(`${label}: expected a refusal with ${code}, but it succeeded`),
    (e) => e);
  assert.equal(err.code, code, `${label}: ${err.message}`);
  return err;
}

module.exports = {
  urlFor, connect, freshDatabase, as, HASH, APP, firstUser, call, logRows, refused,
};
