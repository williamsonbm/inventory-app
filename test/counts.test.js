// =============================================================
// counts.test.js — start, save and submit a count (#81 part 3 group B,
// stories 58–67; seam 1). Run with: pg-test-up, then npm test (node --test)
// =============================================================
// Each test builds a fresh database, calls the database's functions as the
// app's login, and reads the figures through the one calculation
// (inv.item_figures). Approval (group C) is not here: nothing in these tests
// can be approved, so on hand never comes from a count.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, firstUser, call, goLive, logRows, figure, refused } = require('./support/database.js');

// A database with Ann and one hanger, with hangers live.
async function withHanger() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const hanger = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  await goLive(db, 'hangers');
  return { db, ann, hanger };
}

// inv.month_before has one caller, inv.start_count, which takes the moment
// from the clock; this reads it directly, as the owner, to give it moments
// the clock cannot.
async function monthBefore(db, at) {
  return as(db, null, async (owner) =>
    (await owner.query("SELECT pg_catalog.to_char(inv.month_before($1), 'YYYY-MM') AS month", [at])).rows[0].month);
}

test('a count closes the month before the one it was taken in, in the office\'s time zone (S10)', async () => {
  const db = await freshDatabase();
  assert.equal(await monthBefore(db, '2026-07-03 08:00:00-04'), '2026-06', 'July 3 closes June');
  assert.equal(await monthBefore(db, '2026-07-01 00:30:00-04'), '2026-06', 'just after midnight on July 1 closes June');
  // 2026-07-01 02:00 UTC is still June 30, 10:00 PM in the office.
  assert.equal(await monthBefore(db, '2026-07-01 02:00:00+00'), '2026-05', 'June 30 in the office closes May');
  assert.equal(await monthBefore(db, '2027-01-03 08:00:00-05'), '2026-12', 'January closes the December before');
});

test('starting a count makes a draft timed now, closing last month, and a draft changes nothing (stories 58, 59, 65; S7)', async () => {
  const { db, ann, hanger } = await withHanger();
  const onHand = await figure(db, 'on_hand');
  const count = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'monthly', null);

  const takenAt = new Date(count.counted_at);
  assert.ok(Math.abs(Date.now() - takenAt) < 60_000, `the moment is when the count started: ${count.counted_at}`);
  assert.deepEqual(count, {
    id: count.id, version: 1, family: 'hangers', family_name: 'Hangers', kind: 'monthly', status: 'draft',
    closes: await monthBefore(db, count.counted_at), counted_at: count.counted_at, counted_by: 'Ann Lee', lines: [],
  });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.target_table, Number(last.target_id), last.new_value],
    ['start count', 'counts', count.id, count]);
  assert.deepEqual(await figure(db, 'on_hand'), onHand, 'a draft changes no on hand');
  assert.equal(onHand[hanger.id], 0);
});

test('a spot check closes no month; a monthly count may close another month, never a later one (stories 58, 65; Q104)', async () => {
  const { db, ann } = await withHanger();
  const start = (kind, closes) => call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', kind, closes);

  const spot = await start('spot check', null);
  assert.deepEqual([spot.kind, spot.closes], ['spot check', null]);
  const august = await start('monthly', '2026-08');
  assert.equal(august.closes, '2026-08');

  const before = (await logRows(db)).length;
  const cases = [
    ['a spot check given a month', () => start('spot check', '2026-09'), 'IV400'],
    ['a month written another way', () => start('monthly', 'September'), 'IV400'],
    ['month 13', () => start('monthly', '2026-13'), 'IV400'],
    ['a month after the one the count is taken in', () => start('monthly', '2099-01'), 'IV400'],
    ['a kind that is not monthly or spot check', () => start('weekly', null), 'IV400'],
    ['a family that does not exist', () => call(db, 'start_count', ann.id, crypto.randomUUID(), 'bricks', 'monthly', null), 'IV400'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('a count of a family not live in Inventory is refused, whatever writes it (story 57)', async () => {
  const { db, ann } = await withHanger();
  const err = await refused(call(db, 'start_count', ann.id, crypto.randomUUID(), 'plates', 'monthly', null), 'IV422', 'plates are off');
  assert.equal(err.message, 'The Plates family is not live in Inventory yet, so it takes no POs, receipts, corrections or counts.');
  await as(db, null, async (owner) => refused(owner.query(
    "INSERT INTO inv.counts (family, kind, closes, counted_at, counted_by) VALUES ('plates', 'spot check', NULL, now(), $1)", [ann.id]),
  'IV422', 'a direct insert for plates'));
});

// Saves the draft `count` with `lines` and the month it closes, as Ann.
function save(db, ann, count, lines, closes = count.closes) {
  return call(db, 'save_count', ann.id, crypto.randomUUID(), count.id, count.version, closes, JSON.stringify(lines));
}

test('a draft keeps several lines per item, packs × pack size + loose, 0 for an empty rack, and changes nothing (stories 62, 64, 66; S7, S74)', async () => {
  const { db, ann, hanger } = await withHanger();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  const count = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'monthly', null);

  // 3 cartons of 50 and 2 cartons of 25 plus 7 loose, then an empty rack;
  // a row left blank is not counted (Q103).
  const saved = await save(db, ann, count, [
    { item_id: hanger.id, packs: 3, pack_size: 50, pack_kind: 'carton' },
    { item_id: hanger.id, packs: 2, pack_size: 25, pack_kind: 'carton', loose: 7 },
    { item_id: other.id, loose: 0 },
    { item_id: other.id, pack_size: 50, pack_kind: 'carton' },
  ], '2026-08');
  assert.deepEqual(saved, {
    ...count, version: 2, closes: '2026-08',
    lines: [
      { item_id: hanger.id, item: 'LUS28', packs: 3, pack_size: 50, pack_kind: 'carton', loose: null, quantity: 150 },
      { item_id: hanger.id, item: 'LUS28', packs: 2, pack_size: 25, pack_kind: 'carton', loose: 7, quantity: 57 },
      { item_id: other.id, item: 'HUS26', packs: null, pack_size: null, pack_kind: null, loose: 0, quantity: 0 },
    ],
  });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, Number(last.target_id), last.old_value, last.new_value], ['save count', count.id, count, saved]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 0, [other.id]: 0 }, 'a draft changes no on hand (S7)');

  // A later save replaces the draft's lines.
  const again = await save(db, ann, saved, [{ item_id: hanger.id, loose: 12 }]);
  assert.deepEqual(again.lines.map((l) => [l.item, l.quantity]), [['LUS28', 12]]);
  assert.equal(again.version, 3);
});

