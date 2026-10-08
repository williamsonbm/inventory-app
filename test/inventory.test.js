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
const { connect, goLive, reasonId, urlFor } = require('./support/database.js');

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
  assert.deepEqual(items, [{ ...back.body.item, incoming: 0, on_hand: 0, reorder: 'Low' }],
    'a list row also carries the item\'s figures: none on hand is at or below its threshold of 40');
  // EWP stays out of Inventory until step 5, so the family bar leaves it out.
  // The Planner's order, so the two family bars match (owner, 2026-10-02).
  // pack_kinds: what Settings → Pack sizes offers for each family's items.
  // choices: "+ Add item" and Rename offer only these sizes for lumber.
  // Every family starts not live (#81, "Live in Inventory").
  const common = { live: false, order_unit: 'pieces', choices: null, trimmable: false };
  assert.deepEqual(families, [
    { code: 'lumber', name: 'Lumber', identity: ['size', 'grade', 'length_ft'], pack_kinds: ['pack'], ...common, order_unit: 'linear feet', choices: { size: LUMBER_SIZES } },
    { code: 'plates', name: 'Plates', identity: ['sku'], pack_kinds: ['pack', 'box', 'pallet'], ...common },
    { code: 'hangers', name: 'Hangers', identity: ['sku'], pack_kinds: ['carton'], ...common },
    { code: 'lvl', name: 'LVL', identity: ['product', 'size', 'length_ft'], pack_kinds: ['pack'], ...common, trimmable: true },
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
  assert.equal(reasons.length, 7, 'the six built in, and Miscounted');
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

// Story 56: one family's changes. A row with no family (a person, a supplier,
// a reason) shows only under All (Q66).
test('the Activity Log shows one family\'s changes', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  await change(ctx, '/api/pack-sizes/add', { item_id: hanger.id, kind: 'carton', pieces: 50 });
  const plate = (await change(ctx, '/api/items/add', { family: 'plates', identity: { sku: 'MP24' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'MiTek' })).body.supplier;
  await change(ctx, '/api/items/add', { family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 48 } });
  for (const [route, body] of [['/api/lvl-depth-thresholds/set', { depth: '14', version: null, threshold_lf: 720 }],
    ['/api/lumber/lengths', { size: '2x4', grade: '#2', version: 1, lengths: [8] }],
    ['/api/lumber/redirect', { size: '2x6', from_grade: '#2', version: null, to_grade: 'DSS' }]]) {
    const saved = await change(ctx, route, body);
    assert.equal(saved.status, 200, saved.body.error);
  }
  await goLive(ctx.db, 'plates');
  const po = (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: plate.id, ordered: 100 }] })).body.po;
  for (const [route, body] of [['/api/receipts/receive', { po_id: po.id, po_version: po.version, supplier_id: null,
    lines: [{ po_line_id: po.lines[0].id, item_id: plate.id, quantity: 100 }] }],
  ['/api/items/correct', { item_id: plate.id, quantity: -2, reason_id: await reasonId(ctx.db, 'Damaged – scrapped') }]]) {
    const saved = await change(ctx, route, body);
    assert.equal(saved.status, 200, saved.body.error);
  }

  const targets = async (family) => (await read(ctx, `/api/activity?family=${family}`)).entries.map((e) => [e.action, e.target]);
  assert.deepEqual(await targets('hangers'), [['add pack size', 'LUS28 carton'], ['add item', 'LUS28']]);
  assert.deepEqual(await targets('plates'), [['correct', 'MP24'], ['receive', 'PO 4501'], ['enter PO', 'PO 4501'],
    ['switch family live', 'Plates'], ['add item', 'MP24']]);
  assert.deepEqual(await targets('lvl'), [['set LVL depth threshold', 'LVL 14″'], ['add item', '2.1 RigidLam LVL 1-3/4 x 14 48′']]);
  assert.deepEqual(await targets('lumber'), [['set grade redirect', '2x6 #2'], ['set lumber lengths', '2x4 #2']]);
  // The page's family bar: Inventory's families, in the same order (EWP joins in step 5).
  assert.deepEqual((await read(ctx, '/api/activity')).families.map((f) => [f.code, f.name]),
    [['lumber', 'Lumber'], ['plates', 'Plates'], ['hangers', 'Hangers'], ['lvl', 'LVL']]);
  assert.ok((await targets('')).some(([action]) => action === 'add supplier'), 'blank is All, which shows a row with no family');
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

