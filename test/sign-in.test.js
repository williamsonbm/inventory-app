// =============================================================
// sign-in.test.js — signing in, and every route closed until then (#77, seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Boots the whole app on an ephemeral port against a fresh database and calls
// it with fetch(). Needs TEST_DATABASE_URL (see test/support/database.js).
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  startApp, get, post, cookieFrom, addFirstUser, signIn, signInAndChoose, withAdmin,
} = require('./support/app.js');
const { as } = require('./support/database.js');
const { hashPassword } = require('../src/auth/password.js');

test('signed out, a page redirects to sign-in and an API route answers 401 JSON', async () => {
  const { base } = await startApp();

  const page = await get(base, '/?family=plates');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/sign-in?next=%2F%3Ffamily%3Dplates',
    'the sign-in page remembers the page the person tried to open');

  const api = await post(base, '/api/lumber/plan', { files: [] });
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { ok: false, error: 'Please sign in.' });
});

// Adds a person through the database's own function, acting as `actor`.
async function addPerson(db, actor, email, name, password) {
  const hash = await hashPassword(password);
  return as(db, null, async (owner) => (await owner.query(
    'SELECT inv.add_user($1, $2, $3, $4, $5) AS person',
    [actor.id, crypto.randomUUID(), email, name, hash])).rows[0].person);
}

test('the right password sets a cookie the next request accepts', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);

  const res = await post(base, '/api/sign-in', { email: ' ANN@example.com ', password: 'temporary password 1' });
  assert.equal(res.status, 200);
  const cookie = cookieFrom(res);
  assert.ok(cookie, 'a signed-in response sets the session cookie');

  const me = await get(base, '/api/me', cookie);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).user, { name: 'Ann Lee', admin: true, passwordTemporary: true });
});

test('after sign-in the page goes where the person meant to go, never to another site', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  for (const [next, expected] of [
    ['/?family=plates', '/?family=plates'],
    [undefined, '/'],
    ['//evil.example/', '/'],
    ['/\\evil.example/', '/'],
    ['https://evil.example/', '/'],
    // A browser drops tabs and line breaks from an address, so each of these is "//evil.example".
    ['/\t/evil.example', '/'],
    ['/\n/evil.example', '/'],
    ['/\r\\evil.example', '/'],
  ]) {
    const res = await post(base, '/api/sign-in', { email: 'ann@example.com', password: 'temporary password 1', next });
    assert.equal((await res.json()).next, expected, `next: ${next}`);
  }
});

test('a wrong password, an unlisted address and a removed person get the same refusal and no cookie', async () => {
  const { base, db } = await startApp();
  const ann = await addFirstUser(db);
  const bob = await addPerson(db, ann, 'bob@example.com', 'Bob Ray', 'bob temporary 1');
  await as(db, null, (owner) => owner.query(
    'SELECT inv.remove_user($1, $2, $3, $4)', [ann.id, crypto.randomUUID(), bob.id, bob.version]));

  for (const [label, email, password] of [
    ['a wrong password', 'ann@example.com', 'not the password'],
    ['an unlisted address', 'nobody@example.com', 'temporary password 1'],
    ['a removed person with their right password', 'bob@example.com', 'bob temporary 1'],
  ]) {
    const res = await post(base, '/api/sign-in', { email, password });
    assert.equal(res.status, 401, label);
    assert.deepEqual(await res.json(), { ok: false, error: 'The email or password is wrong.' }, label);
    assert.equal(cookieFrom(res), null, `${label}: no cookie`);
  }
});

test('after five wrong passwords in a row, even the right one is refused until the lock ends', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const attempt = (password) => post(base, '/api/sign-in', { email: 'ann@example.com', password });

  for (let i = 1; i <= 5; i++) assert.equal((await attempt(`wrong guess ${i}`)).status, 401, `guess ${i}`);
  const locked = await attempt('temporary password 1');
  assert.equal(locked.status, 401, 'the right password during the lock');
  assert.deepEqual(await locked.json(), { ok: false, error: 'The email or password is wrong.' },
    'the lock gives the same answer, so it does not tell a stranger the address is listed');

  // Move the lock's end into the past, as fifteen minutes passing would.
  await as(db, null, (owner) => owner.query(
    "UPDATE inv.users SET locked_until = pg_catalog.now() - interval '1 second'"));
  assert.equal((await attempt('temporary password 1')).status, 200, 'the right password after the lock');
});

