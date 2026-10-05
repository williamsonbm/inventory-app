// =============================================================
// ledger.test.js — corrections and on hand (#81 part 2; seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds a fresh database with the migration runner and calls the
// database's functions as the app's login, then reads the figures through
// the one calculation (inv.item_figures), as #81's Testing Decisions ask.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, APP, firstUser, call, goLive, logRows, refused } = require('./support/database.js');

async function onHand(db) {
  return as(db, APP, async (app) => Object.fromEntries((await app.query(
    'SELECT item_id::int, on_hand FROM inv.item_figures')).rows.map((r) => [r.item_id, r.on_hand])));
}

async function reasonId(db, text) {
  return as(db, APP, async (app) => Number((await app.query('SELECT id FROM inv.reasons WHERE text = $1', [text])).rows[0].id));
}

// A database with Ann and a hanger that has had 40 received, with hangers live.
async function withHanger() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Simpson');
  const hanger = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  await goLive(db, 'hangers');
  await call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: hanger.id, quantity: 40 }]));
  return { db, ann, supplier, hanger };
}

// Corrects `item` by `quantity` as Ann.
function correct(ctx, item, quantity, reason, note = null, key = crypto.randomUUID()) {
  return call(ctx.db, 'correct', ctx.ann.id, key, item.id, quantity, reason, note);
}

test('a correction changes on hand by the amount typed, with its reason, logged once (story 44)', async () => {
  const ctx = await withHanger();
  const { db, hanger } = ctx;
  assert.equal((await onHand(db))[hanger.id], 40, 'a receipt adds to on hand');
  const scrapped = await reasonId(db, 'Damaged – scrapped');
  const correction = await correct(ctx, hanger, -3, scrapped, ' bent in the yard ');
  assert.deepEqual(correction, {
    id: correction.id, item_id: hanger.id, item: 'LUS28', quantity: -3, reason: 'Damaged – scrapped', note: 'bent in the yard',
  });
  assert.equal((await onHand(db))[hanger.id], 37);

  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'correct');
  assert.equal(log.target_table, 'ledger');
  assert.equal(Number(log.target_id), correction.id);
  assert.deepEqual(log.new_value, correction);
});

