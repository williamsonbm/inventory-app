// =============================================================
// reorder.test.js — the Reorder figure (#81 part 2, stories 52–53; seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds a fresh database with the migration runner, changes on
// hand through the database's own functions as the app's login, then reads
// Reorder through the one calculation (inv.item_figures), as #81's Testing
// Decisions ask: "Q15, Q35: Reorder at the threshold is Low; LVL Short per
// length". In step 3 committed is zero, so available equals on hand.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, APP, firstUser, call, goLive, figure, reasonId } = require('./support/database.js');

const reorder = (db) => figure(db, 'reorder');

// Ann, a supplier, and the families named switched on.
async function setUp(...families) {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Simpson');
  const ctx = { db, ann, supplier };
  ctx.add = (family, identity) => call(db, 'add_item', ann.id, crypto.randomUUID(), family, identity);
  ctx.goLive = () => Promise.all(families.map((f) => goLive(db, f)));
  ctx.receive = (item, quantity) => call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: item.id, quantity }]));
  ctx.scrap = async (item, quantity) =>
    call(db, 'correct', ann.id, crypto.randomUUID(), item.id, -quantity, await reasonId(db, 'Damaged – scrapped'), null);
  ctx.threshold = (item, threshold) => call(db, 'edit_item', ann.id, crypto.randomUUID(), item.id, item.version, { threshold });
  return ctx;
}

test('Reorder is Low at or below the threshold, Short below zero, otherwise OK (story 52, Q15)', async () => {
  const ctx = await setUp('hangers');
  const atThreshold = await ctx.threshold(await ctx.add('hangers', { sku: 'LUS28' }), 40);
  const below = await ctx.threshold(await ctx.add('hangers', { sku: 'LUS26' }), 40);
  const above = await ctx.threshold(await ctx.add('hangers', { sku: 'HUS410' }), 40);
  const zeroThreshold = await ctx.threshold(await ctx.add('hangers', { sku: 'HU210' }), 0);
  const short = await ctx.threshold(await ctx.add('hangers', { sku: 'LUS210' }), 40);
  const notSet = await ctx.add('hangers', { sku: 'H2.5A' });
  const notSetShort = await ctx.add('hangers', { sku: 'A35' });
  await ctx.goLive();
  await ctx.receive(atThreshold, 40);
  await ctx.receive(below, 39);
  await ctx.receive(above, 41);
  await ctx.scrap(short, 6);
  await ctx.scrap(notSetShort, 1);

  assert.deepEqual(await reorder(ctx.db), {
    [atThreshold.id]: 'Low',
    [below.id]: 'Low',
    [above.id]: 'OK',
    [zeroThreshold.id]: 'Low', // 0 means "reorder when none are left"
    [short.id]: 'Short',
    [notSet.id]: 'OK', // a blank threshold is "not set": never Low
    [notSetShort.id]: 'Short',
  });
});

test('LVL: Low compares linear feet per depth; Short is checked per length (story 52, Q35)', async () => {
  const ctx = await setUp('lvl');
  const lvl = (size, length_ft) => ctx.add('lvl', { product: '2.0 LVL 1-3/4', size, length_ft });
  const set = (depth, lf) => call(ctx.db, 'set_lvl_depth_threshold', ctx.ann.id, crypto.randomUUID(), depth, null, lf);
  // 11-7/8: 60 × 16′ = 960 LF, at its 960 LF threshold, so both lengths are Low.
  const low16 = await lvl('11-7/8', 16);
  const low12 = await lvl('11-7/8', 12);
  // 14: 50 × 16′ − 6 × 12′ = 728 LF, above 720, but the 12′ is short.
  const ok16 = await lvl('14', 16);
  const short12 = await lvl('14', 12);
  // 24: no threshold (bought to order), nothing on hand.
  const notSet = await lvl('24', 20);
  await set('11-7/8', 960);
  await set('14', 720);
  await ctx.goLive();
  await ctx.receive(low16, 60);
  await ctx.receive(ok16, 50);
  await ctx.scrap(short12, 6);

  assert.deepEqual(await reorder(ctx.db), {
    [low16.id]: 'Low', [low12.id]: 'Low', [ok16.id]: 'OK', [short12.id]: 'Short', [notSet.id]: 'OK',
  });
  const depths = await as(ctx.db, APP, async (app) => (await app.query(
    'SELECT depth, available_lf, threshold_lf, reorder FROM inv.lvl_depth_figures ORDER BY depth')).rows);
  assert.deepEqual(depths, [
    { depth: '11-7/8', available_lf: 960, threshold_lf: 960, reorder: 'Low' },
    { depth: '14', available_lf: 728, threshold_lf: 720, reorder: 'Short' }, // any short length makes its depth Short
    { depth: '24', available_lf: 0, threshold_lf: null, reorder: 'OK' },
  ]);
});
