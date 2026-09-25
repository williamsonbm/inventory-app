// =============================================================
// test/planner-ui.test.js — the pure helpers in the shared planner UI module.
// Run with: node --test test/planner-ui.test.js
// The DOM-facing half of planner-ui.js (dropZones, drilldowns, sorting, …)
// has no Node harness and is verified manually; this covers the pure
// classification helpers the on-hand sniffers build on, redact(), and
// jobBreakdown().
//
// Recorded-output proof for jobBreakdown (spec #72, step 1):
// port-fixtures/recorded/included-jobs-panels.json holds, as screen text,
// every per-job table the four old family pages showed in their Included Jobs
// panels. Captured 2026-09-24 from this repo at 48c5f30 ("docs: record the
// UI/UX grilling terms and the count-time decision (#71)"), clean tree. Each
// old page's own inline script ran unchanged in a Node vm with stub DOM
// elements, its plan request answered with recorded/<family>-no-stock.json;
// the Included Jobs table it painted was read back and each drill-down's
// heading, column labels, rows and footer kept as text (tags stripped,
// entities decoded, space runs collapsed). Deterministic because the input is
// the recorded body and no sort was applied, so the panel kept drop order.
// The capture script was one-off and is not kept; the old pages it ran are
// in git at that commit.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { looksLikePlateOrHangerStock, redact, jobBreakdown, pickOnHand } = require('../src/planner/planner-ui.js');

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
Delivered Date:,,Customer P.O. #:,CLM-2613489
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

// The SOLD TO / SHIP TO block, shaped like the real export: the customer name
// and the addresses sit in column 0 between the Delivery Date row and the
// Address row, with the two labels spelled down the rows one letter at a time.
const SHEET_WITH_CUSTOMER = `Quote Date:,2/2/2026,Job Number:,11601J
Delivery Date:,8/28/2026,,
Barbara Rodriguez
"Rodriguez, Barbara",S
1284 Harvest Dr
O
L
D

T
O,
8485 Quarry Ct,S
H
Address:,,Lot:,Lot-267,Subdiv:,
Job Name:,Suite 6B,Delivery Area,
`;

