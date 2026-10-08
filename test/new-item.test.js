// =============================================================
// new-item.test.js — the item a person typed that the catalog lacks, for
// story 4's one-click "Add 26′ of …" while counting or receiving (#81 part 3
// group B). Run with: node --test test/new-item.test.js
// =============================================================
// A pure function of the typed text, the families and the items, so no
// database. Adding the item is inv.add_item, tested in catalog.test.js.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { missingItem } = require('../src/inventory/new-item.js');
const { itemLabel } = require('../src/inventory/catalog.js');

const FAMILIES = [
  { code: 'lumber', name: 'Lumber', identity: ['size', 'grade', 'length_ft'] },
  { code: 'plates', name: 'Plates', identity: ['sku'] },
  { code: 'hangers', name: 'Hangers', identity: ['sku'] },
  { code: 'lvl', name: 'LVL', identity: ['product', 'size', 'length_ft'] },
];
const ITEMS = [
  { id: 1, family: 'hangers', sku: 'LUS28' },
  { id: 2, family: 'lumber', size: '2x4', grade: '#2', length_ft: 16 },
  { id: 3, family: 'lvl', product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 24 },
];
const missing = (family, text) => missingItem(FAMILIES, ITEMS, family, text, itemLabel);

test('a new length of an LVL product and depth the catalog has is offered in one click (story 4)', () => {
  assert.deepEqual(missing('lvl', '2.1 RigidLam LVL 1-3/4 x 11-7/8 26'), {
    family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size: '11-7/8', length_ft: 26 },
    offer: 'Add 26′ of 2.1 RigidLam LVL 1-3/4 x 11-7/8',
  });
  // The foot mark may be typed as ' or ’ or ′, and under All the shape says LVL.
  assert.equal(missing('all', "2.1 rigidlam lvl 1-3/4 x 11-7/8 26'").offer, 'Add 26′ of 2.1 RigidLam LVL 1-3/4 x 11-7/8');
});

test('a new length of a lumber size and grade the catalog has is offered (story 4)', () => {
  assert.deepEqual(missing('lumber', '2x4 #2 18′'), {
    family: 'lumber', identity: { size: '2x4', grade: '#2', length_ft: 18 }, offer: 'Add 18′ of 2x4 #2',
  });
});

test('a SKU the catalog lacks is offered for the family shown, never under All (story 4)', () => {
  assert.deepEqual(missing('hangers', ' lus 210 '), {
    family: 'hangers', identity: { sku: 'lus 210' }, offer: 'Add lus 210 to Hangers',
  });
  assert.equal(missing('all', 'LUS210'), null, 'under All a SKU could be a plate or a hanger');
});

test('nothing is offered for an item the catalog has, or a name that is not a whole item', () => {
  const cases = [
    ['hangers', 'lus28', 'a SKU the catalog has, in other capitals'],
    ['all', 'Hangers · LUS28', 'an item the catalog has, as Receive names it under All'],
    ['lvl', '2.1 RigidLam LVL 1-3/4 x 11-7/8 24′', 'a length the catalog has'],
    ['lvl', '2.1 RigidLam LVL 1-3/4 x 14 26′', 'a depth the product does not come in: add it from the Overview'],
    ['lumber', '2x4 SPF 18′', 'a grade the size has no item in yet'],
    ['lumber', '2x4 #2', 'no length'],
    ['lvl', '2.1 RigidLam LVL 1-3/4 x 11-7/8 0', 'a length of 0'],
    ['hangers', '   ', 'nothing typed'],
    ['lumber', '2x4 #2 18 6', 'two lengths'],
  ];
  for (const [family, text, label] of cases) assert.equal(missing(family, text), null, label);
});
