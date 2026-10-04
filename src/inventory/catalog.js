// Inventory → Overview and Receive, and the catalog's Settings (#81 parts 1
// and 2): what the screens list, and the changes a signed-in person makes.
//
// Every change differs only in DATA — which database function it calls, which
// fields of the request it passes, and the name its answer goes back under —
// so the operation lives once in saveCatalogChange, and CATALOG_CHANGES keys
// that data by the route's full literal path (CODING-STANDARDS.md, Seams and
// Readers). The database function checks the version, the retry key and every
// rule again, and writes the activity-log row in the same save.

const { GRADE_STRENGTH_ORDER } = require('../lumber/lumberMenu.js');

// An item as people name it: "LUS28", "2x4 #2 16′",
// "2.1 RigidLam LVL 1-3/4 x 11-7/8 26′". The same words as inv.item_label.
function itemLabel(i) {
  if (i.sku) return i.sku;
  if (i.product) return `${i.product} x ${i.size} ${i.length_ft}′`;
  return `${i.size} ${i.grade} ${i.length_ft}′`;
}

// The only lumber sizes an item or a buying option can have, in screen
// order (inv.lumber_sizes), for the Planner's "Add size and grade" form.
async function readLumberSizes(database) {
  return (await database.read('SELECT inv.lumber_sizes() AS sizes'))[0].sizes;
}

// The families Inventory holds, for the family bar (in the Planner's order,
// so the two bars match) and "+ Add item", and
// every item with its figures (inv.item_figures). live says whether the
// family takes POs yet, and order_unit what its PO lines are ordered in. A family with no identity fields (EWP until step 5) cannot hold
// items, so it is left out. choices gives a name field's only values, which
// the page offers as a list: lumber sizes (inv.lumber_sizes). The version
// rides along so a save can say which version it read (S41).
async function listCatalog(database) {
  const [families, items] = await Promise.all([
    database.read(`
      SELECT code, name, identity, pack_kinds, live, order_unit,
             CASE code WHEN 'lumber' THEN pg_catalog.jsonb_build_object('size', inv.lumber_sizes()) END AS choices
        FROM inv.families
       WHERE identity IS NOT NULL
       ORDER BY pg_catalog.array_position(ARRAY['lumber', 'plates', 'hangers', 'lvl'], code)`),
    database.read(`
      SELECT i.id::int, i.family, i.sku, i.product, i.size, i.grade, i.length_ft, i.stocking, i.threshold, i.note,
             i.active, i.version, f.incoming, f.on_hand
        FROM inv.items i JOIN inv.item_figures f ON f.item_id = i.id
       ORDER BY i.family, i.sku, i.product, i.size, i.grade, i.length_ft`),
  ]);
  // gradeOrder: lumber grades weakest first, the engine's own ranking, so the
  // Overview sorts 2x4 #2 ahead of 2x4 #1 (owner, 2026-10-01).
  return { families, items, gradeOrder: GRADE_STRENGTH_ORDER };
}

// Route → the database function it calls, its arguments after the actor and
// the retry key, the name its answer goes back under, and whether only an
// admin may make it (the database function checks that again).
const CATALOG_CHANGES = {
  '/api/items/add': { fn: 'add_item', args: (b) => [b.family, b.identity], as: 'item' },
  '/api/items/rename': { fn: 'rename_item', args: (b) => [b.id, b.version, b.identity], as: 'item', adminOnly: true },
  '/api/items/edit': { fn: 'edit_item', args: (b) => [b.id, b.version, b.changes], as: 'item' },
  '/api/items/retire': { fn: 'retire_item', args: (b) => [b.id, b.version], as: 'item' },
  '/api/items/unretire': { fn: 'unretire_item', args: (b) => [b.id, b.version], as: 'item' },
  '/api/pack-sizes/add': { fn: 'add_pack_size', args: (b) => [b.item_id, b.kind, b.pieces], as: 'pack_size' },
  '/api/pack-sizes/change': { fn: 'change_pack_size', args: (b) => [b.id, b.version, b.pieces], as: 'pack_size' },
  '/api/suppliers/add': { fn: 'add_supplier', args: (b) => [b.name], as: 'supplier' },
  '/api/suppliers/rename': { fn: 'rename_supplier', args: (b) => [b.id, b.version, b.name], as: 'supplier' },
  '/api/reasons/add': { fn: 'add_reason', args: (b) => [b.text], as: 'reason' },
  '/api/reasons/retire': { fn: 'retire_reason', args: (b) => [b.id, b.version], as: 'reason' },
  '/api/reasons/unretire': { fn: 'unretire_reason', args: (b) => [b.id, b.version], as: 'reason' },
  '/api/lvl-depth-thresholds/set': {
    fn: 'set_lvl_depth_threshold', args: (b) => [b.depth, b.version, b.threshold_lf], as: 'threshold',
  },
  '/api/lumber/lengths': { fn: 'set_lumber_lengths', args: (b) => [b.size, b.grade, b.version, b.lengths], as: 'lengths' },
  '/api/lumber/remove': { fn: 'remove_lumber_group', args: (b) => [b.size, b.grade, b.version], as: 'removed' },
  // Inventory → Receive. A list of lines is sent as JSON text: pg would send
  // a JavaScript array as a Postgres array, which a jsonb argument refuses.
  '/api/pos/enter': {
    fn: 'enter_po', args: (b) => [b.supplier_id, b.number, b.po_date, JSON.stringify(b.lines)], as: 'po',
  },
  '/api/pos/edit': {
    fn: 'edit_po', args: (b) => [b.id, b.version, b.supplier_id, b.number, b.po_date, JSON.stringify(b.lines)], as: 'po',
  },
  // A delivery against a PO (po_id and the version the screen read) or
  // without one (supplier_id).
  '/api/receipts/receive': {
    fn: 'receive', args: (b) => [b.po_id, b.po_version, b.supplier_id, b.bol, JSON.stringify(b.lines)], as: 'receipt',
  },
  // Inventory → Overview → an item → Correct on hand: a change in pieces, + or −.
  '/api/items/correct': {
    fn: 'correct', args: (b) => [b.item_id, b.quantity, b.reason_id, b.note], as: 'correction',
  },
  '/api/pos/close-line': { fn: 'close_po_line', args: (b) => [b.id, b.po_version, b.reason_id], as: 'po' },
  '/api/pos/reopen-line': { fn: 'reopen_po_line', args: (b) => [b.id, b.po_version], as: 'po' },
  '/api/lumber/redirect': {
    fn: 'set_grade_redirect', args: (b) => [b.size, b.from_grade, b.version, b.to_grade], as: 'redirect',
  },
};

