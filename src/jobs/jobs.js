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
// four 20′ boards (Q59). A line whose depth cannot be read matches no item
// and stays its own line. A sheet with no LVL keeps no note about it.
function lvlLines(text) {
  const read = parseLvlSheet(text);
  if (!read.ok) return { error: read.reason };
  return { warnings: read.items.length ? read.warnings : [],
    lines: read.items.map((it) => {
      const depth = extractDepth(it.size, 'LVL');
      return { key: depth ? `${depth} ${it.decimalFeet}` : `unread ${it.size} ${it.decimalFeet}`, sku: `${it.size} · ${feet(it.decimalFeet)}`, quantity: it.qty, length_ft: it.decimalFeet };
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
    const line = { family, sku, quantity, ...(length_ft && { lf: Math.round(quantity * length_ft * 100) / 100 }) };
    if (active.length > 1) several.push(`${sku} (${active.map((i) => i.sku).join(', ')})`);
    else if (active.length === 1) rows.push({ ...line, key, flag: null, item_id: active[0].id });
    else rows.push({ ...line, key, flag: catalogFlag(family, behind, FAMILIES[family].byLength ? null : sku), item_id: behind.length === 1 ? behind[0].id : null });
  }
  return { rows, several };
}

// Job `number` with the lumber cut plan saved with its current sheet, or
// nothing for a job not in the app or with no plan.
async function currentPlan(database, number) {
  const [job] = await database.read(`
    SELECT j.number, j.name, j.delivery_date::text AS delivery_date, p.plan
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN inv.lumber_cut_plans p ON p.sheet_id = s.id
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper($1)`, [String(number)]);
  return job;
}

// A saved cut plan's boards as lines, one per item.
function planRows(plan) {
  const rows = new Map();
  for (const { label, draws } of plan) {
    for (const { item_id, stock_length_ft, boards } of draws) {
      const row = rows.get(item_id) ?? { family: 'lumber', sku: `${label} ${feet(stock_length_ft)}`, quantity: 0, flag: null, item_id };
      row.quantity += boards;
      rows.set(item_id, row);
    }
  }
  return [...rows.values()];
}

// The dropped file read and matched to the catalog: { refusal } for a file
// that cannot be committed whatever is fixed, else { sheet, rows, plan }.
// rows end with the lumber lines the plan cannot place, flagged and with no
// item. A job already in the app keeps the cut plan saved with it, never
// planned again (S32): its lumber lines are that plan's boards, so the same
// sheet is found unchanged after the buying options change (S20, S22).
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
  const saved = sheet.lumber && await currentPlan(database, number);
  const { rows, several } = matchLines(saved ? sheet.lines.filter((l) => l.family !== 'lumber') : sheet.lines, behindByFamily);
  if (several.length) {
    return { refusal: { status: 422, body: { ok: false,
      error: `Job ${number} cannot be committed: ${several.join('; ')} each match more than one catalog item. Retire the one not used.` } } };
  }
  if (saved) {
    const lvl = rows.findIndex((r) => r.family === 'lvl');
    rows.splice(lvl < 0 ? rows.length : lvl, 0, ...planRows(saved.plan));
    return { sheet, rows, plan: saved.plan };
  }
  for (const { reason, ...line } of sheet.unplaced) rows.push({ ...line, flag: { notPlanned: reason }, item_id: null });
  return { sheet, rows, plan: sheet.lumber && cutPlan(sheet.lumber, rows) };
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

// Commits the job on the dropped sheet as `person`, or, with `deduct`,
// commits it and marks it shipped in one save (Deduct directly, story 19);
// `timing` answers "before or after the count?". Returns { status, body };
// the database's own refusals are thrown, for the app's error shaping.
async function commitSheet(database, person, { key, file, timing = null } = {}, { deduct = false } = {}) {
  const { refusal, sheet, rows, plan } = await matchSheet(database, file);
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
    const job = await database.save(deduct ? 'deduct_directly' : 'commit_job', [person.id, key, {
      number, name: sheet.meta.job_name, delivery_date: sheet.meta.delivery_date,
      lines: rows.filter((r) => r.family !== 'lumber').map(({ item_id, quantity }) => ({ item_id, quantity })),
      ...(plan && { lumber: { demand: sheet.lumber.demand, plan } }),
    }, ...(deduct ? [timing] : [])]);
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
  if (!number) return { status: 400, error: 'Name the job whose pull list to print.' };
  const job = await currentPlan(database, number);
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

// Marks jobs built or shipped (stories 15–17, 20): `jobs` are [{number,
// version}] as the board showed them; `timing` answers "before or after the
// count?". One save for every job, so one refusal saves none (S21).
const MARK = { built: 'mark_built', shipped: 'mark_shipped' };

async function markJobs(database, person, { key, to, jobs, timing = null } = {}) {
  if (!MARK[to]) return { status: 400, body: { ok: false, error: 'Mark jobs built or shipped.' } };
  return { status: 200, body: { ok: true, ...await database.save(MARK[to], [person.id, key, JSON.stringify(jobs), timing]) } };
}

// What marking jobs `numbers` built or shipped (`to`) consumes, per job,
// for the confirmation (story 20): each line's item, family and quantity,
// and whether its family is live; one that is not is not tracked yet (J4).
async function toConsume(database, to, numbers) {
  if (!MARK[to]) return { status: 400, body: { ok: false, error: 'Mark jobs built or shipped.' } };
  const jobs = await database.read(`
    SELECT j.number, j.name,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'item', inv.item_label(i), 'family', f.name, 'quantity', c.quantity, 'live', c.live)
                              ORDER BY pg_catalog.array_position($3::text[], f.code), inv.item_label(i))
                       FROM inv.job_to_consume(j, $1) c
                       JOIN inv.items i ON i.id = c.item_id JOIN inv.families f ON f.code = i.family), '[]') AS lines
      FROM inv.jobs j
     WHERE pg_catalog.upper(j.number) = ANY (SELECT pg_catalog.upper(n) FROM pg_catalog.unnest($2::text[]) n)
     ORDER BY j.number`, [to, [].concat(numbers ?? []), FAMILY_ORDER]);
  return { status: 200, body: { ok: true, jobs } };
}

// Cancel, Un-build or Un-ship (stories 23–26) one job, `number`, as the
// board showed it at `version` (J86). `action` names it as the screen does;
// each has its database function and its activity-log action.
const UNDO = {
  cancel: { save: 'cancel_job', logged: 'cancel job' },
  unbuild: { save: 'unbuild_job', logged: 'un-build' },
  unship: { save: 'unship_job', logged: 'un-ship' },
};
const notUndo = { status: 400, body: { ok: false, error: 'Cancel, un-build or un-ship a job.' } };

async function undoJob(database, person, { key, action, number, version } = {}) {
  if (!Object.hasOwn(UNDO, action)) return notUndo;
  const job = await database.save(UNDO[action].save, [person.id, key, number, version]);
  return { status: 200, body: { ok: true, job } };
}

// What `action` on job `number` gives back, for its confirmation (J87):
// the status it goes to, and per item the pieces that come back. Cancel
// lists the unconsumed lines of live families, which return to available
// (S25); Un-build and Un-ship the consumed pieces they return to on hand.
async function toGiveBack(database, action, number) {
  if (!Object.hasOwn(UNDO, action)) return notUndo;
  const [job] = await database.read(`
    SELECT j.number, j.name, inv.undo_to(j, $1) AS "to",
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item', inv.item_label(i), 'quantity', c.quantity)
                              ORDER BY pg_catalog.array_position($3::text[], f.code), inv.item_label(i))
                       FROM (SELECT g.item_id, -pg_catalog.sum(g.quantity)::integer AS quantity
                               FROM inv.job_to_give_back(j, $1) g GROUP BY g.item_id
                             UNION ALL
                             SELECT c.item_id, c.quantity FROM inv.job_to_consume(j, 'shipped') c WHERE $1 = 'cancel job' AND c.live) c
                       JOIN inv.items i ON i.id = c.item_id JOIN inv.families f ON f.code = i.family), '[]') AS lines
      FROM inv.jobs j WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy($2))`, [UNDO[action].logged, number ?? '', FAMILY_ORDER]);
  if (!job) return { status: 404, body: { ok: false, error: `Job ${number} is not in the app.` } };
  return { status: 200, body: { ok: true, ...job } };
}

// The Job board: one row per job, with the families on its current sheet
// (in the Planner's order, live or not yet), whether it can be marked
// built or shipped (as inv.mark_jobs allows) or cancelled, un-built or
// un-shipped (as inv.undo_job allows), and its version for that,
// whether it has a lumber pull
// list, and who changed it last, when.
function listJobs(database) {
  return database.read(`
    SELECT j.number, j.name, j.status, j.version, j.delivery_date::text AS delivery_date,
           j.status = 'committed' AND EXISTS (SELECT 1 FROM inv.job_to_consume(j, 'built')) AS can_build,
           j.status IN ('committed', 'built') AS can_ship,
           j.status IN ('committed', 'built') AS can_cancel,
           j.status = 'built' AS can_unbuild,
           j.status = 'shipped' AS can_unship,
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

module.exports = { checkSheet, commitSheet, markJobs, toConsume, undoJob, toGiveBack, listJobs, pullList };
