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

const { freshDatabase, as, APP, firstUser, call, goLive, logRows, figure, reasonId, refused } = require('./support/database.js');

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
    closes: await monthBefore(db, count.counted_at), counted_at: count.counted_at, counted_by: 'Ann Lee', approved_by: null, lines: [],
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
      { item_id: hanger.id, item: 'LUS28', packs: 3, pack_size: 50, pack_kind: 'carton', loose: null, quantity: 150, expected: null, matched: null, reason: null },
      { item_id: hanger.id, item: 'LUS28', packs: 2, pack_size: 25, pack_kind: 'carton', loose: 7, quantity: 57, expected: null, matched: null, reason: null },
      { item_id: other.id, item: 'HUS26', packs: null, pack_size: null, pack_kind: null, loose: 0, quantity: 0, expected: null, matched: null, reason: null },
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
    lines: [{ item_id: hanger.id, item: 'LUS28', packs: null, pack_size: null, pack_kind: null, loose: 40, quantity: 40, expected: null, matched: null, reason: null }],
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

// Group C (stories 69–76, 80): approve or reject a count, and on hand from
// approved counts. Ann counts; Bob, a second person, approves (S5).

// withHanger, plus Bob, a supplier, and helpers to receive and to act on a count.
// The answer to "before or after the count?" as the database takes it.
const answer = (timing) => timing && JSON.stringify(timing);

async function withTwo() {
  const ctx = await withHanger();
  const { db, ann } = ctx;
  ctx.bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Simpson');
  // A receipt of `quantity` of `item`; `replaces`, a receipt line it enters
  // again; `timing`, the answer to "before or after the count?".
  ctx.receive = (item, quantity, replaces = null, timing = null) => ctx.receiveLines([{ item_id: item.id, quantity }], replaces, timing);
  ctx.receiveLines = (lines, replaces = null, timing = null) => call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify(lines), replaces, answer(timing));
  // Starts a hangers count of `kind`, as `who` (Ann when omitted).
  ctx.start = (kind, who = ann) => call(db, 'start_count', who.id, crypto.randomUUID(), 'hangers', kind, null);
  // Starts a count of `lines` and submits it, as `who` (Ann when omitted).
  ctx.counted = async (lines, who = ann) =>
    submit(db, who, await call(db, 'start_count', who.id, crypto.randomUUID(), 'hangers', 'spot check', null), lines);
  ctx.approve = (who, count, answers = {}) =>
    call(db, 'approve_count', who.id, crypto.randomUUID(), count.id, count.version, JSON.stringify(answers));
  ctx.reject = (who, count) => call(db, 'reject_count', who.id, crypto.randomUUID(), count.id, count.version);
  return ctx;
}

test('count 8:00, receipt 11:00, approval 14:00: on hand has the receipt once (story 76, S1)', async () => {
  const { db, bob, hanger, receive, counted, approve } = await withTwo();
  await receive(hanger, 40);
  const count = await counted([{ item_id: hanger.id, loose: 40 }]);
  await receive(hanger, 10, null, { after: count.id });

  const approved = await approve(bob, count);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved_by, 'Bob Ray');
  assert.deepEqual(approved.lines.map((l) => [l.item, l.quantity, l.expected, l.matched]), [['LUS28', 40, 40, true]]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 50 }, 'the count\'s 40 and the later receipt\'s 10');
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, Number(last.actor_id), last.old_value, last.new_value], ['approve count', bob.id, count, approved]);
});

