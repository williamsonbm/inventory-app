// =============================================================
// test/planner-ui.test.js — pure CSV-sniffing helpers shared by every tab.
// Run with: node --test test/planner-ui.test.js
// The DOM-facing half of planner-ui.js (dropZones, drilldowns, sorting, …)
// has no Node harness and is verified manually; this covers the pure
// classification helpers Plates and Hangers both build their isStockFile on.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikePlateOrHangerStock, redact } = require('../src/planner/planner-ui.js');

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

// ── redact(): strip the sensitive values before a sheet leaves the browser ────
// A synthetic MiTek header shaped like the real export (spec #41 §5). It carries
// the phone clause on purpose: the committed proof corpus has the phone masked
// and the footer rows stripped, so those two clauses cannot be exercised against
// it — this fixture covers phone here instead. Every other clause is also proven
// against the real corpus by test/redaction-invariance.test.js.
const SHEET_WITH_SENSITIVE = `Material Summary,Riverbend Lumber Supply,P.O. Box 1347,Grottoes VA 20335,Business:  (540) 555-0137
Quote Date:,2/2/2026,Job Number:,11601J
Order Date:,8/14/2026,Product:,EWP
Sales Rep:,Richard Thompson
Designer,Lisa Johnson,Customer ID:,708
Address:,8485 Quarry Ct,Lot:,Lot-267,Subdiv:,
Job Name:,Suite 6B,Delivery Area,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
2z4spdss,10,8-00-00,2x4 SP DSS,Regular,,80.00,53.30,$4.16,$865.13,$88.40
,,,,,,,"$1,871.56"
Gross Profit (Margin %),,,,,,,,,,42.5%
Total Lumber:,,,,,,,,,,"$9,701.59"
`;

// Split a CSV line into fields, respecting double-quoted cells, so "column
// count" means real columns — a removed comma INSIDE a quoted money value like
// "$1,871.56" must not read as a lost column.
function csvCols(line) {
  let cols = 1, inQuote = false;
  for (const ch of line) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) cols++;
  }
  return cols;
}

test('redact: removes money, percentages, sales rep, designer, address and phone', () => {
  const out = redact(SHEET_WITH_SENSITIVE);
  // Money on the data row and the Total row goes. The one exception is the
  // cost-only subtotal row, which the blank-row guard keeps whole (spec #41 §5
  // constraint 1) — covered by its own test below.
  for (const money of ['$4.16', '$865.13', '$88.40', '$9,701.59']) {
    assert.ok(!out.includes(money), `money value ${money} survived`);
  }
  assert.ok(!/\d%/.test(out), 'a percentage value survived');
  assert.ok(!out.includes('Richard Thompson'), 'the sales rep name survived');
  assert.ok(!out.includes('Lisa Johnson'), 'the designer name survived');
  assert.ok(!out.includes('8485 Quarry Ct'), 'the job-site address survived');
  assert.ok(!out.includes('555-0137') && !out.includes('(540)'), 'the phone number survived');
});

test('redact: keeps the labels, the job fields and the material data the parsers read', () => {
  const out = redact(SHEET_WITH_SENSITIVE);
  assert.ok(out.includes('Sales Rep:,'), 'the Sales Rep label was removed with its value');
  assert.ok(out.includes('Job Number:,11601J'), 'the job number was removed');
  assert.ok(out.includes('Job Name:,Suite 6B'), 'the job name was removed');
  assert.ok(out.includes('2x4 SP DSS'), 'a material name was removed');
  assert.ok(out.includes('Gross Profit (Margin %)'), 'a template label was removed');
});

test('redact: preserves the row count, the column count and every Total marker', () => {
  const out = redact(SHEET_WITH_SENSITIVE);
  const before = SHEET_WITH_SENSITIVE.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length, 'the row count changed');
  for (let i = 0; i < before.length; i++) {
    assert.equal(csvCols(after[i]), csvCols(before[i]), `column count changed on row ${i}`);
    if (/^Total/.test(before[i])) assert.ok(/^Total/.test(after[i]), `a Total marker was lost on row ${i}`);
  }
});

test('redact: never empties a row completely — a cost-only subtotal row is kept whole', () => {
  // `,,,,,,,"$1,871.56"` would collapse to all-commas, which terminates the
  // hangers section. The guard keeps the original line (spec #41 §5 constraint 1).
  const out = redact(SHEET_WITH_SENSITIVE);
  assert.ok(out.includes(',,,,,,,"$1,871.56"'), 'the cost-only row was emptied instead of kept');
});

test('redact: passes through the trivial inputs untouched', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), undefined);
  assert.equal(redact('SKU,Qty\n2x4,10\n'), 'SKU,Qty\n2x4,10\n');
});
