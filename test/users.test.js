// =============================================================
// users.test.js — Settings → Users and the activity log, over HTTP (#77, seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Boots the whole app against a fresh database, signs in as the first admin,
// and uses the app's own routes, the activity log's included, to check what
// each change did. What the database refuses on its own is in database.test.js.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { get, post, signInAndChoose, withAdmin } = require('./support/app.js');
const { as } = require('./support/database.js');

// Posts one change as the signed-in admin and returns the parsed answer.
async function change(ctx, route, body, cookie = ctx.cookie) {
  const res = await post(ctx.base, route, { key: crypto.randomUUID(), ...body }, cookie);
  return { status: res.status, body: await res.json() };
}

async function activity(ctx, query = '') {
  const res = await get(ctx.base, `/api/activity${query}`, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

async function addBob(ctx) {
  const { status, body } = await change(ctx, '/api/users/add',
    { email: 'Bob@Example.com', name: 'Bob Ray', password: 'bob temporary 1' });
  assert.equal(status, 200, body.error);
  return body.user;
}

test('add, rename, remove and re-activate each write one log row: who, what, was → now', async () => {
  const ctx = await withAdmin();
  const bob = await addBob(ctx);
  assert.deepEqual(bob, { id: bob.id, email: 'bob@example.com', name: 'Bob Ray', active: true, admin: false, version: 1 });

  const renamed = (await change(ctx, '/api/users/rename', { id: bob.id, version: 1, name: 'Robert Ray' })).body.user;
  const removed = (await change(ctx, '/api/users/remove', { id: bob.id, version: 2 })).body.user;
  const back = (await change(ctx, '/api/users/reactivate', { id: bob.id, version: 3 })).body.user;
  assert.equal(back.active, true);

  const { entries } = await activity(ctx);
  const mine = entries.filter((e) => e.target === 'Robert Ray');
  assert.deepEqual(mine.map(({ who, action, was, now }) => ({ who, action, was, now })), [
    { who: 'Ann Lee', action: 're-activate user', was: removed, now: back },
    { who: 'Ann Lee', action: 'remove user', was: renamed, now: removed },
    { who: 'Ann Lee', action: 'rename user', was: bob, now: renamed },
    { who: 'Ann Lee', action: 'add user', was: null, now: bob },
  ], 'newest first, one row per change');
});

test('the same retry key sent twice makes one change and one log row, and both answers match', async () => {
  const ctx = await withAdmin();
  const body = { key: crypto.randomUUID(), email: 'bob@example.com', name: 'Bob Ray', password: 'bob temporary 1' };
  const first = await post(ctx.base, '/api/users/add', body, ctx.cookie);
  const again = await post(ctx.base, '/api/users/add', body, ctx.cookie);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), await first.json(), 'the retry reports the original outcome');

  const users = (await (await get(ctx.base, '/api/users', ctx.cookie)).json()).users;
  assert.equal(users.filter((u) => u.email === 'bob@example.com').length, 1);
  const adds = (await activity(ctx, '?action=add%20user')).entries.filter((e) => e.target === 'Bob Ray');
  assert.equal(adds.length, 1);
});

test('a save from a stale screen is refused, and the refusal carries the current row', async () => {
  const ctx = await withAdmin();
  const bob = await addBob(ctx);
  const renamed = (await change(ctx, '/api/users/rename', { id: bob.id, version: 1, name: 'Robert Ray' })).body.user;
  const stale = await change(ctx, '/api/users/rename', { id: bob.id, version: 1, name: 'Bobby Ray' });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /Someone else changed Robert Ray since you opened this screen/);
  assert.deepEqual(stale.body.current, renamed);
});

test('removing, or taking admin from, the last active admin is refused', async () => {
  const ctx = await withAdmin();
  for (const route of ['/api/users/remove', '/api/users/revoke-admin']) {
    const { status, body } = await change(ctx, route, { id: ctx.ann.id, version: 1 });
    assert.equal(status, 422, route);
    assert.match(body.error, /no active admin/, route);
  }
});

test('impossible people are refused with a plain message', async () => {
  const ctx = await withAdmin();
  await addBob(ctx);
  for (const [label, body, error] of [
    ['a duplicate address in other capitals', { email: 'BOB@example.COM', name: 'Bob Again' }, 'bob@example.com is already on the list.'],
    ['an address with no @', { email: 'bob.example.com', name: 'Bob Ray' }, 'An email address needs exactly one @ and no spaces.'],
    ['an empty name', { email: 'cy@example.com', name: '  ' }, 'A name is required.'],
    ['a short temporary password', { email: 'cy@example.com', name: 'Cy Doe', password: 'short' }, 'A password needs at least 12 characters.'],
  ]) {
    const res = await change(ctx, '/api/users/add', { password: 'a temporary one', ...body });
    assert.equal(res.status, 400, label);
    assert.deepEqual(res.body, { ok: false, error }, label);
  }
});

test('a person who is not an admin sees the list, and every change to it is refused', async () => {
  const ctx = await withAdmin();
  const bob = await addBob(ctx);
  const bobCookie = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password');

  const list = await get(ctx.base, '/api/users', bobCookie);
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).users.map((u) => u.name), ['Ann Lee', 'Bob Ray']);
  const { USER_CHANGES } = require('../src/settings/users.js');
  for (const route of Object.keys(USER_CHANGES)) {
    const res = await change(ctx, route,
      { id: bob.id, version: 1, email: 'cy@example.com', name: 'Cy Doe', password: 'a temporary one' }, bobCookie);
    assert.equal(res.status, 403, route);
    assert.deepEqual(res.body, { ok: false, error: 'Only an admin can do this.' }, route);
  }
});

