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
// Each line of the answer gets flags (#81 design item 4): when it was last
// counted, whether it is retired, whether it is in the catalog at all.
//
// TEST-ONLY SEAM: `onHandText` is exported for test/planner-inventory.test.js,
// which feeds its text to each family's own reader (#81 Testing Decisions).

const { runPlan, PLAN_ROUTES, isCsvFile } = require('../planner/server.js');
const { readLumberOptions } = require('./catalog.js');
const { cell } = require('./month-end.js');
const { OFFICE_TIME_ZONE } = require('../settings/activity.js');
const { parsePlateStockCsv } = require('../plates/readPlateStockCsv.js');
const { parseHangerStockCsv } = require('../hangers/readHangerStockCsv.js');
const { parseLumberStockCsv } = require('../lumber/readLumberStockCsv.js');
const { parseStockCsv } = require('../ewp/readStockCsv.js');

// Each family's columns in the web app's export, and one item's cells.
const figures = (i) => [i.on_hand, i.committed, i.available, i.incoming, i.threshold];
const SKU_EXPORT = {
  header: 'sku,on_hand,committed,available,incoming,threshold,flag,last_counted',
  cells: (i) => [i.sku, ...figures(i), '', i.last_counted],
};
const ON_HAND_FILES = {
  plates: SKU_EXPORT,
  hangers: SKU_EXPORT,
  lumber: {
    header: 'size,grade,length,on_hand,committed,available,incoming,threshold,flag',
    cells: (i) => [i.size, i.grade, i.length_ft, ...figures(i), ''],
  },
  lvl: {
    header: 'item,span,depth,on_hand,committed,committed_incoming,available,incoming,threshold,flag',
    cells: (i) => [`${i.product} x ${i.size}`, i.length_ft, i.size, i.on_hand, i.committed, 0, i.available, i.incoming, i.threshold, ''],
  },
};

// The family's items as its on-hand file, retired items included: what is
// on the shelf still counts.
function onHandText(family, items) {
  const { header, cells } = ON_HAND_FILES[family];
  return [header, ...items.map((i) => cells(i).map((v) => cell(v ?? '')).join(','))].join('\n') + '\n';
}

// Whether the family is live, and every item with its figures. last_counted
// is the New York date, as the web app's export writes it.
async function readInventory(database, family) {
  const [[{ live }], items] = await Promise.all([
    database.read('SELECT live FROM inv.families WHERE code = $1', [family]),
    database.read(`
    SELECT i.id::int, i.version, i.active, i.sku, i.product, i.size, i.grade, i.length_ft, i.threshold, f.on_hand, f.committed, f.available, f.incoming, f.on_order,
           pg_catalog.to_char(f.counted_at AT TIME ZONE $2, 'YYYY-MM-DD') AS last_counted
      FROM inv.items i JOIN inv.item_figures f ON f.item_id = i.id
     WHERE i.family = $1
     ORDER BY i.id`, [family, OFFICE_TIME_ZONE]),
  ]);
  return { live, items };
}

// Every plate's pack sizes, one engine row (src/plates/planPlates.js) per
// size: a pallet as `pallet_eaches`, a pack or box as `eaches_per_unit`. The
// engine makes one buy option per figure and sorts them itself, so which row
// a pallet rides on changes nothing. No product line: the database keeps
// none (Q184).
async function readPlatePacks(database) {
  const sizes = await database.read(`
    SELECT i.sku, p.kind, p.pieces
      FROM inv.items i JOIN inv.pack_sizes p ON p.item_id = i.id
     WHERE i.family = 'plates'`);
  return sizes.map(({ sku, kind, pieces }) => (kind === 'pallet'
    ? { sku, eaches_per_unit: null, unit_label: null, pallet_eaches: pieces }
    : { sku, eaches_per_unit: pieces, unit_label: kind, pallet_eaches: null }));
}

// Each family's lines in the engine's answer and each line's key; an item's
// key, from its one-row on-hand text read by the family's own reader, so an
// item matches a line by the engine's own rule; `sku`, for the families a
// line adds to the catalog in one click (Q186); `byLength`, for the families
// whose lines hold several lengths (Q185).
//
// Deliberately the one-row text and the family's reader, not a key function
// per family: only the plate and hanger readers export one (skuKey), so the
// alternative is new exports from the lumber and LVL readers, ported modules
// that land byte-identical, and a second statement of each key rule.
const LINES = {
  plates: {
    lines: (b) => b.rows, key: (l) => l.key, sku: (l) => l.sku,
    itemKey: (text) => parsePlateStockCsv(text).items[0]?.key,
  },
  hangers: {
    lines: (b) => [...b.buyList, ...b.covered], key: (l) => l.key, sku: (l) => l.sku,
    itemKey: (text) => parseHangerStockCsv(text).rows[0]?.key,
  },
  lumber: {
    lines: (b) => b.bySizeGrade, key: (l) => l.key, byLength: true,
    itemKey: (text) => parseLumberStockCsv(text).byKey.keys().next().value,
  },
  lvl: {
    lines: (b) => b.byDepth, key: (l) => l.depth, byLength: true,
    itemKey: (text) => parseStockCsv(text).items[0]?.depth,
  },
};

