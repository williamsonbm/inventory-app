// =============================================================
// test/lumber.test.js — Unit + HTTP suite for the Lumber planner.
// Run with: node --test test/lumber.test.js
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeLumber, canonGrade } = require('../src/lumber/normalizeLumber.js');
const { parseLumberSheet } = require('../src/lumber/parseLumberSheet.js');
const { cutMapLumber } = require('../src/lumber/lumberCutMap.js');
const { planLumber } = require('../src/lumber/planLumber.js');
const { parseLumberStockCsv } = require('../src/lumber/readLumberStockCsv.js');

// A small Roof job (Product != EWP, so parseJobCsv would reject it) with a
// LUMBER SUMMARY carrying a FALSE separator, a real data row, a per-group
// subtotal (blank MATERIAL NAME) and a second group. Also a PLATE SUMMARY after
// it, to prove the walk stops at the next section.
const JOB_A = `Material Summary,Sample Truss Co,,,
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
PLATE SUMMARY,,,,
SKU,QUANTITY,SIZE-GAUGE,WEIGHT,SQ. INCHES,UNIT COST,TOTAL
,144,MT20  1.5x4,9.94,864.00,$0.44,$51.07
`;

// A second job that adds more 2x4 #2 (to prove cross-job accumulation) and a
// material whose grade doesn't map to any menu token.
const JOB_B = `Material Summary,Sample Truss Co,,,
Quote Date:,4/18/2026,Job Number:,50002R,
Order Date:,5/22/2026,Product:,Floor,
Delivery Date:,6/26/2026,,,
Job Name:,Lot 50 Sample B,Delivery Area,,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
,,,False,,,,,,,
2x4sp2,4,8-00-00,2x4 SP No.2,Regular,,32.00,,,,
,,,False,,,,,,,
2x4ss,2,10-00-00,2x4 SP Sel Str,Regular,,20.00,,,,
`;

// size,grade,length on-hand stock: 4 usable 2x4 #2 @ 8ft and 3 2x6 #2 @ 12ft.
const STOCK_CSV = `size,grade,length,on_hand,committed,available,incoming,threshold,flag
2x4,#2,8,4,0,4,0,,
2x6,#2,12,3,0,3,10,,
`;

// ---- normalizeLumber -------------------------------------------------------

test('normalizeLumber splits size and canonicalizes grade to stock tokens', () => {
  assert.deepEqual(normalizeLumber('2x4 SP No.1'), { size: '2x4', grade: '#1', gradeKnown: true, raw: '2x4 SP No.1' });
  assert.deepEqual(normalizeLumber('2x4 SP No.2'), { size: '2x4', grade: '#2', gradeKnown: true, raw: '2x4 SP No.2' });
  assert.equal(normalizeLumber('2x6 SP DSS').grade, 'DSS');
  // The confirmed alias: sheets print "2400F 2.0E", the yard stocks "MSR2400".
  assert.equal(normalizeLumber('2x4 SP 2400F 2.0E').grade, 'MSR2400');
  assert.equal(normalizeLumber('2x12 SP No.1').size, '2x12');
});

test('normalizeLumber flags an unrecognized grade instead of guessing', () => {
  const r = normalizeLumber('2x4 SP Sel Str');
  assert.equal(r.size, '2x4');
  assert.equal(r.gradeKnown, false);
  assert.equal(canonGrade('2400').grade, 'MSR2400'); // 2400 must not read as a bare "#2"
});

// ---- parseLumberSheet ------------------------------------------------------

test('parseLumberSheet reads lumber rows on a non-EWP job, skipping FALSE/subtotal/section rows', () => {
  const res = parseLumberSheet(JOB_A);
  assert.equal(res.ok, true);
  assert.equal(res.meta.jobNumber, '50001R');
  assert.equal(res.meta.productType, 'Roof');
  // Two real data rows only — the FALSE separators, the blank-material subtotals,
  // and everything from PLATE SUMMARY onward are skipped.
  assert.equal(res.lines.length, 2);
  assert.deepEqual(res.lines[0], { material: '2x4 SP No.2', qty: 10, lengthFt: 8, rawLength: '8-00-00' });
  assert.equal(res.lines[1].material, '2x6 SP No.2');
});

