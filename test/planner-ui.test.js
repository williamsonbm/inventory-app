// =============================================================
// test/planner-ui.test.js — pure CSV-sniffing helpers shared by every tab.
// Run with: node --test test/planner-ui.test.js
// The DOM-facing half of planner-ui.js (dropZones, drilldowns, sorting, …)
// has no Node harness and is verified manually; this covers the pure
// classification helpers Plates and Hangers both build their isStockFile on.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikePlateOrHangerStock } = require('../src/planner/planner-ui.js');

const REAL_HANGER_STOCK = `sku,on_hand,committed,available,incoming,threshold,flag,last_counted
HUS26,20,5,15,0,0,OK,
LU24,4,0,4,10,0,OK,
`;

const EWP_STOCK = `item,span,qty
11 7/8" PJI-40,48-00-00,12
`;

const LUMBER_STOCK = `size,grade,length,qty
2x4,#2,16-00-00,120
`;

// A MiTek job summary whose "Misc Items" section (hardware not covered by a
// recognized hanger/plate SKU) used to get misread as a stock file: the raw
// substring scan found "item" in "Misc Items" and "qty" in the section's own
// "QTY,TYPE,SIZE,LENGTH" header, on two different lines, and mistook the pair
// for a stock CSV's column header. This job file then displaced the real
// stock CSV from the tab's one stock slot (pickStock keeps the newest match).
const JOB_WITH_MISC_ITEMS = `Material Summary,Sample Truss Co,P.O. Box 0000,Anytown VA 00000
Quote Date:,8/11/2026,Job Number:,10004H
Order Date:,8/14/2026,Product:,EWP
Job Name:,Sample Customer,Delivery Area,
Rectangular EWP,,,,
LABEL,SIZE,QTY,LENGTH,
2.1 RigidLam DF LVL,2.1 RigidLam DF LVL,2,10-00-00,
Misc Items,,,,,,
QTY,TYPE,SIZE,LENGTH,,NOTE,
10,,ATR1/2X48HDG,,,,
20,,DTT2Z,,,,
`;

test('looksLikePlateOrHangerStock: recognizes a real hanger/plate stock header', () => {
  assert.equal(looksLikePlateOrHangerStock(REAL_HANGER_STOCK), true);
});

test('looksLikePlateOrHangerStock: rejects EWP item/span/qty stock (has span)', () => {
  assert.equal(looksLikePlateOrHangerStock(EWP_STOCK), false);
});

test('looksLikePlateOrHangerStock: rejects lumber size/grade/length/qty stock (no sku col)', () => {
  assert.equal(looksLikePlateOrHangerStock(LUMBER_STOCK), false);
});

test('looksLikePlateOrHangerStock: a job summary\'s Misc Items section is not a stock header', () => {
  assert.equal(looksLikePlateOrHangerStock(JOB_WITH_MISC_ITEMS), false);
});
