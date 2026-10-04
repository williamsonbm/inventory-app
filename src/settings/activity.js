// The Activity Log (#77; its own mode since #81 part 1): who did what and when, newest first, a page
// at a time. Filters by person, by date range and by action; the family
// filter joins in step 3.
//
// Dates are office days: a range from D1 to D2 covers midnight at the start
// of D1 to midnight at the end of D2, Eastern Time with daylight saving (Q17).
// Postgres converts the day's edges, and `at` stays timestamptz throughout, so
// the comparison never mixes a date with a time (CODING-STANDARDS.md, Drift).
//
// Deliberately, a date must be written YYYY-MM-DD, checked here: Postgres
// would also read "yesterday", and would read 06/07/2026 by the connection's
// DateStyle setting, which a shared pooler connection does not promise.
// A person or page of the wrong type is refused by Postgres (answered 400).
const { itemLabel } = require('../inventory/catalog.js');

const PAGE_SIZE = 50;
const OFFICE_TIME_ZONE = 'America/New_York';  // the page shows times in the same zone (app-header.js)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Answers { error } for a date in any other form, else one page of entries.
async function readActivity(database, { person, action, from, to, before }) {
  const blank = (v) => (v === undefined || v === '' ? null : v);
  if ([from, to].some((d) => blank(d) !== null && !ISO_DATE.test(d))) {
    return { error: 'A date must be written like 2026-09-29.' };
  }
  // The list of actions (for the page's filter) does not depend on the
  // entries, so the two reads run side by side.
  const [rows, actionRows] = await Promise.all([database.read(`
    SELECT l.id, l.at, who.name AS who, l.action, l.target_table, target.name AS target,
           pg_catalog.to_jsonb(item) AS item, l.old_value AS was, l.new_value AS now
      FROM inv.activity_log l
      JOIN inv.users who ON who.id = l.actor_id
      LEFT JOIN inv.users target ON l.target_table = 'users' AND target.id = l.target_id
      LEFT JOIN inv.items item ON (l.target_table = 'items' AND item.id = l.target_id)
        OR (l.target_table = 'pack_sizes'
            AND item.id = (COALESCE(l.new_value, l.old_value) ->> 'item_id')::bigint)
     WHERE ($1::bigint IS NULL OR l.actor_id = $1)
       AND ($2::text IS NULL OR l.action = $2)
       AND ($3::date IS NULL OR l.at >= ($3::date)::timestamp AT TIME ZONE $6)
       AND ($4::date IS NULL OR l.at < ($4::date + 1)::timestamp AT TIME ZONE $6)
       AND ($5::bigint IS NULL OR l.id < $5)
     ORDER BY l.id DESC
     LIMIT ${PAGE_SIZE + 1}`,
  [blank(person), blank(action), blank(from), blank(to), blank(before), OFFICE_TIME_ZONE]),
  database.read('SELECT name FROM inv.actions ORDER BY name')]);
  // One row past the page says whether there is another page, which starts
  // before the last row shown. The ids stay here: `before` is their one reader.
  const page = rows.slice(0, PAGE_SIZE);
  const nextBefore = rows.length > PAGE_SIZE ? page.at(-1).id : null;
  const actions = actionRows.map((r) => r.name);
  const entries = page.map(({ id, target_table: table, item, target, was, now, ...entry }) => ({
    ...entry,
    target: target ?? targetName(table, item, now || was),
    change: describeChange(entry.action, table, was, now),
  }));
  return { entries, before: nextBefore, actions };
}

// What a change touched, in the words its screen uses, for a row that is not
// about a person, by the table it changed. `row` is the change's saved value
// (now, or was when there is no now); `item` is the item a change to an item
// or a pack size is about.
const TARGET_NAMES = {
  items: (item) => (item ? itemLabel(item) : 'the catalog'),  // the import touches many items
  pack_sizes: (item, row) => `${itemLabel(item)} ${row.kind}`,
  suppliers: (_item, row) => row.name,
  reasons: (_item, row) => row.text,
  lvl_depth_thresholds: (_item, row) => `LVL ${row.depth}″`,
  lumber_purchasable_lengths: (_item, row) => `${row.size} ${row.grade}`,
  lumber_grade_redirects: (_item, row) => `${row.size} ${row.from_grade}`,
  purchase_orders: (_item, row) => `PO ${row.number}`,
  receipts: (_item, row) => (row.po_number ? `PO ${row.po_number}` : `${row.supplier}, no PO`),
  families: (_item, row) => row.name,
};
const targetName = (table, item, row) => TARGET_NAMES[table]?.(item, row) ?? null;