test('a person approves a count they worked on, unless an admin switches on "a second person approves" (story 69, S5; Q110, Q113, Q114, Q148)', async () => {
  const { db, ann, bob, hanger, start, approve } = await withTwo();
  const own = await submit(db, ann, await start('spot check'), [{ item_id: hanger.id, loose: 0 }]);
  assert.equal((await approve(ann, own)).approved_by, 'Ann Lee', 'off by default (Q148): the counter approves');

  await call(db, 'set_count_approval_by_another', ann.id, crypto.randomUUID(), 2, true);
  const cy = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'cy@example.com', 'Cy Fox', 'a stand-in for a password hash');
  const dee = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'dee@example.com', 'Dee Hart', 'a stand-in for a password hash');
  // Ann only starts it; Bob saves the draft, then Cy submits it.
  const saved = await save(db, bob, await start('spot check'), [{ item_id: hanger.id, loose: 0 }]);
  const count = await submit(db, cy, saved, saved.lines);

  const before = (await logRows(db)).length;
  for (const [who, label] of [[ann, 'Ann started it'], [bob, 'Bob saved it'], [cy, 'Cy submitted it']]) {
    const err = await refused(approve(who, count), 'IV422', label);
    assert.equal(err.message, 'You worked on this count, so a second person approves it.', label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
  assert.equal((await approve(dee, count)).approved_by, 'Dee Hart');
});

