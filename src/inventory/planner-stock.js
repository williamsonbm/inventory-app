// The Planner run with the database's inputs (#81 part 4, stories 89–90).
// Every read goes through the Planner's own login, which can change no row
// (migration 007; ADR 0001). The Planner module itself stays database-free
// (test/port-guards.test.js), so this file chooses the inputs, hands them to
// its runPlan, and adds to the answer.
//
// The choice of on-hand input: for a family that is live in Inventory, the
// database's figures, written in the web app's export format and passed
// where a dropped file goes (#81, "The app"); a dropped on-hand file is not
// used. For a family not live yet, the dropped file, as before.
//
// TEST-ONLY SEAM: `stockText` is exported for test/planner-stock.test.js,
// which feeds its text to each family's own reader (#81 Testing Decisions).

const { runPlan } = require('../planner/server.js');
const { readLumberOptions } = require('./catalog.js');

// Route → family, by the route's full literal path.
const PLAN_FAMILIES = {
  '/api/plates/plan': 'plates',
  '/api/hangers/plan': 'hangers',
  '/api/lvl/plan': 'lvl',
  '/api/lumber/plan': 'lumber',
};

// Each family's columns in the web app's export, and one item's cells.
// Committed is zero until jobs exist (step 4), so available is on hand.
const figures = (i) => [i.on_hand, 0, i.on_hand, i.incoming, i.threshold];
const STOCK_EXPORTS = {
  plates: {
    header: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted',
    cells: (i) => [i.sku, ...figures(i), '', i.last_counted],
  },
  hangers: {
    header: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted',
    cells: (i) => [i.sku, ...figures(i), '', i.last_counted],
  },
  lumber: {
    header: 'size,grade,length,on_hand,committed,available,incoming,threshold,flag',
    cells: (i) => [i.size, i.grade, i.length_ft, ...figures(i), ''],
  },
  lvl: {
    header: 'item,span,depth,on_hand,committed,committed_incoming,available,incoming,threshold,flag',
    cells: (i) => [`${i.product} x ${i.size}`, i.length_ft, i.size, i.on_hand, 0, 0, i.on_hand, i.incoming, i.threshold, ''],
  },
};

const csvCell = (v) => {
  const t = v == null ? '' : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// The family's items as its on-hand file, retired items included: what is
// on the shelf still counts.
function stockText(family, items) {
  const { header, cells } = STOCK_EXPORTS[family];
  return [header, ...items.map((i) => cells(i).map(csvCell).join(','))].join('\n') + '\n';
}

// Whether the family is live, and every item with its figures. last_counted
// is the New York date, as the web app's export writes it.
async function readPlannerStock(database, family) {
  const [{ live }] = await database.read('SELECT live FROM inv.families WHERE code = $1', [family]);
  const items = await database.read(`
    SELECT i.sku, i.product, i.size, i.grade, i.length_ft, i.threshold, f.on_hand, f.incoming,
           pg_catalog.to_char(f.counted_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS last_counted
      FROM inv.items i JOIN inv.item_figures f ON f.item_id = i.id
     WHERE i.family = $1
     ORDER BY i.id`, [family]);
  return { live, items };
}

// Every plate's pack sizes, in the rows the plate engine takes
// (src/plates/planPlates.js): one row per pack or box size, the pallet on the
// pack row if the plate has one, else on the box row, as the import's file
// (src/plates/packFactors.json) holds them. The database keeps no product
// line, so the engine gets none (Q184).
async function readPlatePacks(database) {
  const sizes = await database.read(`
    SELECT i.id, i.sku, p.kind, p.pieces
      FROM inv.items i JOIN inv.pack_sizes p ON p.item_id = i.id
     WHERE i.family = 'plates'
     ORDER BY i.id, p.kind DESC`);
  const byItem = new Map();
  for (const s of sizes) {
    if (!byItem.has(s.id)) byItem.set(s.id, { sku: s.sku, units: [], pallet: null });
    const plate = byItem.get(s.id);
    if (s.kind === 'pallet') plate.pallet = s.pieces;
    else plate.units.push({ sku: s.sku, eaches_per_unit: s.pieces, unit_label: s.kind, pallet_eaches: null, product_line: null });
  }
  const rows = [];
  for (const { sku, units, pallet } of byItem.values()) {
    // 'pack' sorts before 'box' (kind DESC above), so the pallet lands on the pack row first.
    if (pallet != null && units.length) units[0].pallet_eaches = pallet;
    else if (pallet != null) units.push({ sku, eaches_per_unit: null, unit_label: null, pallet_eaches: pallet, product_line: null });
    rows.push(...units);
  }
  return rows;
}

const hasText = (f) => typeof f?.name === 'string' && typeof f?.text === 'string' && f.text.trim() !== '';

// One plan, with the database's inputs. Returns { status, body }.
async function planFromInventory(database, route, reqBody) {
  const family = PLAN_FAMILIES[route];
  const body = { ...reqBody };
  const warnings = [];

  // A lumber plan always runs with the shared buying options: whatever menu
  // or redirects the request carries are replaced, so an old page's own copy
  // cannot change a buy list. With every length switched off the engine
  // would plan with its own default, so that plan is refused instead.
  if (family === 'lumber') {
    const { menu, redirects } = await readLumberOptions(database);
    if (!Object.keys(menu).length) {
      return { status: 400, body: { ok: false, error: 'No lumber lengths are switched on. Switch on the lengths you buy in the "Stock lengths we buy" panel of the Planner.' } };
    }
    Object.assign(body, { menu, redirects });
  }
  // Plate pack sizes likewise: always the database's (#81 change item 3).
  if (family === 'plates') body.packs = await readPlatePacks(database);

  const { live, items } = await readPlannerStock(database, family);
  if (live) {
    if (hasText(reqBody?.stock)) {
      warnings.push(`"${reqBody.stock.name}" not used: this family is live in Inventory, so the plan uses Inventory's on-hand figures.`);
    }
    body.stock = { name: 'Inventory', text: stockText(family, items) };
  }

  const result = runPlan(route, body);
  if (result.body.ok) result.body.warnings.push(...warnings);
  return result;
}

module.exports = { PLAN_FAMILIES, planFromInventory, stockText };