test('everyone reads the working-day window; only an admin changes it (story 28)', async () => {
  const ctx = await withAdmin();
  await change(ctx, '/api/users/add', { email: 'bob@example.com', name: 'Bob Ray', password: 'bob temporary 1' });
  const bob = await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password');

  const seen = await read({ ...ctx, cookie: bob }, '/api/working-day');
  assert.deepEqual(seen.setting, [{ name: 'working_day_window', value: 1, version: 1 }]);

  const res = await post(ctx.base, '/api/working-day/set', { key: crypto.randomUUID(), version: 1, days: 2 }, bob);
  assert.equal(res.status, 403);
  const saved = await change(ctx, '/api/working-day/set', { version: 1, days: 2 });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.setting.value, 2);
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
  assert.equal(off.body.error, 'The Hangers family is not live in Inventory yet, so it takes no POs, receipts, corrections or counts.');

  await goLive(ctx.db, 'hangers');
  const entered = await change(ctx, '/api/pos/enter', po);
  assert.equal(entered.status, 200, entered.body.error);
  assert.deepEqual(entered.body.po, {
    id: entered.body.po.id, version: 1, supplier_id: supplier.id, supplier: 'Simpson', number: '4501', po_date: '2026-10-03', status: 'ordered',
    lines: [{ id: entered.body.po.lines[0].id, ...lines[0], item: 'LUS28', received: 0, closed_reason: null }],
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
  const other = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'HUS26' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  const reason = (await change(ctx, '/api/reasons/add', { text: 'Cancelled by supplier' })).body.reason;
  await goLive(ctx.db, 'hangers');
  const po = (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }, { item_id: hanger.id, ordered: 20 }] })).body.po;
  const [first, second] = po.lines;

  const edited = await change(ctx, '/api/pos/edit', { id: po.id, version: 1, supplier_id: supplier.id, number: '4510', po_date: '2026-10-03',
    lines: [{ id: first.id, item_id: hanger.id, ordered: 80 }, { id: second.id, item_id: other.id, ordered: 20 }, { item_id: hanger.id, ordered: 5 }] });
  assert.equal(edited.status, 200, edited.body.error);
  const closed = await change(ctx, '/api/pos/close-line', { id: second.id, po_version: 2, reason_id: reason.id });
  assert.equal(closed.body.po.lines[1].closed_reason, 'Cancelled by supplier');
  const stale = await change(ctx, '/api/pos/reopen-line', { id: second.id, po_version: 2 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.current, closed.body.po, 'a stale screen gets the PO as it is now');
  const reopened = await change(ctx, '/api/pos/reopen-line', { id: second.id, po_version: 3 });
  assert.equal(reopened.status, 200, reopened.body.error);
  const { items } = await read(ctx, '/api/items');
  assert.deepEqual([hanger.id, other.id].map((id) => items.find((i) => i.id === id).incoming), [85, 20]);

  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 3).map((e) => [e.action, e.target, e.change]), [
    ['re-open PO line', 'PO 4510', 'line 2 re-opened'],
    ['close PO line', 'PO 4510', 'line 2 closed: Cancelled by supplier'],
    ['edit PO', 'PO 4510', 'number: 4501 → 4510; line 1 ordered: 100 → 80; line 2 item: LUS28 → HUS26; line 3 added'],
  ]);
});

test('Receive takes a delivery against a PO and one without; Incoming and the Activity Log follow', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const other = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'HUS26' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  await goLive(ctx.db, 'hangers');
  const po = (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }] })).body.po;

  const received = await change(ctx, '/api/receipts/receive', { po_id: po.id, po_version: po.version, supplier_id: null, bol: 'B-77',
    lines: [{ po_line_id: po.lines[0].id, item_id: hanger.id, quantity: 120, packs: 2, pack_size: 50, pack_kind: 'carton', loose: 20 },
      { po_line_id: null, item_id: other.id, quantity: 6 }] });
  assert.equal(received.status, 200, received.body.error);
  assert.equal(received.body.receipt.po_number, '4501');
  const stale = await change(ctx, '/api/receipts/receive', { po_id: po.id, po_version: po.version, supplier_id: null,
    lines: [{ po_line_id: po.lines[0].id, item_id: hanger.id, quantity: 1 }] });
  assert.equal(stale.status, 409, 'the same delivery from a second screen is refused');
  assert.equal(stale.body.current.status, 'finished', 'and the screen gets the PO as it is now');
  const walkIn = await change(ctx, '/api/receipts/receive', { po_id: null, po_version: null, supplier_id: supplier.id,
    lines: [{ item_id: other.id, quantity: 4 }] });
  assert.equal(walkIn.status, 200, walkIn.body.error);

  const { pos } = await read(ctx, '/api/pos');
  assert.deepEqual(pos[0].lines.map((l) => l.received), [120]);
  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.action, e.target, e.change]), [
    ['receive', 'Simpson, no PO', 'added: 4 HUS26'],
    ['receive', 'PO 4501', 'added: 120 LUS28 on line 1 (2 cartons of 50 + 20 loose); 6 HUS26 not on the PO; Bill of Lading or tracking number B-77; '
      + 'carton size on file for LUS28: 50'],
  ]);
});

