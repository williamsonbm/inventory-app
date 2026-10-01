// Inventory → Overview and the catalog's Settings (#81 part 1): what the
// screens list, and the changes a signed-in person makes.
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

// The families Inventory holds, for the family filter and "+ Add item", and
// every item. A family with no identity fields (EWP until step 5) cannot hold
// items, so it is left out. The version rides along so a save can say which
// version it read (S41).
async function listCatalog(database) {
  const [families, items] = await Promise.all([
    database.read(`
      SELECT code, name, identity FROM inv.families
       WHERE identity IS NOT NULL
       ORDER BY pg_catalog.array_position(ARRAY['plates', 'hangers', 'lumber', 'lvl'], code)`),
    database.read(`
      SELECT id::int, family, sku, product, size, grade, length_ft, stocking, threshold, note, active, version
        FROM inv.items ORDER BY family, sku, product, size, grade, length_ft`),
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
    database.read('SELECT size, grade, lengths, version FROM inv.lumber_purchasable_lengths'),
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
    sql: 'SELECT id::int, item_id::int, kind, pieces, version FROM inv.pack_sizes ORDER BY item_id, kind, pieces',
  },
  '/api/suppliers': {
    as: 'suppliers',
    sql: 'SELECT id::int, name, version FROM inv.suppliers ORDER BY pg_catalog.lower(name)',
  },
  '/api/reasons': {
    as: 'reasons',
    sql: 'SELECT id::int, text, active, built_in, version FROM inv.reasons ORDER BY active DESC, pg_catalog.lower(text)',
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
  itemLabel, listCatalog, saveCatalogChange, CATALOG_CHANGES, listSettings, SETTINGS_LISTS, readLumberOptions,
};
