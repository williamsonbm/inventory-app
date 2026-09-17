// =============================================================
// parseLumberSheet.js — PURE parser for the LUMBER SUMMARY section of a MiTek
// Material Summary CSV.
// =============================================================
// Ported from the hanger-web-app's src/parseLumberSummary.js, the same way
// parseLvlSheet.js was ported: a small, focused, per-section parser rather than
// a repurposed one. Two deliberate adaptations to this repo:
//   * it reuses the shared row-splitter and length-decoder (parseCsv,
//     parseLength) from src/ewp/parseCsv.js, so the CSV-quoting and
//     FT-IN-SIXTEENTHS rules exist in exactly one place;
//   * output keys are camelCase and the meta block matches parseLvlSheet's
//     ({ jobNumber, jobName, deliveryDate, productType }), so planLumber reads a
//     header the same way planLvl does.
//
// It does NOT gate on `Product == EWP`. Lumber lives on Roof/Floor truss jobs,
// whose Product is "Roof" or "Floor" — gating on EWP (as parseJobCsv does) would
// make every lumber sheet invisible. Same reasoning as parseLvlSheet.js.
//
// Section shape (verified against scrubbed batch exports, e.g.
// scrubbed-examples/batch-0000-scrubbed.csv):
//   LUMBER SUMMARY
//   SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL
//   ,,,False,,,,,,,                                   ← literal FALSE separator, skip
//   2x4sp1,16,10-00-00,2x4 SP No.1,Regular,,160.00,…  ← real line (LENGTH ft-in-16ths)
//   2x4sp1,68,,,,,1104.00,735.99,,,$259.71            ← per-group subtotal (blank MATERIAL NAME), skip
//   …
//   ,335,,,,0,2885,1942.71,,,"$1,079.42"              ← grand-total row (blank MATERIAL NAME), skip
//   PLATE SUMMARY,,,,                                  ← next section = terminator
// A job legitimately without a lumber section (an EWP-only job) returns
// ok:true with 0 lines and a warning — not a rejection.
//
// Returns { ok, reason, meta, lines, warnings }.
//   meta:  { jobNumber, jobName, deliveryDate, productType }
//   lines: [{ material, qty, lengthFt, rawLength }]  — lumber rows only
// =============================================================

"use strict";

const { parseCsv, parseLength } = require('../ewp/parseCsv.js');

const clean = (s) => (s == null ? '' : String(s).trim());
const isBlankRow = (r) => !r || r.every((c) => clean(c) === '');

function parseLumberSheet(csvText) {
  const rows = parseCsv(String(csvText || ''));
  const warnings = [];

  // ---- Header metadata — labels are scattered across columns, so scan the
  // first rows for any "Label:" / value pair rather than fixed positions. This
  // is the shape the scrubbed batch exports use (Job Number: in col 2, Job Name:
  // in col 0), and it tolerates minor column drift between export templates.
  let jobName = 'Unknown';
  let jobNumber = 'Unknown';
  let deliveryDate = 'Unknown';
  let productType = 'Unknown';

  for (const r of rows.slice(0, 40)) {
    for (let i = 0; i < r.length; i++) {
      const label = clean(r[i]).replace(/:$/, '').toLowerCase();
      const value = clean(r[i + 1] || '');
      if (!value) continue;
      if (label === 'job number') jobNumber = value;
      else if (label === 'job name') jobName = value;
      else if (label === 'product') productType = value;
      else if (label === 'delivery date') deliveryDate = value;
    }
  }

  const meta = { jobNumber, jobName, deliveryDate, productType };

  if (jobNumber === 'Unknown') {
    return {
      ok: false,
      reason: 'No "Job Number:" found in the header block — not a Material Summary CSV?',
      meta, lines: [], warnings,
    };
  }

  // ---- Locate the LUMBER SUMMARY section and its column header row ----
  const sectionIdx = rows.findIndex((r) => clean(r[0]).toLowerCase() === 'lumber summary');
  if (sectionIdx === -1) {
    warnings.push(`[${jobNumber}] No "LUMBER SUMMARY" section in this sheet — zero lumber lines for this job.`);
    return { ok: true, reason: null, meta, lines: [], warnings };
  }

  let headerIdx = -1;
  for (let i = sectionIdx + 1; i < Math.min(sectionIdx + 6, rows.length); i++) {
    const h = rows[i].map((c) => clean(c).toLowerCase());
    if (h.includes('qty') && h.includes('length') && h.includes('material name')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return {
      ok: false,
      reason: 'Found "LUMBER SUMMARY" but no QTY/LENGTH/MATERIAL NAME header row after it — format change?',
      meta, lines: [], warnings,
    };
  }
  const header = rows[headerIdx].map((c) => clean(c).toLowerCase());
  const qtyCol = header.indexOf('qty');
  const lengthCol = header.indexOf('length');
  const matCol = header.indexOf('material name');

  // ---- Walk data rows, capturing real lumber lines only ----
  const lines = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlankRow(r)) continue;                 // pre-data spacer rows are normal
    const first = clean(r[0]);
    const rawQty = clean(r[qtyCol]);
    const rawLength = clean(r[lengthCol]);
    const material = clean(r[matCol]);

    // Footer / next-section terminators ("PLATE SUMMARY", "Lumber Cost", "Total …").
    if (/^total\b/i.test(first) || /^total\b/i.test(rawQty) || /^total\b/i.test(material)) break;
    if (/^lumber cost$/i.test(first)) break;
    if (first && !rawQty && !rawLength && !material) break;   // next section header

    if (material.toUpperCase() === 'FALSE') continue;         // literal FALSE separator
    if (rawQty.toLowerCase() === 'qty') continue;             // repeated sub-header
    if (!material) continue;                                  // per-group subtotal / grand total

    // A real data line: qty + length + material.
    const qtyStr = rawQty.replace(/,/g, '');
    const qty = parseInt(qtyStr, 10);
    if (!Number.isFinite(qty) || String(qty) !== qtyStr.replace(/^0+(?=\d)/, '') || qty <= 0) {
      warnings.push(`[${jobNumber}] Row ${i + 1}: QTY not a positive integer ("${rawQty}") for "${material}" — line skipped, verify manually.`);
      continue;
    }

    const lengthFt = parseLength(rawLength);
    if (lengthFt === null) {
      warnings.push(`[${jobNumber}] Row ${i + 1}: unrecognized LENGTH "${rawLength}" for "${material}" — line skipped, verify manually.`);
      continue;
    }

    lines.push({ material, qty, lengthFt, rawLength });
  }

  if (!lines.length && !warnings.length) {
    warnings.push(`[${jobNumber}] LUMBER SUMMARY present but contained no data rows.`);
  }

  return { ok: true, reason: null, meta, lines, warnings };
}

module.exports = { parseLumberSheet };
