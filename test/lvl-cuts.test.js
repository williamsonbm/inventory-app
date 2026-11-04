// =============================================================
// test/lvl-cuts.test.js — Suite for planning one job's LVL cuts (#180).
// Drives planLvlCuts only (seam 2 of #178). Run with:
// node --test test/lvl-cuts.test.js
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planLvlCuts } = require('../src/lvl/planLvlCuts.js');

// The yard's settings when this ships: 48′ for 9-1/2″ through 20″, none for
// 24″, and 10′ as every depth's shortest remainder kept.
const PURCHASABLE = { '9-12': [48], '11-78': [48], '14': [48], '16': [48], '18': [48], '20': [48] };
const KEPT = { '9-12': 10, '11-78': 10, '14': 10, '16': 10, '18': 10, '20': 10, '24': 10 };

function plan({ lines, available = [], purchasable = PURCHASABLE, shortestKept = KEPT }) {
  return planLvlCuts({ lines, available, purchasable, shortestKept });
}

test('sheet 33591R: 2 × 10′ of 9-1/2″ with only 48′ purchasable cuts from one 48′ to buy, 28′ back on hand', () => {
  const out = plan({ lines: [{ depth: '9-12', lengthFt: 10, quantity: 2 }] });
  assert.deepEqual(out, {
    depths: [{ depth: '9-12', boards: [
      { lengthFt: 48, source: 'buy', pieces: [10, 10], remainderFt: 28, keptFt: 28 },
    ] }],
    atLength: [],
  });
});

test('2 × 10′ with 2 × 10′ available on hand pulls the two 10′ and buys nothing', () => {
  const out = plan({
    lines: [{ depth: '9-12', lengthFt: 10, quantity: 2 }],
    available: [{ depth: '9-12', lengthFt: 10, quantity: 2 }],
  });
  assert.deepEqual(out.depths, [{ depth: '9-12', boards: [
    { lengthFt: 10, source: 'on hand', pieces: [10], remainderFt: 0, keptFt: null },
    { lengthFt: 10, source: 'on hand', pieces: [10], remainderFt: 0, keptFt: null },
  ] }]);
});

test('pieces share an opened board: 2 × 10′ and a 20′ cut from one 48′, longest piece first', () => {
  const out = plan({ lines: [
    { depth: '9-12', lengthFt: 10, quantity: 2 },
    { depth: '9-12', lengthFt: 20, quantity: 1 },
  ] });
  assert.deepEqual(out.depths, [{ depth: '9-12', boards: [
    { lengthFt: 48, source: 'buy', pieces: [20, 10, 10], remainderFt: 8, keptFt: null },
  ] }]);
});

test('the shortest available board that fits is picked, whatever order the boards come in', () => {
  const out = plan({
    lines: [{ depth: '9-12', lengthFt: 12, quantity: 1 }],
    available: [
      { depth: '9-12', lengthFt: 48, quantity: 1 },
      { depth: '9-12', lengthFt: 10, quantity: 1 },
      { depth: '9-12', lengthFt: 20, quantity: 1 },
      { depth: '9-12', lengthFt: 14, quantity: 1 },
    ],
  });
  assert.deepEqual(out.depths[0].boards, [
    { lengthFt: 14, source: 'on hand', pieces: [12], remainderFt: 2, keptFt: null },
  ]);
});

// Sheet lengths arrive as decimal feet, as parseLvlSheet reads them.
const ft = (feet, inches = 0) => feet + inches / 12;

// One 48′ to buy for a single piece; what is left of it.
function remainderOf(piece, depth = '9-12', shortestKept = KEPT) {
  const out = plan({ lines: [{ depth, lengthFt: piece, quantity: 1 }], shortestKept });
  const [board] = out.depths[0].boards;
  return { remainderFt: board.remainderFt, keptFt: board.keptFt };
}

test('a remainder at the shortest remainder kept goes back on hand', () => {
  assert.deepEqual(remainderOf(38), { remainderFt: 10, keptFt: 10 });
});

test('a remainder is rounded down to an even foot: 11′10″ goes back as 10′, 27′8″ as 26′', () => {
  assert.deepEqual(remainderOf(ft(36, 2)), { remainderFt: ft(11, 10), keptFt: 10 });
  assert.deepEqual(remainderOf(ft(20, 4)), { remainderFt: ft(27, 8), keptFt: 26 });
});

test('a remainder below the shortest remainder kept after rounding is scrap: 9′10″', () => {
  assert.deepEqual(remainderOf(ft(38, 2)), { remainderFt: ft(9, 10), keptFt: null });
});

test("each depth uses its own shortest remainder kept", () => {
  const kept = { ...KEPT, '11-78': 14 };
  assert.deepEqual(remainderOf(36, '9-12', kept), { remainderFt: 12, keptFt: 12 });
  assert.deepEqual(remainderOf(36, '11-78', kept), { remainderFt: 12, keptFt: null });
});