// The oldest date, or 'never' when any item was never counted.
const oldest = (dates) => (dates.includes(null) ? 'never' : dates.sort()[0]);

// Flags for the answer's lines, by line key; a line with nothing to say has
// none. Last counted and on order only for a live family; retired when every
// item behind the line is, with what Un-retire takes (Q183).
function lineFlags(family, answer, items, live) {
  const { lines, key, sku, byLength } = LINES[family];
  const behindKey = itemsByKey(family, items);

  const flags = {};
  for (const line of lines(answer)) {
    const behind = behindKey.get(key(line)) ?? [];
    if (!behind.length) {
      // A lumber line redirected whole buys nothing, so it needs no item (Q206).
      if (!line.fullyRedirected) flags[key(line)] = catalogFlag(family, behind, sku && sku(line));
      continue;
    }
    const f = {};
    if (live) {
      f.lastCounted = oldest(behind.map((i) => i.last_counted));
      if (byLength) {
        const lengths = [...new Set(behind.map((i) => i.length_ft))];
        f.lastCountedByLength = Object.fromEntries(lengths.map((ft) =>
          [ft, oldest(behind.filter((i) => i.length_ft === ft).map((i) => i.last_counted))]));
      }
      // A PO line with no amount waits for an item behind the line (#130).
      if (behind.some((i) => i.on_order)) f.onOrder = true;
    }
    Object.assign(f, catalogFlag(family, behind));
    if (Object.keys(f).length) flags[key(line)] = f;
  }
  return flags;
}

// The family's items under their line keys, each key from the item's
// one-row on-hand text read by the family's own reader (LINES), so a line
// matches an item by the engine's own rule. Shared with Jobs (src/jobs/jobs.js).
function itemsByKey(family, items) {
  const { itemKey } = LINES[family];
  const behind = new Map();
  for (const item of items) {
    const k = itemKey(onHandText(family, [item]));
    if (k == null) continue;
    if (!behind.has(k)) behind.set(k, []);
    behind.get(k).push(item);
  }
  return behind;
}

// What a line's catalog needs, for the page's buttons (PlannerUI.flagsHtml),
// or null: Un-retire when every item behind it is retired, with what that
// takes (Q183); Add to catalog when there is none, in one click when the line
// names one SKU (Q186).
function catalogFlag(family, behind, sku) {
  if (!behind.length) return { notInCatalog: true, ...(sku && { addToCatalog: { family, identity: { sku } } }) };
  if (behind.every((i) => !i.active)) return { retired: behind.map(({ id, version }) => ({ id, version })) };
  return null;
}

const hasText = (f) => isCsvFile(f) && f.text.trim() !== '';

// The options a family's plan always takes from the database, replacing
// whatever the request carries, so an old page's own copy cannot change a
// buy list: lumber its shared buying options, plates their pack sizes (#81
// change item 3). Returns the options, or { error } to refuse the plan.
const PLAN_OPTIONS = {
  lumber: async (database) => {
    const { menu, redirects } = await readLumberOptions(database);
    // With every length switched off the engine would plan with its own default.
    if (!Object.keys(menu).length) {
      return { error: 'No lumber lengths are switched on. Switch on the lengths you buy in the "Stock lengths we buy" panel of the Planner.' };
    }
    return { menu, redirects };
  },
  plates: async (database) => ({ packs: await readPlatePacks(database) }),
};

// One plan, with the database's inputs. Returns { status, body }.
async function planFromInventory(database, route, reqBody) {
  const { family } = PLAN_ROUTES[route];
  const [options, { live, items }] = await Promise.all([
    PLAN_OPTIONS[family]?.(database) ?? {},
    readInventory(database, family),
  ]);
  if (options.error) return { status: 400, body: { ok: false, error: options.error } };
  const body = { ...reqBody, ...options };
  const warnings = [];

  if (live) {
    if (hasText(reqBody?.stock)) {
      warnings.push(`"${reqBody.stock.name}" not used: this family is live in Inventory, so the plan uses Inventory's on-hand figures.`);
    }
    body.stock = { name: 'Inventory', text: onHandText(family, items) };
  }

  const result = runPlan(route, body);
  if (result.body.ok) {
    result.body.warnings.push(...warnings);
    result.body.flags = lineFlags(family, result.body, items, live);
  }
  return result;
}

module.exports = { planFromInventory, onHandText, readInventory, itemsByKey, catalogFlag, PLAN_OPTIONS };
