// Inventory → Month-end (#81 part 3, stories 83–87): the month-end records
// (inv.month_end_json), and each one's CSV for the accountant.

const { monthName, OFFICE_TIME_ZONE } = require('../settings/activity.js');

// Every family's month-end records, newest month first, each without its
// lines: the list grows by a record per family a month, and a page opens
// one record at a time (readMonthEnd). items is how many items it holds.
async function listMonthEnd(database) {
  const rows = await database.read(`
    SELECT pg_catalog.jsonb_build_object(
             'id', c.id, 'family', c.family, 'family_name', f.name, 'closes', pg_catalog.to_char(c.closes, 'YYYY-MM'),
             'counted_at', c.counted_at,
             'revision', coalesce((SELECT pg_catalog.max(revision) FROM inv.count_corrections WHERE count_id = c.id), 1),
             'items', (SELECT pg_catalog.count(*) FROM (SELECT item_id FROM inv.count_lines WHERE count_id = c.id
                                                        UNION SELECT item_id FROM inv.count_corrections WHERE count_id = c.id) u)) AS record
      FROM inv.counts c JOIN inv.families f ON f.code = c.family
     WHERE c.status = 'approved' AND c.kind = 'monthly'
     ORDER BY c.closes DESC, c.family`);
  return rows.map((r) => r.record);
}

// One month-end record (inv.month_end_json), or null when `id` is none.
async function readMonthEnd(database, id) {
  if (!/^\d{1,18}$/.test(String(id))) return null;
  return (await database.read('SELECT inv.month_end_json($1::bigint) AS record', [id]))[0].record;
}

// The CSV's heading for each identity field; LVL calls its size the depth,
// as the Overview does.
const HEADINGS = { sku: 'SKU', product: 'Product', size: 'Size', grade: 'Grade', length_ft: 'Length (ft)' };
const FAMILY_HEADINGS = { lvl: { size: 'Depth' } };

// "date counted" is the office's day (Q17).
const officeDay = new Intl.DateTimeFormat('en-CA', { timeZone: OFFICE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

// A cell that holds a comma, a quote or a line break goes in quotes, its
// quotes doubled (RFC 4180).
const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

// One record's CSV (story 84): one row per item, with its identity fields,
// its name, its quantity in pieces at the newest revision, and the office
// day it was counted. The file name names the revision, so an old copy is
// never taken for the current one (story 87; owner, Q158). It starts with a
// UTF-8 byte-order mark: without one, Excel on Windows garbles the ′ in a
// lumber or LVL name. null when `id` is no month-end record.
async function monthEndCsv(database, id) {
  const record = await readMonthEnd(database, id);
  if (!record) return null;
  const headings = { ...HEADINGS, ...FAMILY_HEADINGS[record.family] };
  const day = officeDay.format(new Date(record.counted_at));
  const rows = [
    [...record.identity.map((f) => headings[f]), 'Name', 'Quantity (pieces)', 'Date counted'],
    ...record.lines.map((l) => [...record.identity.map((f) => l[f]), l.item, l.quantity, day]),
  ];
  return {
    fileName: `${record.family_name} month-end ${monthName(record.closes)} revision ${record.revision}.csv`,
    text: '\uFEFF' + rows.map((r) => `${r.map(cell).join(',')}\r\n`).join(''),
  };
}

module.exports = { listMonthEnd, readMonthEnd, monthEndCsv };
