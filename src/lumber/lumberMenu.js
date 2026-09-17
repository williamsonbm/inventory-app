// =============================================================
// lumberMenu.js — the default menu of purchasable stock lengths, per size+grade.
// =============================================================
// This is the lumber analog of optimizeCuts.js's DEFAULT_PURCHASE_LENGTHS_BY_CAT:
// the single source of truth for "which stock lengths may the cut-optimizer draw
// from" when the user hasn't overridden them. It is SET by the yard, not searched
// — the packer simply opens the cheapest allowed length per board, so the menu is
// a data table, not a combinatorial choice.
//
// Seeded from the owner's carried-lengths sheet (2026-08-25). The values are
// generic lumber dimensions (nominal size, grade, stock length in feet) — no
// company-identifying content. The UI lets the user edit this per group and
// remembers their edits; this object is only the starting point and the fallback
// when a plan request carries no menu override.
//
// Keys are `${size}|${grade}` using the SAME normalized tokens as
// normalizeLumber.js and the stock CSV's size/grade columns (#1, #2, DSS,
// MSR2400) — so a job line normalized to ("2x4","#2") looks its lengths up here
// directly. A job grade with no key here is reported as `unmatched` by
// planLumber, never silently dropped.
// =============================================================

"use strict";

// size|grade -> sorted-ascending stock lengths (feet). "2x6 DSS & MSR2400" on
// the sheet shares one length set; it is stored as two keys with equal values so
// each grade resolves independently.
const DEFAULT_LUMBER_MENU = {
  '2x4|#2': [6, 7, 8, 10, 12, 14, 16, 20],
  '2x4|#1': [10, 12, 14, 16, 20],
  '2x4|DSS': [10, 12, 14, 16],
  '2x4|MSR2400': [10, 12, 14, 16],
  '2x6|#2': [10, 12, 14, 16],
  '2x6|DSS': [10, 12, 14, 16],
  '2x6|MSR2400': [10, 12, 14, 16],
  '2x8|DSS': [10, 12, 14, 16],
  '2x8|MSR2400': [10, 12, 14, 16],
  '2x10|#1': [10, 12, 14, 16],
  '2x10|DSS': [10, 12, 14, 16],
  '2x12|MSR2400': [10, 12, 14, 16],
};

// Display order for the size axis (numeric by nominal depth). Grades sort by this
// rank then alphabetically, so the editor and the results table read top-to-
// bottom the way the paper sheet does.
const SIZE_ORDER = ['2x4', '2x6', '2x8', '2x10', '2x12'];
const GRADE_ORDER = ['#1', '#2', 'DSS', 'MSR2400'];

// Order two "size|grade" keys for stable display. Unknown sizes/grades sort last,
// then lexically, so a menu the user extends still renders deterministically.
function compareMenuKeys(a, b) {
  const [sa, ga] = a.split('|');
  const [sb, gb] = b.split('|');
  const si = SIZE_ORDER.indexOf(sa);
  const sj = SIZE_ORDER.indexOf(sb);
  if (si !== sj) return (si === -1 ? 99 : si) - (sj === -1 ? 99 : sj);
  const gi = GRADE_ORDER.indexOf(ga);
  const gj = GRADE_ORDER.indexOf(gb);
  if (gi !== gj) return (gi === -1 ? 99 : gi) - (gj === -1 ? 99 : gj);
  return a.localeCompare(b);
}

// Normalize an arbitrary menu object (e.g. one POSTed from the browser after the
// user edited it) into a clean `${size}|${grade}` -> sorted number[] map. Drops
// non-positive / non-numeric lengths and empty groups so the engine never sees a
// group it can't draw from. Returns a fresh object; never mutates the input.
function sanitizeMenu(menu) {
  const out = {};
  if (!menu || typeof menu !== 'object') return out;
  for (const [key, lengths] of Object.entries(menu)) {
    if (!Array.isArray(lengths)) continue;
    const clean = [...new Set(
      lengths.map(Number).filter((n) => Number.isFinite(n) && n > 0),
    )].sort((a, b) => a - b);
    if (clean.length) out[key] = clean;
  }
  return out;
}

