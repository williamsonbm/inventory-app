// Jobs (#97, step 4): committing a job from its material sheet, and the Job
// board.
//
// The server reads the file with the Planner's own parsers and matches each
// line to one catalog item by the Planner's own key rules
// (src/inventory/planner-inventory.js, itemsByKey), so a sheet the Planner
// plans is a sheet Jobs commits. The database function inv.commit_job
// refuses again what this file refuses, and saves the job, its sheet and its
// lines in one save.
// Lumber's lines are the boards of the cut plan the Planner's lumber
// planning works out at commit, saved with the sheet (#99); EWP lines are
// left out of step 4 (J13).

const { parsePlateSummary } = require('../plates/parsePlateSummary.js');
const { skuKey: plateKey } = require('../plates/readPlateStockCsv.js');
const { parseHangerSheet } = require('../hangers/parseHangerSheet.js');
const { skuKey: hangerKey } = require('../hangers/readHangerStockCsv.js');
const { hangerCanon } = require('../hangers/hangerCanon.js');
const { parseLumberSheet } = require('../lumber/parseLumberSheet.js');
const { planLumber } = require('../lumber/planLumber.js');
const { normalizeLumber } = require('../lumber/normalizeLumber.js');
const { parseLvlSheet } = require('../lvl/parseLvlSheet.js');
const { planLvl } = require('../lvl/planLvl.js');
const { extractDepth } = require('../ewp/extractDepth.js');
const { isCsvFile } = require('../planner/server.js');
const { esc, fmtInt, fmtNum, ftLabel: feet, cutInstruction } = require('../planner/planner-ui.js');
const { readInventory, itemsByKey, catalogFlag, PLAN_OPTIONS } = require('../inventory/planner-inventory.js');
const { FAMILY_ORDER } = require('../inventory/catalog.js');
const { OFFICE_TIME_ZONE } = require('../settings/activity.js');

// A plate or hanger sheet's lines; the SKU as it is bought (a hanger's
// STC26 is TC26), which "Add to catalog" adds.
const skuLines = (parse, key, canon = (s) => s) => (text) => {
  const read = parse(text);
  if (!read.ok) return { error: read.reason };
  return { meta: read.meta, warnings: read.warnings,
    lines: read.lines.map((l) => ({ key: key(l.sku), sku: canon(l.sku), quantity: l.qty })) };
};

// LVL lines are one item per depth and length: "4 × 20′" of 11-7/8 is
// four 20′ boards (Q59). A sheet with no LVL keeps no note about it.
function lvlLines(text) {
  const read = parseLvlSheet(text);
  if (!read.ok) return { error: read.reason };
  return { warnings: read.items.length ? read.warnings : [],
    lines: read.items.map((it) => {
      const depth = extractDepth(it.size, 'LVL');
      return { key: depth && `${depth} ${it.decimalFeet}`, sku: `${it.size} · ${feet(it.decimalFeet)}`, quantity: it.qty, length_ft: it.decimalFeet };
    }) };
}

// Lumber's lines are the boards of the job's cut plan, worked out with the
// shared buying options and no on-hand, as the Planner plans one job: one
// line per size, grade and stock length. A sheet line the plan cannot place
// (a grade not bought, a piece longer than any length, a size it cannot
// read) is kept as `unplaced`, and refuses the job (J58).
async function lumberLines(text, database) {
  const read = parseLumberSheet(text);
  if (!read.ok) return { error: read.reason };
  if (!read.lines.length) return { warnings: read.warnings, lines: [] };
  const options = await PLAN_OPTIONS.lumber(database);
  if (options.error) return { error: options.error };
  const plan = planLumber([{ name: 'sheet', text }], null, options);
  const [job] = plan.jobs;

  const unplaced = job.items.filter((it) => !normalizeLumber(it.material).size)
    .map((it) => ({ sku: `${it.material} ${it.length}`, quantity: it.qty, reason: 'Its size cannot be read.' }));
  // A grade not bought is reported once by grade and again per length: once.
  const byGrade = new Set();
  for (const u of plan.unmatched) {
    const grade = `${u.size}|${u.grade}`;
    if (u.requiredLengthFt == null) byGrade.add(grade);
    else if (byGrade.has(grade)) continue;
    unplaced.push({ sku: u.material + (u.requiredLengthFt == null ? '' : ` ${feet(u.requiredLengthFt)}`), quantity: u.qty,
      reason: `${u.reason} Change the lengths we buy in the Planner.` });
  }

  const groups = plan.bySizeGrade.filter((g) => g.draws.length);
  return {
    warnings: plan.warnings,
    // From the draws the plan saves (cutPlan), summed per length by readSheet.
    lines: groups.flatMap((g) => g.draws.map(({ stockLengthFt, pieces }) =>
      ({ key: `${g.key} ${stockLengthFt}`, sku: `${g.label} ${feet(stockLengthFt)}`, quantity: pieces }))),
    unplaced,
    lumber: { demand: job.items, groups },
  };
}

