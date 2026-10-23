// Jobs (#97, step 4): committing a job from its material sheet, and the Job
// board.
//
// The server reads the file with the Planner's own plate and hanger parsers
// and matches each line to one catalog item by the Planner's own key rules
// (src/inventory/planner-inventory.js, itemsByKey), so a sheet the Planner
// plans is a sheet Jobs commits. The database function inv.commit_job
// refuses again what this file refuses, and saves the job, its sheet and its
// lines in one save.
// Lumber and LVL lines come with #99; EWP lines are left out of step 4 (J13).

const { parsePlateSummary } = require('../plates/parsePlateSummary.js');
const { skuKey: plateKey } = require('../plates/readPlateStockCsv.js');
const { parseHangerSheet } = require('../hangers/parseHangerSheet.js');
const { skuKey: hangerKey } = require('../hangers/readHangerStockCsv.js');
const { hangerCanon } = require('../hangers/hangerCanon.js');
const { isCsvFile } = require('../planner/server.js');
const { readInventory, itemsByKey, catalogFlag } = require('../inventory/planner-inventory.js');
const { FAMILY_ORDER } = require('../inventory/catalog.js');

// Each family's parser, the line key its engine uses, and the SKU as it is
// bought (a hanger's STC26 is TC26), which "Add to catalog" adds.
const FAMILIES = {
  plates: { parse: parsePlateSummary, key: plateKey, canon: (s) => s },
  hangers: { parse: parseHangerSheet, key: hangerKey, canon: hangerCanon },
};

// The file's job and its lines, one per family and key with quantities
// summed. Returns { error } for a file that is not a job's material sheet.
function readSheet(text) {
  let meta;
  const lines = new Map();
  const warnings = [];
  for (const [family, { parse, key, canon }] of Object.entries(FAMILIES)) {
    const read = parse(text);
    if (!read.ok) return { error: read.reason };
    meta = read.meta;
    warnings.push(...read.warnings);
    for (const line of read.lines) {
      const k = key(line.sku);
      // Runs of blanks as one, as the catalog stores a SKU (inv.new_item).
      const seen = lines.get(`${family} ${k}`) ?? { family, key: k, sku: canon(line.sku).trim().replace(/\s+/g, ' '), quantity: 0 };
      seen.quantity += line.qty;
      lines.set(`${family} ${k}`, seen);
    }
  }
  return { meta, lines: [...lines.values()], warnings };
}

// Each line's one active catalog item, or the line with the Planner's flag
// for what fixes it (catalogFlag). A line whose one item is retired is
// flagged but keeps that item in `matched`, in sheet order, so a retry sends
// the request it repeats. `several` names a line that two active items
// share, which a person settles by retiring one.
function matchLines(lines, behindByFamily) {
  const matched = [];
  const flagged = [];
  const several = [];
  for (const { family, key, sku, quantity } of lines) {
    const behind = behindByFamily[family].get(key) ?? [];
    const active = behind.filter((i) => i.active);
    if (active.length === 1) matched.push({ item_id: active[0].id, quantity });
    else if (active.length > 1) several.push(`${sku} (${active.map((i) => i.sku).join(', ')})`);
    else {
      if (behind.length === 1) matched.push({ item_id: behind[0].id, quantity });
      flagged.push({ family, sku, quantity, flag: catalogFlag(family, behind, sku) });
    }
  }
  return { matched, flagged, several };
}

// Commits the job on the dropped sheet as `person`. Returns { status, body };
// the database's own refusals are thrown, for the app's error shaping.
async function commitSheet(database, person, { key, file } = {}) {
  if (!isCsvFile(file)) return { status: 400, body: { ok: false, error: 'The sheet must carry a name and its text.' } };
  const sheet = readSheet(file.text);
  if (sheet.error) return { status: 400, body: { ok: false, error: sheet.error } };
  const number = sheet.meta.job_number;
  if (!sheet.lines.length) {
    return { status: 400, body: { ok: false, error: `Job ${number} has no plate or hanger lines to commit.` } };
  }
  // One family after the other: each read holds two of the pool's three connections.
  const behindByFamily = {};
  for (const family of Object.keys(FAMILIES)) {
    behindByFamily[family] = itemsByKey(family, (await readInventory(database, family)).items);
  }
  const { matched, flagged, several } = matchLines(sheet.lines, behindByFamily);
  if (several.length) {
    return { status: 422, body: { ok: false,
      error: `Job ${number} was not committed: ${several.join('; ')} each match more than one catalog item. Retire the one not used.` } };
  }
  const n = flagged.length;
  const refusal = { status: 422, body: { ok: false,
    error: `Job ${number} was not committed: ${n === 1 ? '1 line is' : `${n} lines are`} not in the catalog or ${n === 1 ? 'is' : 'are'} retired.`,
    lines: flagged } };
  // A line not in the catalog was never committed; a retired line may have
  // been, so the database answers first: a retry answers as the commit it
  // repeats, the same sheet again is unchanged (S20, S22), and a different
  // sheet is refused as one. Otherwise it refuses the retired lines.
  if (matched.length < sheet.lines.length) return refusal;
  try {
    const job = await database.save('commit_job', [person.id, key, {
      number, name: sheet.meta.job_name, delivery_date: sheet.meta.delivery_date, lines: matched,
    }]);
    return { status: 200, body: { ok: true, job, warnings: sheet.warnings } };
  } catch (err) {
    if (n && err.code === 'IV422' && err.detail === 'inactive items') return refusal;
    throw err;
  }
}

// The Job board: one row per job, with the families on its current sheet
// (in the Planner's order, live or not yet) and who changed it last, when.
function listJobs(database) {
  return database.read(`
    SELECT j.number, j.name, j.status, j.delivery_date::text AS delivery_date,
           (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.name, 'live', f.live)
                     ORDER BY pg_catalog.array_position($1::text[], f.code))
              FROM inv.families f
             WHERE f.code IN (SELECT i.family FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id
                               WHERE l.sheet_id = s.id)) AS families,
           last.at AS changed_at, u.name AS changed_by
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT * FROM inv.activity_log
                     WHERE target_table = 'jobs' AND target_id = j.id ORDER BY id DESC LIMIT 1) last ON true
      JOIN inv.users u ON u.id = last.actor_id
     ORDER BY last.at DESC`, [FAMILY_ORDER]);
}

module.exports = { commitSheet, listJobs };
