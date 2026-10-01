// The owner's catalog import (#81 part 1, "How existing data comes in").
// Reads the web app's on-hand exports and this repo's pack-size files, and
// adds the items, pack sizes and LVL depth thresholds in one call to
// inv.import_catalog: one save, logged as one action. It only adds, so a
// second run skips what is there and never overwrites an edit made in the app.
//
// Run it over the direct connection (port 5432) with the owner's login, like
// the migrations; the app's login cannot run inv.import_catalog.
//
// Usage:
//   DIRECT_DATABASE_URL=postgres://... node src/db/import-catalog.js <admin email> \
//     <plates.csv> <hangers.csv> <lumber.csv> <ewp.csv> <special-order.csv> <lvl-depth-thresholds.csv>
//
// Inputs, each a CSV with a header row:
//   plates, hangers  the web app's exports: sku, …, threshold, …
//   lumber           the web app's export: size, grade, length, …, threshold, …
//   ewp              the web app's EWP export with "hide non-stocked" unticked;
//                    only its LVL rows are read (item, span, …, on_hand, …, threshold)
//   special-order    family, sku: the web app's plate and hanger special-order lists
//   lvl-depth-thresholds  depth, threshold_lf: read from the web app before the import
// Pack sizes come from src/plates/packFactors.json and data/hanger-cartons.csv.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const { parseCsv } = require('../plates/parseCsv.js');

const PLATE_PACKS = path.join(__dirname, '..', 'plates', 'packFactors.json');
const HANGER_CARTONS = path.join(__dirname, '..', '..', 'data', 'hanger-cartons.csv');

// The shortest LVL length carried at each depth, in feet; every 2′ length from
// there to the export's longest (48′) is an item, so an offcut always has an
// item to go back into. No 22″: no longer carried. Owner, 2026-09-30 (#81).
const LVL_SHORTEST_FT = { '9-1/2': 6, '11-7/8': 6, 14: 8, 16: 8, 18: 8, 20: 12, 24: 12 };

// MiTek writes NAILED for a site-nailed connection, which the company does not supply.
const NOT_ITEMS = { hangers: ['NAILED'] };

// Rows of a CSV file as objects keyed by its header, blank lines left out.
function readCsv(file) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows
    .filter((r) => r.some((f) => f.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] || '').trim()])));
}

