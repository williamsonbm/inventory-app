// The Activity Log (#77; its own mode since #81 part 1): who did what and when, newest first, a page
// at a time. Filters by person, by date range, by action and by family.
//
// A row's family (story 56) is its item's, or its PO lines', or the items its
// ledger rows hold (a receipt, correction, trim or reversal); lumber lengths
// and grade redirects are Lumber's, LVL depth thresholds LVL's. A row with no
// family (a person, a supplier, a reason, the catalog import) shows only under
// All (Q66). The family list rides along for the page's family bar.
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
const { itemLabel, readFamilies } = require('../inventory/catalog.js');

const PAGE_SIZE = 50;
const OFFICE_TIME_ZONE = 'America/New_York';  // the page shows times in the same zone (app-header.js)
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Answers { error } for a date in any other form, else one page of entries.
async function readActivity(database, { person, action, family, from, to, before }) {
  const blank = (v) => (v === undefined || v === '' ? null : v);
  if ([from, to].some((d) => blank(d) !== null && !ISO_DATE.test(d))) {
    return { error: 'A date must be written like 2026-09-29.' };
  }
  // The lists of actions and families (for the page's filters) do not
  // depend on the entries, so the three reads run side by side.
  const [rows, actionRows, families] = await Promise.all([database.read(`
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
       AND ($7::text IS NULL OR CASE
             WHEN l.target_table IN ('items', 'pack_sizes') THEN item.family = $7
             WHEN l.target_table = 'lvl_depth_thresholds' THEN $7 = 'lvl'
             WHEN l.target_table IN ('lumber_purchasable_lengths', 'lumber_grade_redirects') THEN $7 = 'lumber'
             WHEN l.target_table = 'families'
               THEN EXISTS (SELECT FROM inv.families f WHERE f.code = $7 AND f.name = l.new_value ->> 'name')
             WHEN l.target_table = 'counts'
               THEN EXISTS (SELECT FROM inv.counts c WHERE c.id = l.target_id AND c.family = $7)
             WHEN l.target_table = 'purchase_orders'
               THEN EXISTS (SELECT FROM inv.po_lines pl JOIN inv.items i ON i.id = pl.item_id
                             WHERE pl.po_id = l.target_id AND i.family = $7)
             ELSE EXISTS (SELECT FROM inv.ledger g JOIN inv.items i ON i.id = g.item_id
                           WHERE g.action_id = l.id AND i.family = $7) END)
     ORDER BY l.id DESC
     LIMIT ${PAGE_SIZE + 1}`,
  [blank(person), blank(action), blank(from), blank(to), blank(before), OFFICE_TIME_ZONE, blank(family)]),
  database.read('SELECT name FROM inv.actions ORDER BY name'),
  readFamilies(database)]);
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
  return { entries, before: nextBefore, actions, families };
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
  ledger: (_item, row) => row.item ?? row.lines[0].item,  // a correction's item, a trim's long one, or a reversal's first
  families: (_item, row) => row.name,
  counts: (_item, row) => `${row.family_name} count`,
  settings: (_item, row) => SETTINGS[row.name].label,
};
const targetName = (table, item, row) => TARGET_NAMES[table]?.(item, row) ?? null;

// What an addition added, beyond the name the row already shows, by its
// action where two actions write one table (a trim and a correction both
// write the ledger), else by the table it went into. The catalog import's
// row holds its own report.
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
  ledger: (row) => `on hand ${signed(row.quantity)}, ${row.reason}${noted(row)}`,
  reverse: (row) => `reversal of ${reversalLines(row)}${noted(row)}`,
  counts: (row) => countLabel(row),
  trim: (row) => `${row.boards} trimmed to ${row.length_ft}′`
    + `${row.item_added ? ' (new item, Non-Stock)' : row.item_unretired ? ' (put back in use)' : ''}${noted(row)}`,
};

// What a reversal undid: "the receipt: LUS28 −30".
const reversalLines = (r) => `${ENTRY_NAMES[r.reverses]}: ${r.lines.map((l) => `${l.item} ${signed(l.quantity)}`).join(', ')}`;
const signed = (n) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
// The entry a receipt, correction or trim replaced, reversed in the same save.
const replaced = (row) => (row.reversed ? `; reverses ${reversalLines(row.reversed)}` : '');

const noted = (row) => (row.note ? `; note: ${row.note}` : '');

// The entry a reversal undoes, by the action that wrote it.
const ENTRY_NAMES = { receive: 'the receipt', correct: 'the correction', trim: 'the trim' };