// What an addition added, beyond the name the row already shows, by the
// table it went into. The catalog import's row holds its own report.
const ADDED = {
  users: (row) => `${row.name}, ${row.email}`,
  items: (row) => (row.added
    ? `${row.added.items} items, ${row.added.pack_sizes} pack sizes and ${row.added.lvl_depth_thresholds} LVL depth thresholds; `
      + `${row.skipped.items} items were there already`
    : `${row.stocking}, ${row.threshold === null ? 'no threshold' : `threshold ${row.threshold}`}`),
  pack_sizes: (row) => `${row.pieces} pieces`,
  lvl_depth_thresholds: (row) => (row.threshold_lf === null ? 'no threshold' : `${row.threshold_lf} linear feet`),
  lumber_purchasable_lengths: (row) => (row.lengths.length ? row.lengths.map((l) => `${l}′`).join(', ') : 'no lengths'),
  lumber_grade_redirects: (row) => (row.to_grade ? `to ${row.to_grade}` : 'no redirect'),
  purchase_orders: (row) => `${row.supplier}, dated ${row.po_date}, ${row.lines.length} line${row.lines.length === 1 ? '' : 's'}`,
  receipts: describeReceipt,
};

// What a receipt brought, line by line, with the PO line each went on and
// how it came, then its Bill of Lading and any pack size it put on file
// (story 19).
function describeReceipt(row) {
  const plural = (kind, n) => (n === 1 ? kind : kind === 'box' ? 'boxes' : `${kind}s`);
  const lines = row.lines.map((l) => {
    const where = l.po_line ? ` on line ${l.po_line}` : row.po_id ? ' not on the PO' : '';
    const how = [l.packs !== null && `${l.packs} ${plural(l.pack_kind, l.packs)} of ${l.pack_size}`,
      l.loose !== null && `${l.loose} loose`].filter(Boolean).join(' + ');
    return `${l.quantity} ${l.item}${where}${how ? ` (${how})` : ''}`;
  });
  if (row.bol) lines.push(`Bill of Lading or tracking number ${row.bol}`);
  for (const p of row.pack_sizes_added) lines.push(`${p.kind} size on file for ${p.item}: ${p.pieces}`);
  return lines.join('; ');
}

// What a change to a PO did, by its supplier, number and date, then line by
// line, numbered as the Receive page numbers them (lines in the order
// entered, so a new line comes last).
const PO_FIELDS = { supplier: 'supplier', number: 'number', po_date: 'date' };
const LINE_FIELDS = { ordered: 'ordered', pack_size: 'pack size' };
function describePoChange(was, now) {
  const changes = Object.entries(PO_FIELDS).filter(([k]) => was[k] !== now[k]).map(([k, word]) => `${word}: ${was[k]} → ${now[k]}`);
  now.lines.forEach((line, n) => {
    const before = was.lines.find((l) => l.id === line.id);
    if (!before) return changes.push(`line ${n + 1} added`);
    if (before.closed_reason !== line.closed_reason) {
      changes.push(line.closed_reason ? `line ${n + 1} closed: ${line.closed_reason}` : `line ${n + 1} re-opened`);
    }
    if (before.item_id !== line.item_id) changes.push(`line ${n + 1} item: ${before.item} → ${line.item}`);
    for (const [k, word] of Object.entries(LINE_FIELDS)) {
      if (before[k] === line[k]) continue;
      changes.push(`line ${n + 1} ${word}: ${before[k] ?? 'none'} → ${line[k] ?? 'none'}`);
    }
  });
  return changes.join('; ');
}

// A change told its own way, by the table it changed; any other table's
// change lists each field that differs.
const CHANGED = { purchase_orders: describePoChange };

// What a change did, in words, for the "Was → now" column: an addition (no
// was) says what was added; a removal (no now) says so; a table in CHANGED
// tells its own; any other change lists each field that differs, was → now.
// A password action shows nothing: the log keeps no password.
function describeChange(action, table, was, now) {
  if (action.includes('password')) return '';
  if (!now) return 'removed';
  if (!was) {
    const added = ADDED[table]?.(now);
    return added ? `added: ${added}` : 'added';
  }
  if (CHANGED[table]) return CHANGED[table](was, now);
  return Object.keys(now).filter((k) => k !== 'version' && JSON.stringify(was[k]) !== JSON.stringify(now[k]))
    .map((k) => `${k}: ${was[k]} → ${now[k]}`).join('; ');
}

module.exports = { readActivity, describeChange };