test('Correct on hand changes an item\'s on hand with a reason; the Overview and the Activity Log follow (stories 44–46)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  await goLive(ctx.db, 'hangers');
  const { reasons } = await read(ctx, '/api/reasons');
  const reason = (text) => reasons.find((r) => r.text === text).id;
  assert.deepEqual(reasons.filter((r) => r.entry).map((r) => [r.text, r.entry]).sort(),
    [['Opening balance (web app)', 'import'], ['Weathered – trimmed', 'trim']], 'the page hides reasons kept for another entry (Q31)');

  const returned = await change(ctx, '/api/items/correct',
    { item_id: hanger.id, quantity: 6, reason_id: reason('Returned from job site'), note: 'Job 1234' });
  assert.equal(returned.status, 200, returned.body.error);
  const scrapped = await change(ctx, '/api/items/correct',
    { item_id: hanger.id, quantity: -2, reason_id: reason('Damaged – scrapped'), note: null });
  assert.equal(scrapped.status, 200, scrapped.body.error);
  assert.equal(scrapped.body.correction.quantity, -2);
  const refusedOne = await change(ctx, '/api/items/correct', { item_id: hanger.id, quantity: 3, reason_id: null, note: null });
  assert.deepEqual([refusedOne.status, refusedOne.body.error], [400, 'A correction needs a reason from the list.']);

  const { items } = await read(ctx, '/api/items');
  assert.equal(items.find((i) => i.id === hanger.id).on_hand, 4);
  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.slice(0, 2).map((e) => [e.action, e.target, e.change]), [
    ['correct', 'LUS28', 'added: on hand −2, Damaged – scrapped'],
    ['correct', 'LUS28', 'added: on hand +6, Returned from job site; note: Job 1234'],
  ]);
});

test('the Overview list carries each item\'s Reorder and a line per LVL depth (stories 52–53, Q58)', async () => {
  const ctx = await withAdmin();
  const lvl = { product: '2.0 LVL 1-3/4', size: '11-7/8' };
  const long = (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft: 16 } })).body.item;
  const short = (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft: 12 } })).body.item;
  const set = await change(ctx, '/api/lvl-depth-thresholds/set', { depth: '11-7/8', version: null, threshold_lf: 960 });
  assert.equal(set.status, 200, set.body.error);
  await goLive(ctx.db, 'lvl');
  // Two 16′ boards trimmed to 12′ with none on hand: −32 LF + 24 LF.
  const trim = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 12, boards: 2, note: null });
  assert.equal(trim.status, 200, trim.body.error);

  const { items, lvlDepths } = await read(ctx, '/api/items');
  const reorder = (id) => items.find((i) => i.id === id).reorder;
  assert.deepEqual([reorder(long.id), reorder(short.id)], ['Short', 'Low']);
  assert.deepEqual(lvlDepths, [{ depth: '11-7/8', available_lf: -8, threshold_lf: 960, reorder: 'Short' }]);
});

