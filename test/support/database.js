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

module.exports = { urlFor, connect, freshDatabase, as };