// A blank threshold is "not set". Anything else goes to the database as a
// number if it is one, or as given, so the database refuses it plainly.
function threshold(raw) {
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

const squeeze = (sku) => sku.replace(/\s+/g, ' ');

// Works out everything to import from the files, and the notes to show the
// owner about what was left out. Stocking status: Special Order for the
// special-order lists, Stocked with a threshold, Non-Stock otherwise; LVL is
// Stocked where its depth has a threshold, Special Order where it has none.
function catalogFromFiles(files) {
  const items = [];
  const packSizes = [];
  const notes = [];
  const special = readCsv(files.specialOrder);

  for (const family of ['plates', 'hangers']) {
    const rows = readCsv(files[family]);
    const skus = new Set(rows.map((r) => squeeze(r.sku)));
    const specialHere = new Set(special.filter((s) => s.family === family).map((s) => squeeze(s.sku)));
    for (const r of rows) {
      const sku = squeeze(r.sku);
      if ((NOT_ITEMS[family] || []).includes(sku)) {
        notes.push(`Skipped hanger ${sku}: MiTek writes it for a site-nailed connection, which is not supplied.`);
        continue;
      }
      const t = threshold(r.threshold);
      const stocking = specialHere.has(sku) ? 'Special Order' : t === null ? 'Non-Stock' : 'Stocked';
      items.push({ family, identity: { sku }, stocking, threshold: t });
    }
    for (const sku of specialHere) {
      if (!skus.has(sku)) {
        notes.push(`Special Order ${family.replace(/s$/, '')} ${sku} is not in the ${family.replace(/s$/, '')} export, so it was not added.`);
      }
    }
  }

  for (const r of readCsv(files.lumber)) {
    const t = threshold(r.threshold);
    items.push({
      family: 'lumber',
      identity: { size: r.size, grade: r.grade, length_ft: Number(r.length) },
      stocking: t === null ? 'Non-Stock' : 'Stocked',
      threshold: t,
    });
  }

  const depths = readCsv(files.lvlDepthThresholds)
    .map((r) => ({ depth: r.depth, threshold_lf: threshold(r.threshold_lf) }));
  const stockedDepths = new Set(depths.filter((d) => d.threshold_lf !== null).map((d) => d.depth));
  for (const r of readCsv(files.ewp).filter((row) => /RigidLam/.test(row.item))) {
    const cut = r.item.lastIndexOf(' x ');
    const [product, depth, length] = [r.item.slice(0, cut), r.item.slice(cut + 3), Number(r.span)];
    const label = `LVL ${r.item} ${length}′`;
    if (!(depth in LVL_SHORTEST_FT) || length < LVL_SHORTEST_FT[depth]) {
      if (Number(r.on_hand) > 0) notes.push(`${label} holds ${r.on_hand} but is not carried, so it was not added.`);
      continue;
    }
    if (r.threshold !== '') {
      notes.push(`Dropped the threshold ${r.threshold} on ${label}: LVL thresholds are per depth.`);
    }
    items.push({
      family: 'lvl',
      identity: { product, size: depth, length_ft: length },
      stocking: stockedDepths.has(depth) ? 'Stocked' : 'Special Order',
      threshold: null,
    });
  }

  for (const p of JSON.parse(fs.readFileSync(PLATE_PACKS, 'utf8'))) {
    const identity = { sku: squeeze(p.sku) };
    packSizes.push({ family: 'plates', identity, kind: p.unit_label, pieces: p.eaches_per_unit });
    if (p.pallet_eaches != null) packSizes.push({ family: 'plates', identity, kind: 'pallet', pieces: p.pallet_eaches });
  }
  for (const c of readCsv(HANGER_CARTONS)) {
    packSizes.push({ family: 'hangers', identity: { sku: squeeze(c.sku) }, kind: c.kind, pieces: Number(c.pieces) });
  }

  // A pack size whose item is not in today's export is left out, so one
  // retired SKU never blocks the whole import.
  const known = new Set(items.map((i) => `${i.family}|${JSON.stringify(i.identity)}`));
  const kept = packSizes.filter((p) => known.has(`${p.family}|${JSON.stringify(p.identity)}`));
  for (const family of ['plates', 'hangers']) {
    const left = packSizes.filter((p) => p.family === family && !kept.includes(p)).length;
    const one = family.replace(/s$/, '');
    if (left) notes.push(`Left out ${left} ${one} pack sizes whose items are not in the ${one} export.`);
  }

  return { items, packSizes: kept, depths, notes };
}

// Imports the catalog into the database at `url` as the owner, naming the
// admin `adminEmail` as the importer. Returns what was added and skipped,
// each skipped item by name, and the notes about what was left out. A
// refusal leaves nothing saved.
async function importCatalog(url, files, adminEmail) {
  const { items, packSizes, depths, notes } = catalogFromFiles(files);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // The database refuses anyone but an active admin too, but its message
    // ("Only an active user can make changes") does not say the address is
    // the problem, so the owner is told that here first.
    const { rows } = await client.query(
      'SELECT 1 FROM inv.users WHERE email = pg_catalog.lower(pg_catalog.btrim($1)) AND active AND admin', [adminEmail]);
    if (!rows.length) {
      throw Object.assign(new Error(`No active admin has the address ${adminEmail}.`), { code: 'IV403' });
    }
    const { rows: [{ result }] } = await client.query(
      'SELECT inv.import_catalog($1, $2, $3, $4) AS result',
      [adminEmail, JSON.stringify(items), JSON.stringify(packSizes), JSON.stringify(depths)]);
    return { ...result, notes };
  } finally {
    await client.end();
  }
}

module.exports = { importCatalog };

if (require.main === module) {
  const url = process.env.DIRECT_DATABASE_URL;
  const [email, plates, hangers, lumber, ewp, specialOrder, lvlDepthThresholds] = process.argv.slice(2);
  if (!url || !lvlDepthThresholds) {
    console.error('Usage: DIRECT_DATABASE_URL=... node src/db/import-catalog.js <admin email> '
      + '<plates.csv> <hangers.csv> <lumber.csv> <ewp.csv> <special-order.csv> <lvl-depth-thresholds.csv>');
    process.exit(1);
  }
  importCatalog(url, { plates, hangers, lumber, ewp, specialOrder, lvlDepthThresholds }, email).then(
    (r) => {
      console.log(`Added ${r.added.items} items, ${r.added.pack_sizes} pack sizes, ${r.added.lvl_depth_thresholds} LVL depth thresholds.`);
      console.log(`Skipped (already there) ${r.skipped.items} items, ${r.skipped.pack_sizes} pack sizes, ${r.skipped.lvl_depth_thresholds} LVL depth thresholds.`);
      for (const item of r.skipped_items) console.log(`  Skipped, already in the catalog: ${item}`);
      for (const note of r.notes) console.log(note);
    },
    (err) => {
      console.error(`Nothing was imported: ${err.message}`);
      process.exit(1);
    });
}