// Each family's lines, in the order the check shows them. `byLength`: one
// item per line key and length.
const FAMILIES = {
  plates: { read: skuLines(parsePlateSummary, plateKey) },
  hangers: { read: skuLines(parseHangerSheet, hangerKey, hangerCanon) },
  lumber: { read: lumberLines, byLength: true },
  lvl: { read: lvlLines, byLength: true },
};

// The file's job and its lines, one per family and key with quantities
// summed. Returns { error } for a file that is not a job's material sheet.
async function readSheet(text, database) {
  let meta;
  const lines = new Map();
  const warnings = [];
  const unplaced = [];
  let lumber = null;
  for (const [family, { read }] of Object.entries(FAMILIES)) {
    const sheet = await read(text, database);
    if (sheet.error) return { error: sheet.error };
    meta ??= sheet.meta;
    warnings.push(...sheet.warnings);
    unplaced.push(...(sheet.unplaced ?? []).map((u) => ({ family, ...u })));
    lumber ??= sheet.lumber;
    for (const { key, sku, quantity, length_ft } of sheet.lines) {
      // Runs of blanks as one, as the catalog stores a SKU (inv.new_item).
      const seen = lines.get(`${family} ${key}`) ?? { family, key, sku: sku.trim().replace(/\s+/g, ' '), quantity: 0, length_ft };
      seen.quantity += quantity;
      lines.set(`${family} ${key}`, seen);
    }
  }
  return { meta, lines: [...lines.values()], unplaced, lumber, warnings };
}

// The family's items under their line keys, and for a family bought by
// length, under the key and the item's length.
function catalogKeys(family, items) {
  const behind = itemsByKey(family, items);
  if (!FAMILIES[family].byLength) return behind;
  const byLength = new Map();
  for (const [key, list] of behind) {
    for (const item of list) {
      const k = `${key} ${item.length_ft}`;
      byLength.set(k, [...(byLength.get(k) ?? []), item]);
    }
  }
  return byLength;
}

// Each line with its one active catalog item, or with the Planner's flag for
// what fixes it (catalogFlag). A line whose one item is retired is flagged
// but keeps that item, so a retry sends the request it repeats. `several`
// names a line that two active items share, which a person settles by
// retiring one. A lumber or LVL line names no SKU to add in one click: it is
// added in Inventory, its form filled from the line.
function matchLines(lines, behindByFamily) {
  const rows = [];
  const several = [];
  for (const { family, key, sku, quantity, length_ft } of lines) {
    const behind = behindByFamily[family].get(key) ?? [];
    const active = behind.filter((i) => i.active);
    const line = { family, sku, quantity, ...(length_ft && { lf: quantity * length_ft }) };
    if (active.length > 1) several.push(`${sku} (${active.map((i) => i.sku).join(', ')})`);
    else if (active.length === 1) rows.push({ ...line, key, flag: null, item_id: active[0].id });
    else rows.push({ ...line, key, flag: catalogFlag(family, behind, FAMILIES[family].byLength ? null : sku), item_id: behind.length === 1 ? behind[0].id : null });
  }
  return { rows, several };
}

// The dropped file read and matched to the catalog: { refusal } for a file
// that cannot be committed whatever is fixed, else { sheet, rows }. rows
// end with the lumber lines the plan cannot place, flagged and with no item.
async function matchSheet(database, file) {
  if (!isCsvFile(file)) return { refusal: { status: 400, body: { ok: false, error: 'The sheet must carry a name and its text.' } } };
  const sheet = await readSheet(file.text, database);
  if (sheet.error) return { refusal: { status: 400, body: { ok: false, error: sheet.error } } };
  const number = sheet.meta.job_number;
  if (!sheet.lines.length && !sheet.unplaced.length) {
    return { refusal: { status: 400, body: { ok: false, error: `Job ${number} has no lines to commit.` } } };
  }
  // One family after the other: each read holds two of the pool's three connections.
  const behindByFamily = {};
  for (const family of Object.keys(FAMILIES)) {
    behindByFamily[family] = catalogKeys(family, (await readInventory(database, family)).items);
  }
  const { rows, several } = matchLines(sheet.lines, behindByFamily);
  if (several.length) {
    return { refusal: { status: 422, body: { ok: false,
      error: `Job ${number} cannot be committed: ${several.join('; ')} each match more than one catalog item. Retire the one not used.` } } };
  }
  for (const { reason, ...line } of sheet.unplaced) rows.push({ ...line, flag: { notPlanned: reason }, item_id: null });
  return { sheet, rows };
}

