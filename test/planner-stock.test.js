// The Planner reads the database (#81 part 4, stories 89–94), through the
// whole app over HTTP (seam 2, test/support/app.js): which on-hand figures a
// plan nets against, the plate pack sizes it prices a shortfall with, the
// flags on each buy-list line, and that a run changes no row.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withAdmin, post } = require('./support/app.js');
const { call, goLive } = require('./support/database.js');
const { stockText } = require('../src/inventory/planner-stock.js');
const { parsePlateStockCsv } = require('../src/plates/readPlateStockCsv.js');
const { parseHangerStockCsv } = require('../src/hangers/readHangerStockCsv.js');
const { parseLumberStockCsv } = require('../src/lumber/readLumberStockCsv.js');
const { parseStockCsv } = require('../src/ewp/readStockCsv.js');

const HANGER_SHEET = {
  name: 'CANON1.csv',
  text: fs.readFileSync(path.join(__dirname, 'hanger-fixtures', 'stc-canon-synthetic.csv'), 'utf8'),
};
const PLATE_SHEET = {
  name: '10001R.csv',
  text: fs.readFileSync(path.join(__dirname, 'plate-fixtures', '10001R-materials.csv'), 'utf8'),
};

// A hanger's line, to buy or already covered.
const hangerLine = (plan, sku) => [...plan.buyList, ...plan.covered].find((l) => l.sku === sku);

// Ann, an admin signed in, and a supplier to receive from.
async function setUp() {
  const ctx = await withAdmin();
  const supplier = await call(ctx.db, 'add_supplier', ctx.ann.id, crypto.randomUUID(), 'Simpson');
  ctx.add = (family, identity) => call(ctx.db, 'add_item', ctx.ann.id, crypto.randomUUID(), family, identity);
  ctx.receive = (item, quantity) => call(ctx.db, 'receive', ctx.ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: item.id, quantity }]));
  ctx.plan = async (route, body) => {
    const res = await post(ctx.base, route, body, ctx.cookie);
    const json = await res.json();
    assert.equal(res.status, 200, `${route}: ${JSON.stringify(json)}`);
    return json;
  };
  return ctx;
}

