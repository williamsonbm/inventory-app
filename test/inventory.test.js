// =============================================================
// inventory.test.js — the catalog and its Settings, over HTTP (#81 part 1, seam 3).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Boots the whole app against a fresh database, signs in as the first admin,
// and uses the app's own routes. What the database refuses on its own is in
// catalog.test.js; that every route refuses a signed-out request is in
// sign-in.test.js's sweep.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { get, post, signInAndChoose, withAdmin } = require('./support/app.js');
const { connect, goLive, urlFor } = require('./support/database.js');

// Posts one change as the signed-in admin and returns the status and parsed answer.
async function change(ctx, route, body) {
  const res = await post(ctx.base, route, { key: crypto.randomUUID(), ...body }, ctx.cookie);
  return { status: res.status, body: await res.json() };
}

// The sizes lumber comes in (owner, 2026-10-02), frozen here.
const LUMBER_SIZES = ['2x4', '2x6', '2x8', '2x10', '2x12'];

async function read(ctx, route) {
  const res = await get(ctx.base, route, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

test('the Overview lists the catalog, and its cells add, edit and retire items', async () => {
  const ctx = await withAdmin();
  const added = await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } });
  assert.equal(added.status, 200, added.body.error);
  const item = added.body.item;
  assert.equal(item.stocking, 'Special Order');

  const edited = await change(ctx, '/api/items/edit', { id: item.id, version: 1, changes: { stocking: 'Stocked', threshold: 40 } });
  assert.deepEqual(edited.body.item, { ...item, stocking: 'Stocked', threshold: 40, version: 2 });
  const retired = await change(ctx, '/api/items/retire', { id: item.id, version: 2 });
  assert.equal(retired.body.item.active, false);
  const back = await change(ctx, '/api/items/unretire', { id: item.id, version: 3 });
  assert.equal(back.body.item.active, true);

  const { families, items } = await read(ctx, '/api/items');
  assert.deepEqual(items, [{ ...back.body.item, incoming: 0 }], 'a list row also carries the item\'s figures');
  // EWP stays out of Inventory until step 5, so the family bar leaves it out.
  // The Planner's order, so the two family bars match (owner, 2026-10-02).
  // pack_kinds: what Settings → Pack sizes offers for each family's items.
  // choices: "+ Add item" and Rename offer only these sizes for lumber.
  // Every family starts not live (#81, "Live in Inventory").
  const common = { live: false, order_unit: 'pieces', choices: null };
  assert.deepEqual(families, [
    { code: 'lumber', name: 'Lumber', identity: ['size', 'grade', 'length_ft'], pack_kinds: ['pack'], ...common, order_unit: 'linear feet', choices: { size: LUMBER_SIZES } },
    { code: 'plates', name: 'Plates', identity: ['sku'], pack_kinds: ['pack', 'box', 'pallet'], ...common },
    { code: 'hangers', name: 'Hangers', identity: ['sku'], pack_kinds: ['carton'], ...common },
    { code: 'lvl', name: 'LVL', identity: ['product', 'size', 'length_ft'], pack_kinds: ['pack'], ...common },
  ]);
  const odd = await change(ctx, '/api/items/add', { family: 'lumber', identity: { size: '2x5', grade: '#2', length_ft: 8 } });
  assert.equal(odd.status, 400);
  assert.equal(odd.body.error, 'Lumber comes in 2x4, 2x6, 2x8, 2x10 and 2x12.');

  // S41: a second screen still holding version 1 sees the other save.
  const stale = await change(ctx, '/api/items/edit', { id: item.id, version: 1, changes: { note: 'x' } });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, back.body.item);
  const blank = await change(ctx, '/api/items/add', { family: 'plates', identity: { sku: ' ' } });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /Plates items are named by: sku/);
});

