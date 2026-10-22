// The Planner reads the database (#81 part 4, stories 89–94), through the
// whole app over HTTP (seam 2, test/support/app.js): which on-hand figures a
// plan nets against, the plate pack sizes it prices a shortfall with, the
// flags on each buy-list line, and that a run changes no row.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withAdmin, post } = require('./support/app.js');
const { as, call, goLive } = require('./support/database.js');
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

// Four lumber lines (2x4 #1, #2, DSS, MSR2400) and one LVL depth (11-78).
const LUMBER_LVL_SHEET = {
  name: '66059F.csv',
  text: fs.readFileSync(path.join(__dirname, 'port-fixtures', 'sheets', '66059F-scrubbed.csv'), 'utf8'),
};

// Today in New York, as last counted is written.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

// A hanger's line, to buy or already covered.
const hangerLine = (plan, sku) => [...plan.buyList, ...plan.covered].find((l) => l.sku === sku);

// Ann, an admin signed in, and a supplier to receive from.
async function setUp() {
  const ctx = await withAdmin();
  const supplier = await call(ctx.db, 'add_supplier', ctx.ann.id, crypto.randomUUID(), 'Simpson');
  ctx.add = (family, identity) => call(ctx.db, 'add_item', ctx.ann.id, crypto.randomUUID(), family, identity);
  ctx.receive = (item, quantity) => call(ctx.db, 'receive', ctx.ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: item.id, quantity }]));
  ctx.retire = (item) => call(ctx.db, 'retire_item', ctx.ann.id, crypto.randomUUID(), item.id, item.version);
  // A spot check of `family` that finds one of each item, approved; `at`,
  // the moment it was counted, when not now.
  ctx.count = async (family, items, at = null) => {
    const started = await call(ctx.db, 'start_count', ctx.ann.id, crypto.randomUUID(), family, 'spot check', null);
    if (at) await as(ctx.db, null, (owner) => owner.query('UPDATE inv.counts SET counted_at = $2 WHERE id = $1', [started.id, at]));
    const count = await call(ctx.db, 'submit_count', ctx.ann.id, crypto.randomUUID(), started.id, started.version, started.closes,
      JSON.stringify(items.map((i) => ({ item_id: i.id, loose: 1 }))));
    return call(ctx.db, 'approve_count', ctx.ann.id, crypto.randomUUID(), count.id, count.version, '{}');
  };
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
  const own = [{ sku: 'MT20 2x4', eaches_per_unit: 1, unit_label: 'box', pallet_eaches: null }];

  const options = async () => (await ctx.plan('/api/plates/plan', { files: [PLATE_SHEET], packs: own }))
    .rows.find((r) => r.key === 'MT202X4').purchase;
  // The sheet asks for 214 and there is no on-hand file.
  assert.deepEqual(await options(),
    [{ unit: 'box', eachesPerUnit: 330, units: 1, totalEaches: 330, leftover: 116 }]);

  await call(ctx.db, 'change_pack_size', ctx.ann.id, crypto.randomUUID(), box.id, box.version, 100);
  await call(ctx.db, 'add_pack_size', ctx.ann.id, crypto.randomUUID(), plate.id, 'pallet', 15400);
  assert.deepEqual(await options(), [
    { unit: 'box', eachesPerUnit: 100, units: 3, totalEaches: 300, leftover: 86 },
    { unit: 'pallet', eachesPerUnit: 15400, units: 1, totalEaches: 15400, leftover: 15186 },
  ]);
});

// Flags on the buy-list lines (#81 design item 4; Q183, Q185, Q186): one
// field keyed by the engine's own line key, so the engine's answer is
// unchanged. A line with nothing to say has no entry.
test('a live family\'s lines say when last counted, whether retired, and whether in the catalog (Q183, Q186)', async () => {
  const ctx = await setUp();
  const hus26 = await ctx.add('hangers', { sku: 'HUS26' });
  const h2az = await ctx.add('hangers', { sku: 'H2AZ' });
  await goLive(ctx.db, 'hangers');
  await ctx.count('hangers', [hus26]);
  const retired = await ctx.retire(h2az);

  const { flags } = await ctx.plan('/api/hangers/plan', { files: [HANGER_SHEET] });
  assert.deepEqual(flags.HUS26, { lastCounted: today() });
  assert.deepEqual(flags.H2AZ, { lastCounted: 'never', retired: [{ id: retired.id, version: retired.version }] });
  assert.deepEqual(flags.H1AZ, { notInCatalog: true, addToCatalog: { family: 'hangers', identity: { sku: 'H1AZ' } } },
    'the sheet says H1A2; the line, and so the new item, takes the canonical SKU');

  // Plates are not live: no last counted, the rest the same.
  await ctx.retire(await ctx.add('plates', { sku: 'MT20 2x4' }));
  const plates = await ctx.plan('/api/plates/plan', { files: [PLATE_SHEET] });
  assert.deepEqual(Object.keys(plates.flags.MT202X4), ['retired']);
  assert.deepEqual(plates.flags.MT2015X4, { notInCatalog: true, addToCatalog: { family: 'plates', identity: { sku: 'MT20  1.5x4' } } },
    'the sheet\'s SKU as it stands; adding an item folds the double space');
});

