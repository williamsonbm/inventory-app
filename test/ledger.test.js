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