test('an Unmatched item needs a reason from Settings → Reasons before approval; a Matched one takes none (stories 70, 71; S9; Q111)', async () => {
  const { db, bob, hanger, receive, counted, approve } = await withTwo();
  const other = await call(db, 'add_item', bob.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(hanger, 40);
  await receive(other, 5);
  // LUS28 in two pack sizes adds up to 38 against the app's 40; HUS26 matches.
  const count = await counted([
    { item_id: hanger.id, packs: 1, pack_size: 25, pack_kind: 'carton' },
    { item_id: hanger.id, loose: 13 },
    { item_id: other.id, loose: 5 },
  ]);
  const scrapped = await reasonId(db, 'Damaged – scrapped');

  const before = (await logRows(db)).length;
  const cases = [
    ['no reason', {}, 'IV400', 'LUS28 is Unmatched: counted 38, the app had 40. Pick a reason.'],
    ['a reason for a Matched item', { reasons: { [hanger.id]: scrapped, [other.id]: scrapped } }, 'IV400', 'HUS26 is Matched, so it takes no reason.'],
    ['a reason not on the list', { reasons: { [hanger.id]: 999999 } }, 'IV400', 'LUS28 needs a reason from the list.'],
    ['a reason that is not a number', { reasons: { [hanger.id]: 'x' } }, 'IV400', 'LUS28 needs a reason from the list.'],
    ['the reason kept for a trim', { reasons: { [hanger.id]: await reasonId(db, 'Weathered – trimmed') } }, 'IV422',
      '"Weathered – trimmed" is for a trim. Use Trim on the LVL item.'],
    ['the reason kept for the import', { reasons: { [hanger.id]: await reasonId(db, 'Opening balance (web app)') } }, 'IV422',
      '"Opening balance (web app)" is for the cutover import only.'],
  ];
  for (const [label, answers, code, message] of cases) {
    const err = await refused(approve(bob, count, answers), code, label);
    assert.equal(err.message, message, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');

  const approved = await approve(bob, count, { reasons: { [hanger.id]: scrapped } });
  assert.deepEqual(approved.lines.map((l) => [l.item, l.quantity, l.expected, l.matched, l.reason]), [
    ['LUS28', 25, 40, false, 'Damaged – scrapped'],
    ['LUS28', 13, 40, false, 'Damaged – scrapped'],
    ['HUS26', 5, 5, true, null],
  ]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38, [other.id]: 5 }, 'on hand starts from the count');
});

test('"Unexplained" is a built-in reason that explains an Unmatched item and cannot be retired (story 71; Q117)', async () => {
  const { db, ann, bob, hanger, receive, counted, approve } = await withTwo();
  await receive(hanger, 40);
  const unexplained = await reasonId(db, 'Unexplained');
  const err = await refused(call(db, 'retire_reason', ann.id, crypto.randomUUID(), unexplained, 1), 'IV422', 'retiring a built-in reason');
  assert.equal(err.message, 'The app relies on "Unexplained", so it cannot be retired.');
  const approved = await approve(bob, await counted([{ item_id: hanger.id, loose: 38 }]), { reasons: { [hanger.id]: unexplained } });
  assert.deepEqual(approved.lines.map((l) => [l.item, l.matched, l.reason]), [['LUS28', false, 'Unexplained']]);
});

test('an Unmatched item with nothing recorded before the count needs no reason; after its first approved count it does (story 71; Q118)', async () => {
  const { db, ann, bob, hanger, receive, counted, approve } = await withTwo();
  const added = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(hanger, 40);
  const count = await counted([{ item_id: hanger.id, loose: 38 }, { item_id: added.id, loose: 5 }]);

  const review = await call(db, 'count_review', count.id);
  assert.deepEqual(review.nothing_before, [added.id], 'the screen learns which items need no reason');
  const err = await refused(approve(bob, count), 'IV400', 'LUS28 had a receipt before the count');
  assert.equal(err.message, 'LUS28 is Unmatched: counted 38, the app had 40. Pick a reason.');

  const unexplained = await reasonId(db, 'Unexplained');
  const approved = await approve(bob, count, { reasons: { [hanger.id]: unexplained } });
  assert.deepEqual(approved.lines.map((l) => [l.item, l.matched, l.reason]),
    [['LUS28', false, 'Unexplained'], ['HUS26', false, null]]);

  // HUS26 now has an approved count, so a different figure needs a reason.
  const recount = await counted([{ item_id: added.id, loose: 4 }]);
  assert.deepEqual((await call(db, 'count_review', recount.id)).nothing_before, []);
  await refused(approve(bob, recount), 'IV400', 'HUS26 after its first approved count');
  // Whatever writes the row, the same rule holds (the first approval above
  // passed the same check).
  await as(db, null, async (owner) => {
    await owner.query('UPDATE inv.count_lines SET expected = 5 WHERE count_id = $1', [recount.id]);
    await refused(owner.query("UPDATE inv.counts SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1",
      [recount.id, bob.id]), '23514', 'approving with no reason, past the function');
  });
});

test('an approved count and its lines are locked, whatever writes them, and a rejected count changes no on hand (stories 74, 80; S6, S75)', async () => {
  const { db, bob, hanger, receive, counted, approve, reject } = await withTwo();
  await receive(hanger, 40);
  const bad = await counted([{ item_id: hanger.id, loose: 3 }]);
  const rejected = await reject(bob, bad);
  assert.deepEqual([rejected.status, rejected.approved_by], ['rejected', null]);
  assert.equal((await logRows(db)).at(-1).action, 'reject count');
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 40 }, 'a rejected count changes nothing (S6)');
  await refused(approve(bob, rejected), 'IV422', 'approving a rejected count');

  // The recount is a new count (Q112); with LUS28 freed, it can wait for approval.
  const approved = await approve(bob, await counted([{ item_id: hanger.id, loose: 40 }]));
  const again = await refused(reject(bob, approved), 'IV422', 'rejecting an approved count');
  assert.equal(again.message, 'Only a count waiting for approval can be approved or rejected.');
  await as(db, null, async (owner) => {
    for (const [label, sql] of [
      ['changing a line', 'UPDATE inv.count_lines SET loose = 41 WHERE count_id = $1'],
      ['changing the app\'s number', 'UPDATE inv.count_lines SET expected = 41 WHERE count_id = $1'],
      ['removing a line', 'DELETE FROM inv.count_lines WHERE count_id = $1'],
      ['moving the moment', "UPDATE inv.counts SET counted_at = counted_at - interval '1 day' WHERE id = $1"],
      ['un-approving', "UPDATE inv.counts SET status = 'waiting', approved_at = NULL, approved_by = NULL WHERE id = $1"],
    ]) await refused(owner.query(sql, [approved.id]), 'IV422', label);
  });
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 40 });
});