test('a draft save is refused whole for one bad line, acts once on a retry, and is refused when stale (S21, S22, S41)', async () => {
  const { db, ann, hanger } = await withHanger();
  const plate = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 3x4' });
  await goLive(db, 'plates');
  const retired = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HU210' });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), retired.id, retired.version);
  const count = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  const good = { item_id: hanger.id, loose: 4 };

  const before = (await logRows(db)).length;
  const cases = [
    ['an item of another family', [good, { item_id: plate.id, loose: 1 }], 'IV422', 'MT20 3x4 is Plates, but this count is of Hangers.'],
    ['a retired item', [good, { item_id: retired.id, loose: 1 }], 'IV422', 'HU210 is retired. Un-retire it before you count it.'],
    ['an item not in the catalog', [good, { item_id: 999999, loose: 1 }], 'IV400', 'Line 2: pick the item from the catalog.'],
    ['packs without a pack size', [good, { item_id: hanger.id, packs: 2 }], 'IV400', 'LUS28: give both the packs and the pack size, or neither.'],
    ['a pack size of 0', [good, { item_id: hanger.id, packs: 2, pack_size: 0, pack_kind: 'carton' }], 'IV400', 'LUS28: a pack size is a whole number of pieces above 0.'],
    ['a kind the family has no packs of', [good, { item_id: hanger.id, packs: 2, pack_size: 20, pack_kind: 'pallet' }], 'IV400', 'LUS28: a pack size for Hangers is a carton.'],
    ['negative loose pieces', [good, { item_id: hanger.id, loose: -1 }], 'IV400', 'LUS28: loose pieces are a whole number, 0 or more.'],
    ['a fraction of a pack', [good, { item_id: hanger.id, packs: 1.5, pack_size: 20, pack_kind: 'carton' }], 'IV400', 'LUS28: packs are a whole number, 0 or more.'],
    ['more pieces than a whole number holds', [good, { item_id: hanger.id, packs: 2000000000, pack_size: 2, pack_kind: 'carton' }], 'IV400', 'LUS28: 2000000000 × 2 is more pieces than the app can hold.'],
    ['lines that are not a list', { item_id: hanger.id }, 'IV400', 'A count lists its lines.'],
  ];
  for (const [label, lines, code, message] of cases) {
    const err = await refused(save(db, ann, count, lines), code, label);
    assert.equal(err.message, message, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');

  const key = crypto.randomUUID();
  const args = [ann.id, key, count.id, count.version, null, JSON.stringify([good])];
  const first = await call(db, 'save_count', ...args);
  assert.deepEqual(await call(db, 'save_count', ...args), first, 'the retry answers as the first save did');
  assert.equal((await logRows(db)).length, before + 1, 'the retry adds no log row');

  const stale = await refused(save(db, ann, count, [{ item_id: hanger.id, loose: 5 }]), 'IV409', 'a stale screen');
  assert.equal(stale.message, 'Someone else changed this count since you opened this screen.');
  assert.deepEqual(JSON.parse(stale.detail), first, 'the refusal carries the count as it is now');
  await refused(save(db, ann, first, [good]), 'IV422', 'a save that changes nothing');
});

// Submits `count` with `lines`, as `who`.
function submit(db, who, count, lines, closes = count.closes) {
  return call(db, 'submit_count', who.id, crypto.randomUUID(), count.id, count.version, closes, JSON.stringify(lines));
}

test('submitting saves the lines and waits for approval, keeping the moment the count started (stories 59, 67; S7)', async () => {
  const { db, ann, hanger } = await withHanger();
  const count = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'monthly', null);

  const empty = await refused(submit(db, ann, count, [{ item_id: hanger.id }]), 'IV400', 'a count with no lines');
  assert.equal(empty.message, 'A count needs at least one counted line to submit. A row left blank is not counted; type 0 for an empty rack.');

  const waiting = await submit(db, ann, count, [{ item_id: hanger.id, loose: 40 }]);
  assert.deepEqual(waiting, {
    ...count, version: 2, status: 'waiting',
    lines: [{ item_id: hanger.id, item: 'LUS28', packs: null, pack_size: null, pack_kind: null, loose: 40, quantity: 40 }],
  });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value], ['submit count', count, waiting]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 0 }, 'a waiting count changes no on hand');

  const again = await refused(save(db, ann, waiting, [{ item_id: hanger.id, loose: 41 }]), 'IV422', 'saving a submitted count');
  assert.equal(again.message, 'This count is already submitted, so it is not changed here.');
  await as(db, null, async (owner) => refused(owner.query(
    'INSERT INTO inv.count_lines (count_id, item_id, loose) VALUES ($1, $2, 1)', [count.id, hanger.id]),
  'IV422', 'a direct insert on a submitted count'));
});