test('Trim takes LVL boards down to a shorter length; the Overview and the Activity Log follow (stories 47–48, Q39)', async () => {
  const ctx = await withAdmin();
  const lvl = { product: '2.0 LVL 1-3/4', size: '11-7/8' };
  const long = (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft: 16 } })).body.item;
  const short = (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft: 12 } })).body.item;
  await goLive(ctx.db, 'lvl');

  const toShort = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 12, boards: 2, note: 'wet ends' });
  assert.equal(toShort.status, 200, toShort.body.error);
  assert.equal(toShort.body.trim.to_item, '2.0 LVL 1-3/4 x 11-7/8 12′');
  const toNew = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 10, boards: 1, note: null });
  assert.equal(toNew.status, 200, toNew.body.error);
  const refusedOne = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 16, boards: 1, note: null });
  assert.deepEqual([refusedOne.status, refusedOne.body.error], [400, 'Pick a length shorter than 16′.']);
  const retired = (await change(ctx, '/api/items/retire', { id: short.id, version: short.version })).body.item;
  assert.equal(retired.active, false, 'the 12′ is retired');
  const unretired = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 12, boards: 1, note: null, unretire: true });
  assert.equal(unretired.status, 200, unretired.body.error);

  const { items } = await read(ctx, '/api/items');
  const figures = (length) => { const i = items.find((x) => x.family === 'lvl' && x.length_ft === length); return [i.on_hand, i.stocking]; };
  assert.deepEqual([figures(16), figures(12), figures(10)],
    [[-4, 'Special Order'], [3, 'Special Order'], [1, 'Non-Stock']]);
  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.filter((e) => e.action === 'trim').map((e) => [e.target, e.change]), [
    ['2.0 LVL 1-3/4 x 11-7/8 16′', 'added: 1 trimmed to 12′ (put back in use)'],
    ['2.0 LVL 1-3/4 x 11-7/8 16′', 'added: 1 trimmed to 10′ (new item, Non-Stock)'],
    ['2.0 LVL 1-3/4 x 11-7/8 16′', 'added: 2 trimmed to 12′; note: wet ends'],
  ]);
});

test('History lists one item\'s receipts, corrections and settings changes, newest first, with who (story 55)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const other = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'HUS26' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  await goLive(ctx.db, 'hangers');
  await change(ctx, '/api/items/edit', { id: hanger.id, version: hanger.version, changes: { threshold: 40 } });
  const po = (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number: '4501', po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }] })).body.po;
  await change(ctx, '/api/receipts/receive', { po_id: po.id, po_version: po.version, supplier_id: null, bol: 'B-77',
    lines: [{ po_line_id: po.lines[0].id, item_id: hanger.id, quantity: 120, packs: 2, pack_size: 50, pack_kind: 'carton', loose: 20 },
      { po_line_id: null, item_id: other.id, quantity: 6 }] });
  await change(ctx, '/api/receipts/receive', { po_id: null, po_version: null, supplier_id: supplier.id,
    lines: [{ item_id: hanger.id, quantity: 4 }] });
  const { reasons } = await read(ctx, '/api/reasons');
  await change(ctx, '/api/items/correct', { item_id: hanger.id, quantity: -2,
    reason_id: reasons.find((r) => r.text === 'Damaged – scrapped').id, note: 'bent' });

  const { entries } = await read(ctx, `/api/items/history?id=${hanger.id}`);
  assert.deepEqual(entries.map((e) => [e.action, e.who, e.change, e.detail]), [
    ['correct', 'Ann Lee', -2, 'Damaged – scrapped; note: bent'],
    ['receive', 'Ann Lee', 4, 'Simpson, no PO'],
    ['receive', 'Ann Lee', 120, 'PO 4501 line 1, Simpson; 2 cartons of 50 + 20 loose; Bill of Lading or tracking number B-77; '
      + 'carton size on file: 50'],
    ['edit item', 'Ann Lee', null, 'threshold: null → 40'],
    ['add item', 'Ann Lee', null, 'added: Special Order, no threshold'],
  ]);
  const times = entries.map((e) => Date.parse(e.at));
  assert.ok(times.every((t, n) => t && (n === 0 || t <= times[n - 1])), `each entry has its time, newest first: ${times}`);

  const { entries: others } = await read(ctx, `/api/items/history?id=${other.id}`);
  assert.deepEqual(others.map((e) => [e.action, e.change, e.detail]), [
    ['receive', 6, 'PO 4501, not on the PO, Simpson; Bill of Lading or tracking number B-77'],
    ['add item', null, 'added: Special Order, no threshold'],
  ]);
  const missing = await get(ctx.base, '/api/items/history?id=999999', ctx.cookie);
  assert.deepEqual([missing.status, (await missing.json()).error], [400, 'That item is not in the catalog.']);
});