test('approval asks of each entry made during the count "Was this item counted after this entry?"; Yes leaves it out of on hand (story 72; S63, S70; Q33)', async () => {
  const { db, ann, bob, hanger, receive, approve } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(hanger, 40);
  await receive(other, 40);
  const draft = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  // During the count, 10 of each arrive. LUS28 was counted after its
  // receipt (50 on the rack), HUS26 before it (40).
  await receive(hanger, 10);
  await receive(other, 10);
  const count = await submit(db, ann, draft, [{ item_id: hanger.id, loose: 50 }, { item_id: other.id, loose: 40 }]);
  await receive(hanger, 1, null, { after: count.id });  // after the count was submitted: approval does not ask

  const entries = await call(db, 'count_entries', count.id);
  assert.deepEqual(entries.map((e) => [e.item, e.action, e.quantity]), [['LUS28', 'receive', 10], ['HUS26', 'receive', 10]]);
  const [lus, hus] = entries.map((e) => e.id);

  const cases = [
    ['an entry left unanswered', { counted_after: { [lus]: true } }, 'HUS26: answer "Was this item counted after this entry?" for the receipt of 10.'],
    ['an entry not on the list', { counted_after: { [lus]: true, [hus]: false, 999999: true } }, 'Answer only for the entries listed.'],
    ['an entry number past the database\'s whole numbers', { counted_after: { [lus]: true, [hus]: false, '1234567890123456789012345': true } },
      'Answer only for the entries listed.'],
    ['answers that are not by entry', { counted_after: 5 }, 'Answer "Was this item counted after this entry?" entry by entry.'],
  ];
  for (const [label, answers, message] of cases) {
    const err = await refused(approve(bob, count, answers), 'IV400', label);
    assert.equal(err.message, message, label);
  }

  const approved = await approve(bob, count, { counted_after: { [lus]: true, [hus]: false } });
  assert.deepEqual(approved.lines.map((l) => [l.item, l.quantity, l.expected, l.matched]),
    [['LUS28', 50, 50, true], ['HUS26', 40, 40, true]], 'the app\'s number counts a Yes entry in');
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 51, [other.id]: 50 },
    'LUS28: 50 counted + 1 after; HUS26: 40 counted + the 10 it was counted before');
});

test('an entry a count holds, entered again with other numbers, is held too, however often (Q33; owner, 2026-10-05; PR #89 review)', async () => {
  const { db, ann, bob, hanger, receive, approve } = await withTwo();
  await receive(hanger, 40);
  const draft = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  const receipt = await receive(hanger, 10);
  const count = await submit(db, ann, draft, [{ item_id: hanger.id, loose: 50 }]);
  await approve(bob, count, { counted_after: { [receipt.lines[0].id]: true } });

  const twelve = await receive(hanger, 12, receipt.lines[0].id);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 50 }, 'the rack held 50 when counted; the 12 was in it');
  await receive(hanger, 13, twelve.lines[0].id);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 50 }, 'a re-entry of the re-entry is held as well');
});

test('a trim a count holds, entered again, keeps each item on the count that holds its row (Q33; PR #89 review)', async () => {
  const { db, ann, bob, hanger, receive, approve } = await withTwo();
  const lvl = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft });
  const long = await lvl(16);
  const short = await lvl(12);
  await goLive(db, 'lvl');
  await receive(long, 5);
  // Two spot checks of LVL, one of each length, both under way when 2 boards are trimmed.
  const start = () => call(db, 'start_count', ann.id, crypto.randomUUID(), 'lvl', 'spot check', null);
  const [ofLong, ofShort] = [await start(), await start()];
  const trimmed = await call(db, 'trim', ann.id, crypto.randomUUID(), long.id, 12, 2, null, false);
  for (const [draft, item, loose] of [[ofLong, long, 3], [ofShort, short, 2]]) {
    const count = await submit(db, ann, draft, [{ item_id: item.id, loose }]);
    const [entry] = await call(db, 'count_entries', count.id);
    await approve(bob, count, { counted_after: { [entry.id]: true } });
  }

  await call(db, 'trim', ann.id, crypto.randomUUID(), long.id, 12, 1, null, false, trimmed.id);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 0, [long.id]: 3, [short.id]: 2 },
    'both counts held the trim, so both hold its re-entry');
});

