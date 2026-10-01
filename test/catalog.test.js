// =============================================================
// catalog.test.js — the item catalog and its Settings (#81 part 1, seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds a fresh database with the migration runner and calls the
// database's functions as the app's login, as database.test.js does. The
// app's own checks would refuse most bad input first, so only this seam
// proves what the database refuses on its own.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, APP, HASH, firstUser, call, logRows, refused } = require('./support/database.js');
const { DEFAULT_LUMBER_MENU } = require('../src/lumber/lumberMenu.js');

test('a new item starts Special Order with no threshold, and one log row records it', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const item = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: ' MT18HS 3x8 ' });
  assert.deepEqual(item, {
    id: item.id, family: 'plates', sku: 'MT18HS 3x8', product: null, size: null, grade: null, length_ft: null,
    stocking: 'Special Order', threshold: null, note: null, active: true, version: 1,
  });

  const last = (await logRows(db)).at(-1);
  assert.equal(Number(last.actor_id), ann.id);
  assert.equal(last.action, 'add item');
  assert.equal(last.target_table, 'items');
  assert.equal(Number(last.target_id), item.id);
  assert.equal(last.old_value, null);
  assert.deepEqual(last.new_value, item);
});

test('each family names its items its own way, and one family never holds the same item twice', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const add = (family, identity) => call(db, 'add_item', ann.id, crypto.randomUUID(), family, identity);

  // S19: similar SKUs stay separate items.
  for (const sku of ['MT18HS', 'MT18AHS', 'M18SHS']) await add('hangers', { sku });
  await add('plates', { sku: 'MT18HS' });  // another family may use the same text
  const lumber = await add('lumber', { size: '2x4', grade: '#2', length_ft: 16 });
  assert.deepEqual([lumber.size, lumber.grade, lumber.length_ft], ['2x4', '#2', 16]);
  const lvl = await add('lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 26 });
  assert.deepEqual([lvl.product, lvl.size, lvl.length_ft], ['2.1 RigidLam LVL 1-3/4', '11-7/8', 26]);

  const before = (await logRows(db)).length;
  const cases = [
    ['a plate with no SKU', 'plates', { sku: '  ' }, 'IV400'],
    ['a hanger with a length', 'hangers', { sku: 'LUS28', length_ft: 8 }, 'IV400'],
    ['lumber with no grade', 'lumber', { size: '2x4', length_ft: 16 }, 'IV400'],
    ['lumber with a SKU', 'lumber', { sku: 'X', size: '2x4', grade: '#2', length_ft: 16 }, 'IV400'],
    ['LVL with no length', 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '14' }, 'IV400'],
    ['a length of 0', 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 0 }, 'IV400'],
    ['a length that is not a whole number', 'lumber', { size: '2x4', grade: '#2', length_ft: 7.5 }, 'IV400'],
    ['an unknown family', 'nails', { sku: 'N8' }, 'IV400'],
    ['an EWP item, which waits for step 5', 'ewp', { sku: '11 7/8" PJI-40' }, 'IV422'],
    ['a SKU already in the family', 'hangers', { sku: ' MT18HS ' }, 'IV400'],
    ['lumber already in the catalog', 'lumber', { size: '2x4', grade: '#2', length_ft: 16 }, 'IV400'],
  ];
  for (const [label, family, identity, code] of cases) {
    await refused(add(family, identity), code, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('a person sets stocking status, threshold and note; each save is logged was → now', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const item = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  const edit = (version, changes) =>
    call(db, 'edit_item', ann.id, crypto.randomUUID(), item.id, version, changes);

  const stocked = await edit(1, { stocking: 'Stocked', threshold: 40 });
  assert.deepEqual(stocked, { ...item, stocking: 'Stocked', threshold: 40, version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'edit item');
  assert.deepEqual(last.old_value, item);
  assert.deepEqual(last.new_value, stocked);

  // S39: 0 means "reorder when none are left"; blank means "not set". A field
  // left out of the change keeps its value.
  assert.equal((await edit(2, { threshold: 0 })).threshold, 0);
  const blank = await edit(3, { threshold: null, note: '  weathered, keep for now  ' });
  assert.deepEqual([blank.threshold, blank.note, blank.stocking], [null, 'weathered, keep for now', 'Stocked']);
  assert.equal((await edit(4, { note: ' ' })).note, null, 'a blank note is no note');
});

test('impossible edits are refused, and a stale screen is refused with the current item', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const item = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  const lvl = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl',
    { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 48 });
  const edit = (target, version, changes) =>
    call(db, 'edit_item', ann.id, crypto.randomUUID(), target.id, version, changes);

  const before = (await logRows(db)).length;
  const cases = [
    ['a negative threshold (S40)', item, { threshold: -1 }, 'IV400'],
    ['a threshold that is not a whole number', item, { threshold: 2.5 }, 'IV400'],
    ['a stocking status not on the list', item, { stocking: 'stocked' }, 'IV400'],
    ['a threshold on an LVL item (Q16: LVL thresholds are per depth)', lvl, { threshold: 20 }, 'IV400'],
    ['a field that is not editable', item, { sku: 'LUS26' }, 'IV400'],
    ['an item that does not exist', { id: 999999 }, { note: 'x' }, 'IV400'],
  ];
  for (const [label, target, changes, code] of cases) {
    await refused(edit(target, 1, changes), code, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');

  // S41: a second screen still holding version 1 must not overwrite this save.
  const saved = await edit(item, 1, { threshold: 10 });
  const err = await refused(edit(item, 1, { threshold: 20 }), 'IV409', 'a stale version');
  assert.deepEqual(JSON.parse(err.detail), saved, 'the refusal carries the current item');
});

test('an item is retired and un-retired, never deleted, and each is logged', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const item = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 4x6' });

  const retired = await call(db, 'retire_item', ann.id, crypto.randomUUID(), item.id, 1);
  assert.deepEqual(retired, { ...item, active: false, version: 2 });
  assert.equal((await logRows(db)).at(-1).action, 'retire item');
  await refused(call(db, 'retire_item', ann.id, crypto.randomUUID(), item.id, 2), 'IV422', 'retired twice');

  const back = await call(db, 'unretire_item', ann.id, crypto.randomUUID(), item.id, 2);
  assert.deepEqual(back, { ...item, version: 3 });
  assert.equal((await logRows(db)).at(-1).action, 'un-retire item');
});

test('pack sizes: each item lists its known sizes; a size is corrected, logged was → now', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const item = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  const add = (kind, pieces, target = item) =>
    call(db, 'add_pack_size', ann.id, crypto.randomUUID(), target.id, kind, pieces);

  const carton = await add('carton', 50);
  assert.deepEqual(carton, { id: carton.id, item_id: item.id, kind: 'carton', pieces: 50, version: 1 });
  assert.equal((await logRows(db)).at(-1).action, 'add pack size');
  await add('pallet', 2000);  // S74: one item may have several sizes

  const fixed = await call(db, 'change_pack_size', ann.id, crypto.randomUUID(), carton.id, 1, 25);
  assert.deepEqual(fixed, { ...carton, pieces: 25, version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'change pack size');
  assert.deepEqual([last.old_value, last.new_value], [carton, fixed]);

  const before = (await logRows(db)).length;
  const cases = [
    ['a size of 0 (S40)', () => add('box', 0), 'IV400'],
    ['a size that is not a whole number', () => add('box', 2.5), 'IV400'],
    ['a kind not on the list', () => add('bundle', 10), 'IV400'],
    ['a size the item already has', () => add('carton', 25), 'IV400'],
    ['an item that does not exist', () => add('box', 10, { id: 999999 }), 'IV400'],
    ['a change to 0', () => call(db, 'change_pack_size', ann.id, crypto.randomUUID(), carton.id, 2, 0), 'IV400'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
  await refused(call(db, 'change_pack_size', ann.id, crypto.randomUUID(), carton.id, 1, 30), 'IV409', 'a stale version');
});

test('an LVL threshold is set per depth in linear feet, blank or 0 or more, and logged', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl',
    { product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 48 });
  const set = (depth, version, lf) =>
    call(db, 'set_lvl_depth_threshold', ann.id, crypto.randomUUID(), depth, version, lf);

  // A depth with no threshold yet has no version; the first save gives it one.
  const first = await set('11-7/8', null, 960);
  assert.deepEqual(first, { depth: '11-7/8', threshold_lf: 960, version: 1 });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value], ['set LVL depth threshold', null, first]);
  const blank = await set('11-7/8', 1, null);
  assert.deepEqual(blank, { ...first, threshold_lf: null, version: 2 });

  const before = (await logRows(db)).length;
  const cases = [
    ['a negative threshold', () => set('11-7/8', 2, -1), 'IV400'],
    ['a depth no LVL item has', () => set('22', null, 480), 'IV400'],
    ['a stale version', () => set('11-7/8', 1, 720), 'IV409'],
    ['a second first save', () => set('11-7/8', null, 720), 'IV409'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('suppliers are added and renamed, and one name is never listed twice', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const boise = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), ' Boise Cascade ');
  assert.deepEqual(boise, { id: boise.id, name: 'Boise Cascade', version: 1 });
  assert.equal((await logRows(db)).at(-1).action, 'add supplier');

  const renamed = await call(db, 'rename_supplier', ann.id, crypto.randomUUID(), boise.id, 1, 'Boise Cascade BMD');
  assert.deepEqual(renamed, { ...boise, name: 'Boise Cascade BMD', version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value], ['rename supplier', boise, renamed]);

  const before = (await logRows(db)).length;
  const cases = [
    ['a blank name', () => call(db, 'add_supplier', ann.id, crypto.randomUUID(), '  '), 'IV400'],
    ['a name already listed, in other capitals',
      () => call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'boise cascade bmd'), 'IV400'],
    ['a stale rename', () => call(db, 'rename_supplier', ann.id, crypto.randomUUID(), boise.id, 1, 'X'), 'IV409'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('reasons: the five the app relies on are there from the start; others are added, retired and un-retired', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const listed = await as(db, APP, async (app) =>
    (await app.query('SELECT text, active, built_in FROM inv.reasons ORDER BY text')).rows);
  assert.deepEqual(listed.map((r) => r.text), ['Damaged – scrapped', 'Opening balance (web app)', 'Remake',
    'Returned from job site', 'Weathered – trimmed']);
  assert.ok(listed.every((r) => r.active && r.built_in), 'the five start active and built in');

  const miscount = await call(db, 'add_reason', ann.id, crypto.randomUUID(), ' Miscounted ');
  assert.deepEqual(miscount, { id: miscount.id, text: 'Miscounted', active: true, built_in: false, version: 1 });
  const retired = await call(db, 'retire_reason', ann.id, crypto.randomUUID(), miscount.id, 1);
  assert.deepEqual(retired, { ...miscount, active: false, version: 2 });
  assert.deepEqual((await call(db, 'unretire_reason', ann.id, crypto.randomUUID(), miscount.id, 2)),
    { ...miscount, version: 3 });
  assert.deepEqual((await logRows(db)).slice(-3).map((r) => r.action),
    ['add reason', 'retire reason', 'un-retire reason']);

  const remake = await as(db, APP, async (app) =>
    (await app.query("SELECT id FROM inv.reasons WHERE text = 'Remake'")).rows[0]);
  const before = (await logRows(db)).length;
  const cases = [
    ['a blank reason', () => call(db, 'add_reason', ann.id, crypto.randomUUID(), ' '), 'IV400'],
    ['a reason already listed, in other capitals',
      () => call(db, 'add_reason', ann.id, crypto.randomUUID(), 'remake'), 'IV400'],
    ['retiring a reason the app relies on',
      () => call(db, 'retire_reason', ann.id, crypto.randomUUID(), Number(remake.id), 1), 'IV422'],
    ['un-retiring a reason in use', () => call(db, 'unretire_reason', ann.id, crypto.randomUUID(), miscount.id, 3), 'IV422'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test("lumber buying options start as the engine's default menu, and each change is shared and logged", async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const readLengths = () => as(db, APP, async (app) =>
    (await app.query('SELECT size, grade, lengths, version FROM inv.lumber_purchasable_lengths')).rows);

  // Day one gives the same buy list as today.
  const seeded = Object.fromEntries((await readLengths()).map((r) => [`${r.size}|${r.grade}`, r.lengths]));
  assert.deepEqual(seeded, DEFAULT_LUMBER_MENU);

  const setLengths = (size, grade, version, lengths) =>
    call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), size, grade, version, lengths);
  const changed = await setLengths('2x4', '#2', 1, [20, 8, 16]);
  assert.deepEqual(changed, { size: '2x4', grade: '#2', lengths: [8, 16, 20], version: 2 });
  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'set lumber lengths');
  assert.deepEqual(log.old_value.lengths, DEFAULT_LUMBER_MENU['2x4|#2']);
  const added = await setLengths('2x12', '#2', null, [12, 16]);  // a group not carried before
  assert.deepEqual(added, { size: '2x12', grade: '#2', lengths: [12, 16], version: 1 });

  const redirect = await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x6', '#2', null, 'DSS');
  assert.deepEqual(redirect, { size: '2x6', from_grade: '#2', to_grade: 'DSS', version: 1 });
  const cleared = await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x6', '#2', 1, null);
  assert.deepEqual(cleared, { ...redirect, to_grade: null, version: 2 });
  assert.deepEqual((await logRows(db)).slice(-2).map((r) => r.action), ['set grade redirect', 'set grade redirect']);

  const before = (await logRows(db)).length;
  const cases = [
    ['a length of 0', () => setLengths('2x4', '#2', 2, [0, 8]), 'IV400'],
    ['a length that is not a whole number', () => setLengths('2x4', '#2', 2, [8.5]), 'IV400'],
    ['a stale version', () => setLengths('2x4', '#2', 1, [8]), 'IV409'],
    ['a blank grade', () => setLengths('2x4', ' ', null, [8]), 'IV400'],
    ['a redirect to the same grade',
      () => call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x6', '#2', 2, '#2'), 'IV400'],
  ];
  for (const [label, attempt, code] of cases) await refused(attempt(), code, label);
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('an admin renames an item, logged was → now; nobody else can, and a name in use is refused', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', HASH);
  const typo = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS288' });
  const rename = (actor, version, identity, target = typo) =>
    call(db, 'rename_item', actor.id, crypto.randomUUID(), target.id, version, identity);

  const fixed = await rename(ann, 1, { sku: ' LUS28 ' });
  assert.deepEqual(fixed, { ...typo, sku: 'LUS28', version: 2 });
  const last = (await logRows(db)).at(-1);
  assert.deepEqual([last.action, last.old_value, last.new_value], ['rename item', typo, fixed]);

  const lvl = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl',
    { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 46 });
  assert.equal((await rename(ann, 1, { product: '2.1 RigidLam LVL 1-3/4', size: '14', length_ft: 48 }, lvl)).length_ft, 48);

  await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS26' });
  const before = (await logRows(db)).length;
  await refused(rename(bob, 2, { sku: 'LUS210' }), 'IV403', 'a person who is not an admin');
  const taken = await refused(rename(ann, 2, { sku: 'LUS26' }), 'IV400', 'a name another item has');
  assert.equal(taken.message, 'LUS26 is already in the catalog.');
  await refused(rename(ann, 2, { size: '2x4', grade: '#2', length_ft: 8 }), 'IV400', "another family's fields");
  await refused(rename(ann, 1, { sku: 'LUS210' }), 'IV409', 'a stale version');
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
});

test('adding an item that is retired says to un-retire it instead', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const lu = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LU24' });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), lu.id, 1);
  const err = await refused(call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LU24' }), 'IV400', 'a retired item');
  assert.equal(err.message, 'LU24 is in the catalog but retired; un-retire it instead.');
});

test('the database refuses an item that does not fill exactly its family\'s name fields, whatever writes it', async () => {
  const db = await freshDatabase();
  await as(db, null, async (owner) => {
    const insert = (columns, values) => owner.query(
      `INSERT INTO inv.items (${columns}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`, values);
    await refused(insert('family, sku, size', ['plates', 'MT18HS 3x8', '2x4']), '23514', 'a plate with a size');
    await refused(insert('family, sku', ['lumber', '2x4']), '23514', 'lumber named by a SKU');
    await refused(insert('family, size, grade', ['lumber', '2x4', '#2']), '23514', 'lumber with no length');
    await refused(insert('family, sku', ['ewp', 'BCI 6000']), '23514', 'an EWP item before step 5');
    await insert('family, size, grade, length_ft', ['lumber', '2x4', '#2', 8]);
    await refused(owner.query("UPDATE inv.items SET sku = 'X' WHERE family = 'lumber'"), '23514', 'a SKU added to lumber');
  });
});

test('the database refuses a lumber length that is not above 0, whatever writes it', async () => {
  const db = await freshDatabase();
  await as(db, null, async (owner) => {
    const set = (lengths) => owner.query(
      "UPDATE inv.lumber_purchasable_lengths SET lengths = $1 WHERE size = '2x4' AND grade = '#2'", [lengths]);
    await refused(set([8, 0]), '23514', 'a length of 0');
    await refused(set([-2]), '23514', 'a negative length');
    await refused(set([8, null]), '23514', 'a blank length');
    await set([]);
  });
});

test('a name that differs from an item\'s name only in capitals names the same item', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const add = (family, identity) => call(db, 'add_item', ann.id, crypto.randomUUID(), family, identity);
  const lus = await add('hangers', { sku: 'LUS28' });
  let err = await refused(add('hangers', { sku: 'lus28' }), 'IV400', 'a SKU in other capitals');
  assert.match(err.message, /LUS28|lus28/);
  await refused(add('lumber', { size: '2X4', grade: '#2', length_ft: 8 }).then(() => add('lumber', { size: '2x4', grade: '#2', length_ft: 8 })),
    'IV400', 'a lumber size in other capitals');
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), lus.id, 1);
  err = await refused(add('hangers', { sku: 'Lus28' }), 'IV400', 'a retired SKU in other capitals');
  assert.match(err.message, /retired; un-retire it instead/);
  // A rename that changes only the capitals of the item's own name is allowed.
  await call(db, 'unretire_item', ann.id, crypto.randomUUID(), lus.id, 2);
  const renamed = await call(db, 'rename_item', ann.id, crypto.randomUUID(), lus.id, 3, { sku: 'Lus28' });
  assert.equal(renamed.sku, 'Lus28');
});