test('Settings lists and changes pack sizes, suppliers, reasons and LVL depth thresholds', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  await change(ctx, '/api/items/add', { family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 48 } });

  const carton = (await change(ctx, '/api/pack-sizes/add', { item_id: hanger.id, kind: 'carton', pieces: 50 })).body.pack_size;
  const fixed = (await change(ctx, '/api/pack-sizes/change', { id: carton.id, version: 1, pieces: 25 })).body.pack_size;
  assert.equal(fixed.pieces, 25);
  assert.deepEqual((await read(ctx, '/api/pack-sizes')).pack_sizes, [fixed]);

  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Boise Cascade' })).body.supplier;
  const renamed = (await change(ctx, '/api/suppliers/rename', { id: supplier.id, version: 1, name: 'Boise Cascade BMD' })).body.supplier;
  assert.deepEqual((await read(ctx, '/api/suppliers')).suppliers, [renamed]);

  const reason = (await change(ctx, '/api/reasons/add', { text: 'Miscounted' })).body.reason;
  const retired = (await change(ctx, '/api/reasons/retire', { id: reason.id, version: 1 })).body.reason;
  const back = (await change(ctx, '/api/reasons/unretire', { id: reason.id, version: 2 })).body.reason;
  assert.equal(retired.active, false);
  const { reasons } = await read(ctx, '/api/reasons');
  assert.equal(reasons.length, 6, 'the five built in, and Miscounted');
  assert.deepEqual(reasons.find((r) => r.id === reason.id), back);

  const depth = (await change(ctx, '/api/lvl-depth-thresholds/set', { depth: '14', version: null, threshold_lf: 720 })).body.threshold;
  assert.deepEqual(depth, { depth: '14', threshold_lf: 720, version: 1 });
  // Every depth an LVL item has is listed, with or without a threshold yet.
  assert.deepEqual((await read(ctx, '/api/lvl-depth-thresholds')).thresholds, [depth]);

  const zero = await change(ctx, '/api/pack-sizes/add', { item_id: hanger.id, kind: 'box', pieces: 0 });
  assert.equal(zero.status, 400);
  // A mistyped huge number gets a plain message, not "The request was refused."
  const huge = await change(ctx, '/api/pack-sizes/add', { item_id: hanger.id, kind: 'box', pieces: 3e9 });
  assert.deepEqual([huge.status, huge.body.error], [400, 'That number is too large. Check what you typed.']);
});

// A made-up material sheet: ten 2x4 #2 at 8′ and three 2x6 #2 at 12′.
const LUMBER_SHEET = `Material Summary,Sample Truss Co,,,
Quote Date:,4/16/2026,Job Number:,50001R,
Order Date:,5/20/2026,Product:,Roof,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 50 Sample A,Delivery Area,,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
,,,False,,,,,,,
2x4sp2,10,8-00-00,2x4 SP No.2,Regular,,80.00,53.30,,,
2x4sp2,10,,,,,80.00,,,,
,,,False,,,,,,,
2x6sp2,3,12-00-00,2x6 SP No.2,Regular,,36.00,,,,
2x6sp2,3,,,,,36.00,,,,
`;

test('the Planner plans lumber with the shared buying options, never a copy the page sends', async () => {
  const ctx = await withAdmin();
  const before = await read(ctx, '/api/lumber/menu');
  assert.deepEqual(before.menu['2x4|#2'], [6, 7, 8, 10, 12, 14, 16, 20], "the engine's default, from the database");

  const lengths = await change(ctx, '/api/lumber/lengths',
    { size: '2x4', grade: '#2', version: before.versions.lengths['2x4|#2'], lengths: [16] });
  assert.equal(lengths.status, 200, lengths.body.error);
  const redirect = await change(ctx, '/api/lumber/redirect', { size: '2x6', from_grade: '#2', version: null, to_grade: 'DSS' });
  assert.equal(redirect.status, 200, redirect.body.error);
  const after = await read(ctx, '/api/lumber/menu');
  assert.deepEqual([after.menu['2x4|#2'], after.redirects], [[16], { '2x6|#2': 'DSS' }]);

  // An old page still sends the menu it kept on its own computer.
  const res = await post(ctx.base, '/api/lumber/plan', {
    files: [{ name: 'a.csv', text: LUMBER_SHEET }], menu: { '2x4|#2': [8] }, redirects: {},
  }, ctx.cookie);
  const plan = await res.json();
  assert.equal(res.status, 200, plan.error);
  const row = (key) => plan.bySizeGrade.find((r) => r.key === key);
  assert.deepEqual([...new Set(row('2x4|#2').draws.map((d) => d.stockLengthFt))], [16], 'cut from the shared 16′ only');
  assert.deepEqual(row('2x6|#2').redirect, { toLabel: '2x6 DSS', lf: 36 }, 'the shared redirect applies');
});