test('the approval screen reads each entry and each item\'s on hand at the count\'s moment, to show Matched before approving (story 71, 72)', async () => {
  const { ann, db, hanger, receive, counted } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(hanger, 40);
  const count = await counted([{ item_id: hanger.id, loose: 38 }, { item_id: other.id, loose: 0 }]);
  await receive(hanger, 10, null, { after: count.id });  // after the submit: in neither list

  const review = await call(db, 'count_review', count.id);
  assert.deepEqual(review.entries, [], 'no entry was made during the count');
  assert.deepEqual(review.on_hand, { [hanger.id]: 40, [other.id]: 0 }, 'on hand at counted_at, by item id');
  assert.equal(await call(db, 'count_review', 999999), null, 'a count that does not exist reads as nothing');
});

test('an entry made during the count and then reversed reads as its quantity and 0 net, as approval adds it up (story 72; PR #89 review)', async () => {
  const { db, ann, bob, hanger, receive, approve } = await withTwo();
  await receive(hanger, 40);
  const draft = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  const receipt = await receive(hanger, 10);
  await call(db, 'reverse', ann.id, crypto.randomUUID(), receipt.lines[0].id, null);
  const count = await submit(db, ann, draft, [{ item_id: hanger.id, loose: 40 }]);

  const { entries } = await call(db, 'count_review', count.id);
  assert.deepEqual(entries.map((e) => [e.action, e.quantity, e.net]), [['receive', 10, 0]], 'the page shows 10 and adds 0');
  const approved = await approve(bob, count, { counted_after: { [entries[0].id]: true } });
  assert.deepEqual(approved.lines.map((l) => [l.quantity, l.expected, l.matched]), [[40, 40, true]]);
});

test('two people approving two August monthly counts at the same moment: the second gets the plain message, not the index\'s', async () => {
  const { db, ann, bob, hanger } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  // An item on a waiting count is locked, so each count has its own item.
  const monthly = async (item) => submit(db, ann,
    await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'monthly', '2026-08'), [{ item_id: item.id, loose: 0 }]);
  const [first, second] = [await monthly(hanger), await monthly(other)];
  const approve = (client, count) => client.query('SELECT inv.approve_count($1, $2, $3, $4, $5) AS result',
    [bob.id, crypto.randomUUID(), count.id, count.version, '{}']);
  await as(db, APP, (a) => as(db, APP, async (b) => {
    await a.query('BEGIN');
    await approve(a, first);
    const racing = approve(b, second);  // waits on the index until the first one commits
    await new Promise((resolve) => setTimeout(resolve, 300));
    await a.query('COMMIT');
    const err = await racing.then(() => assert.fail('the second approval should be refused'), (e) => e);
    assert.deepEqual([err.code, err.message], ['IV422', 'Hangers already has an approved monthly count closing August 2026.']);
  }));
});

test('a recount of one item changes only that item; an entry before the count, and its later reversal, change nothing (stories 75; S2, S4, S27)', async () => {
  const { db, ann, bob, hanger, receive, counted, approve } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(other, 7);
  const before = await receive(hanger, 40);  // before the count, so the count holds it (S2)
  const first = await approve(bob, await counted([{ item_id: hanger.id, loose: 40 }, { item_id: other.id, loose: 7 }]));
  await receive(other, 3, null, { after: first.id });

  // A spot check of LUS28 alone leaves HUS26 on its earlier baseline (S4).
  const recount = await approve(bob, await counted([{ item_id: hanger.id, loose: 38 }]),
    { reasons: { [hanger.id]: await reasonId(db, 'Damaged – scrapped') } });
  assert.equal(recount.lines[0].expected, 40);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38, [other.id]: 10 });

  // Reversing the receipt from before both counts keeps its moment, so
  // neither it nor its reversal touches on hand (S27).
  await call(db, 'reverse', ann.id, crypto.randomUUID(), before.lines[0].id, 'entered twice');
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38, [other.id]: 10 });
});