test('History shows a trim on both lengths: trimmed to on the long one, trimmed from on the short one (story 55)', async () => {
  const ctx = await withAdmin();
  const lvl = { product: '2.0 LVL 1-3/4', size: '11-7/8' };
  const long = (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft: 16 } })).body.item;
  await goLive(ctx.db, 'lvl');
  const trimmed = (await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 12, boards: 2, note: 'wet ends' })).body.trim;

  const { items } = await read(ctx, '/api/items');
  const short = items.find((i) => i.length_ft === 12);
  const [onLong] = (await read(ctx, `/api/items/history?id=${long.id}`)).entries;
  const [onShort] = (await read(ctx, `/api/items/history?id=${short.id}`)).entries;
  assert.equal(trimmed.to_item, '2.0 LVL 1-3/4 x 11-7/8 12′');
  assert.deepEqual([onLong.action, onLong.change, onLong.detail], ['trim', -2, 'trimmed to 12′; note: wet ends']);
  assert.deepEqual([onShort.action, onShort.change, onShort.detail], ['trim', 2, 'trimmed from 16′ and added as Non-Stock; note: wet ends'],
    'the trim added 12′ to the catalog (Q84)');
});

test('History says when a trim put a retired length back in use (story 55, Q39, Q82)', async () => {
  const ctx = await withAdmin();
  const lvl = { product: '2.0 LVL 1-3/4', size: '11-7/8' };
  const add = async (length_ft) => (await change(ctx, '/api/items/add', { family: 'lvl', identity: { ...lvl, length_ft } })).body.item;
  const long = await add(16);
  const short = await add(12);
  await change(ctx, '/api/items/retire', { id: short.id, version: short.version });
  await goLive(ctx.db, 'lvl');
  const trimmed = await change(ctx, '/api/items/trim', { item_id: long.id, length_ft: 12, boards: 2, note: null, unretire: true });
  assert.equal(trimmed.status, 200, trimmed.body.error);

  const [onShort] = (await read(ctx, `/api/items/history?id=${short.id}`)).entries;
  const [onLong] = (await read(ctx, `/api/items/history?id=${long.id}`)).entries;
  assert.equal(onShort.detail, 'trimmed from 16′ and put back in use');
  assert.equal(onLong.detail, 'trimmed to 12′', 'the long length was never retired');
});

test('Reverse undoes a receipt line from History: the original stays, marked reversed, and the reversal takes its time (stories 42, 55, 79)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  await goLive(ctx.db, 'hangers');
  await change(ctx, '/api/receipts/receive', { po_id: null, po_version: null, supplier_id: supplier.id,
    lines: [{ item_id: hanger.id, quantity: 12 }] });
  const history = async () => (await read(ctx, `/api/items/history?id=${hanger.id}`)).entries;
  const [received] = await history();
  assert.deepEqual([received.action, received.reversed], ['receive', false]);

  const reversed = await change(ctx, '/api/ledger/reverse', { id: received.id, note: 'wrong supplier' });
  assert.equal(reversed.status, 200, reversed.body.error);
  assert.deepEqual(reversed.body.reversal.lines, [{ item: 'LUS28', quantity: -12 }]);
  const again = await change(ctx, '/api/ledger/reverse', { id: received.id, note: null });
  assert.deepEqual([again.status, again.body.error], [422, 'That entry is already reversed.']);

  const [reversal, original] = await history();
  assert.deepEqual([reversal.action, reversal.change, reversal.detail, reversal.reversed], ['reverse', -12, 'reverses the receipt; note: wrong supplier', false]);
  assert.deepEqual([original.id, original.reversed], [received.id, true]);
  assert.equal(reversal.at, original.at, 'a reversal takes the time of the entry it reverses (story 79)');
  const { items } = await read(ctx, '/api/items');
  assert.equal(items.find((i) => i.id === hanger.id).on_hand, 0);
  const [logged] = (await read(ctx, '/api/activity')).entries;
  assert.deepEqual([logged.action, logged.target, logged.change], ['reverse', 'LUS28', 'added: reversal of the receipt: LUS28 −12; note: wrong supplier']);
});