test('parseLumberSheet returns ok with zero lines for a sheet that has no LUMBER SUMMARY', () => {
  const noLumber = `Material Summary,Co,,,
Quote Date:,4/1/2026,Job Number:,50003R,
Product:,,Product:,Roof,
Job Name:,No Lumber,Delivery Area,,
PLATE SUMMARY,,,,
SKU,QUANTITY,SIZE-GAUGE,WEIGHT,SQ. INCHES,UNIT COST,TOTAL
,10,MT20  2x4,1,2,$0,$0
`;
  const res = parseLumberSheet(noLumber);
  assert.equal(res.ok, true);
  assert.equal(res.lines.length, 0);
  assert.ok(res.warnings.some((w) => /No "LUMBER SUMMARY"/.test(w)), 'a sheet with no LUMBER SUMMARY must warn about it');
});

// ---- cutMapLumber ----------------------------------------------------------

test('cutMapLumber: stocked-exact draws 1:1 with zero waste', () => {
  const { draws, unmatched } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: '#2', required_length_ft: 8, qty: 10 }],
    { '2x4|#2': [8, 10, 12, 16] },
  );
  assert.equal(unmatched.length, 0);
  assert.equal(draws.length, 1);
  assert.equal(draws[0].stock_length_ft, 8);
  assert.equal(draws[0].pieces, 10);
  assert.equal(draws[0].rule, 'stocked-exact');
  assert.equal(draws[0].waste_ft_total, 0);
});

test('cutMapLumber: blocks multiple short cuts per board (yield >= 2)', () => {
  // Six 4ft cuts, only 16ft stocked -> 4 per board -> 2 boards ("block").
  const { draws } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: '#2', required_length_ft: 4, qty: 6 }],
    { '2x4|#2': [16] },
  );
  assert.equal(draws[0].pieces, 2);
  assert.equal(draws[0].rule, 'block');
});

test('cutMapLumber: a required length longer than every stocked length is unmatched, not dropped', () => {
  const { draws, unmatched } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: '#2', required_length_ft: 24, qty: 3 }],
    { '2x4|#2': [8, 12, 16, 20] },
  );
  assert.equal(draws.length, 0);
  assert.equal(unmatched.length, 1);
  assert.match(unmatched[0].reason, /exceeds longest/);
});

// ---- cutMapLumber: 2x4 #2/#1 commodity override ----------------------------
// Every carried length divides evenly into 1' and 2', so best-fit's normal
// shortest-wins tie-break would buy short stock for commodity blocking. The
// yard instead wants those cut from drop off 20' stock — see lumberCutMap.js.

test("cutMapLumber: 2x4 #2/#1 draw exact 1' and 2' cuts from 20' stock, not the shortest tie", () => {
  const { draws } = cutMapLumber(
    [
      { size_norm: '2x4', grade_norm: '#2', required_length_ft: 1, qty: 7 },
      { size_norm: '2x4', grade_norm: '#1', required_length_ft: 2, qty: 3 },
    ],
    { '2x4|#2': [6, 7, 8, 10, 12, 14, 16, 20], '2x4|#1': [10, 12, 14, 16, 20] },
  );
  const d2 = draws.find((d) => d.grade_norm === '#2');
  const d1 = draws.find((d) => d.grade_norm === '#1');
  assert.equal(d2.stock_length_ft, 20);
  assert.equal(d2.rule, 'commodity-override');
  assert.equal(d2.pieces, 1); // yield floor(20/1)=20, ceil(7/20)=1
  assert.equal(d1.stock_length_ft, 20);
  assert.equal(d1.rule, 'commodity-override');
});

test('cutMapLumber: commodity override does not apply to other grades at 1\'/2\'', () => {
  const { draws } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: 'DSS', required_length_ft: 1, qty: 4 }],
    { '2x4|DSS': [10, 12, 14, 16] },
  );
  assert.equal(draws[0].stock_length_ft, 10);
  assert.notEqual(draws[0].rule, 'commodity-override');
});