test('no saw kerf: 4 × 12′ cut from one 48′', () => {
  const out = plan({ lines: [{ depth: '11-78', lengthFt: 12, quantity: 4 }] });
  assert.deepEqual(out.depths, [{ depth: '11-78', boards: [
    { lengthFt: 48, source: 'buy', pieces: [12, 12, 12, 12], remainderFt: 0, keptFt: null },
  ] }]);
});

test('pieces that add up to exactly 48′ in inches fit one 48′: 2 × 16′8″ and a 14′8″', () => {
  const out = plan({ lines: [
    { depth: '9-12', lengthFt: ft(16, 8), quantity: 2 },
    { depth: '9-12', lengthFt: ft(14, 8), quantity: 1 },
  ] });
  const boards = out.depths[0].boards;
  assert.deepEqual(boards.map((b) => [b.lengthFt, b.pieces.length, b.keptFt]), [[48, 3, null]]);
});

test('a depth with no purchasable length (24″) is committed at its own length, with that reason', () => {
  const out = plan({ lines: [{ depth: '24', lengthFt: 20, quantity: 3 }] });
  assert.deepEqual(out, {
    depths: [],
    atLength: [{ depth: '24', lengthFt: 20, quantity: 3, reason: 'no purchasable length' }],
  });
});

test('a piece longer than every purchasable length is committed at its own length, with that reason', () => {
  const out = plan({ lines: [
    { depth: '9-12', lengthFt: 52, quantity: 2 },
    { depth: '9-12', lengthFt: 10, quantity: 1 },
  ] });
  assert.deepEqual(out, {
    depths: [{ depth: '9-12', boards: [
      { lengthFt: 48, source: 'buy', pieces: [10], remainderFt: 38, keptFt: 38 },
    ] }],
    atLength: [{ depth: '9-12', lengthFt: 52, quantity: 2, reason: 'longer than every purchasable length' }],
  });
});

test('a new board is bought at the shortest purchasable length that fits', () => {
  const out = plan({
    lines: [{ depth: '14', lengthFt: 30, quantity: 1 }, { depth: '14', lengthFt: 16, quantity: 1 }],
    purchasable: { ...PURCHASABLE, '14': [48, 20, 32] },
  });
  assert.deepEqual(out.depths[0].boards.map((b) => [b.lengthFt, b.source, b.pieces]), [
    [32, 'buy', [30]],
    [20, 'buy', [16]],
  ]);
});

test('depths are never mixed: a 9-1/2″ piece is not cut from an 11-7/8″ board on hand', () => {
  const out = plan({
    lines: [{ depth: '9-12', lengthFt: 10, quantity: 1 }, { depth: '11-78', lengthFt: 30, quantity: 1 }],
    available: [{ depth: '11-78', lengthFt: 48, quantity: 1 }],
  });
  assert.deepEqual(out.depths, [
    { depth: '9-12', boards: [{ lengthFt: 48, source: 'buy', pieces: [10], remainderFt: 38, keptFt: 38 }] },
    { depth: '11-78', boards: [{ lengthFt: 48, source: 'on hand', pieces: [30], remainderFt: 18, keptFt: 18 }] },
  ]);
});

test('a piece goes into a board already opened before an unopened board on hand', () => {
  const out = plan({
    lines: [{ depth: '16', lengthFt: 12, quantity: 1 }, { depth: '16', lengthFt: 6, quantity: 1 }],
    available: [{ depth: '16', lengthFt: 20, quantity: 1 }, { depth: '16', lengthFt: 6, quantity: 1 }],
  });
  assert.deepEqual(out.depths[0].boards, [
    { lengthFt: 20, source: 'on hand', pieces: [12, 6], remainderFt: 2, keptFt: null },
  ]);
});

test('a depth with no purchasable length still cuts from a board on hand that fits; the rest is at its own length', () => {
  const out = plan({
    lines: [{ depth: '24', lengthFt: 12, quantity: 2 }],
    available: [{ depth: '24', lengthFt: 20, quantity: 1 }],
  });
  assert.deepEqual(out, {
    depths: [{ depth: '24', boards: [
      { lengthFt: 20, source: 'on hand', pieces: [12], remainderFt: 8, keptFt: null },
    ] }],
    atLength: [{ depth: '24', lengthFt: 12, quantity: 1, reason: 'no purchasable length' }],
  });
});

test('a depth with boards but no shortest remainder kept throws an error that names the depth', () => {
  assert.throws(
    () => plan({ lines: [{ depth: '9-12', lengthFt: 10, quantity: 2 }], shortestKept: {} }),
    /9-12/,
  );
});

test('a piece a hair past the board (inside the 1/16″ tolerance) leaves a remainder of 0, not below 0', () => {
  const out = plan({ lines: [{ depth: '9-12', lengthFt: 48.004, quantity: 1 }] });
  assert.deepEqual(out.depths[0].boards.map((b) => [b.lengthFt, b.remainderFt, b.keptFt]), [[48, 0, null]]);
});
