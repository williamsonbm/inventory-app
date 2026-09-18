// =============================================================
// parseCsv.js — ported from source-to-port/parseCSV.txt
// (n8n Code Node — Updated 05/25/26 6:25 AM)
// =============================================================
// Two text helpers shared by the family sheet parsers: a CSV row splitter
// and a MiTek length decoder. Neither one knows what a material sheet is.
//
//   parseCsv(text)   — splits CSV text into rows of string fields.
//   parseLength(raw) — decodes "FT-IN-SIXTEENTHS" to decimal feet.
//
// Length format from MiTek: FT-IN-SIXTEENTHS  e.g. 47-05-08
//   = 47 ft + 5 in + 8/16 in
//   = 47 + 5/12 + 8/192  (since 1 sixteenth-of-an-inch = 1/192 ft)
//
// This file held `parseJobCsv` as well, the EWP job-sheet parser. Its only
// caller was `readBatch` in src/planner/server.js, and the EWP port (#41)
// deleted that. An export with no reader does not ship, so `parseJobCsv`
// left in the same change. It survives in `materials-planner`, where the
// owner still runs the EWP tab. The four family parsers never used it:
// src/lvl/parseLvlSheet.js and src/lumber/parseLumberSheet.js each record
// why they parse their own sheet instead.
// =============================================================

// =============================================================
// HELPERS
// =============================================================

// Convert "FT-IN-SIXTEENTHS" to decimal feet.
//   "47-05-08"  -> 47 + 5/12 + 8/192 = 47.4583
//   "07-05-08"  -> 7.4583
//   "12-00-00"  -> 12
// Returns null on malformed input.
function parseLength(raw) {
  const parts = raw.split('-');
  if (parts.length !== 3) return null;
  const ft = parseInt(parts[0]);
  const inch = parseInt(parts[1]);
  const sixteenths = parseInt(parts[2]);
  if (isNaN(ft) || isNaN(inch) || isNaN(sixteenths)) return null;
  return parseFloat((ft + inch / 12 + sixteenths / 192).toFixed(4));
}

// Minimal RFC-4180-ish CSV parser.  Handles:
//   - quoted fields containing commas
//   - escaped doublequotes ("")
//   - \r\n and \n line endings
// Returns array of arrays of strings (no trimming — caller trims).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  // Flush trailing field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// parseCsv (the row splitter) is exported for readStockCsv.js. The stock CSV
// carries the same booby-trapped item strings as a material summary —
// `"11 7/8"" PJI-40"` — so it needs quote-aware splitting too, and a second
// implementation would be a second thing to get wrong.
//
// parseLength is exported for src/lvl/parseLvlSheet.js, same reasoning: the
// FT-IN-SIXTEENTHS format is a fixed MiTek convention, not something a second
// copy should ever re-derive.
module.exports = { parseCsv, parseLength };