test('cutMapLumber: commodity override does not apply to other sizes at 1\'/2\'', () => {
  const { draws } = cutMapLumber(
    [{ size_norm: '2x6', grade_norm: '#2', required_length_ft: 1, qty: 4 }],
    { '2x6|#2': [10, 12, 14, 16] },
  );
  assert.equal(draws[0].stock_length_ft, 10);
  assert.notEqual(draws[0].rule, 'commodity-override');
});

test('cutMapLumber: commodity override only matches exact whole-foot 1\'/2\', not fractional lengths', () => {
  const { draws } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: '#2', required_length_ft: 1.5, qty: 4 }],
    { '2x4|#2': [6, 8, 20] },
  );
  assert.notEqual(draws[0].stock_length_ft, 20);
  assert.notEqual(draws[0].rule, 'commodity-override');
});

test('cutMapLumber: commodity override falls back silently to best-fit when 20\' is not carried', () => {
  const { draws } = cutMapLumber(
    [{ size_norm: '2x4', grade_norm: '#2', required_length_ft: 2, qty: 6 }],
    { '2x4|#2': [6, 8, 12] },
  );
  assert.equal(draws[0].stock_length_ft, 6); // best-fit's own answer, no warning/unmatched
  assert.notEqual(draws[0].rule, 'commodity-override');
});

test('cutMapLumber: commodity override draws never feed Tier-2 consolidation', () => {
  const { draws } = cutMapLumber(
    [
      { size_norm: '2x4', grade_norm: '#2', required_length_ft: 1, qty: 7 },
      { size_norm: '2x4', grade_norm: '#2', required_length_ft: 3, qty: 7 },
    ],
    { '2x4|#2': [6, 7, 8, 10, 12, 14, 16, 20] },
  );
  const overrideDraws = draws.filter((d) => d.rule === 'commodity-override');
  assert.equal(overrideDraws.length, 1);
  assert.equal(overrideDraws[0].stock_length_ft, 20);
  // No mixed/consolidated bin absorbed the 1' pieces.
  const mixed = draws.filter((d) => d.rule === 'mixed');
  for (const m of mixed) assert.ok(!m.contents.includes(1), 'no consolidated bin may absorb the 1ft commodity-override pieces');
});

// ---- planLumber ------------------------------------------------------------

test('planLumber rolls up linear feet per size/grade and packs boards greenfield', () => {
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], null);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.hasStock, false);

  const g24 = plan.bySizeGrade.find((g) => g.key === '2x4|#2');
  const g26 = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  assert.equal(g24.usedLf, 80);        // 10 x 8
  assert.equal(g24.piecesToBuy, 10);   // 8ft is stocked-exact
  assert.equal(g26.usedLf, 36);        // 3 x 12
  assert.equal(g26.piecesToBuy, 3);
  assert.equal(plan.summary.totalPiecesToBuy, 13);
  // The 8ft stock rows carry no linear-feet netting when there is no stock file.
  assert.equal(g24.stockLf, null);
});

test('planLumber breaks the pooled order down by stock length and gives per-job board plans', () => {
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], null);

  // Pooled order: 10 cuts @ 8ft -> 10 boards of 8ft; the by-length breakdown
  // sums to the headline Buy figure (this is the number that maps to packs).
  const g24 = plan.bySizeGrade.find((g) => g.key === '2x4|#2');
  assert.deepEqual(g24.buyByLength, [{ stockLengthFt: 8, boards: 10 }]);
  assert.equal(g24.buyByLength.reduce((s, b) => s + b.boards, 0), g24.piecesToBuy);

  // Per-job board plan (cut on its own): job totals its own boards, by group.
  const job = plan.jobs[0];
  assert.equal(job.totalPieces, 13);           // 10 boards (2x4) + 3 boards (2x6)
  const jg = job.byGroup.find((x) => x.key === '2x4|#2');
  assert.deepEqual(jg.buyByLength, [{ stockLengthFt: 8, boards: 10 }]);
  assert.equal(jg.inMenu, true);
});