test('four wrong passwords and then the right one start the count again', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const attempt = (password) => post(base, '/api/sign-in', { email: 'ann@example.com', password });
  for (let i = 1; i <= 4; i++) await attempt(`wrong guess ${i}`);
  assert.equal((await attempt('temporary password 1')).status, 200);
  for (let i = 1; i <= 4; i++) await attempt(`wrong guess ${i}`);
  assert.equal((await attempt('temporary password 1')).status, 200, 'four more wrong ones do not lock');
});

test('with a temporary password, every page but "choose your password" sends the person there', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const cookie = await signIn(base, 'ann@example.com', 'temporary password 1');

  const page = await get(base, '/', cookie);
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/password');
  const api = await get(base, '/api/lumber/menu', cookie);
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { ok: false, error: 'Choose your own password first.' });
  assert.equal((await get(base, '/password', cookie)).status, 200);
});

test('a new password must be 12 to 200 characters, and the current one must be typed first', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const cookie = await signIn(base, 'ann@example.com', 'temporary password 1');
  const choose = (current, password) =>
    post(base, '/api/password', { key: crypto.randomUUID(), current, password }, cookie);

  for (const [label, current, password, error] of [
    ['11 characters', 'temporary password 1', 'x'.repeat(11), 'A password needs at least 12 characters.'],
    ['201 characters', 'temporary password 1', 'x'.repeat(201), 'A password can have at most 200 characters.'],
    ['a wrong current password', 'not the password', 'a good new password', 'The current password is wrong.'],
  ]) {
    const res = await choose(current, password);
    assert.equal(res.status, 400, label);
    assert.deepEqual(await res.json(), { ok: false, error }, label);
  }
  assert.equal((await get(base, '/', cookie)).headers.get('location'), '/password', 'still temporary');
});

test('choosing a password clears the temporary one and signs out every other computer', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const here = await signIn(base, 'ann@example.com', 'temporary password 1');
  const elsewhere = await signIn(base, 'ann@example.com', 'temporary password 1');

  const res = await post(base, '/api/password',
    { key: crypto.randomUUID(), current: 'temporary password 1', password: 'ann own password' }, here);
  assert.equal(res.status, 200);
  const renewed = cookieFrom(res);
  assert.ok(renewed, 'this computer gets a new cookie');

  assert.equal((await get(base, '/', renewed)).status, 200, 'the new cookie opens the Planner');
  assert.equal((await get(base, '/api/me', here)).status, 401, 'the cookie from before the change');
  assert.equal((await get(base, '/api/me', elsewhere)).status, 401, 'another computer');
  assert.equal((await post(base, '/api/sign-in',
    { email: 'ann@example.com', password: 'temporary password 1' })).status, 401, 'the old password');
  await signIn(base, 'ann@example.com', 'ann own password');
});

test('a tampered, unsigned or foreign cookie is refused', async () => {
  const ctx = await withAdmin();
  const [name, value] = ctx.cookie.split('=');
  const [payload, signature] = value.split('.');
  const otherPayload = Buffer.from(JSON.stringify({ u: ctx.ann.id + 1, p: '0' })).toString('base64url');
  for (const [label, cookie] of [
    ['another person\'s id under this signature', `${name}=${otherPayload}.${signature}`],
    ['no signature', `${name}=${payload}`],
    ['a changed signature', `${name}=${payload}.${signature.slice(0, -2)}AA`],
    ['nonsense', `${name}=nonsense`],
  ]) {
    assert.equal((await get(ctx.base, '/api/me', cookie)).status, 401, label);
  }
});