test('a live family plans against the database, a dropped file ignored; a family not live plans against the file (stories 89–90)', async () => {
  const ctx = await setUp();
  const hus26 = await ctx.add('hangers', { sku: 'HUS26' });
  await goLive(ctx.db, 'hangers');
  await ctx.receive(hus26, 4);
  const hangerFile = { name: 'hanger-stock.csv', text: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\nHUS26,100,0,100,0,,,\n' };

  const hangers = await ctx.plan('/api/hangers/plan', { files: [HANGER_SHEET], stock: hangerFile });
  const line = hangerLine(hangers, 'HUS26');
  assert.equal(line.available, 4, 'on hand from the database, not the file\'s 100');
  assert.equal(line.shortfall, 5, 'the sheet asks for 9');
  assert.equal(hangers.stockFileName, 'Inventory');
  assert.ok(hangers.warnings.some((w) => w.includes('hanger-stock.csv') && w.includes('live')),
    `a warning names the unused file: ${JSON.stringify(hangers.warnings)}`);

  // Dropped among the sheets instead, the file is still not used.
  const sniffed = await ctx.plan('/api/hangers/plan', { files: [HANGER_SHEET, hangerFile] });
  assert.equal(hangerLine(sniffed, 'HUS26').available, 4);

  // Plates are not live: the dropped file decides, even with a plate item in the catalog.
  await ctx.add('plates', { sku: 'MT20 2x4' });
  const plateFile = { name: 'plate-stock.csv', text: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\nMT20 2x4,500,0,500,0,,,\n' };
  const plates = await ctx.plan('/api/plates/plan', { files: [PLATE_SHEET], stock: plateFile });
  assert.equal(plates.rows.find((r) => r.key === 'MT202X4').availableEaches, 500);
  assert.equal(plates.stockFileName, 'plate-stock.csv');
});

// Plate pack sizes live in the database only (#81 change item 3): a plan
// prices a shortfall with them, whether or not plates are live.
test('a plate plan prices with the database\'s pack sizes; a Settings change reaches the next plan; a request cannot bring its own (Q175, Q180)', async () => {
  const ctx = await setUp();
  const plate = await ctx.add('plates', { sku: 'MT20 2x4' });
  const box = await call(ctx.db, 'add_pack_size', ctx.ann.id, crypto.randomUUID(), plate.id, 'box', 330);
  const own = [{ sku: 'MT20 2x4', eaches_per_unit: 1, unit_label: 'box', pallet_eaches: null, product_line: null }];

  const options = async () => (await ctx.plan('/api/plates/plan', { files: [PLATE_SHEET], packs: own }))
    .rows.find((r) => r.key === 'MT202X4').purchase;
  // The sheet asks for 214 and there is no on-hand file.
  assert.deepEqual(await options(),
    [{ unit: 'box', productLine: null, eachesPerUnit: 330, units: 1, totalEaches: 330, leftover: 116 }]);

  await call(ctx.db, 'change_pack_size', ctx.ann.id, crypto.randomUUID(), box.id, box.version, 100);
  await call(ctx.db, 'add_pack_size', ctx.ann.id, crypto.randomUUID(), plate.id, 'pallet', 15400);
  assert.deepEqual(await options(), [
    { unit: 'box', productLine: null, eachesPerUnit: 100, units: 3, totalEaches: 300, leftover: 86 },
    { unit: 'pallet', productLine: null, eachesPerUnit: 15400, units: 1, totalEaches: 15400, leftover: 15186 },
  ]);
});

// The text the app builds for a live family, read back by the family's own
// reader, gives the database's figures (#81 Testing Decisions).
test('the on-hand text built from the database reads back as the same figures in every family\'s own reader', () => {
  const plates = parsePlateStockCsv(stockText('plates', [
    { sku: 'MT20 2x4', on_hand: 40, incoming: 12, threshold: 100, last_counted: '2026-10-01' },
    { sku: 'MT18AHS 3x8', on_hand: -6, incoming: 0, threshold: null, last_counted: null },
  ]));
  const mt20 = plates.bySku.get('MT202X4');
  assert.deepEqual([mt20.availableRaw, mt20.onHand, mt20.committed, mt20.incoming, mt20.threshold, mt20.lastCounted],
    [40, 40, 0, 12, 100, '2026-10-01']);
  const mt18 = plates.bySku.get('MT18AHS3X8');
  assert.deepEqual([mt18.availableRaw, mt18.threshold, mt18.lastCounted], [-6, null, null]);
  assert.equal(plates.lastCounted, '2026-10-01');

  const hangers = parseHangerStockCsv(stockText('hangers', [
    { sku: 'LUS28', on_hand: 7, incoming: 3, threshold: 20, last_counted: '2026-10-01' },
    { sku: 'HUS26, "special"', on_hand: -2, incoming: 0, threshold: null, last_counted: null },
  ]));
  const lus28 = hangers.byKey.get('LUS28');
  assert.deepEqual([lus28.availableRaw, lus28.onHand, lus28.committed, lus28.incoming, lus28.threshold], [7, 7, 0, 3, 20]);
  assert.deepEqual(hangers.rows.map((r) => r.sku), ['LUS28', 'HUS26, "special"'], 'a SKU with a comma and quotes stays one cell');

  const lumber = parseLumberStockCsv(stockText('lumber', [
    { size: '2x4', grade: '#2', length_ft: 8, on_hand: 10, incoming: 4, threshold: null },
    { size: '2x4', grade: '#2', length_ft: 16, on_hand: 5, incoming: 0, threshold: 30 },
  ]));
  const group = lumber.byKey.get('2x4|#2');
  assert.deepEqual(group.boards, [{ span: 8, qty: 10 }, { span: 16, qty: 5 }]);
  assert.equal(group.onHandLf, 160);
  assert.equal(group.incomingLf, 32);

  const lvl = parseStockCsv(stockText('lvl', [
    { product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 24, on_hand: 3, incoming: 2, threshold: null },
  ]));
  assert.deepEqual(lvl.items, [{ source: 'inventory', item: '2.1 RigidLam LVL 1-3/4 x 11-7/8', depth: '11-78', span: 24, qty: 3, incoming: 2 }]);
});