test('impossible corrections are refused with a plain message, and none leaves a row (stories 44–46, 57)', async () => {
  const ctx = await withHanger();
  const { db, ann, hanger } = ctx;
  const plate = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 3x4' });
  const lumber = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lumber', { size: '2x4', grade: '#2', length_ft: 16 });
  await goLive(db, 'lumber');
  const [scrapped, returned, trimmed, opening] = await Promise.all(['Damaged – scrapped', 'Returned from job site',
    'Weathered – trimmed', 'Opening balance (web app)'].map((text) => reasonId(db, text)));
  const other = await call(db, 'add_reason', ann.id, crypto.randomUUID(), 'Miscounted');
  const old = await call(db, 'add_reason', ann.id, crypto.randomUUID(), 'Old reason');
  await call(db, 'retire_reason', ann.id, crypto.randomUUID(), old.id, old.version);

  const before = (await logRows(db)).length;
  const cases = [
    ['no change', [hanger, 0, other.id], 'IV400', /^Type the change in pieces: a whole number other than 0/],
    ['a part of a piece', [hanger, 2.5, other.id], 'IV400', /^Type the change in pieces: a whole number other than 0/],
    ['no reason (story 44)', [hanger, 2, null], 'IV400', /^A correction needs a reason from the list\.$/],
    ['a retired reason', [hanger, 2, old.id], 'IV400', /^"Old reason" is retired\. Pick a reason in use\.$/],
    ['the trim reason', [hanger, -1, trimmed], 'IV422', /^"Weathered – trimmed" is for a trim/],
    ['the opening balance reason', [hanger, 5, opening], 'IV422', /^"Opening balance \(web app\)" is for the cutover import/],
    ['a scrap that adds (story 45)', [hanger, 2, scrapped], 'IV400', /^"Damaged – scrapped" takes pieces away: type a number below 0\.$/],
    ['a return that takes away (story 46)', [hanger, -2, returned, 'Job 1234'], 'IV400',
      /^"Returned from job site" adds pieces: type a number above 0\.$/],
    ['a return with no job number (story 46)', [hanger, 2, returned, '  '], 'IV400', /^Type the job number in the note/],
    ['a return of lumber', [lumber, 2, returned, 'Job 1234'], 'IV422', /^Lumber does not come back from a job site/],
    ['a family not live (story 57)', [plate, 2, other.id], 'IV422', /^The Plates family is not live in Inventory yet/],
    ['an item not in the catalog', [{ id: 999999 }, 2, other.id], 'IV400', /^Pick the item from the catalog\.$/],
    ['a long note', [hanger, 2, other.id, 'x'.repeat(201)], 'IV400', /^A note has at most 200 characters\.$/],
  ];
  for (const [label, [item, quantity, reason, note], code, message] of cases) {
    const err = await refused(correct(ctx, item, quantity, reason, note), code, label);
    assert.match(err.message, message, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
  assert.deepEqual(await onHand(db), { [hanger.id]: 40, [plate.id]: 0, [lumber.id]: 0 }, 'no refusal changes on hand');
});

test('a return from a job site adds to on hand with its job number, and a retry acts once (stories 46, 104)', async () => {
  const ctx = await withHanger();
  const { db, hanger } = ctx;
  const returned = await reasonId(db, 'Returned from job site');
  const key = crypto.randomUUID();
  const first = await correct(ctx, hanger, 6, returned, 'Job 1234', key);
  assert.deepEqual([first.quantity, first.reason, first.note], [6, 'Returned from job site', 'Job 1234']);
  const before = (await logRows(db)).length;
  assert.deepEqual(await correct(ctx, hanger, 6, returned, 'Job 1234', key), first, 'a retry answers with the first save');
  assert.equal((await logRows(db)).length, before, 'a retry writes no second log row');
  assert.equal((await onHand(db))[hanger.id], 46, 'a retry adds nothing twice');
});

test('a reason kept for another entry closes no PO line either (Q31)', async () => {
  const ctx = await withHanger();
  const { db, ann, supplier, hanger } = ctx;
  const po = await call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, '4501', '2026-10-03',
    JSON.stringify([{ item_id: hanger.id, ordered: 10 }]));
  const trimmed = await reasonId(db, 'Weathered – trimmed');
  const err = await refused(call(db, 'close_po_line', ann.id, crypto.randomUUID(), po.lines[0].id, po.version, trimmed),
    'IV422', 'the trim reason on a PO line');
  assert.match(err.message, /^"Weathered – trimmed" is for a trim/);
  const remake = await reasonId(db, 'Remake');
  assert.equal((await correct(ctx, hanger, -2, remake)).reason, 'Remake', 'Remake is offered as a correction (Q30)');
});

// A database with Ann and two LVL lengths of one product and depth, 16′ and
// 12′, with 5 of the 16′ received and LVL live.
async function withLvl() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Boise');
  const lvl = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl',
    { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft });
  const long = await lvl(16);
  const short = await lvl(12);
  await goLive(db, 'lvl');
  await call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: long.id, quantity: 5 }]));
  return { db, ann, long, short };
}

// Trims `boards` of `item` to `length_ft` as Ann; `unretire` says the
// screen told her a retired length comes back into use.
function trim(ctx, item, length_ft, boards, note = null, key = crypto.randomUUID(), unretire = false) {
  return call(ctx.db, 'trim', ctx.ann.id, key, item.id, length_ft, boards, note, unretire);
}

test('a trim takes boards off the long item and puts them on the short one, as one logged entry (story 47, Q37)', async () => {
  const ctx = await withLvl();
  const { db, long, short } = ctx;
  const trimmed = await trim(ctx, long, 12, 3, ' weathered ends ');
  assert.deepEqual(trimmed, {
    id: trimmed.id, item: '2.0 LVL 1-3/4 x 11-7/8 16′', to_item: '2.0 LVL 1-3/4 x 11-7/8 12′', length_ft: 12, boards: 3,
    note: 'weathered ends', item_added: false, item_unretired: false,
  });
  assert.deepEqual(await onHand(db), { [long.id]: 2, [short.id]: 3 });

  const log = (await logRows(db)).at(-1);
  assert.deepEqual([log.action, log.target_table, Number(log.target_id)], ['trim', 'ledger', trimmed.id]);
  assert.deepEqual(log.new_value, trimmed);
});