// The cut plan as inv.commit_job saves it, each draw with its board's item.
function cutPlan({ groups }, rows) {
  const items = new Map(rows.filter((r) => r.family === 'lumber').map((r) => [r.key, r.item_id]));
  return groups.map((g) => ({ label: g.label, draws: g.draws.map((d) => ({
    item_id: items.get(`${g.key} ${d.stockLengthFt}`), stock_length_ft: d.stockLengthFt, boards: d.pieces,
    required_length_ft: d.requiredLengthFt, contents: d.contents, waste_ft: d.wasteFt,
  })) }));
}

// What committing the dropped sheet would save, shown before the person
// commits it (J27): the job and every line, each with what fixes it. Saves
// nothing. For a job already in the app, `status` says so and no line asks
// for a fix: the commit then answers "unchanged" or "already committed".
async function checkSheet(database, { file } = {}) {
  const { refusal, sheet, rows } = await matchSheet(database, file);
  if (refusal) return refusal;
  const { job_number: number, job_name: name, delivery_date } = sheet.meta;
  const [found] = await database.read('SELECT status FROM inv.jobs WHERE pg_catalog.upper(number) = pg_catalog.upper($1)', [number]);
  const status = found?.status ?? null;
  return { status: 200, body: { ok: true,
    job: { number, name, delivery_date, status },
    lines: rows.map(({ item_id, key, flag, ...line }) => ({ ...line, flag: status ? null : flag })),
    // LVL's linear feet per depth, as the Planner shows them (Q59).
    lvl_by_depth: planLvl([{ name: 'sheet', text: file.text }]).jobs[0].byDepth.map(({ label, lf }) => ({ label, lf })),
    warnings: sheet.warnings } };
}

// What a refused commit's flagged lines need, as one sentence.
function refusalText(number, flagged) {
  const lines = (n) => (n === 1 ? '1 line is' : `${n} lines are`);
  const unplaced = flagged.filter((l) => l.flag.notPlanned).length;
  const catalog = flagged.length - unplaced;
  const why = [
    catalog && `${lines(catalog)} not in the catalog or ${catalog === 1 ? 'is' : 'are'} retired`,
    unplaced && `${unplaced === 1 ? '1 lumber line' : `${unplaced} lumber lines`} cannot be planned with the lengths we buy`,
  ].filter(Boolean);
  return `Job ${number} was not committed: ${why.join('; ')}.`;
}

// Commits the job on the dropped sheet as `person`. Returns { status, body };
// the database's own refusals are thrown, for the app's error shaping.
async function commitSheet(database, person, { key, file } = {}) {
  const { refusal, sheet, rows } = await matchSheet(database, file);
  if (refusal) return refusal;
  const number = sheet.meta.job_number;
  const flagged = rows.filter((r) => r.flag).map(({ item_id, key, ...line }) => line);
  const n = flagged.length;
  const refused = { status: 422, body: { ok: false, error: refusalText(number, flagged), lines: flagged } };
  // A line not in the catalog was never committed; a retired line may have
  // been, so the database answers first: a retry answers as the commit it
  // repeats, the same sheet again is unchanged (S20, S22), and a different
  // sheet is refused as one. Otherwise it refuses the retired lines.
  if (rows.some((r) => !r.item_id)) return refused;
  try {
    const job = await database.save('commit_job', [person.id, key, {
      number, name: sheet.meta.job_name, delivery_date: sheet.meta.delivery_date,
      lines: rows.filter((r) => r.family !== 'lumber').map(({ item_id, quantity }) => ({ item_id, quantity })),
      ...(sheet.lumber && { lumber: { demand: sheet.lumber.demand, plan: cutPlan(sheet.lumber, rows) } }),
    }]);
    return { status: 200, body: { ok: true, job, warnings: sheet.warnings } };
  } catch (err) {
    if (n && err.code === 'IV422' && err.detail === 'inactive items') return refused;
    throw err;
  }
}