// Purchasing-decision "upgrade" order: weakest to strongest, for the grade-
// redirect feature (see planLumber.js's "redirects" option — swap all demand
// for one grade onto a stronger one you'd rather buy, e.g. "don't stock 2x6
// #2, put that demand on 2x6 DSS instead"). NOT the same as GRADE_ORDER above
// — that one is display order (matches the carried-lengths sheet layout);
// this is a strength ranking, confirmed with the owner. A redirect target
// must rank higher than its source: you can always over-spec to a stronger
// board, never the reverse, so the tool enforces the direction rather than
// trusting every caller to get it right. Exported and served via
// /api/lumber/menu so the "Redirect to" picker (in lumber.html's
// Stock-lengths panel) filters its options from this SAME array — not its
// own copy — so the two can't drift out of sync. resolveRedirects below is
// still what actually enforces the rule either way, so a stale client that
// missed a menu refresh just gets its pick dropped with a warning.
const GRADE_STRENGTH_ORDER = ['#2', '#1', 'DSS', 'MSR2400'];

// Does `menu` carry any stock lengths for this "size|grade" key? The one
// definition of "carried" — planLumber.js's `inMenu` fields call this
// directly instead of repeating the Boolean(menu[key] && menu[key].length)
// check inline, the way resolveRedirects already did before this was pulled out.
const isCarried = (menu, key) => Boolean(menu[key] && menu[key].length);
const outranks = (grade, than) => {
  const gi = GRADE_STRENGTH_ORDER.indexOf(grade);
  const ti = GRADE_STRENGTH_ORDER.indexOf(than);
  return gi !== -1 && ti !== -1 && gi > ti;
};

// Validate a caller-supplied redirect map ({ "size|fromGrade": "toGrade" })
// against the strength order and the effective menu. A redirect survives only
// if both grades are recognized, the target outranks the source, AND the
// target size/grade is actually carried (has stock lengths) — otherwise the
// redirect would just relabel demand onto a grade nobody can buy, trading one
// "not carried" gap for another. Invalid entries are dropped, never thrown
// and never applied silently; the caller (planLumber) turns `dropped` into
// warnings so a stale redirect (e.g. its target got un-carried mid-session)
// is visible rather than quietly ignored.
//
// @returns { redirects: Map(fromKey -> toGrade), dropped: [{ fromKey, toGrade, reason }] }
function resolveRedirects(rawRedirects, menu) {
  const redirects = new Map();
  const dropped = [];
  if (!rawRedirects || typeof rawRedirects !== 'object') return { redirects, dropped };
  for (const [fromKey, rawTo] of Object.entries(rawRedirects)) {
    const [size, fromGrade] = String(fromKey).split('|');
    const toGrade = String(rawTo || '').trim();
    // A malformed key or an empty target is dropped like any other invalid
    // redirect — reported, not silently skipped. (fromGrade === toGrade is
    // NOT special-cased here: it falls through to the outranks check below,
    // which correctly rejects it with "X isn't stronger than X" — a grade
    // never outranks itself — so the caller sees the same kind of reason a
    // real downgrade attempt would get, not silence.)
    if (!size || !fromGrade || !toGrade) {
      dropped.push({ fromKey, toGrade, reason: 'malformed redirect entry' });
      continue;
    }
    if (!GRADE_STRENGTH_ORDER.includes(fromGrade) || !GRADE_STRENGTH_ORDER.includes(toGrade)) {
      dropped.push({ fromKey, toGrade, reason: 'not a recognized grade' }); continue;
    }
    if (!outranks(toGrade, fromGrade)) { dropped.push({ fromKey, toGrade, reason: `${toGrade} isn't stronger than ${fromGrade}` }); continue; }
    if (!isCarried(menu, `${size}|${toGrade}`)) { dropped.push({ fromKey, toGrade, reason: `${toGrade} isn't a carried grade for ${size}` }); continue; }
    redirects.set(fromKey, toGrade);
  }
  return { redirects, dropped };
}

module.exports = { DEFAULT_LUMBER_MENU, compareMenuKeys, sanitizeMenu, resolveRedirects, GRADE_STRENGTH_ORDER, isCarried };