test('planLumber accumulates the same size/grade across jobs and surfaces an unknown grade', () => {
  const plan = planLumber([
    { name: 'a.csv', text: JOB_A },
    { name: 'b.csv', text: JOB_B },
  ], null);

  const g24 = plan.bySizeGrade.find((g) => g.key === '2x4|#2');
  assert.equal(g24.usedLf, 80 + 32);   // job A 80 + job B 32
  assert.equal(g24.jobs.length, 2);

  // "2x4 SP Sel Str" has a real size but an unmapped grade: its footage is still
  // counted, and it's reported in unmatched rather than silently priced.
  assert.ok(plan.unmatched.some((u) => /Sel Str/.test(u.material) || u.grade !== '#1'), 'the unmapped "Sel Str" grade must be reported in unmatched, not silently priced');
  const gss = plan.bySizeGrade.find((g) => g.key.startsWith('2x4|') && g.key !== '2x4|#2');
  assert.ok(gss, 'the unmapped-grade group is still listed');
  assert.equal(gss.inMenu, false);
});

test('planLumber nets against on-hand: pieces split into on-hand vs buy, and LF Need/Have/Buy', () => {
  const stock = parseLumberStockCsv(STOCK_CSV);
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], stock, {});
  assert.equal(plan.hasStock, true);

  // 2x4 #2: need 10 @ 8ft; 4 usable 8ft boards on hand -> 4 from on-hand, buy 6.
  const g24 = plan.bySizeGrade.find((g) => g.key === '2x4|#2');
  assert.equal(g24.piecesOnHand, 4);
  assert.equal(g24.piecesToBuy, 6);
  assert.equal(g24.stockLf, 32);       // 4 x 8
  assert.equal(g24.neededLf, 48);      // 80 - 32
  assert.equal(g24.remainingLf, 0);

  // 2x6 #2: need 3 @ 12ft; 3 on hand -> fully covered, nothing to buy. Incoming
  // (10 boards @ 12ft) is shown, never netted.
  const g26 = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  assert.equal(g26.piecesOnHand, 3);
  assert.equal(g26.piecesToBuy, 0);
  assert.equal(g26.incomingLf, 120);
});

test('planLumber exposes rawLengths per group: distinct cut lengths, longest first, and a Need-tying total', () => {
  // One size/grade at four distinct lengths: a whole 12ft plus three 1/16-based
  // lengths (x-11-06 -> x.9479ft) that each round UP a hair. Chosen so the naive
  // sum of per-row (already-rounded) LF drifts a cent above Need — the case the
  // Raw-lengths footer must handle by tying to usedLf, not summing the rows.
  const MULTI = `Material Summary,Sample Truss Co,,,
Quote Date:,4/16/2026,Job Number:,50009R,
Order Date:,5/20/2026,Product:,Roof,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 50 Multi,Delivery Area,,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
,,,False,,,,,,,
2x4sp2,2,12-00-00,2x4 SP No.2,Regular,,24.00,,,,
,,,False,,,,,,,
2x4sp2,1,7-11-06,2x4 SP No.2,Regular,,7.95,,,,
,,,False,,,,,,,
2x4sp2,1,5-11-06,2x4 SP No.2,Regular,,5.95,,,,
,,,False,,,,,,,
2x4sp2,1,3-11-06,2x4 SP No.2,Regular,,3.95,,,,
`;
  const plan = planLumber([{ name: 'multi.csv', text: MULTI }], null);
  const g24 = plan.bySizeGrade.find((g) => g.key === '2x4|#2');

  // Four distinct lengths, sorted longest first; the near-identical x.9479 cuts
  // stay separate rows. Qty and LF are the per-length accumulation.
  assert.equal(g24.rawLengths.length, 4);
  assert.deepEqual(g24.rawLengths.map((r) => r.lengthFt), [12, 7.9479, 5.9479, 3.9479]);
  assert.deepEqual(g24.rawLengths.map((r) => r.qty), [2, 1, 1, 1]);

  // usedLf is the demand total rounded ONCE — this is the value the Raw-lengths
  // footer shows, and it equals the Need (LF) column by construction.
  assert.equal(g24.usedLf, 41.84);

  // The hazard the footer fix guards against: summing the per-row (already-
  // rounded) LF drifts above Need. If these ever agree, the drift case has
  // stopped drifting and this test no longer proves the footer must use usedLf.
  const naiveSum = Math.round(g24.rawLengths.reduce((s, r) => s + r.lf, 0) * 100) / 100;
  assert.equal(naiveSum, 41.85);
  assert.notEqual(naiveSum, g24.usedLf);
});