// A date as the office writes it: 11/3/2026.
const usDate = (date) => new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TIME_ZONE }).format(date);

// The lumber pull list of job `number`, printed from the cut plan saved
// with its current sheet (story 48, Q57), whatever its status. One section
// per size and grade, longest boards first; totals of boards, linear feet
// and scrap. Returns { status, html } or { status, error }.
async function pullList(database, number) {
  const [job] = await database.read(`
    SELECT j.number, j.name, j.delivery_date::text AS delivery_date, p.plan
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN inv.lumber_cut_plans p ON p.sheet_id = s.id
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper($1)`, [String(number ?? '')]);
  if (!job) return { status: 404, error: `Job ${number} has no lumber cut plan.` };
  let boards = 0, lf = 0, scrap = 0;
  const sections = job.plan.map(({ label, draws }) => {
    const rows = [...draws].sort((a, b) => b.stock_length_ft - a.stock_length_ft).map((d) => {
      boards += d.boards;
      lf += d.boards * d.stock_length_ft;
      scrap += d.waste_ft;
      // As the Planner says it, from what the plan saved, never planned again.
      const instruction = cutInstruction({ stockLengthFt: d.stock_length_ft, requiredLengthFt: d.required_length_ft, contents: d.contents });
      return `<tr><td class="q">×${fmtInt(d.boards)}</td><td class="l">${feet(d.stock_length_ft)}</td><td>${esc(instruction)}</td>` +
        `<td class="n">${fmtNum(d.boards * d.stock_length_ft)}</td></tr>`;
    });
    return `<h2>${esc(label)}</h2><table><thead><tr><th>Boards</th><th>Length</th><th>Cut instruction</th><th class="n">LF</th></tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table>`;
  });
  const delivery = job.delivery_date ? `Delivery ${usDate(new Date(`${job.delivery_date}T12:00:00Z`))}<br>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pull List - Job ${esc(job.number)}</title><style>
  body{font-family:Arial,Helvetica,sans-serif;color:#222;font-size:13px;margin:1.5rem}
  .head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #1f3a5f;padding-bottom:7px}
  .head .t{font-size:18px;font-weight:bold;color:#1f3a5f}.head .s{text-align:right;color:#666}.head .s b{color:#222}
  h2{font-size:15px;color:#1f3a5f;border-bottom:1.5px solid #1f3a5f;padding:9px 0 4px;margin:14px 0 6px;break-after:avoid}
  table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;color:#888;text-transform:uppercase;padding:8px 10px}
  td{padding:9px 10px;font-size:15px;border-bottom:1px solid #eee}td.q{font-weight:bold;width:70px}td.l{font-weight:bold;width:90px}
  .n{text-align:right}.foot{margin-top:22px;border-top:2px solid #1f3a5f;padding-top:10px;display:flex;justify-content:space-between}
</style></head><body>
<div class="head"><span class="t">Pull List — Job ${esc(job.number)}</span>
<span class="s">${job.name ? `<b>${esc(job.name)}</b><br>` : ''}${delivery}Printed ${usDate(new Date())}</span></div>
${sections.join('\n')}
<div class="foot"><span><b>${fmtInt(boards)}</b> boards</span><span><b>${fmtNum(lf)}</b> LF</span>` +
    `<span><b>${fmtInt(Math.round(scrap))}</b> ft scrap</span></div>
</body></html>`;
  return { status: 200, html };
}

// The Job board: one row per job, with the families on its current sheet
// (in the Planner's order, live or not yet), whether it has a lumber pull
// list, and who changed it last, when.
function listJobs(database) {
  return database.read(`
    SELECT j.number, j.name, j.status, j.delivery_date::text AS delivery_date,
           (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', f.name, 'live', f.live)
                     ORDER BY pg_catalog.array_position($1::text[], f.code))
              FROM inv.families f
             WHERE f.code IN (SELECT i.family FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id
                               WHERE l.sheet_id = s.id)) AS families,
           EXISTS (SELECT 1 FROM inv.lumber_cut_plans p WHERE p.sheet_id = s.id) AS pull_list,
           last.at AS changed_at, u.name AS changed_by
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT * FROM inv.activity_log
                     WHERE target_table = 'jobs' AND target_id = j.id ORDER BY id DESC LIMIT 1) last ON true
      JOIN inv.users u ON u.id = last.actor_id
     ORDER BY last.at DESC`, [FAMILY_ORDER]);
}

module.exports = { checkSheet, commitSheet, listJobs, pullList };
