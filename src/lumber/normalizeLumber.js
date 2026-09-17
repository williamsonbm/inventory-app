// =============================================================
// normalizeLumber.js — MiTek material name -> { size, grade }.
// =============================================================
// The one bit of lumber logic with no counterpart to port: in the hanger-web-app
// this split is done in the database (a generated sku_norm/size_norm/grade_norm),
// so the pure files never carry it. Here it has to live somewhere, and it lives
// here — small, explicit, and unit-tested.
//
// A job sheet names lumber in free text, "<size> <species> <grade>":
//   "2x4 SP No.2", "2x6 SP DSS", "2x4 SP 2400F 2.0E", "2x12 SP No.1"
// The stock CSV and the purchase menu key material by SIZE + GRADE only, using
// short tokens (#1, #2, DSS, MSR2400) and no species column. So this function:
//   * pulls the nominal size ("2x4") out of the name,
//   * drops the species token (SP / DF / HF / SPF — the yard stocks one species
//     per size, so it isn't part of the key),
//   * canonicalizes the remaining grade text to the stock/menu token.
//
// Grade aliases (confirmed against the owner's carried-lengths sheet, where the
// grade the sheets print as "2400F 2.0E" is stocked as "MSR2400"):
//   No.1 / #1                -> #1
//   No.2 / #2                -> #2
//   DSS                      -> DSS
//   2400F 2.0E / MSR / 2400  -> MSR2400
// Anything else passes through as-is with gradeKnown:false, so planLumber can
// surface it as unmatched rather than guess. Never throws; never mutates input.
// =============================================================

"use strict";

// Species tokens dropped from the grade text — the key is size+grade only.
const SPECIES = /\b(SP|SPF|SYP|DF|DFL|HF|HEM|FIR)\b/gi;

// Canonicalize the leftover grade text to a stock/menu token.
// Order matters: match the MSR and DSS names before the bare-digit fallback,
// because "2400F 2.0E" and "2.0E" both contain stray digits that would otherwise
// be read as a #1/#2 grade.
function canonGrade(text) {
  const t = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return { grade: 'Unknown', gradeKnown: false };
  if (/\bMSR\b/.test(t) || /2400/.test(t)) return { grade: 'MSR2400', gradeKnown: true };
  if (/\bDSS\b/.test(t)) return { grade: 'DSS', gradeKnown: true };
  if (/(?:NO\.?\s*|#\s*)1\b/.test(t) || /^1$/.test(t)) return { grade: '#1', gradeKnown: true };
  if (/(?:NO\.?\s*|#\s*)2\b/.test(t) || /^2$/.test(t)) return { grade: '#2', gradeKnown: true };
  return { grade: t, gradeKnown: false };
}

/**
 * @param   {string} material  e.g. "2x4 SP No.2"
 * @returns {{ size: string|null, grade: string, gradeKnown: boolean, raw: string }}
 */
function normalizeLumber(material) {
  const raw = String(material || '').trim();

  const m = raw.match(/(\d+)\s*[xX]\s*(\d+)/);
  const size = m ? `${parseInt(m[1], 10)}x${parseInt(m[2], 10)}` : null;

  // Grade text is whatever follows the size token, minus species.
  const rest = (m ? raw.slice(raw.indexOf(m[0]) + m[0].length) : raw).replace(SPECIES, ' ');
  const { grade, gradeKnown } = canonGrade(rest);

  return { size, grade, gradeKnown, raw };
}

// "2x4" + "#2" -> "2x4 #2" for display. Keeps the label spelling in one place.
function lumberLabel(size, grade) {
  return `${size || '?'} ${grade || ''}`.trim();
}

module.exports = { normalizeLumber, canonGrade, lumberLabel };
