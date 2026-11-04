// =============================================================
// planLvlCuts.js — "Which LVL boards does the yard pull for this one job,
// and what does it cut from each?" (#180, the rule in #178 "LVL planning")
// =============================================================
// DB-free. No caller in the app yet: test/lvl-cuts.test.js drives it until
// the jobs module commits a job's LVL as boards (#182).
//
// Lengths are decimal feet, as parseLvlSheet gives them (11′10″ = 11.8333…);
// a remainder is returned to the nearest 1/16″, the sheet's precision.
// A remainder goes back on hand rounded down to an even foot, as the yard
// counts (27′8″ → 26′); below the depth's shortest remainder kept it is scrap.
// =============================================================

"use strict";

// Fits and lengths use lumber's 1/16″ tolerance, so floating point never
// shortens 10′ to 8′ or opens a needless board.
const { TOL_FT, approxGte, nextStockedUp } = require('../lumber/lumberCutMap.js');

const SIXTEENTHS_PER_FT = 192;

/**
 * @param {{
 *   lines: Array<{ depth: string, lengthFt: number, quantity: number }>,
 *   available: Array<{ depth: string, lengthFt: number, quantity: number }>,
 *   purchasable: Record<string, number[]>,
 *   shortestKept: Record<string, number>,
 * }} input
 */
function planLvlCuts({ lines, available, purchasable, shortestKept }) {
  const depths = [];
  const atLength = [];
  for (const depth of new Set(lines.map((l) => l.depth))) {
    const pieces = lines.filter((l) => l.depth === depth)
      .flatMap((l) => Array(l.quantity).fill(l.lengthFt))
      .sort((a, b) => b - a);
    // One row per on-hand length, shortest first; a board exists only once a
    // piece opens it, so work is bounded by the job, not by on hand.
    const onHand = available.filter((a) => a.depth === depth)
      .map((a) => ({ lengthFt: a.lengthFt, unopened: a.quantity }))
      .sort((a, b) => a.lengthFt - b.lengthFt);
    const purchasableLengths = purchasable[depth] || [];
    const boards = [];
    for (const piece of pieces) {
      let board = boards.find((b) => approxGte(b.remainderFt, piece));
      if (!board) {
        const shelf = onHand.find((r) => r.unopened > 0 && approxGte(r.lengthFt, piece));
        const lengthFt = shelf ? shelf.lengthFt : nextStockedUp(piece, purchasableLengths);
        if (lengthFt === undefined) {
          const last = atLength[atLength.length - 1];
          if (last && last.depth === depth && last.lengthFt === piece) last.quantity += 1;
          else atLength.push({ depth, lengthFt: piece, quantity: 1, reason: purchasableLengths.length
            ? 'longer than every purchasable length' : 'no purchasable length' });
          continue;
        }
        if (shelf) shelf.unopened -= 1;
        board = { lengthFt, source: shelf ? 'on hand' : 'buy', pieces: [], remainderFt: lengthFt };
        boards.push(board);
      }
      board.pieces.push(piece);
      board.remainderFt -= piece;
    }
    // A missing or non-number setting would quietly misjudge every remainder.
    if (boards.length && !Number.isFinite(shortestKept[depth])) {
      throw new Error(`No shortest remainder kept for LVL depth ${depth}`);
    }
    for (const b of boards) {
      b.remainderFt = Math.max(0, Math.round(b.remainderFt * SIXTEENTHS_PER_FT) / SIXTEENTHS_PER_FT);
      const evenFt = Math.floor((b.remainderFt + TOL_FT) / 2) * 2;
      b.keptFt = evenFt >= shortestKept[depth] ? evenFt : null;
    }
    if (boards.length) depths.push({ depth, boards });
  }
  return { depths, atLength };
}

module.exports = { planLvlCuts };
