// =============================================================
// import.test.js — the owner's catalog import (#81 part 1, seam 2).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// importCatalog reads the web app's exports and this repo's pack-size files,
// and makes one database call. Each test runs it against a fresh database.
// Inputs: the Planner's recorded exports of 2026-09-02, the owner's EWP
// export of 2026-09-30, and two small made-up files (special-order.csv,
// lvl-depth-thresholds.csv). Expected counts were read from those files.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { freshDatabase, urlFor, as, APP, firstUser, call, logRows, refused, HASH } = require('./support/database.js');
const { importCatalog } = require('../src/db/import-catalog.js');

const STOCK = path.join(__dirname, 'port-fixtures', 'stock');
const HERE = path.join(__dirname, 'import-fixtures');
const FILES = {
  plates: path.join(STOCK, 'plate-stock-20260902.csv'),
  hangers: path.join(STOCK, 'hanger-stock-20260902.csv'),
  lumber: path.join(STOCK, 'lumber-stock-20260902.csv'),
  ewp: path.join(HERE, 'ewp-stock-20260930.csv'),
  specialOrder: path.join(HERE, 'special-order.csv'),
  lvlDepthThresholds: path.join(HERE, 'lvl-depth-thresholds.csv'),
};

async function counts(db) {
  return as(db, APP, async (app) => (await app.query(`
    SELECT family, stocking, count(*)::int AS n FROM inv.items GROUP BY 1, 2 ORDER BY 1, 2`)).rows);
}

test('the import adds the catalog, pack sizes and LVL depth thresholds, and reports what it left out', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  const report = await importCatalog(urlFor(db), FILES, 'ann@example.com');

  assert.deepEqual(await counts(db), [
    { family: 'hangers', stocking: 'Non-Stock', n: 72 },
    { family: 'hangers', stocking: 'Special Order', n: 1 },
    { family: 'hangers', stocking: 'Stocked', n: 39 },
    { family: 'lumber', stocking: 'Non-Stock', n: 58 },
    // #81: every 2′ length to 48′, from 6′ (9-1/2″, 11-7/8″), 8′ (14–18″) or
    // 12′ (20″, 24″); no 22″. Stocked where the depth has a threshold.
    { family: 'lvl', stocking: 'Special Order', n: 19 },
    { family: 'lvl', stocking: 'Stocked', n: 126 },
    { family: 'plates', stocking: 'Non-Stock', n: 15 },
    { family: 'plates', stocking: 'Special Order', n: 1 },
    { family: 'plates', stocking: 'Stocked', n: 47 },
  ]);
  assert.deepEqual(report.added, { items: 378, pack_sizes: 209, lvl_depth_thresholds: 7 });
  assert.deepEqual(report.skipped, { items: 0, pack_sizes: 0, lvl_depth_thresholds: 0 });

  await as(db, APP, async (app) => {
    const one = async (sql, params) => (await app.query(sql, params)).rows;
    // The export's "MT18HS  3x8" (two spaces) is the plate MT18HS 3x8.
    assert.equal((await one("SELECT 1 FROM inv.items WHERE sku = 'MT18HS 3x8'")).length, 1);
    // S74: an MT20 plate comes in a band of 20 and a box; S18: a pallet size where known.
    assert.deepEqual(await one(`
      SELECT p.kind, p.pieces FROM inv.pack_sizes p JOIN inv.items i ON i.id = p.item_id
       WHERE i.sku = 'MT20 3x6' ORDER BY p.pieces`), [
      { kind: 'pack', pieces: 20 }, { kind: 'box', pieces: 260 }, { kind: 'pallet', pieces: 14000 }]);
    assert.deepEqual(await one(`
      SELECT i.product, i.size, i.length_ft, i.threshold FROM inv.items i
       WHERE i.family = 'lvl' AND i.size = '11-7/8' AND i.length_ft = 48`),
      [{ product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 48, threshold: null }]);
    assert.deepEqual(await one("SELECT depth, threshold_lf FROM inv.lvl_depth_thresholds WHERE depth IN ('11-7/8', '24') ORDER BY 1"),
      [{ depth: '11-7/8', threshold_lf: 960 }, { depth: '24', threshold_lf: null }]);
  });

  assert.deepEqual(report.notes, [
    'Skipped hanger NAILED: MiTek writes it for a site-nailed connection, which is not supplied.',
    'Special Order hanger LUS99 is not in the hanger export, so it was not added.',
    'Dropped the threshold 20 on LVL 2.1 RigidLam LVL 1-3/4 x 11-7/8 48′: LVL thresholds are per depth.',
    'Dropped the threshold 20 on LVL 2.1 RigidLam LVL 1-3/4 x 14 48′: LVL thresholds are per depth.',
  ]);

  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'import catalog');
  assert.deepEqual(log.new_value, { added: report.added, skipped: report.skipped });
});

test('a second import adds only what is new and never overwrites an edit made in the app', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  await importCatalog(urlFor(db), FILES, 'ann@example.com');
  const [lus] = await as(db, APP, async (app) =>
    (await app.query("SELECT id, version FROM inv.items WHERE sku = 'LUS28'")).rows);
  await call(db, 'edit_item', ann.id, crypto.randomUUID(), Number(lus.id), lus.version, { threshold: 999 });

  const again = await importCatalog(urlFor(db), FILES, 'ann@example.com');
  assert.deepEqual(again.added, { items: 0, pack_sizes: 0, lvl_depth_thresholds: 0 });
  assert.deepEqual(again.skipped, { items: 378, pack_sizes: 209, lvl_depth_thresholds: 7 });
  const [after] = await as(db, APP, async (app) =>
    (await app.query("SELECT threshold FROM inv.items WHERE sku = 'LUS28'")).rows);
  assert.equal(after.threshold, 999);
});

test('one bad row saves nothing, and only an active admin can be named as the importer', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'import-'));
  const bad = path.join(dir, 'hangers.csv');
  fs.writeFileSync(bad, 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\nLUS28,0,0,0,0,-5,,\n');
  await refused(importCatalog(urlFor(db), { ...FILES, hangers: bad }, 'ann@example.com'), 'IV400', 'a negative threshold');
  await refused(importCatalog(urlFor(db), FILES, 'bob@example.com'), 'IV403', 'a person who is not an admin');
  await refused(importCatalog(urlFor(db), FILES, 'nobody@example.com'), 'IV403', 'an address not on the list');
  assert.deepEqual(await counts(db), [], 'nothing was saved');
});

test('a pack size for an item not in the export is left out and counted in a note', async () => {
  const db = await freshDatabase();
  await firstUser(db);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'import-'));
  const one = path.join(dir, 'hangers.csv');
  fs.writeFileSync(one, 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\nLUS28,0,0,0,0,,,\n');
  const report = await importCatalog(urlFor(db), { ...FILES, hangers: one }, 'ann@example.com');
  assert.equal(report.added.items, 378 - 111, 'one hanger instead of 112');
  assert.equal(report.added.pack_sizes, 209 - 111, "only LUS28's carton of the 112");
  assert.ok(report.notes.includes('Left out 111 hanger pack sizes whose items are not in the hanger export.'),
    `notes: ${report.notes.join(' | ')}`);
});
