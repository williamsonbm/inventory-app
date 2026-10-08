// =============================================================
// settings.test.js — inv.settings and the working-day window (#81 part 3
// group A, story 28). Run with: pg-test-up, then npm test (node --test)
// =============================================================
// What the database refuses or calculates on its own. The route that saves
// the window is in inventory.test.js (seam 3), like the catalog's other
// admin-only changes.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, HASH, firstUser, call, logRows, refused } = require('./support/database.js');

// A moment in America/New_York, as the database would store it (checked
// against the calendar: 2026-10-12 is a Monday, 2026-10-09 the Friday before it).
const MONDAY_8AM = '2026-10-12 08:00:00-04';
const FRIDAY_8AM = '2026-10-09 08:00:00-04';

// inv.working_day_window_start has no caller yet (group D, part 3's
// before-or-after question, calls it later), so it carries no grant to the
// app's own login; this reads it directly, as the owner.
async function windowStart(db, at) {
  return as(db, null, async (owner) =>
    (await owner.query('SELECT inv.working_day_window_start($1) AS start', [at])).rows[0].start.toISOString());
}

test('the working-day window defaults to 1, and Monday 8:00 reaches back to Friday 8:00', async () => {
  const db = await freshDatabase();
  assert.equal(await windowStart(db, MONDAY_8AM), new Date(FRIDAY_8AM).toISOString());
});

test('an admin sets the working-day window, logged was → now, and the window function uses it', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const set = (version, days) => call(db, 'set_working_day_window', ann.id, crypto.randomUUID(), version, days);

  const changed = await set(1, 2);
  assert.deepEqual(changed, { name: 'working_day_window', value: 2, version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value],
    ['set working day window', { name: 'working_day_window', value: 1, version: 1 }, changed]);
  // With the window at 2, Monday 8:00 skips Sunday and Saturday, then two
  // weekdays: Friday, then Thursday.
  assert.equal(await windowStart(db, MONDAY_8AM), new Date('2026-10-08 08:00:00-04').toISOString());

  const before = (await logRows(db)).length;
  const cases = [
    ['a non-admin', () => call(db, 'set_working_day_window', bob.id, crypto.randomUUID(), 2, 3), 'IV403'],
    ['0 days', () => set(2, 0), 'IV400'],
    ['a negative number of days', () => set(2, -1), 'IV400'],
    ['a fractional number of days', () => set(2, 1.5), 'IV400'],
    ['a number past the database\'s whole numbers', () => set(2, 3000000000), 'IV400'],
    ['a stale version', () => set(1, 3), 'IV409'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
  assert.equal((await refused(set(2, 21), 'IV400', 'more than 20 days (Q126)')).message, 'The working-day window is a whole number of days, from 1 to 20.');
  assert.equal((await set(2, 20)).value, 20, '20 is the most');
});

test('an admin switches off "a second person approves a count", logged was → now (owner, Q110, Q114)', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const set = (who, version, on) => call(db, 'set_count_approval_by_another', who.id, crypto.randomUUID(), version, on);

  const off = await set(ann, 1, false);
  assert.deepEqual(off, { name: 'count_approval_by_another', value: false, version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value],
    ['set count approval', { name: 'count_approval_by_another', value: true, version: 1 }, off]);

  const before = (await logRows(db)).length;
  const cases = [
    ['a non-admin', () => set(bob, 2, true), 'IV403'],
    ['neither on nor off', () => set(ann, 2, null), 'IV400'],
    ['a stale version', () => set(ann, 1, true), 'IV409'],
    ['no change', () => set(ann, 2, false), 'IV422'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});