// What a receipt brought, line by line, with the PO line each went on and
// how it came, then its Bill of Lading and any pack size it put on file
// (story 19).
function describeReceipt(row) {
  const lines = row.lines.map((l) => {
    const where = l.po_line ? ` on line ${l.po_line}` : row.po_id ? ' not on the PO' : '';
    const how = howItCame(l);
    return `${l.quantity} ${l.item}${where}${how ? ` (${how})` : ''}`;
  });
  if (row.bol) lines.push(`Bill of Lading or tracking number ${row.bol}`);
  for (const p of row.pack_sizes_added) lines.push(`${p.kind} size on file for ${p.item}: ${p.pieces}`);
  return lines.join('; ');
}

// How a receipt line came, as entered: "2 cartons of 50 + 20 loose", or
// blank when only the pieces were typed.
function howItCame(l) {
  const plural = (kind, n) => (n === 1 ? kind : kind === 'box' ? 'boxes' : `${kind}s`);
  return [l.packs !== null && `${l.packs} ${plural(l.pack_kind, l.packs)} of ${l.pack_size}`,
    l.loose !== null && `${l.loose} loose`].filter(Boolean).join(' + ');
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

// The month a count closes, "2026-09", in words: "September 2026".
const monthName = (month) => new Date(`${month}-01T00:00:00Z`)
  .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// A count by its kind: "spot check", or "monthly, closes September 2026".
const countLabel = (row) => (row.closes ? `${row.kind}, closes ${monthName(row.closes)}` : row.kind);

// An Unmatched count's number and reason, if it has one (Q118: some need none).
const appHad = (c) => `the app had ${c.expected}${c.reason ? `; ${c.reason}` : ''}`;

// What a decision did to a count (approved: its lines with the app's number
// and the reason where unmatched; or rejected), else what a save or submit did: submitted, the month it closes, and
// its lines as they now stand, when they changed: each with how it was
// found when it was in packs ("157 LUS28 (3 cartons of 50 + 7 loose)"); a
// line of loose pieces only is just its pieces ("0 HUS26").
function describeCountChange(was, now) {
  const changes = [];
  if (now.status === 'rejected') return 'rejected';
  if (now.status === 'approved') {
    const lines = now.lines.map((l) => `${l.quantity} ${l.item}${l.matched ? '' : ` (${appHad(l)})`}`);
    return `approved; lines: ${lines.join(', ')}`;
  }
  if (was.status !== now.status) changes.push('submitted for approval');
  if (was.closes !== now.closes) changes.push(`closes: ${monthName(was.closes)} → ${monthName(now.closes)}`);
  if (JSON.stringify(was.lines) !== JSON.stringify(now.lines)) {
    changes.push(`lines: ${now.lines.map((l) => `${l.quantity} ${l.item}${l.packs === null ? '' : ` (${howItCame(l)})`}`)
      .join(', ') || 'none'}`);
  }
  return changes.join('; ');
}

// Each setting: its name on the Settings page, and its change in words.
const yesNo = (v) => (v ? 'yes' : 'no');
const SETTINGS = {
  working_day_window: { label: 'Working day', describe: (was, now) => `${was.value} → ${now.value}` },
  count_approval_by_another: {
    label: 'Count approval', describe: (was, now) => `second person must approve: ${yesNo(was.value)} → ${yesNo(now.value)}`,
  },
};
const describeSettingChange = (was, now) => SETTINGS[now.name].describe(was, now);

// A change told its own way, by the table it changed; any other table's
// change lists each field that differs.
const CHANGED = { purchase_orders: describePoChange, counts: describeCountChange, settings: describeSettingChange };

// What a change did, in words, for the "Was → now" column: an addition (no
// was) says what was added; a removal (no now) says so; a table in CHANGED
// tells its own; any other change lists each field that differs, was → now.
// A password action shows nothing: the log keeps no password.
function describeChange(action, table, was, now) {
  if (action.includes('password')) return '';
  if (!now) return 'removed';
  if (!was) {
    const added = (ADDED[action] ?? ADDED[table])?.(now);
    return added ? `added: ${added}${replaced(now)}` : 'added';
  }
  if (CHANGED[table]) return CHANGED[table](was, now);
  return Object.keys(now).filter((k) => k !== 'version' && JSON.stringify(was[k]) !== JSON.stringify(now[k]))
    .map((k) => `${k}: ${was[k]} → ${now[k]}`).join('; ');
}

module.exports = { readActivity, describeChange, howItCame, noted, countLabel, appHad, ENTRY_NAMES };