test('a family has at most one approved monthly count per month (design, "Rules the database enforces")', async () => {
  const { db, ann, bob, hanger, approve } = await withTwo();
  const monthly = async () => submit(db, ann,
    await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'monthly', '2026-08'), [{ item_id: hanger.id, loose: 0 }]);
  await approve(bob, await monthly());
  const err = await refused(approve(bob, await monthly()), 'IV422', 'a second approved August count');
  assert.equal(err.message, 'Hangers already has an approved monthly count closing August 2026.');
});

// Group D (stories 77–79; design Q4/Q26, Q34): an entry saved within the
// working-day window after a count that covers one of its items asks
// "Was this before or after the count?". The answer is the last argument:
// { before: count id } or { after: count id }.
async function scrap(db, who, item, pieces, timing = null, replaces = null) {
  return call(db, 'correct', who.id, crypto.randomUUID(), item.id, -pieces, await reasonId(db, 'Damaged – scrapped'), null,
    replaces, answer(timing));
}

test('built 10:00, counted 11:00, entered 15:00: Before times the entry at the count\'s moment, so the count holds it (story 77; S3)', async () => {
  const { db, ann, bob, hanger, receive, start, approve } = await withTwo();
  await receive(hanger, 40);
  // 2 were scrapped before the count, so the rack had 38; nobody entered it.
  const count = await submit(db, ann, await start('monthly'),
    [{ item_id: hanger.id, loose: 38 }]);

  const asked = await refused(scrap(db, ann, hanger, 2), 'IV409', 'an entry after a count, with no answer');
  assert.equal(asked.message, 'Was this before or after the count? Pick one, then save again.');
  assert.deepEqual(JSON.parse(asked.detail), {
    counts: [{ id: count.id, family_name: 'Hangers', kind: 'monthly', counted_at: count.counted_at }],
  });

  const saved = await scrap(db, ann, hanger, 2, { before: count.id });
  assert.deepEqual(saved.timed, { before: true, counted_at: count.counted_at });
  const approved = await approve(bob, count);
  assert.deepEqual(approved.lines.map((l) => [l.quantity, l.expected, l.matched]), [[38, 38, true]],
    'the app\'s number at the count\'s moment has the scrap in it');
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38 }, 'the count\'s 38, the scrap not taken off again');
});

test('two counts in the window list both, oldest first: before the first, between them, or after the second (story 78; Q34, S71)', async () => {
  const { db, ann, bob, hanger, receive, counted, approve } = await withTwo();
  await receive(hanger, 40);
  const first = await approve(bob, await counted([{ item_id: hanger.id, loose: 40 }]));
  // One piece was scrapped between the two counts, so the second found 39.
  const second = await counted([{ item_id: hanger.id, loose: 39 }]);

  const asked = await refused(scrap(db, ann, hanger, 1), 'IV409', 'no answer');
  assert.deepEqual(JSON.parse(asked.detail).counts.map((c) => c.id), [first.id, second.id]);

  const before = await scrap(db, ann, hanger, 1, { before: first.id });
  const between = await scrap(db, ann, hanger, 1, { before: second.id });
  const after = await scrap(db, ann, hanger, 1, { after: second.id });
  assert.deepEqual([before.timed, between.timed, after.timed], [
    { before: true, counted_at: first.counted_at },
    { before: true, counted_at: second.counted_at },
    { before: false, counted_at: second.counted_at },
  ]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38 }, 'the first count\'s 40, less the two after it');
  assert.deepEqual(await call(db, 'count_entries', second.id), [], 'an entry timed by its answer is not asked about again');
  const approved = await approve(bob, second);
  assert.deepEqual(approved.lines.map((l) => [l.quantity, l.expected, l.matched]), [[39, 39, true]]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 38 }, 'the second count\'s 39, less the one after it');

  const stale = await refused(scrap(db, ann, hanger, 1, { after: first.id }), 'IV409', 'after a count with a later one in the window');
  assert.equal(stale.message, 'The counts changed since this screen asked. Pick again, then save.');
  assert.deepEqual(JSON.parse(stale.detail).counts.map((c) => c.id), [first.id, second.id]);
});