test('the Planner adds a lumber size and grade with no lengths, and its lengths are then switched on', async () => {
  const ctx = await withAdmin();
  const added = await change(ctx, '/api/lumber/lengths', { size: '2x4', grade: 'SS', version: null, lengths: [] });
  assert.equal(added.status, 200, added.body.error);
  let options = await read(ctx, '/api/lumber/menu');
  assert.deepEqual(options.lumberSizes, LUMBER_SIZES, 'the sizes the add form offers');
  assert.equal(options.versions.lengths['2x4|SS'], 1, 'listed, so the page shows its row');
  assert.equal(options.menu['2x4|SS'], undefined, 'not bought until a length is switched on');

  const on = await change(ctx, '/api/lumber/lengths', { size: '2x4', grade: 'SS', version: 1, lengths: [16] });
  assert.equal(on.status, 200, on.body.error);
  options = await read(ctx, '/api/lumber/menu');
  assert.deepEqual(options.menu['2x4|SS'], [16]);

  // Removed, it leaves the panel; its row stays in the database, marked removed.
  await change(ctx, '/api/lumber/lengths', { size: '2x4', grade: 'SS', version: 2, lengths: [] });
  const removed = await change(ctx, '/api/lumber/remove', { size: '2x4', grade: 'SS', version: 3 });
  assert.equal(removed.status, 200, removed.body.error);
  options = await read(ctx, '/api/lumber/menu');
  assert.equal(options.versions.lengths['2x4|SS'], undefined, 'no row in the panel');
});

test('a lumber plan with every length switched off is refused, never planned with the default lengths', async () => {
  const ctx = await withAdmin();
  const { menu, versions } = await read(ctx, '/api/lumber/menu');
  for (const key of Object.keys(menu)) {
    const [size, grade] = key.split('|');
    const off = await change(ctx, '/api/lumber/lengths', { size, grade, version: versions.lengths[key], lengths: [] });
    assert.equal(off.status, 200, off.body.error);
  }
  const res = await post(ctx.base, '/api/lumber/plan', { files: [{ name: 'a.csv', text: LUMBER_SHEET }] }, ctx.cookie);
  const plan = await res.json();
  assert.equal(res.status, 400, JSON.stringify(plan).slice(0, 200));
  assert.match(plan.error, /No lumber lengths are switched on/);
});

test('a first save that loses a race to another first save is answered 409, not a crash', async () => {
  const ctx = await withAdmin();
  const other = await connect(urlFor(ctx.db, 'inv_app'));
  const watcher = await connect(urlFor(ctx.db));
  try {
    await other.query('BEGIN');
    await other.query('SELECT inv.set_lumber_lengths($1, $2, $3, $4, $5, $6)',
      [ctx.ann.id, crypto.randomUUID(), '2x4', 'SS', null, [8]]);
    const pending = post(ctx.base, '/api/lumber/lengths',
      { key: crypto.randomUUID(), size: '2x4', grade: 'SS', version: null, lengths: [10] }, ctx.cookie);
    // Let the other save commit only once the app's save waits on its lock.
    for (let tries = 0; ; tries += 1) {
      const { rowCount } = await watcher.query(`SELECT 1 FROM pg_catalog.pg_stat_activity
        WHERE datname = pg_catalog.current_database() AND wait_event_type = 'Lock'`);
      if (rowCount) break;
      assert.ok(tries < 250, "the app's save never waited for the other save");
      await new Promise((r) => setTimeout(r, 20));
    }
    await other.query('COMMIT');
    const res = await pending;
    const text = await res.text();
    assert.equal(res.status, 409, text);
    assert.match(JSON.parse(text).error, /Someone else changed 2x4 SS/);
  } finally {
    await other.end();
    await watcher.end();
  }
});