// The lumber buying options everyone shares (S37), in the shape the lumber
// engine takes: menu is "size|grade" → stock lengths, redirects is
// "size|from grade" → to grade. A group with no lengths is not bought, and
// a cleared redirect is none, so both are left out. versions carries each
// row's version, keyed the same way, so the page can say which it read (S41).
async function readLumberOptions(database) {
  const [lengths, redirects] = await Promise.all([
    database.read('SELECT size, grade, lengths, version FROM inv.lumber_purchasable_lengths WHERE NOT removed'),
    database.read('SELECT size, from_grade, to_grade, version FROM inv.lumber_grade_redirects'),
  ]);
  const options = { menu: {}, redirects: {}, versions: { lengths: {}, redirects: {} } };
  for (const l of lengths) {
    const key = `${l.size}|${l.grade}`;
    if (l.lengths.length) options.menu[key] = l.lengths;
    options.versions.lengths[key] = l.version;
  }
  for (const r of redirects) {
    const key = `${r.size}|${r.from_grade}`;
    if (r.to_grade) options.redirects[key] = r.to_grade;
    options.versions.redirects[key] = r.version;
  }
  return options;
}

// Route → what a Settings page lists, and the name the rows go back under.
// Each row has the shape its change route answers with, so a page can swap
// a saved row in place.
const SETTINGS_LISTS = {
  '/api/pack-sizes': {
    as: 'pack_sizes',
    sql: 'SELECT id::int, item_id::int, kind, pieces, version FROM inv.pack_sizes ORDER BY item_id, kind',
  },
  '/api/suppliers': {
    as: 'suppliers',
    sql: 'SELECT id::int, name, version FROM inv.suppliers ORDER BY pg_catalog.lower(name)',
  },
  '/api/reasons': {
    as: 'reasons',
    sql: 'SELECT id::int, text, active, built_in, entry, version FROM inv.reasons ORDER BY active DESC, pg_catalog.lower(text)',
  },
  // Every depth an LVL item has, with its threshold if one was ever saved;
  // a depth never saved has no version yet.
  '/api/lvl-depth-thresholds': {
    as: 'thresholds',
    sql: `SELECT d.depth, t.threshold_lf, t.version
            FROM (SELECT DISTINCT size AS depth FROM inv.items WHERE family = 'lvl') d
            LEFT JOIN inv.lvl_depth_thresholds t ON t.depth = d.depth
           ORDER BY pg_catalog.array_position(ARRAY['9-1/2', '11-7/8', '14', '16', '18', '20', '22', '24'], d.depth), d.depth`,
  },
};

// Inventory → Receive: every PO, newest first, each in the shape
// /api/pos/enter answers with.
async function listPos(database) {
  const rows = await database.read(
    'SELECT inv.po_json(id) AS po FROM inv.purchase_orders ORDER BY po_date DESC, id DESC');
  return rows.map((r) => r.po);
}

async function listSettings(database, route) {
  const { as, sql } = SETTINGS_LISTS[route];
  return { [as]: await database.read(sql) };
}

// Runs one change for `actor` and answers { [as]: row }, the row as the
// database left it. A refusal by the database is thrown, and the app's error
// shaping answers it.
async function saveCatalogChange(database, actor, route, body) {
  const { fn, args, as } = CATALOG_CHANGES[route];
  return { [as]: await database.save(fn, [actor.id, body.key, ...args(body)]) };
}

module.exports = {
  itemLabel, listCatalog, listPos, readLumberSizes, saveCatalogChange, CATALOG_CHANGES, listSettings, SETTINGS_LISTS, readLumberOptions,
};