test('a receipt that replaces one on the wrong PO takes the original\'s time, and History shows all three rows (owner, 2026-10-05)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const supplier = (await change(ctx, '/api/suppliers/add', { name: 'Simpson' })).body.supplier;
  await goLive(ctx.db, 'hangers');
  const enter = async (number) => (await change(ctx, '/api/pos/enter', { supplier_id: supplier.id, number, po_date: '2026-10-03',
    lines: [{ item_id: hanger.id, ordered: 100 }] })).body.po;
  const [wrong, right] = [await enter('4501'), await enter('4502')];
  const first = (await change(ctx, '/api/receipts/receive', { po_id: wrong.id, po_version: wrong.version, supplier_id: null,
    lines: [{ po_line_id: wrong.lines[0].id, item_id: hanger.id, quantity: 30 }] })).body.receipt;

  const replaced = await change(ctx, '/api/receipts/receive', { po_id: right.id, po_version: right.version, supplier_id: null,
    lines: [{ po_line_id: right.lines[0].id, item_id: hanger.id, quantity: 30 }], replaces: first.lines[0].id });
  assert.equal(replaced.status, 200, replaced.body.error);
  const entries = (await read(ctx, `/api/items/history?id=${hanger.id}`)).entries.slice(0, 3);
  // reversal marks the row the replacing receipt wrote as a reversal, so the
  // page offers no Reverse on it, though the receipt's action wrote it (Q44).
  assert.deepEqual(entries.map((e) => [e.action, e.change, e.detail, e.reversed, e.reversal]), [
    ['receive', 30, 'PO 4502 line 1, Simpson', false, false],
    ['receive', -30, 'reverses the receipt', false, true],
    ['receive', 30, 'PO 4501 line 1, Simpson', true, false],
  ]);
  assert.equal(new Set(entries.map((e) => e.at)).size, 1, 'the replacement and the reversal take the original\'s time');
  const [logged] = (await read(ctx, '/api/activity')).entries;
  assert.equal(logged.change, 'added: 30 LUS28 on line 1; reverses the receipt: LUS28 −30');

  const { reasons } = await read(ctx, '/api/reasons');
  const scrapped = reasons.find((r) => r.text === 'Damaged – scrapped').id;
  const wrongFix = (await change(ctx, '/api/items/correct', { item_id: hanger.id, quantity: -5, reason_id: scrapped, note: null })).body.correction;
  const fixed = await change(ctx, '/api/items/correct', { item_id: hanger.id, quantity: -3, reason_id: scrapped, note: null, replaces: wrongFix.id });
  assert.equal(fixed.status, 200, fixed.body.error);
  assert.equal(fixed.body.correction.reversed.reverses, 'correct');
});

test('anyone starts, saves and submits a count; Count lists it, and the Activity Log says what each step did (stories 58–67)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  const other = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'HUS26' } })).body.item;
  await goLive(ctx.db, 'hangers');
  await change(ctx, '/api/users/add', { email: 'bob@example.com', name: 'Bob Ray', password: 'bob temporary 1' });
  const bob = { ...ctx, cookie: await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password') };

  // Bob is not an admin: counting is everyone's work (#81, "Admin-only actions").
  const started = await change(bob, '/api/counts/start', { family: 'hangers', kind: 'monthly', closes: '2026-08' });
  assert.equal(started.status, 200, started.body.error);
  const count = started.body.count;
  assert.deepEqual([count.status, count.closes, count.counted_by], ['draft', '2026-08', 'Bob Ray']);

  const lines = [{ item_id: hanger.id, packs: 3, pack_size: 50, pack_kind: 'carton', loose: 7 }, { item_id: other.id, loose: 0 }];
  const saved = await change(bob, '/api/counts/save', { id: count.id, version: count.version, closes: '2026-09', lines });
  assert.equal(saved.status, 200, saved.body.error);
  assert.deepEqual(saved.body.count.lines.map((l) => [l.item, l.quantity]), [['LUS28', 157], ['HUS26', 0]]);
  assert.deepEqual((await read(bob, '/api/counts')).counts, [saved.body.count], 'Count lists the draft to carry on with');

  const submitted = await change(bob, '/api/counts/submit',
    { id: count.id, version: saved.body.count.version, closes: '2026-09', lines: [lines[0]] });
  assert.equal(submitted.status, 200, submitted.body.error);
  assert.equal(submitted.body.count.status, 'waiting');
  assert.deepEqual((await read(bob, '/api/counts')).counts, [submitted.body.count], 'and the count waiting for approval');

  const { entries } = await read(ctx, '/api/activity?family=hangers');
  assert.deepEqual(entries.slice(0, 3).map((e) => [e.who, e.action, e.target, e.change]), [
    ['Bob Ray', 'submit count', 'Hangers count', 'submitted for approval; lines: 157 LUS28 (3 cartons of 50 + 7 loose)'],
    ['Bob Ray', 'save count', 'Hangers count', 'closes: August 2026 → September 2026; lines: 157 LUS28 (3 cartons of 50 + 7 loose), 0 HUS26'],
    ['Bob Ray', 'start count', 'Hangers count', 'added: monthly, closes August 2026'],
  ]);
  assert.deepEqual((await read(ctx, '/api/activity?family=plates')).entries, [], 'a count shows under its own family only');
});

