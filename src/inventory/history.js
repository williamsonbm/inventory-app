// Inventory → Overview → an item → History (#81 story 55): every change to
// one item's on hand, and every change to its settings, with who and when,
// newest first. The Activity Log lists every action in the app, one row per
// action; History lists one item, one row per ledger row, so a receipt of
// three items shows here as the one line about this item.
//
// The whole History comes in one answer, with no pages: at 4–12 POs a month
// per material (owner, 2026-10-04), one item likely gets well under a few
// hundred rows a year.

const { describeChange, howItCame, noted, ENTRY_NAMES } = require('../settings/activity.js');

// Each ledger row of the item, with what its detail is made from. A trim's
// other row (pair: a correction is one row, a trim two) gives the other length; a reversal's original (o), the
// action it reverses. reversed says a later reversal undid the row.
const LEDGER_ROWS = `
  SELECT g.effective_at AS at, l.id AS log_id, g.id, who.name AS who, l.action, g.quantity, g.note,
         ol.action AS reverses, EXISTS (SELECT FROM inv.ledger x WHERE x.reverses_id = g.id) AS reversed,
         r.text AS reason, rc.bol, po.number AS po_number, s.name AS supplier,
         inv.po_line_number(g.po_line_id) AS po_line, g.packs, g.pack_size, g.pack_kind, g.loose,
         l.new_value -> 'pack_sizes_added' AS pack_sizes_added, inv.item_label(i) AS item, other.length_ft AS other_length
    FROM inv.ledger g
    JOIN inv.items i ON i.id = g.item_id
    JOIN inv.activity_log l ON l.id = g.action_id
    JOIN inv.users who ON who.id = l.actor_id
    LEFT JOIN inv.reasons r ON r.id = g.reason_id
    LEFT JOIN inv.receipts rc ON rc.id = g.receipt_id
    LEFT JOIN inv.purchase_orders po ON po.id = rc.po_id
    LEFT JOIN inv.suppliers s ON s.id = coalesce(rc.supplier_id, po.supplier_id)
    LEFT JOIN inv.ledger pair ON g.kind = 'correction' AND pair.kind = 'correction' AND pair.action_id = g.action_id AND pair.id <> g.id
    LEFT JOIN inv.items other ON other.id = pair.item_id
    LEFT JOIN inv.ledger o ON o.id = g.reverses_id
    LEFT JOIN inv.activity_log ol ON ol.id = o.action_id
   WHERE g.item_id = $1`;

// Each change to the item itself or to one of its pack sizes, as the
// Activity Log records it.
const SETTINGS_ROWS = `
  SELECT l.at, l.id AS log_id, who.name AS who, l.action, l.target_table, l.old_value AS was, l.new_value AS now
    FROM inv.activity_log l
    JOIN inv.users who ON who.id = l.actor_id
   WHERE (l.target_table = 'items' AND l.target_id = $1)
      OR (l.target_table = 'pack_sizes' AND (COALESCE(l.new_value, l.old_value) ->> 'item_id')::bigint = $1)`;

// What a ledger row was, in words, by the action that wrote it; a reversal
// by its own words, whether a Reverse or a replacing entry wrote it.
const DETAIL = {
  receive: (g) => {
    const where = !g.po_number ? `${g.supplier}, no PO`
      : g.po_line ? `PO ${g.po_number} line ${g.po_line}, ${g.supplier}` : `PO ${g.po_number}, not on the PO, ${g.supplier}`;
    const sizes = (g.pack_sizes_added || []).filter((p) => p.item === g.item).map((p) => `${p.kind} size on file: ${p.pieces}`);
    return [where, howItCame(g), g.bol && `Bill of Lading or tracking number ${g.bol}`, ...sizes].filter(Boolean).join('; ');
  },
  correct: (g) => g.reason + noted(g),
  trim: (g) => `trimmed ${g.quantity < 0 ? 'to' : 'from'} ${g.other_length}′${noted(g)}`,
  reverse: (g) => `reverses ${ENTRY_NAMES[g.reverses]}${noted(g)}`,
};

// Answers { error } for an item not in the catalog, else { entries }.
async function readHistory(database, id) {
  const known = /^\d{1,18}$/.test(id ?? '') && (await database.read('SELECT 1 FROM inv.items WHERE id = $1', [id])).length;
  if (!known) return { error: 'That item is not in the catalog.' };
  const [ledger, settings] = await Promise.all([database.read(LEDGER_ROWS, [id]), database.read(SETTINGS_ROWS, [id])]);
  const entries = [
    ...ledger.map((g) => ({ at: g.at, log_id: g.log_id, id: Number(g.id), who: g.who, action: g.action, change: g.quantity,
      detail: DETAIL[g.reverses ? 'reverse' : g.action](g), reversed: g.reversed })),
    ...settings.map((s) => ({ at: s.at, log_id: s.log_id, who: s.who, action: s.action, change: null,
      detail: describeChange(s.action, s.target_table, s.was, s.now) })),
  ];
  // Newest first, then the latest action, then the row written last.
  entries.sort((a, b) => b.at - a.at || Number(b.log_id) - Number(a.log_id) || Number(b.id) - Number(a.id));
  return { entries: entries.map(({ log_id: _, ...e }) => e) };
}

module.exports = { readHistory };