test('the app asks about a count started in the window, not rejected, that covers the item: a monthly one even with no lines yet (story 77; Q26, Q145)', async () => {
  const { db, ann, bob, hanger, start, counted, reject } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  const ids = async (attempt, label) => JSON.parse((await refused(attempt, 'IV409', label)).detail).counts.map((c) => c.id);

  // A spot check covers only the items it has a line for (Q103).
  const spot = await save(db, ann, await start('spot check'), [{ item_id: other.id, loose: 5 }]);
  assert.equal((await scrap(db, ann, hanger, 1)).timed, undefined, 'LUS28 is not on the spot check');
  assert.deepEqual(await ids(scrap(db, ann, other, 1), 'HUS26 is on it'), [spot.id]);

  const rejected = await counted([{ item_id: hanger.id, loose: 3 }]);
  await reject(bob, rejected);
  assert.equal((await scrap(db, ann, hanger, 1)).timed, undefined, 'a rejected count is not asked about');
  assert.deepEqual(await ids(scrap(db, ann, hanger, 1, { before: rejected.id }), 'an answer when nothing is asked'), [],
    'an answer about a count no longer asked about is stale');

  const old = await start('monthly');
  await as(db, null, (owner) => owner.query("UPDATE inv.counts SET counted_at = counted_at - interval '5 days' WHERE id = $1", [old.id]));
  assert.equal((await scrap(db, ann, hanger, 1)).timed, undefined, 'a count started before the window is not asked about');

  const monthly = await start('monthly');
  assert.deepEqual(await ids(scrap(db, ann, hanger, 1), 'a monthly draft with no lines'), [monthly.id]);
  assert.deepEqual(await ids(scrap(db, ann, hanger, 1, { before: spot.id }), 'a count that does not cover the item'), [monthly.id]);
  const before = (await logRows(db)).length;
  for (const [label, timing] of [['a word', { before: 'first' }], ['both', { before: monthly.id, after: monthly.id }],
    ['a number', 5], ['nothing in it', {}], ['a list', [monthly.id]]]) {
    const err = await refused(scrap(db, ann, hanger, 1, timing), 'IV400', label);
    assert.equal(err.message, 'Answer before or after with a count from the list.', label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('a reversal, and an entry entered again, take the time of the entry they replace and are never asked (story 79; Q144)', async () => {
  const { db, ann, bob, hanger, receive, start, approve } = await withTwo();
  await receive(hanger, 40);
  const once = await scrap(db, ann, hanger, 2);
  const twice = await scrap(db, ann, hanger, 1);
  const count = await submit(db, ann, await start('monthly'),
    [{ item_id: hanger.id, loose: 36 }]);

  const err = await refused(scrap(db, ann, hanger, 4, { after: count.id }, once.id), 'IV400', 'a re-entry with an answer');
  assert.equal(err.message, 'An entry entered again keeps the time of the one it replaces.');
  assert.equal((await scrap(db, ann, hanger, 4, null, once.id)).timed, undefined, 'four were scrapped, not two');
  await call(db, 'reverse', ann.id, crypto.randomUUID(), twice.id, 'entered twice');
  const approved = await approve(bob, count);
  assert.deepEqual(approved.lines.map((l) => [l.quantity, l.expected]), [[36, 36]], '40 less the 4 scrapped, the reversed 1 not');
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 36 }, 'both changes are before the count, which holds them');
});

test('a receipt of several items asks once, about every count of any of them, and its answer times every line (stories 77, 78)', async () => {
  const { db, ann, bob, hanger, receive, receiveLines, counted, approve } = await withTwo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await receive(other, 40);
  // The delivery was on the rack before the spot check of HUS26, entered after it.
  const spot = await counted([{ item_id: other.id, loose: 50 }]);
  const lines = [{ item_id: hanger.id, quantity: 5 }, { item_id: other.id, quantity: 10 }];

  const asked = await refused(receiveLines(lines), 'IV409', 'a receipt with an item on a count');
  assert.deepEqual(JSON.parse(asked.detail).counts.map((c) => c.id), [spot.id]);
  const receipt = await receiveLines(lines, null, { before: spot.id });
  assert.deepEqual(receipt.timed, { before: true, counted_at: spot.counted_at });
  const approved = await approve(bob, spot);
  assert.deepEqual(approved.lines.map((l) => [l.item, l.quantity, l.expected, l.matched]), [['HUS26', 50, 50, true]]);
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 5, [other.id]: 50 });
});

