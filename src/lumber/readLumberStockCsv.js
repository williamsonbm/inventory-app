// =============================================================
// readLumberStockCsv.js — lumber on-hand CSV -> per size+grade boards on hand.
// =============================================================
// The lumber planner's second input: what dimensional lumber is already on the
// yard. A sibling reader (like readPlateStockCsv.js), NOT src/ewp/readStockCsv.js,
// because the schemas differ: a lumber board is keyed (size, grade, length) with
// size and grade in SEPARATE columns, whereas the EWP reader demands a single
// `item` column plus `span` and throws otherwise. Feeding one to the other gets
// it rejected, then mis-routed, then rejected again — two confusing errors for
// one mismatch.
//
// COLUMNS — by header name, not position (real exports carry a title line and
// vary column order):
//   size,grade,length,on_hand,committed,available,incoming,threshold,flag
// Rules ported from the EWP/plate readers, each already paid for once:
//   * `available` (on hand - committed) wins over on_hand/qty — a board promised
//     to another job can't be cut for this one.
//   * negatives clamp to 0 for planning but are counted for a warning; a negative
//     on-hand is a data fault, not an empty shelf.
//   * `incoming` is surfaced, never netted — an inbound PO may not land before the
//     job ships, so it's the buyer's call, shown beside the buy figure.
//   * blank/non-numeric rows (subtotals, spacers) are skipped, not errors.
//
// Returns { byKey, warnings }.
//   byKey     Map(`size|grade` -> { boards: [{ span, qty }], onHandLf, incomingLf })
//             boards carry the 0-clamped qty the piece-netting pass consumes;
//             incoming is kept only as the group total incomingLf (never per board).
//   warnings  human-readable data faults (negative on-hand, empty file) surfaced
//             to the buyer via planLumber; never silently dropped.
// =============================================================

"use strict";

const { parseCsv } = require('../ewp/parseCsv.js');
const { normalizeLumber, canonGrade } = require('./normalizeLumber.js');

const SIZE_COLS = ['size', 'nominal', 'item', 'product', 'description'];
const GRADE_COLS = ['grade'];
const LENGTH_COLS = ['length', 'span', 'stock_length', 'stocklength'];
const QTY_COLS = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
const INCOMING_COLS = ['incoming', 'on_po', 'on_order', 'onorder'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

function findCol(header, aliases) {
  for (const alias of aliases) {
    const i = header.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

// A lumber stock header carries size + grade + length + a quantity column. The
// `grade` column is the strong discriminator: EWP stock has item+span but no
// grade, and a MiTek material summary has none of these as a header pair.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const header = rows[r].map(norm);
    if (findCol(header, SIZE_COLS) !== -1 && findCol(header, GRADE_COLS) !== -1 &&
        findCol(header, LENGTH_COLS) !== -1 && findCol(header, QTY_COLS) !== -1) {
      return { row: r, header };
    }
  }
  return null;
}

const numOrNull = (v) => {
  const t = String(v ?? '').trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * @param   {string} text
 * @returns {{ byKey, warnings }}
 * @throws  {Error} when no recognizable header exists — a stock file that
 *          silently parses to zero rows reads as "empty yard" and prices the
 *          whole batch as a buy, the worst possible failure here.
 */
function parseLumberStockCsv(text) {
  const rows = parseCsv(String(text || ''));
  const found = findHeader(rows);
  if (!found) {
    throw new Error(
      'Not a lumber stock CSV: no header row with size, grade, length and a ' +
      `quantity column (${QTY_COLS.join('/')}) was found.`,
    );
  }
  const { row: headerRow, header } = found;

  const iSize = findCol(header, SIZE_COLS);
  const iGrade = findCol(header, GRADE_COLS);
  const iLength = findCol(header, LENGTH_COLS);
  const iQty = findCol(header, QTY_COLS);
  const iIncoming = findCol(header, INCOMING_COLS);

  const byKey = new Map();
  const warnings = [];
  const negatives = [];
  let rowCount = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cols = rows[r];
    if (!cols.length || cols.every((c) => !String(c).trim())) continue;   // blank

    const rawSize = String(cols[iSize] ?? '').trim();
    const rawGrade = String(cols[iGrade] ?? '').trim();
    if (!rawSize || !rawGrade) continue;                                  // subtotal/spacer

    const span = numOrNull(cols[iLength]);
    if (span === null || span <= 0) continue;

    const qty = numOrNull(cols[iQty]);
    if (qty === null) continue;

    // Normalize size+grade through the same canon the job side uses, so
    // "2x4"/"#2" from the file and ("2x4","#2") from a material name land on the
    // same key. Size is already short here; grade may be "#2" or "MSR2400".
    const sizeN = normalizeLumber(rawSize).size || rawSize.toLowerCase();
    const gradeN = canonGrade(rawGrade).grade;
    const key = `${sizeN}|${gradeN}`;

    if (qty < 0) negatives.push({ key, span, qty });
    // Boards are discrete: floor to whole sticks so linear-feet (qty x span) and
    // the on-hand board loop in planLumber can never disagree on a fractional row.
    const usable = Math.max(0, Math.floor(qty));
    const incoming = Math.max(0, Math.floor(iIncoming === -1 ? 0 : (numOrNull(cols[iIncoming]) || 0)));
    rowCount++;

    // On-hand boards for netting: merge duplicate (key, span) rows by summing.
    if (!byKey.has(key)) byKey.set(key, { boards: [], onHandLf: 0, incomingLf: 0 });
    const g = byKey.get(key);
    const board = g.boards.find((b) => b.span === span);
    if (board) { board.qty += usable; }
    else g.boards.push({ span, qty: usable });
    g.onHandLf += usable * span;
    g.incomingLf += incoming * span;   // group-level incoming (surfaced, never netted)
  }

  if (negatives.length) {
    const total = negatives.reduce((s, n) => s + n.qty, 0);
    warnings.push(
      `${negatives.length} lumber row${negatives.length === 1 ? '' : 's'} had a NEGATIVE ` +
      `on-hand (${total} boards total) — treated as 0 for planning. Fix with a physical ` +
      `count before trusting this plan.`,
    );
  }
  if (!rowCount) warnings.push('No usable lumber stock rows were found in this file.');

  return { byKey, warnings };
}

// Sniff for routing a dropped file. Presence of size+grade+length+qty headers is
// unique to the lumber stock file; a material summary has no such row. Cheap
// reject first — a 1 KB substring scan clears the common case (job files) without
// a full CSV parse — then confirm a real header on the rare candidate.
function looksLikeLumberStockCsv(text) {
  const head = String(text || '').slice(0, 1024).toLowerCase();
  if (!(head.includes('size') && head.includes('grade') && head.includes('length') &&
        (head.includes('available') || head.includes('qty') || head.includes('on_hand')))) {
    return false;
  }
  try {
    return !!findHeader(parseCsv(String(text || '')));
  } catch {
    return false;
  }
}

module.exports = { parseLumberStockCsv, looksLikeLumberStockCsv };