test('planLumber matches MiTek\'s own printed lineal-foot total against a real fixture', () => {
  const csv = fs.readFileSync(path.join(__dirname, 'lumber-fixtures', 'batch-0000-scrubbed.csv'), 'utf8');
  const plan = planLumber([{ name: 'batch-0000-scrubbed.csv', text: csv }], null);
  // The fixture's own grand-total row reads LINEAL FEET = 2885; per-group
  // subtotals read 1104 (2x4 #1) and 1563 (2x4 #2). Direct cross-check.
  assert.equal(plan.summary.totalUsedLf, 2885);
  assert.equal(plan.bySizeGrade.find((g) => g.key === '2x4|#1').usedLf, 1104);
  assert.equal(plan.bySizeGrade.find((g) => g.key === '2x4|#2').usedLf, 1563);
});

// ---- planLumber: grade redirects ------------------------------------------

test('planLumber redirect moves all of one grade\'s demand onto a stronger carried grade', () => {
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], null, { redirects: { '2x6|#2': 'DSS' } });

  // The source row stays visible (zero demand for BUYING purposes), tagged
  // with where it went — never silently dropped from the table. It still
  // shows its own original breakdown (Raw lengths / Driving usage read this),
  // just nothing to purchase under this grade.
  const fromRow = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  assert.equal(fromRow.usedLf, 0);
  // toGrade is internal-only now (byKey's own g.redirect keeps it, to build
  // redirectedIn's key) — the row's public redirect carries only what the UI
  // reads: toLabel and lf.
  assert.deepEqual(fromRow.redirect, { toLabel: '2x6 DSS', lf: 36 });
  assert.equal(fromRow.fullyRedirected, true);
  assert.deepEqual(fromRow.rawLengths, [{ lengthFt: 12, qty: 3, lf: 36 }]);
  assert.equal(fromRow.jobs.length, 1);
  assert.equal(fromRow.jobs[0].lf, 36);
  assert.equal(fromRow.piecesToBuy, 0);
  assert.deepEqual(fromRow.buyByLength, []);

  // The target row picks up the full 36 LF (3 x 12ft), packs it under its own
  // menu, and reports where it came from for the rollup note. It has no
  // native demand of its own (ownLf 0) — all 36 LF is redirected-in.
  const toRow = plan.bySizeGrade.find((g) => g.key === '2x6|DSS');
  assert.equal(toRow.usedLf, 36);
  assert.equal(toRow.fullyRedirected, false);
  assert.equal(toRow.ownLf, 0);
  assert.deepEqual(toRow.redirectedIn, [{ fromLabel: '2x6 #2', lf: 36 }]);
  assert.deepEqual(toRow.rawLengths, [{ lengthFt: 12, qty: 3, lf: 36 }]);
  assert.equal(toRow.piecesToBuy, 3);
  assert.equal(toRow.draws[0].stockLengthFt, 12);

  // Per-job breakdown follows the merge: the job's own board plan is grouped
  // under the target grade, not the original.
  const jg = plan.jobs[0].byGroup.find((x) => x.key === '2x6|DSS');
  assert.ok(jg, 'job A\'s 2x6 demand is filed under DSS after the redirect');
  assert.equal(jg.lf, 36);
  assert.ok(!plan.jobs[0].byGroup.some((x) => x.key === '2x6|#2'), 'the source grade 2x6|#2 must not remain in the per-job breakdown after the redirect');
});