test('a second person approves a waiting count from its review; the count-approval switch is the admin\'s, and the Activity Log says each step (stories 69–76; Q110, Q113)', async () => {
  const ctx = await withAdmin();
  const hanger = (await change(ctx, '/api/items/add', { family: 'hangers', identity: { sku: 'LUS28' } })).body.item;
  await goLive(ctx.db, 'hangers');
  await change(ctx, '/api/users/add', { email: 'bob@example.com', name: 'Bob Ray', password: 'bob temporary 1' });
  const bob = { ...ctx, cookie: await signInAndChoose(ctx.base, 'bob@example.com', 'bob temporary 1', 'bob own password') };
  const waiting = async () => {
    const started = (await change(bob, '/api/counts/start', { family: 'hangers', kind: 'spot check' })).body.count;
    return (await change(bob, '/api/counts/submit',
      { id: started.id, version: started.version, closes: null, lines: [{ item_id: hanger.id, loose: 5 }] })).body.count;
  };
  const count = await waiting();

  const review = await read(bob, `/api/counts/review?id=${count.id}`);
  assert.deepEqual([review.entries, review.on_hand, review.nothing_before], [[], { [hanger.id]: 0 }, [hanger.id]]);
  assert.equal((await post(ctx.base, '/api/counts/review?id=1', {}, bob.cookie)).status, 404, 'a review is read, never posted');

  // Bob worked on it; the admin did not.
  const { reasons } = await read(ctx, '/api/reasons');
  const reason = reasons.find((r) => r.text === 'Damaged – scrapped').id;
  const own = await change(bob, '/api/counts/approve',
    { id: count.id, version: count.version, answers: { reasons: { [hanger.id]: reason } } });
  assert.equal(own.status, 422);
  assert.equal(own.body.error, 'You worked on this count, so a second person approves it.');
  // LUS28 had nothing before the count, so its reason is optional (Q118).
  const approved = await change(ctx, '/api/counts/approve',
    { id: count.id, version: count.version, answers: { reasons: { [hanger.id]: reason } } });
  assert.equal(approved.status, 200, approved.body.error);
  assert.equal(approved.body.count.status, 'approved');
  assert.equal((await read(bob, '/api/items')).items[0].on_hand, 5);

  const second = await waiting();
  const rejected = await change(ctx, '/api/counts/reject', { id: second.id, version: second.version });
  assert.equal(rejected.body.count.status, 'rejected');
  assert.deepEqual((await read(bob, '/api/counts')).counts, [], 'nothing waits any more');

  // The switch: everyone reads it, only an admin changes it.
  const seen = await read(bob, '/api/count-approval');
  assert.deepEqual(seen.setting, [{ name: 'count_approval_by_another', value: true, version: 1 }]);
  const denied = await post(ctx.base, '/api/count-approval/set', { key: crypto.randomUUID(), version: 1, on: false }, bob.cookie);
  assert.equal(denied.status, 403);
  assert.equal((await change(ctx, '/api/count-approval/set', { version: 1, on: false })).body.setting.value, false);
  const third = await waiting();
  const mine = await change(bob, '/api/counts/approve', { id: third.id, version: third.version, answers: {} });
  assert.equal(mine.status, 200, 'with the switch off, the counter approves');

  const { entries } = await read(ctx, '/api/activity');
  assert.deepEqual(entries.filter((e) => /^(approve|reject) count$/.test(e.action)).map((e) => [e.who, e.action, e.target, e.change]), [
    ['Bob Ray', 'approve count', 'Hangers count', 'approved; lines: 5 LUS28'],
    ['Ann Lee', 'reject count', 'Hangers count', 'rejected'],
    ['Ann Lee', 'approve count', 'Hangers count', 'approved; lines: 5 LUS28 (the app had 0; Damaged – scrapped)'],
  ]);
  assert.deepEqual(entries.filter((e) => e.action === 'set count approval').map((e) => [e.target, e.change]),
    [['Count approval', 'second person must approve: yes → no']]);
});