// A labeled value with a comma in it, which the export wraps in quotes. A pass
// that stops at the first comma leaves the rest of the value and a stray quote;
// the plates parser then reads the stray quote as the start of a quoted cell
// and merges every row after it into that one cell.
const SHEET_WITH_QUOTED_VALUES = `Delivered Date:,,Customer P.O. #:,"PO 12, rev 2"
Sales Rep:,"Thompson, Richard"
Designer,"Johnson, Lisa",Customer ID:,"708, 709"
Address:,"8485 Quarry Ct, Unit 4",Lot:,Lot-267,Subdiv:,
PLATE SUMMARY,,
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

test('redact: removes money, percentages, sales rep, designer, address, phone, customer ID and P.O. number', () => {
  const out = redact(SHEET_WITH_SENSITIVE);
  // Money on the data row and the Total row goes. The cost-only subtotal row
  // keeps a dash instead of its cost — covered by its own test below.
  for (const money of ['$4.16', '$865.13', '$88.40', '$9,701.59']) {
    assert.ok(!out.includes(money), `money value ${money} survived`);
  }
  assert.ok(!/\d%/.test(out), 'a percentage value survived');
  assert.ok(!out.includes('Richard Thompson'), 'the sales rep name survived');
  assert.ok(!out.includes('Lisa Johnson'), 'the designer name survived');
  assert.ok(!out.includes('8485 Quarry Ct'), 'the job-site address survived');
  assert.ok(!out.includes('555-0137') && !out.includes('(540)'), 'the phone number survived');
  assert.ok(!out.includes('Customer ID:,708'), 'the customer ID survived');
  assert.ok(!out.includes('CLM-2613489'), 'the customer P.O. number survived');
});

test('redact: removes a whole quoted value that has a comma in it', () => {
  const before = SHEET_WITH_QUOTED_VALUES.split('\n');
  const after = redact(SHEET_WITH_QUOTED_VALUES).split('\n');
  for (const part of ['rev 2', 'Richard', 'Lisa', '709', 'Unit 4']) {
    assert.ok(!after.join('\n').includes(part), `part of a quoted value survived: ${part}`);
  }
  for (let i = 0; i < before.length; i++) {
    assert.equal(csvCols(after[i]), csvCols(before[i]), `column count changed on row ${i}`);
  }
});

test('redact: keeps the labels, the job fields and the material data the parsers read', () => {
  const out = redact(SHEET_WITH_SENSITIVE);
  assert.ok(out.includes('Sales Rep:,'), 'the Sales Rep label was removed with its value');
  assert.ok(out.includes('Customer ID:,'), 'the Customer ID label was removed with its value');
  assert.ok(out.includes('Customer P.O. #:,'), 'the Customer P.O. # label was removed with its value');
  assert.ok(out.includes('Job Number:,11601J'), 'the job number was removed');
  assert.ok(out.includes('Job Name:,Suite 6B'), 'the job name was removed');
  assert.ok(out.includes('2x4 SP DSS'), 'a material name was removed');
  assert.ok(out.includes('Gross Profit (Margin %)'), 'a template label was removed');
});

test('redact: preserves the row count, the column count and every Total marker', () => {
  for (const sheet of [SHEET_WITH_SENSITIVE, SHEET_WITH_CUSTOMER]) {
    const before = sheet.split('\n');
    const after = redact(sheet).split('\n');
    assert.equal(after.length, before.length, 'the row count changed');
    for (let i = 0; i < before.length; i++) {
      assert.equal(csvCols(after[i]), csvCols(before[i]), `column count changed on row ${i}`);
      if (/^Total/.test(before[i])) assert.ok(/^Total/.test(after[i]), `a Total marker was lost on row ${i}`);
    }
  }
});

test('redact: never empties a row completely — a cost-only subtotal row keeps a dash, not its cost', () => {
  // `,,,,,,,"$1,871.56"` would collapse to all-commas, which terminates the
  // hangers section (spec #41 §5 constraint 1). A dash keeps the row non-blank
  // without the cost (#38, decided 2026-09-23).
  const out = redact(SHEET_WITH_SENSITIVE);
  assert.ok(!out.includes('$1,871.56'), 'the cost on the cost-only row survived');
  assert.ok(out.includes('\n,,,,,,,"-"\n'), 'the cost-only row was not kept as a dash');
});

test('redact: removes the customer name and addresses in the SOLD TO / SHIP TO block', () => {
  const out = redact(SHEET_WITH_CUSTOMER);
  for (const value of ['Barbara', 'Rodriguez', 'Harvest', 'Quarry']) {
    assert.ok(!out.includes(value), `customer value ${value} survived`);
  }
  assert.ok(out.includes('Delivery Date:,8/28/2026,,'), 'the delivery date was removed');
  assert.ok(out.includes('Job Name:,Suite 6B'), 'the job name was removed');
});

test('redact: a colon inside a customer line does not end the block early', () => {
  const sheet = SHEET_WITH_CUSTOMER.replace('1284 Harvest Dr', 'C/O Smith:\n1284 Harvest Dr');
  const out = redact(sheet);
  for (const value of ['Smith', 'Harvest', 'Quarry']) {
    assert.ok(!out.includes(value), `customer value ${value} survived`);
  }
});

test('redact: finds the end label up to 40 rows down, and leaves the block alone past that', () => {
  // Past 40 rows the layout has changed. Blanking on regardless could reach a
  // section header and drop that section from the buy list; the owner chose a
  // buy list that stays right over a customer name that stays home (#38,
  // 2026-09-23). The corpus block is 15 to 17 rows.
  const sheet = (rowsDown) => 'Delivery Date:,8/28/2026,,\nBarbara Rodriguez\n'
    + '2z4spdss,10,8-00-00\n'.repeat(rowsDown - 2) + 'Address:,,\n';
  assert.ok(!redact(sheet(40)).includes('Barbara'), 'an end label 40 rows down was not found');
  const past = redact(sheet(41));
  assert.ok(past.includes('\nBarbara Rodriguez\n'), 'the block was blanked with its end label 41 rows down');
  assert.ok(past.includes('\n2z4spdss,10,8-00-00\n'), 'a material row was blanked with no end label in reach');
});

// The two footer rows, laid out as in test/plate-fixtures/10001R-materials.csv
// (made-up values): the company, its address and phone in one quoted cell, then
// the report creator, the print date and the page count. The 50-sheet corpus
// has its footer rows stripped, so this fixture covers them.
const SHEET_WITH_FOOTER = `Gross Profit (Margin %),,,,,,,
,,,,,,,
"Oakridge Truss Co - 123 Mill Rd , Staunton VA 24401 Phone: (540) 555-0199",,,,,,,
Pat Morgan,Pat -  Date: 9/4/2026  Page: 1 of 1,9/4/2026 ,,,,,
`;

test('redact: replaces every cell of the two footer rows with a dash', () => {
  const out = redact(SHEET_WITH_FOOTER).split('\n');
  assert.equal(out[2], '-,,,,,,,');
  assert.equal(out[3], '-,-,-,,,,,');
});

test('redact: leaves the footer rows whole when either marker is missing', () => {
  // Only one of the two footer markers: the layout has changed, so the rows
  // are left alone rather than guessed at.
  const noPhone = 'Notes:,see plan,,\nPat Morgan,Pat -  Date: 9/4/2026  Page: 1 of 1,9/4/2026 ,,\n';
  assert.equal(redact(noPhone), noPhone);
  const noPage = '"Oakridge Truss Co Phone: ",,\nLUMBER SUMMARY,,\n';
  assert.equal(redact(noPage), noPage);
});

test('redact: replaces the company cells of row 1 with dashes, keeping the report title', () => {
  // parseHangerSheet reads the first cell of row 1, so the title stays.
  const out = redact(SHEET_WITH_SENSITIVE).split('\n');
  assert.equal(out[0], 'Material Summary,-,-,-,-');
});

test('redact: leaves row 1 whole when it has no Business: label', () => {
  const sheet = 'Material Summary,Oakridge Truss Co,P.O. Box 12,Staunton VA 24401\nJob Name:,Suite 6B,,\n';
  assert.equal(redact(sheet), sheet);
});

test('redact: passes through the trivial inputs untouched', () => {
  assert.equal(redact(''), '');
  assert.equal(redact(undefined), undefined);
  assert.equal(redact('SKU,Qty\n2x4,10\n'), 'SKU,Qty\n2x4,10\n');
});

// ── jobBreakdown(): one job's Included Jobs detail, for any family ──────────
// Spec #72, step 1, seam 2. Jobs are shaped like each plan route's jobs[]
// entries; the expected rows are worked by hand from those inputs.

// Columns and rows as plain text, the form a person reads off the screen: a
// browser shows a run of spaces as one, and a missing value as nothing.
const screen = (cell) => String(cell == null ? '' : cell).replace(/\s+/g, ' ').trim();
const asText = (tables) => tables.map((t) => ({
  heading: screen(t.heading),
  columns: t.columns.map((c) => c.label),
  rows: t.rows.map((r) => r.map(screen)),
  ...(t.footer ? { footer: t.footer.map(screen) } : {}),
}));

// One lumber job: two sheet lines of 2x4 #2 (3 × 16 ft + 4 × 10 ft = 88 LF),
// cut on its own into 3 boards of 16 ft and 2 boards of 20 ft (88 LF bought,
// 48 + 40 = 88; the 20 ft boards each carry two 10 ft cuts).
const LUMBER_JOB = {
  name: '10001R.csv', jobNumber: '10001R', jobName: 'Sample', deliveryDate: '9/30/2026',
  items: [
    { material: '2x4 SP No.2', qty: 3, length: '16-00-00' },
    { material: '2x4 SP No.2', qty: 4, length: '10-00-00' },
  ],
  totalLf: 88,
  totalPieces: 5,
  byGroup: [{ label: '2x4 #2', lf: 88, buyByLength: [{ stockLengthFt: 16, boards: 3 }, { stockLengthFt: 20, boards: 2 }] }],
};

test('jobBreakdown: lumber lists the sheet lines with their total linear feet', () => {
  const [lines] = asText(jobBreakdown('lumber', LUMBER_JOB));
  assert.deepEqual(lines, {
    heading: "Line items — 2 row(s) on 10001R's material sheet",
    columns: ['Material', 'Qty', 'Length'],
    rows: [['2x4 SP No.2', '3', '16-00-00'], ['2x4 SP No.2', '4', '10-00-00']],
    footer: ['Total LF', '88'],
  });
});

test('jobBreakdown: lumber lists the boards to cut per stock length beside the sheet lines', () => {
  const [, boards] = asText(jobBreakdown('lumber', LUMBER_JOB));
  assert.deepEqual(boards, {
    heading: 'Boards to cut — 5 total',
    columns: ['Size / Grade', 'Stock length', 'Boards'],
    // The size/grade label heads its group's first row only.
    rows: [['2x4 #2', '16′', '3'], ['', '20′', '2']],
    footer: ['Total LF', '88'],
  });
});

test('jobBreakdown: plates lists each plate SKU with its quantity', () => {
  const job = {
    name: '10002J.csv', jobNumber: '10002J', jobName: 'Sample', plateLines: 2, eaches: 1_260,
    items: [{ sku: 'MT20 3x4', qty: 1_200 }, { sku: 'MT20 4x6', qty: 60 }],
  };
  assert.deepEqual(asText(jobBreakdown('plates', job)), [{
    heading: "Material list — 2 plate line(s) on 10002J's sheet",
    columns: ['SKU', 'Qty'],
    rows: [['MT20 3x4', '1,200'], ['MT20 4x6', '60']],
  }]);
});

test('jobBreakdown: hangers lists each line with its section, and a line with no section reads Hangers', () => {
  const job = {
    name: '10003H.csv', jobNumber: '10003H', jobName: 'Sample', category: 'Hangers',
    lines: [{ sku: 'HUS26', qty: 12, section: 'Hangers' }, { sku: 'LUS28', qty: 4 }],
  };
  assert.deepEqual(asText(jobBreakdown('hangers', job)), [{
    heading: "Material list — 2 hanger line(s) on 10003H's sheet",
    columns: ['Size', 'Qty', 'Section'],
    rows: [['HUS26', '12', 'Hangers'], ['LUS28', '4', 'Hangers']],
  }]);
});

test('jobBreakdown: a job with no lines for its family has no breakdown', () => {
  assert.deepEqual(jobBreakdown('hangers', { name: 'x.csv', jobNumber: 'X' }), []);
});

test('jobBreakdown: LVL lists each line with its label, size, quantity (two decimals) and length, and a missing label reads —', () => {
  const job = {
    name: '10004J.csv', jobNumber: '10004J', jobName: 'Sample', totalLf: 70, byDepth: [],
    items: [
      { label: '1BM1-2', size: '2.1 RigidLam DF LVL 1-3/4 x 11-7/8', qty: 2, length: '20-00-00' },
      { size: '2.1 RigidLam DF LVL 1-3/4 x 9-1/4', qty: 1.125, length: '20-00-00' },
    ],
  };
  assert.deepEqual(asText(jobBreakdown('lvl', job)), [{
    heading: "Line items — 2 row(s) on 10004J's material sheet",
    columns: ['Label', 'Size', 'Qty', 'Length'],
    rows: [
      ['1BM1-2', '2.1 RigidLam DF LVL 1-3/4 x 11-7/8', '2', '20-00-00'],
      ['—', '2.1 RigidLam DF LVL 1-3/4 x 9-1/4', '1.13', '20-00-00'],
    ],
  }]);
});

// ── jobBreakdown() against the four old Included Jobs panels ────────────────
// Recorded-output proof that the one shared function shows what each family's
// own panel showed (spec #72, step 1, seam 2), for every job of the recorded
// 50-sheet run. See the file header for how the panels were captured.
const RECORDED = path.join(__dirname, 'port-fixtures', 'recorded');
const OLD_PANELS = JSON.parse(fs.readFileSync(path.join(RECORDED, 'included-jobs-panels.json'), 'utf8'));

for (const family of ['lumber', 'plates', 'hangers', 'lvl']) {
  test(`jobBreakdown: ${family} shows the same rows the old ${family} panel showed, for all 50 recorded jobs`, () => {
    const { jobs } = JSON.parse(fs.readFileSync(path.join(RECORDED, `${family}-no-stock.json`), 'utf8')).body;
    const old = OLD_PANELS[family];
    assert.equal(jobs.length, 50, 'the recorded run should still hold 50 jobs');
    assert.equal(old.length, jobs.length, 'one recorded panel entry per job');
    jobs.forEach((job, i) => {
      assert.equal(old[i].jobNumber, job.jobNumber, `entry ${i} is recorded for the same job`);
      assert.deepEqual(asText(jobBreakdown(family, job)), old[i].tables, `job ${job.jobNumber}`);
    });
  });
}

// ── pickOnHand(): which file each family plans against ─────────────────────
// Risk overrides size (docs/CODING-STANDARDS.md, Tests): this step selects
// which input each family's calculation reads, and the server takes a named
// on-hand file as given. Real files: the 50 corpus sheets and the four
// on-hand exports, with each family's sniffer as its section file defines it.
test('pickOnHand: each family gets its own on-hand file, and no on-hand file is planned as a job', () => {
  const vm = require('node:vm');
  const ctx = { window: {} };
  ctx.window.window = ctx.window;
  vm.createContext(ctx.window);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'planner', 'planner-ui.js'), 'utf8'), ctx.window);
  for (const f of ['lumber', 'plates', 'hangers', 'lvl']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'planner', `${f}-section.js`), 'utf8'), ctx.window);
  }
  const families = ctx.window.PlannerSections;

  const dir = (sub) => path.join(__dirname, 'port-fixtures', sub);
  let addedAt = 0;
  const read = (sub) => fs.readdirSync(dir(sub)).sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir(sub), name), 'utf8'), addedAt: ++addedAt }));
  const sheets = read('sheets');
  const files = sheets.concat(read('stock'));

  const { onHand, jobs } = pickOnHand(files, families);
  assert.deepEqual(
    Object.fromEntries(Object.entries(onHand).map(([family, f]) => [family, f.name])),
    {
      lumber: 'lumber-stock-20260902.csv',
      plates: 'plate-stock-20260902.csv',
      hangers: 'hanger-stock-20260902.csv',
      lvl: 'ewp-stock-20260902.csv',
    });
  assert.deepEqual(jobs.map((f) => f.name), sheets.map((f) => f.name), 'every sheet, and only the sheets, is a job');
});

test('pickOnHand: the last-added on-hand file a family claims wins', () => {
  const families = { lumber: { isOnHandFile: (t) => t.startsWith('size,grade') } };
  const files = [
    { name: 'old.csv', text: 'size,grade,length,qty\n', addedAt: 1 },
    { name: 'job.csv', text: 'Job Number:,1\n', addedAt: 2 },
    { name: 'new.csv', text: 'size,grade,length,qty\n', addedAt: 3 },
  ];
  const { onHand, jobs } = pickOnHand(files, families);
  assert.equal(onHand.lumber.name, 'new.csv');
  assert.deepEqual(jobs.map((f) => f.name), ['job.csv'], 'an unpicked on-hand file is still not a job');
});

test('pickOnHand: a claimed on-hand file is never a job, even when the general on-hand check misses it', () => {
  // An export whose header the shared looksLikeAnyStock check does not know.
  const families = { lvl: { isOnHandFile: (t) => t.startsWith('Board,Span') } };
  const files = [
    { name: 'odd-export.csv', text: 'Board,Span,Pieces\n', addedAt: 1 },
    { name: 'job.csv', text: 'Job Number:,1\n', addedAt: 2 },
  ];
  const { onHand, jobs } = pickOnHand(files, families);
  assert.equal(onHand.lvl.name, 'odd-export.csv');
  assert.deepEqual(jobs.map((f) => f.name), ['job.csv']);
});