test('an item is on one waiting count at a time; the refusal names who holds it, and a draft blocks nothing (S8, Q31)', async () => {
  const { db, ann, hanger } = await withHanger();
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  const start = (who) => call(db, 'start_count', who.id, crypto.randomUUID(), 'hangers', 'spot check', null);

  // Two drafts of one item save side by side: a draft holds nothing.
  const anns = await save(db, ann, await start(ann), [{ item_id: hanger.id, loose: 40 }]);
  const bobs = await save(db, bob, await start(bob), [{ item_id: other.id, loose: 3 }, { item_id: hanger.id, loose: 41 }]);

  const held = await submit(db, ann, anns, anns.lines);
  const day = new Date(held.counted_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' });
  const before = (await logRows(db)).length;
  const err = await refused(submit(db, bob, bobs, bobs.lines), 'IV422', 'a second waiting count of LUS28');
  assert.equal(err.message, `LUS28 is on Ann Lee's count from ${day}, waiting for approval.`);
  assert.equal((await logRows(db)).length, before, 'the refusal leaves no log row');

  // Without LUS28, Bob's count of HUS26 goes through.
  const fine = await submit(db, bob, bobs, [{ item_id: other.id, loose: 3 }]);
  assert.equal(fine.status, 'waiting');
});

test('two submits of one item at the same moment: the second waits for the first, then is refused (S8)', async () => {
  const { db, ann, hanger } = await withHanger();
  const start = () => call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  const lines = JSON.stringify([{ item_id: hanger.id, loose: 40 }]);
  const [one, two] = [await start(), await start()];

  await as(db, 'inv_app', async (first) => as(db, 'inv_app', async (second) => {
    const submitIn = (client, c) => client.query('SELECT inv.submit_count($1, $2, $3, $4, NULL, $5)',
      [ann.id, crypto.randomUUID(), c.id, c.version, lines]);
    await first.query('BEGIN');
    await submitIn(first, one);
    await second.query('BEGIN');
    const racing = submitIn(second, two).then(() => 'submitted', (e) => e);
    // The second submit is waiting on the first's lock: still unsettled.
    const early = await Promise.race([racing, new Promise((r) => setTimeout(() => r('waiting'), 300))]);
    assert.equal(early, 'waiting', 'the second submit waits while the first is open');
    await first.query('COMMIT');
    const outcome = await racing;
    await second.query('ROLLBACK');
    assert.equal(outcome.code, 'IV422', `the second submit is refused: ${outcome.message ?? outcome}`);
    assert.match(outcome.message, /^LUS28 is on Ann Lee's count from /);
  }));
});

test('an item on a count keeps its name, so the count goes on naming it (story 107)', async () => {
  const { db, ann, hanger } = await withHanger();
  const count = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  await save(db, ann, count, [{ item_id: hanger.id, loose: 0 }]);
  const err = await refused(call(db, 'rename_item', ann.id, crypto.randomUUID(), hanger.id, hanger.version, { sku: 'LUS28Z' }),
    'IV422', 'renaming a counted item');
  assert.equal(err.message, 'LUS28 is on a count, so its name stays.');
});