test('a trim asks about the counts of either length; its answer times both of its rows (story 78)', async () => {
  const { db, ann, bob, hanger, receive, approve } = await withTwo();
  const lvl = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft });
  const long = await lvl(16);
  const short = await lvl(12);
  await goLive(db, 'lvl');
  await receive(long, 5);
  const spot = async (item, loose) => submit(db, ann,
    await call(db, 'start_count', ann.id, crypto.randomUUID(), 'lvl', 'spot check', null), [{ item_id: item.id, loose }]);
  // 16′ counted before the trim (5), 12′ after it (2).
  const ofLong = await spot(long, 5);
  const ofShort = await spot(short, 2);
  const trim = (timing) => call(db, 'trim', ann.id, crypto.randomUUID(), long.id, 12, 2, null, false, null, answer(timing));

  const asked = await refused(trim(null), 'IV409', 'a trim between two counts');
  assert.deepEqual(JSON.parse(asked.detail).counts.map((c) => c.id), [ofLong.id, ofShort.id]);
  assert.deepEqual((await trim({ before: ofShort.id })).timed, { before: true, counted_at: ofShort.counted_at });
  for (const count of [ofLong, ofShort]) {
    assert.equal((await approve(bob, count)).lines[0].matched, true, `count ${count.id}`);
  }
  assert.deepEqual(await figure(db, 'on_hand'), { [hanger.id]: 0, [long.id]: 3, [short.id]: 2 });
});

test('a draft is discarded by the person who started it or an admin; it stays on the record, changes nothing and stops the question (Q149)', async () => {
  const { db, ann, bob, hanger, start, counted } = await withTwo();
  const cy = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'cy@example.com', 'Cy Fox', 'a stand-in for a password hash');
  const discard = (who, count) => call(db, 'discard_count', who.id, crypto.randomUUID(), count.id, count.version);
  const draft = await save(db, bob, await start('monthly', bob), [{ item_id: hanger.id, loose: 3 }]);
  await refused(scrap(db, ann, hanger, 1), 'IV409', 'a draft in the window is asked about');

  const before = (await logRows(db)).length;
  const notYours = await refused(discard(cy, draft), 'IV403', 'Cy did not start it and is not an admin');
  assert.equal(notYours.message, 'Only the person who started this count, or an admin, can discard it.');
  await refused(discard(bob, { ...draft, version: 1 }), 'IV409', 'a stale screen');
  const waiting = await counted([{ item_id: hanger.id, loose: 3 }], bob);
  const submitted = await refused(discard(bob, waiting), 'IV422', 'a waiting count');
  assert.equal(submitted.message, 'Only a draft is discarded. A count waiting for approval is rejected instead.');
  assert.equal((await logRows(db)).length, before + 2, 'no refusal leaves a log row; the count of 3 left two');

  const discarded = await discard(bob, draft);
  assert.deepEqual(discarded, { ...draft, version: draft.version + 1, status: 'discarded' });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, Number(last.actor_id), last.old_value, last.new_value], ['discard count', bob.id, draft, discarded]);
  assert.equal((await discard(ann, await start('monthly', bob))).status, 'discarded', 'an admin discards anyone\'s draft');
  await as(db, null, async (owner) => refused(owner.query("UPDATE inv.counts SET status = 'draft' WHERE id = $1", [draft.id]),
    'IV422', 'a discarded count stays as it is'));
  await call(db, 'reject_count', ann.id, crypto.randomUUID(), waiting.id, waiting.version);
  assert.equal((await scrap(db, ann, hanger, 1)).timed, undefined, 'a discarded draft is not asked about');
});