test('the Activity Log names the item, pack size, supplier or reason each change touched', async () => {
  const ctx = await withAdmin();
  const item = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'BOGUS26' } })).body.item;
  await change(ctx, '/api/pack-sizes/add', { item_id: item.id, kind: 'carton', pieces: 50 });
  await change(ctx, '/api/suppliers/add', { name: 'Boise Cascade' });
  await change(ctx, '/api/reasons/add', { text: 'Miscounted' });
  await change(ctx, '/api/items/add', { family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 48 } });
  await change(ctx, '/api/lvl-depth-thresholds/set', { depth: '14', version: null, threshold_lf: 720 });
  await change(ctx, '/api/lumber/lengths', { size: '2x4', grade: '#2', version: 1, lengths: [8] });
  await change(ctx, '/api/lumber/redirect', { size: '2x6', from_grade: '#2', version: null, to_grade: 'DSS' });
  await change(ctx, '/api/items/add', { family: 'lumber', identity: { size: '2x6', grade: 'DSS', length_ft: 16 } });

  // Each row says what the change did, in words; an addition says what was added.
  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 9).map((e) => [e.action, e.target, e.change]), [
    ['add item', '2x6 DSS 16′', 'added: Special Order, no threshold'],
    ['set grade redirect', '2x6 #2', 'added: to DSS'],
    ['set lumber lengths', '2x4 #2', 'lengths: 6,7,8,10,12,14,16,20 → 8'],
    ['set LVL depth threshold', 'LVL 14″', 'added: 720 linear feet'],
    ['add item', '2.1 RigidLam LVL 1-3/4 x 14 48′', 'added: Special Order, no threshold'],
    ['add reason', 'Miscounted', 'added'],
    ['add supplier', 'Boise Cascade', 'added'],
    ['add pack size', 'BOGUS26 carton', 'added: 50 pieces'],
    ['add item', 'BOGUS26', 'added: Special Order, no threshold'],
  ]);
});

test('the Activity Log says what the catalog import and a removal did', async () => {
  const { describeChange } = require('../src/settings/activity.js');
  const report = { added: { items: 378, pack_sizes: 209, lvl_depth_thresholds: 7 },
    skipped: { items: 2, pack_sizes: 0, lvl_depth_thresholds: 0 }, skipped_items: ['LUS28', 'A35'] };
  assert.equal(describeChange('import catalog', 'items', null, report),
    'added: 378 items, 209 pack sizes and 7 LVL depth thresholds; 2 items were there already');
  assert.equal(describeChange('remove lumber group', 'lumber_purchasable_lengths',
    { size: '2x4', grade: '1650', lengths: [], version: 1 }, null), 'removed');
  assert.equal(describeChange('set password', 'users', { name: 'Bob' }, { name: 'Bob' }), '', 'the log keeps no password');
});

test('only an admin can rename an item', async () => {
  const ctx = await withAdmin();
  const item = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS288' } })).body.item;
  await change(ctx, '/api/users/add', { email: 'bob@example.com', name: 'Bob Ray', password: 'bob temporary 1' });
  const bob = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password');

  const res = await post(ctx.base, '/api/items/rename',
    { key: crypto.randomUUID(), id: item.id, version: 1, identity: { sku: 'LUS28' } }, bob);
  assert.equal(res.status, 403);
  const renamed = await change(ctx, '/api/items/rename', { id: item.id, version: 1, identity: { sku: 'LUS28' } });
  assert.equal(renamed.status, 200, renamed.body.error);
  assert.equal(renamed.body.item.sku, 'LUS28');
});