test('a removed person is stopped on their next request, though still signed in', async () => {
  const { base, db, ann, cookie } = await withAdmin();
  const bob = await addPerson(db, ann, 'bob@example.com', 'Bob Ray', 'bob temporary 1');
  const bobCookie = await signInAndChoose(base, 'bob@example.com', 'bob temporary 1', 'bob own password');
  assert.equal((await get(base, '/', bobCookie)).status, 200);

  const res = await post(base, '/api/users/remove',
    { key: crypto.randomUUID(), id: bob.id, version: bob.version }, cookie);
  assert.equal(res.status, 200, await res.text());
  assert.equal((await get(base, '/', bobCookie)).status, 302, 'a page');
  assert.equal((await get(base, '/api/me', bobCookie)).status, 401, 'an API route');
});

test('Sign out ends the session on this computer', async () => {
  const { base, cookie } = await withAdmin();
  const res = await post(base, '/api/sign-out', {}, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie().join('\n'), /^inv_session=; .*Max-Age=0/m,
    'the cookie is cleared');
});

test('when the database does not answer, sign-in says so plainly and signs no one in', async () => {
  // Port 9 on this machine: nothing listens there, so every connection is refused.
  const { base } = await startApp({ databaseUrl: 'postgres://inv_app@127.0.0.1:9/none' });
  const res = await post(base, '/api/sign-in', { email: 'ann@example.com', password: 'temporary password 1' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: 'The database is not answering. Try again in a minute.' });
  assert.equal(cookieFrom(res), null);
});

// Every route an Express app registers, as "METHOD /path".
function routesOf(app) {
  return app._router.stack.filter((layer) => layer.route).flatMap((layer) =>
    Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${layer.route.path}`));
}

// The spec's open list, exactly: the sign-in page and the one sign-in route.
const OPEN = ['GET /sign-in', 'POST /api/sign-in'];

test('every route the app registers refuses a signed-out request, except the open list', async () => {
  const { base, app } = await startApp();
  const { app: planner } = require('../src/planner/server.js');
  // Express 4 hides a mounted app inside its parent, so each is swept on its
  // own; a mounted app this test does not know about fails it.
  const mounted = app._router.stack.filter((layer) => layer.name === 'mounted_app');
  assert.equal(mounted.length, 1, 'only the Planner is mounted; sweep any new mounted app here too');
  const routes = [...routesOf(app), ...routesOf(planner)];
  assert.ok(routes.length > 20, `the sweep found the routes: ${routes.join(', ')}`);

  const open = [];
  for (const route of routes) {
    const [method, path] = route.split(' ');
    const res = await fetch(base + path, {
      method, redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    const refusedPage = res.status === 302 && res.headers.get('location').startsWith('/sign-in?next=');
    const refusedApi = res.status === 401
      && (await res.clone().json()).error === 'Please sign in.';
    if (!refusedPage && !refusedApi) open.push(route);
    if (path.startsWith('/api/') || method !== 'GET') {
      assert.ok(!refusedPage, `${route}: an API route answers 401, not a redirect`);
    }
  }
  assert.deepEqual(open.sort(), [...OPEN].sort());
});

test('with a temporary password, every script and stylesheet the password page loads still answers', async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const cookie = await signIn(base, 'ann@example.com', 'temporary password 1');
  const page = await get(base, '/password', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  const assets = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 2, `found the page's files: ${assets}`);
  for (const asset of assets) {
    assert.equal((await get(base, asset, cookie)).status, 200, `${asset} for a temporary password`);
  }
});

test('Sign out ends the session on the server: the old cookie, or one a late answer puts back, is refused', async () => {
  const { base, cookie } = await withAdmin();
  const elsewhere = await signIn(base, 'ann@example.com', 'ann own password');
  assert.equal((await post(base, '/api/sign-out', {}, cookie)).status, 200);
  assert.equal((await get(base, '/api/me', cookie)).status, 401, 'the cookie from before Sign out');
  assert.equal((await get(base, '/api/me', elsewhere)).status, 401, 'another computer');
  const again = await signIn(base, 'ann@example.com', 'ann own password');
  assert.equal((await get(base, '/api/me', again)).status, 200, 'a new sign-in works');
});

