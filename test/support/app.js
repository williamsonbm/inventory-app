// =============================================================
// test/support/app.js — the whole app on an ephemeral port (#77, seam 1).
// Not a test file: node --test also loads it, finds no tests, and counts it
// as one passing file.
// =============================================================
// Boots the real composed app (src/app.js) against a fresh database built by
// the migration runner, connected as the app's own login. Nothing outside
// the app is replaced.
// =============================================================

const { after } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../../src/app.js');
const { openDatabase } = require('../../src/db/database.js');
const { hashPassword } = require('../../src/auth/password.js');
const { urlFor, freshDatabase, as } = require('./database.js');

const SESSION_SECRET = 'a test signing secret, at least 32 characters long';
const running = [];

after(async () => {
  for (const { server, database } of running) {
    await new Promise((r) => server.close(r));
    await database.end();
  }
});

// Starts the app on a fresh database. Returns the base URL, the database's
// name (for the owner's own setup and for moving the lock time), and fetch
// helpers that send JSON.
async function startApp({ databaseUrl } = {}) {
  const db = databaseUrl ? null : await freshDatabase();
  const database = openDatabase(databaseUrl || urlFor(db, 'inv_app'));
  const app = createApp({ database, sessionSecret: SESSION_SECRET });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  running.push({ server, database });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, db, app };
}

// A request that never follows a redirect, so a test sees the redirect itself.
function get(base, path, cookie) {
  return fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
}

function post(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

// The session cookie a response sets, as a Cookie header value, or null.
function cookieFrom(res) {
  const set = res.headers.getSetCookie().find((c) => c.startsWith('inv_session='));
  return set ? set.split(';')[0] : null;
}

// The first person, added by the owner's one-time setup with a temporary password.
async function addFirstUser(db, { email = 'ann@example.com', name = 'Ann Lee', password = 'temporary password 1' } = {}) {
  const hash = await hashPassword(password);
  return as(db, null, async (owner) => (await owner.query(
    'SELECT inv.add_first_user($1, $2, $3) AS person', [email, name, hash])).rows[0].person);
}

// Signs in and returns the cookie; fails the test if sign-in is refused.
async function signIn(base, email, password) {
  const res = await post(base, '/api/sign-in', { email, password });
  assert.equal(res.status, 200, `sign-in as ${email}: ${await res.text()}`);
  return cookieFrom(res);
}

// Signs in with a temporary password and chooses `password`; returns the new cookie.
async function signInAndChoose(base, email, temporary, password) {
  const cookie = await signIn(base, email, temporary);
  const res = await post(base, '/api/password',
    { key: crypto.randomUUID(), current: temporary, password }, cookie);
  assert.equal(res.status, 200, `choosing a password as ${email}: ${await res.text()}`);
  return cookieFrom(res);
}

// An app with Ann, an admin, signed in with her own password.
async function withAdmin() {
  const ctx = await startApp();
  const ann = await addFirstUser(ctx.db);
  const cookie = await signInAndChoose(ctx.base, 'ann@example.com', 'temporary password 1', 'ann own password');
  return { ...ctx, ann, cookie };
}

module.exports = { startApp, get, post, cookieFrom, addFirstUser, signIn, signInAndChoose, withAdmin };