test('planLumber redirect leaves on-hand stock grade-locked', () => {
  const stock = parseLumberStockCsv(STOCK_CSV);   // 3 x 2x6 #2 @12ft on hand, 10 incoming
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], stock, { redirects: { '2x6|#2': 'DSS' } });

  // The #2 stock sits fully unused — it can't satisfy DSS-labeled demand.
  const fromRow = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  assert.equal(fromRow.stockLf, 36);
  assert.equal(fromRow.remainingLf, 36);
  assert.equal(fromRow.neededLf, 0);
  assert.equal(fromRow.piecesOnHand, 0);

  // DSS has no stock of its own, so its redirected-in demand is bought fresh.
  const toRow = plan.bySizeGrade.find((g) => g.key === '2x6|DSS');
  assert.equal(toRow.stockLf, 0);
  assert.equal(toRow.neededLf, 36);
  assert.equal(toRow.piecesOnHand, 0);
  assert.equal(toRow.piecesToBuy, 3);
});

test('planLumber redirect does not chain through a second hop', () => {
  // 2x6 #2 (3 @ 12ft) and native 2x6 DSS (2 @ 10ft) on the same job, with BOTH
  // #2->DSS and DSS->MSR2400 active. Chaining would put all 56 LF on MSR2400;
  // one hop per line keeps #2's 36 LF at DSS and only DSS's own 20 LF moves on.
  const JOB_CHAIN = `Material Summary,Sample Truss Co,,,
Quote Date:,4/16/2026,Job Number:,50010R,
Order Date:,5/20/2026,Product:,Roof,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 50 Chain,Delivery Area,,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
,,,False,,,,,,,
2x6sp2,3,12-00-00,2x6 SP No.2,Regular,,36.00,,,,
,,,False,,,,,,,
2x6dss,2,10-00-00,2x6 SP DSS,Regular,,20.00,,,,
`;
  const plan = planLumber([{ name: 'chain.csv', text: JOB_CHAIN }], null, {
    redirects: { '2x6|#2': 'DSS', '2x6|DSS': 'MSR2400' },
  });

  const g2 = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  const gDss = plan.bySizeGrade.find((g) => g.key === '2x6|DSS');
  const gMsr = plan.bySizeGrade.find((g) => g.key === '2x6|MSR2400');

  assert.equal(g2.usedLf, 0);
  assert.deepEqual(g2.redirect, { toLabel: '2x6 DSS', lf: 36 });
  assert.equal(g2.fullyRedirected, true);
  // #2's own breakdown survives the redirect — its native 3 @ 12ft, not DSS's.
  assert.deepEqual(g2.rawLengths, [{ lengthFt: 12, qty: 3, lf: 36 }]);
  assert.equal(g2.piecesToBuy, 0);

  // DSS both received #2's 36 LF (a normal redirect target — that demand is
  // really, truly at DSS now, so it counts as DSS's usedLf) AND redirected
  // its OWN 20 LF onward to MSR2400 — both facts hold on the same row without
  // one clobbering the other.
  assert.equal(gDss.usedLf, 36);
  assert.deepEqual(gDss.redirect, { toLabel: '2x6 MSR2400', lf: 20 });
  assert.deepEqual(gDss.redirectedIn, [{ fromLabel: '2x6 #2', lf: 36 }]);
  // DSS is NOT "fully" redirected — it has real, nonzero demand of its own
  // (received from #2), so it keeps its REAL breakdown (what it's actually
  // buying: 3 @ 12ft from #2), not its native one (2 @ 10ft, which moved on).
  // Its OWN native share of that 36 is 0 — every bit of it came in from #2.
  assert.equal(gDss.fullyRedirected, false);
  assert.equal(gDss.ownLf, 0);
  assert.deepEqual(gDss.rawLengths, [{ lengthFt: 12, qty: 3, lf: 36 }]);
  assert.equal(gDss.piecesToBuy, 3);
  assert.equal(gDss.draws[0].stockLengthFt, 12);

  // MSR2400 only has DSS's native 20 LF — #2's 36 LF stopped at DSS, proving
  // no chaining.
  assert.equal(gMsr.usedLf, 20);
  assert.equal(gMsr.ownLf, 0);
  assert.deepEqual(gMsr.redirectedIn, [{ fromLabel: '2x6 DSS', lf: 20 }]);
  assert.deepEqual(gMsr.rawLengths, [{ lengthFt: 10, qty: 2, lf: 20 }]);
});