test('a person removed and then re-activated is not signed back in by an old cookie', async () => {
  const { base, db, ann, cookie } = await withAdmin();
  const bob = await addPerson(db, ann, 'bob@example.com', 'Bob Ray', 'bob temporary 1');
  const bobCookie = await signInAndChoose(base, 'bob@example.com', 'bob temporary 1', 'bob own password');
  for (const [route, version] of [['/api/users/remove', 1], ['/api/users/reactivate', 2]]) {
    const res = await post(base, route, { key: crypto.randomUUID(), id: bob.id, version }, cookie);
    assert.equal(res.status, 200, await res.text());
  }
  assert.equal((await get(base, '/api/me', bobCookie)).status, 401, 'the cookie from before the removal');
  await signIn(base, 'bob@example.com', 'bob own password');
});

test('during a lock, a password change says the account is locked, and a change is not a sign-in', async () => {
  const { base, cookie } = await withAdmin();
  const signedIn = async (c) => (await (await get(base, '/api/users', c)).json()).users[0].last_signed_in_at;
  const before = await signedIn(cookie);
  const res = await post(base, '/api/password',
    { key: crypto.randomUUID(), current: 'ann own password', password: 'ann second password' }, cookie);
  assert.equal(res.status, 200);
  const renewed = cookieFrom(res);
  assert.equal(await signedIn(renewed), before, 'a password change does not move "last signed in"');

  for (let i = 1; i <= 5; i++) await post(base, '/api/sign-in', { email: 'ann@example.com', password: `guess ${i}` });
  const locked = await post(base, '/api/password',
    { key: crypto.randomUUID(), current: 'ann second password', password: 'ann third password' }, renewed);
  assert.equal(locked.status, 400);
  assert.deepEqual(await locked.json(),
    { ok: false, error: 'Too many wrong passwords. Try again in 15 minutes, or ask an admin for a temporary password.' });
});

test('an address saved with an invisible trailing character still signs in, as typed', async () => {
  const { base, cookie } = await withAdmin();
  // U+FEFF often rides along with pasted text. Postgres does not count it as a blank.
  const email = 'cy@example.com﻿';
  const add = await post(base, '/api/users/add',
    { key: crypto.randomUUID(), email, name: 'Cy Doe', password: 'cy temporary 12' }, cookie);
  assert.equal(add.status, 200, await add.text());
  await signIn(base, email, 'cy temporary 12');
});

test('a database that stops answering during sign-in gets the plain message, not "not confirmed"', { timeout: 30000 }, async () => {
  const { base, db } = await startApp();
  await addFirstUser(db);
  const { connect, urlFor } = require('./support/database.js');
  const owner = await connect(urlFor(db));
  try {
    // Holding Ann's row makes the sign-in's save wait until the app gives up on it.
    await owner.query('BEGIN');
    await owner.query("SELECT 1 FROM inv.users WHERE email = 'ann@example.com' FOR UPDATE");
    const res = await post(base, '/api/sign-in', { email: 'ann@example.com', password: 'temporary password 1' });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: 'The database is not answering. Try again in a minute.' });
  } finally {
    await owner.query('ROLLBACK');
    await owner.end();
  }
});

test('a Sign out the database cannot record still signs this computer out', async () => {
  const { base, db, cookie } = await withAdmin();
  // The owner takes the right away, so the save of the sign-out fails.
  await as(db, null, (owner) => owner.query('REVOKE EXECUTE ON FUNCTION inv.sign_out(bigint) FROM inv_app'));
  const res = await post(base, '/api/sign-out', {}, cookie);
  assert.notEqual(res.status, 200, 'the failure is reported, not hidden');
  const cookies = res.headers.getSetCookie().filter((c) => c.startsWith('inv_session='));
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /^inv_session=; .*Max-Age=0/, 'this computer is signed out all the same');
});