test('an admin sets a temporary password: one log row with no password or hash, and the person is sent to choose their own', async () => {
  const ctx = await withAdmin();
  const bob = await addBob(ctx);
  const bobCookie = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password');

  const res = await post(ctx.base, '/api/users/set-password',
    { key: crypto.randomUUID(), id: bob.id, password: 'bob temporary 2' }, ctx.cookie);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal((await get(ctx.base, '/api/me', bobCookie)).status, 401, 'Bob is signed out elsewhere');

  const rows = (await activity(ctx, '?action=set%20password')).entries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, 'Ann Lee');
  assert.equal(rows[0].target, 'Bob Ray');
  const logText = JSON.stringify(await activity(ctx));
  for (const secret of ['bob temporary 2', 'bob own password', 'scrypt$']) {
    assert.ok(!logText.includes(secret) && !text.includes(secret), `no "${secret}" in the log or the answer`);
  }

  const cookie = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 2', 'bob new password');
  assert.equal((await get(ctx.base, '/', cookie)).status, 200);
});

test('no error response carries a stack trace, SQL or a credential', async () => {
  const ctx = await withAdmin();
  const bodies = [];
  const collect = async (res) => bodies.push(`${res.status} ${await res.text()}`);
  await collect(await post(ctx.base, '/api/users/rename', { key: 'not a uuid', id: 1, version: 1, name: 'x' }, ctx.cookie));
  await collect(await post(ctx.base, '/api/users/rename', { key: crypto.randomUUID(), id: 'x', version: 1, name: 'x' }, ctx.cookie));
  await collect(await get(ctx.base, '/api/activity?from=yesterday', ctx.cookie));
  await collect(await post(ctx.base, '/api/users/add', { key: crypto.randomUUID() }, ctx.cookie));
  await collect(await get(ctx.base, '/api/no-such-thing', ctx.cookie));
  await collect(await fetch(`${ctx.base}/api/users/add`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: ctx.cookie }, body: '{"bad json',
  }));
  for (const body of bodies) {
    assert.match(body, /^[45]\d\d \{"ok":false,"error":"[^"]+"\}$/, 'one plain refusal');
    assert.doesNotMatch(body, /\bat \S+:\d+|SELECT|inv\.|postgres:|scrypt|syntax|invalid input/i, body);
  }
});

test('the activity log filters by person, action and office day, newest first, a page at a time', async () => {
  const ctx = await withAdmin();
  const bob = await addBob(ctx);
  await change(ctx, '/api/users/grant-admin', { id: bob.id, version: 1 });
  const bobCookie = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password');
  let version = 2;
  for (let i = 1; i <= 60; i++) {
    const { status } = await change(ctx, '/api/users/rename', { id: bob.id, version: version++, name: `Bob ${i}` }, bobCookie);
    assert.equal(status, 200);
  }

  const bobsRenames = await activity(ctx, `?person=${bob.id}&action=rename%20user`);
  assert.equal(bobsRenames.entries.length, 50, 'one page');
  assert.deepEqual(bobsRenames.entries.slice(0, 2).map((e) => e.now.name), ['Bob 60', 'Bob 59'], 'newest first');
  const rest = await activity(ctx, `?person=${bob.id}&action=rename%20user&before=${bobsRenames.before}`);
  assert.deepEqual(rest.entries.map((e) => e.now.name), ['Bob 10', 'Bob 9', 'Bob 8', 'Bob 7', 'Bob 6',
    'Bob 5', 'Bob 4', 'Bob 3', 'Bob 2', 'Bob 1']);
  assert.equal(rest.before, null, 'no page after the last');

  const anns = (await activity(ctx, `?person=${ctx.ann.id}`)).entries.map((e) => e.action);
  assert.deepEqual(anns, ['grant admin', 'add user', 'change password', 'add user']);

  // Office days are Eastern Time. Every row here was written today in New York.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const [y, m, d] = today.split('-').map(Number);
  const dayAfter = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const count = async (q) => (await activity(ctx, `?person=${ctx.ann.id}${q}`)).entries.length;
  assert.equal(await count(`&from=${today}&to=${today}`), 4, 'today, both ends inclusive');
  assert.equal(await count(`&from=${dayAfter}`), 0, 'from tomorrow');
  assert.equal(await count(`&to=${dayBefore}`), 0, 'up to yesterday');

  // 03:30 on July 1 in UTC is 23:30 on June 30 in New York (daylight time).
  await as(ctx.db, null, (owner) => owner.query(
    "UPDATE inv.activity_log SET at = '2026-07-01 03:30:00+00' WHERE action = 'grant admin'"));
  const onDay = async (day) => (await activity(ctx, `?from=${day}&to=${day}`)).entries.map((e) => e.action);
  assert.deepEqual(await onDay('2026-06-30'), ['grant admin'], 'the office day it happened');
  assert.deepEqual(await onDay('2026-07-01'), [], 'not the UTC day');

  const refused = await get(ctx.base, '/api/activity?from=06/07/2026', ctx.cookie);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { ok: false, error: 'A date must be written like 2026-09-29.' });
});