test('Receive enters a PO, lists it, and the Overview shows its lines as Incoming (stories 29–32)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  const lines = [{ item_id: hanger.id, ordered: 100, pack_size: 50 }];
  const po = { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03', lines };

  // Story 57: until the owner switches hangers live, the database refuses the PO.
  const off = await change(ctx, '/api/pos/enter', po);
  assert.equal(off.status, 422);
  assert.equal(off.body.error, 'The Hangers family is not live in Inventory yet, so it takes no POs, receipts or counts.');

  await goLive(ctx.db, 'hangers');
  const entered = await change(ctx, '/api/pos/enter', po);
  assert.equal(entered.status, 200, entered.body.error);
  assert.deepEqual(entered.body.po, {
    id: entered.body.po.id, version: 1, supplier_id: supplier.id, supplier: 'Simpson', number: '4501', po_date: '2026-10-03',
    lines: [{ id: entered.body.po.lines[0].id, ...lines[0], closed_reason: null }],
  });
  assert.deepEqual((await read(ctx, '/api/pos')).pos, [entered.body.po]);

  // live: Receive offers only live families' items; order_unit: how an amount is ordered (Q14).
  const { families, items } = await read(ctx, '/api/items');
  assert.deepEqual(families.map((f) => [f.code, f.live, f.order_unit]), [
    ['lumber', false, 'linear feet'], ['plates', false, 'pieces'], ['hangers', true, 'pieces'], ['lvl', false, 'pieces'],
  ]);
  assert.equal(items.find((i) => i.id === hanger.id).incoming, 100);
});

test('the Activity Log names the PO entered and the family switched live', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  await goLive(ctx.db, 'hangers');
  await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }, { item_id: hanger.id, ordered: 20 }] });

  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.action, e.target, e.change]), [
    ['enter PO', 'PO 4501', 'added: Simpson, dated 2026-10-03, 2 lines'],
    ['switch family live', 'Hangers', 'live: false → true'],
  ]);
});

test('Receive edits a PO and closes and re-opens a line; the Activity Log says what changed', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  const reason = (await change(ctx, '/api/reasons/add', { text: 'Cancelled by supplier' })).body.reason;
  await goLive(ctx.db, 'hangers');
  const po = (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }, { item_id: hanger.id, ordered: 20 }] })).body.po;
  const [first, second] = po.lines;

  const edited = await change(ctx, '/api/pos/edit', { id: po.id, version: 1, supplier_id: supplier.id, number: '4510', po_date: '2026-10-03',
    lines: [{ id: first.id, item_id: hanger.id, ordered: 80 }, { id: second.id, item_id: hanger.id, ordered: 20 }, { item_id: hanger.id, ordered: 5 }] });
  assert.equal(edited.status, 200, edited.body.error);
  const closed = await change(ctx, '/api/pos/close-line', { id: second.id, po_version: 2, reason_id: reason.id });
  assert.equal(closed.body.po.lines[1].closed_reason, 'Cancelled by supplier');
  const stale = await change(ctx, '/api/pos/reopen-line', { id: second.id, po_version: 2 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, closed.body.po, 'a stale screen gets the PO as it is now');
  const reopened = await change(ctx, '/api/pos/reopen-line', { id: second.id, po_version: 3 });
  assert.equal(reopened.status, 200, reopened.body.error);
  assert.equal((await read(ctx, '/api/items')).items[0].incoming, 105);

  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 3).map((e) => [e.action, e.target, e.change]), [
    ['re-open PO line', 'PO 4510', 'line 2 re-opened'],
    ['close PO line', 'PO 4510', 'line 2 closed: Cancelled by supplier'],
    ['edit PO', 'PO 4510', 'number: 4501 → 4510; line 1 ordered: 100 → 80; line 3 added'],
  ]);
});