test('a trim to a length the catalog lacks adds that item as Non-Stock, and a retry adds nothing twice (stories 48, 104)', async () => {
  const ctx = await withLvl();
  const { db, long } = ctx;
  const key = crypto.randomUUID();
  const trimmed = await trim(ctx, long, 10, 1, null, key);
  assert.deepEqual([trimmed.to_item, trimmed.item_added], ['2.0 LVL 1-3/4 x 11-7/8 10′', true]);
  const added = await as(db, APP, async (app) => (await app.query(
    'SELECT id::int, stocking, active FROM inv.items WHERE family = $1 AND length_ft = 10', ['lvl'])).rows);
  assert.deepEqual(added, [{ id: added[0].id, stocking: 'Non-Stock', active: true }]);

  assert.deepEqual(await trim(ctx, long, 10, 1, null, key), trimmed, 'a retry answers with the first save');
  assert.equal((await onHand(db))[added[0].id], 1, 'a retry adds nothing twice');
  assert.equal((await onHand(db))[long.id], 4);
});

test('impossible trims are refused with a plain message, and none leaves a row or an item (stories 47–48)', async () => {
  const ctx = await withLvl();
  const { db, ann, long, short } = ctx;
  const hanger = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  await goLive(db, 'hangers');
  const retired = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl',
    { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft: 8 });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), retired.id, retired.version);

  const before = { log: (await logRows(db)).length, onHand: await onHand(db) };
  const cases = [
    ['not LVL', [hanger, 2, 1], 'IV422', /^Hangers items are not trimmed\. A trim is for a weathered LVL board\.$/],
    ['an item not in the catalog', [{ id: 999999 }, 12, 1], 'IV400', /^Pick the item from the catalog\.$/],
    ['the same length', [long, 16, 1], 'IV400', /^Pick a length shorter than 16′\.$/],
    ['a longer length', [short, 16, 1], 'IV400', /^Pick a length shorter than 12′\.$/],
    ['no length', [long, null, 1], 'IV400', /^Pick a length shorter than 16′\.$/],
    ['a part of a foot', [long, 10.5, 1], 'IV400', /^Pick a length shorter than 16′\.$/],
    ['no boards', [long, 12, 0], 'IV400', /^Type how many boards: a whole number above 0, such as 1 or 3\.$/],
    ['a part of a board', [long, 12, 1.5], 'IV400', /^Type how many boards/],
    ['boards below 0', [long, 12, -1], 'IV400', /^Type how many boards/],
    ['too many boards to store', [long, 12, 1e12], 'IV400', /^Type how many boards/],
    ['a retired short length, not confirmed (Q39)', [long, 8, 1], 'IV422',
      /^2\.0 LVL 1-3\/4 x 11-7\/8 8′ is retired\. Pick the length again: the trim puts it back in use\.$/],
    ['a long note', [long, 12, 1, 'x'.repeat(201)], 'IV400', /^A note has at most 200 characters\.$/],
    ['a long note to a new length', [long, 10, 1, 'x'.repeat(201)], 'IV400', /^A note has at most 200 characters\.$/],
  ];
  for (const [label, [item, length, boards, note], code, message] of cases) {
    const err = await refused(trim(ctx, item, length, boards, note), code, label);
    assert.match(err.message, message, label);
  }
  assert.equal((await logRows(db)).length, before.log, 'no refusal leaves a log row');
  assert.deepEqual(await onHand(db), before.onHand, 'no refusal changes on hand or adds an item');
});

test('a trim to a retired length puts it back in use when the screen said so (Q39)', async () => {
  const ctx = await withLvl();
  const { db, ann, long, short } = ctx;
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), short.id, short.version);
  const trimmed = await trim(ctx, long, 12, 2, null, crypto.randomUUID(), true);
  assert.equal(trimmed.item_unretired, true);
  const back = await as(db, APP, async (app) => (await app.query('SELECT active FROM inv.items WHERE id = $1', [short.id])).rows[0]);
  assert.deepEqual(back, { active: true });
  assert.deepEqual(await onHand(db), { [long.id]: 3, [short.id]: 2 });
  assert.equal((await trim(ctx, long, 12, 1, null, crypto.randomUUID(), true)).item_unretired, false,
    'a length in use is only trimmed to');
});
