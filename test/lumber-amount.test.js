// =============================================================
// lumber-amount.test.js — a lumber PO line's amount in LF, board feet or
// pieces, each filling the other two (#131, spec #127).
// Run with: node --test test/lumber-amount.test.js
// =============================================================
// Pure functions of the item and the typed text, so no database. The
// whole-pieces guarantee is inv.check_po_line_amount, tested in
// purchasing.test.js.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fill, asSaved } = require('../src/inventory/lumber-amount.js');

const board = (size, length_ft) => ({ size, length_ft });

test('LF typed fills pieces, rounded down, and board feet; LF refills from the whole pieces (the spec\'s example)', () => {
  assert.deepEqual(fill(board('2x4', 8), 'lf', '100'), { lf: '96', boardFeet: '64', pieces: '12' });
});

test('board feet typed fills the other two from whole pieces, rounded down', () => {
  assert.deepEqual(fill(board('2x4', 8), 'boardFeet', '64'), { lf: '96', boardFeet: '64', pieces: '12' },
    '64 board feet is exactly 12 pieces of 2x4 8′');
  assert.deepEqual(fill(board('2x4', 8), 'boardFeet', '70'), { lf: '104', boardFeet: '69.3', pieces: '13' });
  assert.deepEqual(fill(board('2x4', 10), 'boardFeet', '6.7'), { lf: '10', boardFeet: '6.7', pieces: '1' },
    'the board feet shown for one piece, typed back, is still one piece');
  assert.deepEqual(fill(board('2x8', 10), 'boardFeet', '13.3'), { lf: '10', boardFeet: '13.3', pieces: '1' },
    'one piece is 13.33 board feet, shown as 13.3; typed back, it is still one piece');
  assert.equal(fill(board('2x8', 10), 'boardFeet', '13.2').pieces, '0');
});

test('pieces typed fill LF and board feet; part of a piece rounds down', () => {
  assert.deepEqual(fill(board('2x10', 12), 'pieces', '5'), { lf: '60', boardFeet: '100', pieces: '5' });
  assert.deepEqual(fill(board('2x4', 8), 'pieces', '12.7'), { lf: '96', boardFeet: '64', pieces: '12' });
  assert.deepEqual(fill(board('2x4', 8), 'lf', '5'), { lf: '0', boardFeet: '0', pieces: '0' }, 'less than one piece');
});

test('clearing a box clears all three, so the line has no amount', () => {
  const none = { lf: '', boardFeet: '', pieces: '' };
  for (const box of ['lf', 'boardFeet', 'pieces']) assert.deepEqual(fill(board('2x6', 16), box, ' '), none, box);
  assert.deepEqual(asSaved(board('2x6', 16), null), none, 'a saved line with no amount');
});

test('a saved amount shows as it is, even part of a piece, until a box is typed in', () => {
  assert.deepEqual(asSaved(board('2x10', 12), 1000), { lf: '1000', boardFeet: '1666.7', pieces: '83.3' },
    'Preview PO 9988 line 2, saved before #131');
  assert.deepEqual(asSaved(board('2x12', 16), 160), { lf: '160', boardFeet: '320', pieces: '10' });
});