test('a lumber line gives last counted per length and shows the oldest; a family not live gives none (Q185, Q186)', async () => {
  const ctx = await setUp();
  const add = (grade, length_ft) => ctx.add('lumber', { size: '2x4', grade, length_ft });
  const [no2at8, no2at16, no1at10, no1at12] = [await add('#2', 8), await add('#2', 16), await add('#1', 10), await add('#1', 12)];
  const lvl = await ctx.add('lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 24 });
  await goLive(ctx.db, 'lumber');
  await ctx.count('lumber', [no2at8, no1at10], '2026-10-01 12:00-04');
  await ctx.count('lumber', [no1at12]);
  const retiredLvl = await ctx.retire(lvl);
  await ctx.retire(no2at16); // one length of 2x4 #2: the line is not retired

  const lumber = await ctx.plan('/api/lumber/plan', { files: [LUMBER_LVL_SHEET] });
  assert.deepEqual(lumber.flags['2x4|#2'], { lastCounted: 'never', lastCountedByLength: { 8: '2026-10-01', 16: 'never' } });
  assert.deepEqual(lumber.flags['2x4|#1'], { lastCounted: '2026-10-01', lastCountedByLength: { 10: '2026-10-01', 12: today() } });
  assert.deepEqual(lumber.flags['2x4|DSS'], { notInCatalog: true }, 'lumber is added from Overview, not in one click');

  const lvlPlan = await ctx.plan('/api/lvl/plan', { files: [LUMBER_LVL_SHEET] });
  assert.deepEqual(lvlPlan.flags, { '11-78': { retired: [{ id: retiredLvl.id, version: retiredLvl.version }] } },
    'not live: no last counted');
});

test('a lumber line redirected whole buys nothing, so it is not flagged as not in the catalog (Q206)', async () => {
  const ctx = await setUp();
  await call(ctx.db, 'set_grade_redirect', ctx.ann.id, crypto.randomUUID(), '2x4', 'DSS', null, 'MSR2400');

  const lumber = await ctx.plan('/api/lumber/plan', { files: [LUMBER_LVL_SHEET] });
  assert.equal(lumber.bySizeGrade.find((l) => l.key === '2x4|DSS').fullyRedirected, true, 'the redirect took the whole line');
  assert.equal(lumber.flags['2x4|DSS'], undefined);
  assert.deepEqual(lumber.flags['2x4|MSR2400'], { notInCatalog: true }, 'the line it goes to is still flagged');
});

// A plan changes no row (#81 design item 5). Every table's row count and a
// hash of its rows, read as the owner, after Ann signs in and before all four
// plans, and after. The hash catches a changed value, which a count misses.
// The database's grants are the guarantee (test/database.test.js, S62).
test('running all four plans, one family live and one on a dropped file, changes no row in any table', async () => {
  const ctx = await setUp();
  const hus26 = await ctx.add('hangers', { sku: 'HUS26' });
  await goLive(ctx.db, 'hangers');
  await ctx.receive(hus26, 4);
  const tables = () => as(ctx.db, null, async (owner) => {
    const { rows } = await owner.query(`SELECT pg_catalog.format('%I.%I', schemaname, tablename) AS name FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`);
    const seen = {};
    for (const { name } of rows) {
      seen[name] = (await owner.query(`SELECT count(*)::int AS rows,
        pg_catalog.md5(coalesce(pg_catalog.string_agg(t::text, '|' ORDER BY t::text), '')) AS hash FROM ${name} t`)).rows[0];
    }
    return seen;
  });
  const before = await tables();
  assert.ok(before['inv.items'].rows === 1 && before['inv.ledger'].rows > 0, `the check sees the app's tables: ${JSON.stringify(before)}`);

  const plateFile = { name: 'plate-stock.csv', text: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\nMT20 2x4,500,0,500,0,,,\n' };
  await ctx.plan('/api/hangers/plan', { files: [HANGER_SHEET] });
  await ctx.plan('/api/plates/plan', { files: [PLATE_SHEET], stock: plateFile });
  await ctx.plan('/api/lumber/plan', { files: [LUMBER_LVL_SHEET] });
  await ctx.plan('/api/lvl/plan', { files: [LUMBER_LVL_SHEET] });
  assert.deepEqual(await tables(), before);
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
