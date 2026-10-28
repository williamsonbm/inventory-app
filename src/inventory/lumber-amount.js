// lumber-amount.js — a lumber PO line's amount in LF, board feet or pieces
// (#131, spec #127). An office person types any one; the other two fill in.
// Pieces are whole and rounded down, and LF and board feet refill from those
// whole pieces, so all three describe the same pieces. The line saves LF,
// and the database refuses LF that is not whole pieces
// (inv.check_po_line_amount).
//
// Board feet = LF × thickness × width ÷ 12, from the nominal size: a 2x4 is
// 0.667 board feet per foot. Shown to one decimal place, a whole number
// without one.
//
// Loaded by the Receive page as /lumber-amount.js, and by Node for
// test/lumber-amount.test.js.
(function (root) {
  // Board feet in one foot of the item: "2x4" is 2 × 4 ÷ 12.
  const perFoot = (item) => {
    const [thickness, width] = item.size.split('x').map(Number);
    return thickness * width / 12;
  };
  const shown = (n) => String(Math.round(n * 10) / 10);

  // One piece in LF and in board feet: what an arrow in each box adds.
  const onePiece = (item) => ({ lf: item.length_ft, boardFeet: item.length_ft * perFoot(item) });

  // All three boxes from LF, which may be part of a piece only on a line
  // saved before #131.
  function asSaved(item, lf) {
    if (lf === null || lf === undefined) return { lf: '', boardFeet: '', pieces: '' };
    return { lf: String(lf), boardFeet: shown(lf * perFoot(item)), pieces: shown(lf / item.length_ft) };
  }

  // All three boxes from the text typed in one of them ('lf', 'boardFeet'
  // or 'pieces'), in whole pieces. Blank text clears all three.
  function fill(item, box, text) {
    if (String(text).trim() === '') return asSaved(item, null);
    const perPiece = { ...onePiece(item), pieces: 1 }[box];
    // Board feet are shown rounded to 0.1, so deliberately up to 0.05 more
    // than typed counts: a shown figure typed back keeps its pieces. Without
    // it, rounding down strictly, one piece of 2x8 10′ (13.33, shown 13.3)
    // types back as 0 pieces. The cost: 5.3 board feet of 2x4 8′ (5.33 is
    // one piece) counts as one piece.
    const typed = Number(text) + (box === 'boardFeet' ? 0.05 : 0);
    const pieces = Math.max(0, Math.floor(typed / perPiece));
    return asSaved(item, pieces * item.length_ft);
  }

  const api = { fill, asSaved, onePiece };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LumberAmount = api;
})(typeof window !== 'undefined' ? window : globalThis);