test('planLumber redirect: a redirected 1\' 2x4 #2 piece packs under DSS\'s own rule, not #2\'s commodity override', () => {
  // The override is keyed on (size, grade) as seen by cutMapLumber, and
  // jobDemand/residualDemand are grouped under the EFFECTIVE (post-redirect)
  // grade — so redirected demand naturally lands on the target grade's own
  // best-fit, never the source grade's commodity rule. DSS's default menu
  // ([10,12,14,16]) doesn't even carry 20', so if the override leaked through
  // by string-matching the wrong grade, this would misfire loudly.
  const JOB = `Material Summary,Sample Truss Co,,,
Quote Date:,4/16/2026,Job Number:,50011R,
Order Date:,5/20/2026,Product:,Roof,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 50 Redirect Override,Delivery Area,,
LUMBER SUMMARY,,,,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
,,,False,,,,,,,
2x4sp2,10,1-00-00,2x4 SP No.2,Regular,,10.00,,,,
`;
  const plan = planLumber([{ name: 'a.csv', text: JOB }], null, { redirects: { '2x4|#2': 'DSS' } });

  const toRow = plan.bySizeGrade.find((g) => g.key === '2x4|DSS');
  assert.equal(toRow.usedLf, 10);
  // 1' divides every DSS-carried length evenly, so DSS's own tie-break picks
  // the shortest — 10' — not the #2 rule's 20'.
  assert.equal(toRow.draws[0].stockLengthFt, 10);
  assert.notEqual(toRow.draws[0].rule, 'commodity-override');
});

test('planLumber drops an invalid redirect and warns, without touching demand', () => {
  // Five ways a redirect can be invalid: unrecognized target grade, a target
  // that doesn't outrank the source, a target that isn't carried for that
  // size (2x12 only carries MSR2400 in the default menu), a grade redirected
  // to itself (falls through to the outranks check — never special-cased,
  // so it gets the same kind of reason a real downgrade would), and a
  // malformed key with no "size|grade" shape.
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], null, {
    redirects: {
      '2x6|#2': 'BogusGrade', '2x6|DSS': '#2', '2x12|#2': '#1',
      '2x4|#2': '#2', 'garbage': 'DSS',
    },
  });

  // Nothing about the real demand changed — no group carries a `redirect`.
  const g26 = plan.bySizeGrade.find((g) => g.key === '2x6|#2');
  assert.equal(g26.usedLf, 36);
  assert.equal(g26.redirect, null);
  assert.ok(!plan.bySizeGrade.some((g) => g.redirect), 'no row anywhere carries a redirect');

  assert.ok(plan.warnings.some((w) => /BogusGrade/.test(w) && /not a recognized grade/.test(w)), 'an unrecognized redirect target must warn');
  assert.ok(plan.warnings.some((w) => /isn't stronger than/.test(w)), 'a redirect to a grade that does not outrank the source must warn');
  assert.ok(plan.warnings.some((w) => /isn't a carried grade/.test(w)), 'a redirect to a grade not carried for that size must warn');
  // A grade redirected to itself is never silently dropped — every invalid
  // entry surfaces a warning, none just vanish.
  assert.ok(plan.warnings.some((w) => /2x4 #2 → #2 skipped: #2 isn't stronger than #2/.test(w)), 'a grade redirected to itself must warn, never silently drop');
  assert.ok(plan.warnings.some((w) => /malformed redirect entry/.test(w)), 'a malformed redirect key must warn');
});

test('planLumber is pure — same inputs, identical output, inputs untouched', () => {
  const files = [{ name: 'a.csv', text: JOB_A }, { name: 'b.csv', text: JOB_B }];
  const stock = parseLumberStockCsv(STOCK_CSV);
  const before = JSON.stringify(files);
  const a = JSON.stringify(planLumber(files, stock, {}));
  const b = JSON.stringify(planLumber(files, stock, {}));
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(files), before, 'inputs must not be mutated');
});

test('src/lumber modules require no database, no fs, no network', () => {
  const dir = path.join(__dirname, '..', 'src', 'lumber');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      assert.ok(r.startsWith('./') || r.startsWith('../ewp/'),
        `${f} requires "${r}" - lumber modules may only reuse sibling or ../ewp/ helpers`);
    }
  }
});

// ---- HTTP route integration ------------------------------------------------

const { app } = require('../src/planner/server.js');

async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /lumber serves the Lumber planner page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/lumber`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>Lumber planner<\/title>/i);
  });
});

test('GET /api/lumber/menu returns the default carried-lengths seed', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/lumber/menu`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.menu['2x4|#2'], [6, 7, 8, 10, 12, 14, 16, 20]);
  });
});