test('a lumber group that differs from another only in capitals, or holds a "|", is refused', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const set = (size, grade) => call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), size, grade, null, [8]);
  const err = await refused(set('2x4', 'dss'), 'IV400', 'the seeded 2x4 DSS in other capitals');
  assert.equal(err.message, '2x4 dss is already on the list as 2x4 DSS.');
  await refused(set('2X4', 'DSS'), 'IV400', 'the size in other capitals');
  // The page names a group "size|grade" and splits it there again.
  await refused(set('2x4', 'A|B'), '23514', 'a grade with "|"');
  await refused(set('2x4|2x6', 'SS'), '23514', 'a size with "|"');
  await set('2x4', 'SS');
});

test('a lumber group is removed only when no length is switched on and no redirect names it', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const lengths = (size, grade, version, list) =>
    call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), size, grade, version, list);
  const remove = (size, grade, version) => call(db, 'remove_lumber_group', ann.id, crypto.randomUUID(), size, grade, version);

  await lengths('2x4', '1650', null, []);
  await refused(remove('2x4', '#2', 1), 'IV422', 'a group with lengths switched on');
  await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x4', '1650', null, 'DSS');
  await refused(remove('2x4', '1650', 1), 'IV422', 'a group redirected to another grade');
  await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x4', '1650', 1, null);
  await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x4', '#1', null, '1650');
  await refused(remove('2x4', '1650', 1), 'IV422', 'a group another grade is redirected to');
  await call(db, 'set_grade_redirect', ann.id, crypto.randomUUID(), '2x4', '#1', 1, null);
  await refused(remove('2x4', '1650', 9), 'IV409', 'a group changed since the screen read it');

  await remove('2x4', '1650', 1);
  const left = await as(db, APP, async (app) =>
    (await app.query("SELECT 1 FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '1650'")).rows);
  assert.deepEqual(left, [], 'removed');
  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'remove lumber group');
  assert.deepEqual(last.old_value, { size: '2x4', grade: '1650', lengths: [], version: 1 });
  assert.equal(last.new_value, null);
});