test('POST /api/lumber/plan plans via HTTP, auto-detecting the stock file', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/lumber/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { name: 'a.csv', text: JOB_A },
          { name: 'stock.csv', text: STOCK_CSV },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.jobs.length, 1);
    assert.equal(data.rerouted.length, 1);
    assert.equal(data.rerouted[0].to, 'stock');
    assert.equal(data.hasStock, true);
    const g24 = data.bySizeGrade.find((g) => g.key === '2x4|#2');
    assert.equal(g24.piecesToBuy, 6);
  });
});

test('POST /api/lumber/plan honors an edited menu override', async () => {
  await withServer(async (base) => {
    // Drop 8ft from the 2x4 #2 menu. The default menu buys ten 8ft boards
    // (stocked-exact); with 8ft gone the optimizer blocks two 8ft cuts from one
    // 16ft board instead — 5 boards, zero waste — so the override demonstrably
    // changed the answer and no draw uses an 8ft board.
    const res = await fetch(`${base}/api/lumber/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'a.csv', text: JOB_A }], menu: { '2x4|#2': [10, 12, 16], '2x6|#2': [12, 16] } }),
    });
    const data = await res.json();
    const g24 = data.bySizeGrade.find((g) => g.key === '2x4|#2');
    assert.ok(g24.draws.every((d) => d.stockLengthFt !== 8), 'no draw uses the removed 8ft length');
    assert.equal(g24.piecesToBuy, 5);
    assert.equal(g24.draws[0].stockLengthFt, 16);
    assert.equal(g24.draws[0].rule, 'block');
  });
});

test('POST /api/lumber/plan applies a redirect sent from the browser', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/lumber/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ name: 'a.csv', text: JOB_A }],
        redirects: { '2x6|#2': 'DSS' },
      }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    const fromRow = data.bySizeGrade.find((g) => g.key === '2x6|#2');
    const toRow = data.bySizeGrade.find((g) => g.key === '2x6|DSS');
    assert.equal(fromRow.usedLf, 0);
    assert.deepEqual(fromRow.redirect, { toLabel: '2x6 DSS', lf: 36 });
    assert.equal(toRow.usedLf, 36);
  });
});

// ---- On-hand netting is bounded by demand, not by the on-hand file ----------
// A billion boards against this 13-piece sheet: before the fix this exhausted
// the heap, so no clock is needed.

test('a huge on-hand board count does not blow up the netting pass', () => {
  const stock = parseLumberStockCsv(`size,grade,length,on_hand
2x4,#2,8,1000000000
2x6,#2,12,1000000000
`);
  const plan = planLumber([{ name: 'a.csv', text: JOB_A }], stock);
  const row = plan.bySizeGrade.find((g) => g.key === '2x4|#2');
  assert.equal(row.piecesOnHand, 10, 'ten 8ft pieces take ten 8ft boards');
  assert.equal(row.piecesToBuy, 0);
});

// Demand side: a QTY typo past the netting ceiling is refused by name.

test('a demand group over the netting ceiling is refused by name', () => {
  const sheet = JOB_A.replace('2x4sp2,10,8-00-00', '2x4sp2,100000000,8-00-00');
  const stock = parseLumberStockCsv(STOCK_CSV);
  assert.throws(() => planLumber([{ name: 'a.csv', text: sheet }], stock),
    /2x4 #2.*100,000,000 pieces.*1,000,000/);
});
