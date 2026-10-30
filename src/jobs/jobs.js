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
const { compareMenuKeys } = require('../lumber/lumberMenu.js');
const { normalizeLumber } = require('../lumber/normalizeLumber.js');
const { parseLvlSheet } = require('../lvl/parseLvlSheet.js');
const { planLvl } = require('../lvl/planLvl.js');
const { extractDepth } = require('../ewp/extractDepth.js');
const { isCsvFile } = require('../planner/server.js');
const { esc, fmtInt, fmtNum, ftLabel: feet, cutInstruction } = require('../planner/planner-ui.js');
const { readInventory, itemsByKey, catalogFlag, handledSheets, PLAN_OPTIONS } = require('../inventory/planner-inventory.js');
const { FAMILY_ORDER } = require('../inventory/catalog.js');
const { OFFICE_TIME_ZONE, describeChange } = require('../settings/activity.js');

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

// The step that fixes a reason the plan gives for a line it cannot place;
// a reason it does not know gets no sentence.
function lumberFix(reason) {
  if (reason.startsWith('Unrecognized grade')) return 'The app does not know this grade. Ask for the grade to be added.';
  if (reason.startsWith('Unknown size/grade')) {
    return 'In the Planner\'s Stock lengths panel, add this size and grade if it is missing and turn on lengths for it, '
      + 'or redirect it to a stronger grade we buy.';
  }
  if (reason.startsWith('Required length')) return 'Add a longer length in the Planner\'s Stock lengths panel.';
  return '';
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
      reason: `${u.reason.replace(/\.?$/, '.')} ${lumberFix(u.reason)}`.trim() });
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
  // The readers take any m/d/yyyy; a day that does not exist (2/30) would
  // fail later as a refused request.
  const [y, m, d] = meta.delivery_date?.split('-') ?? [];
  if (y && new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) !== meta.delivery_date) {
    return { error: `The sheet's delivery date, ${+m}/${+d}/${y}, is not a date.` };
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

// Job `number` with the lumber cut plan saved with its current sheet, and
// `same_lines`: whether that plan was worked out from lumber lines `demand`
// (#120, J138). Nothing for a job not in the app or with no plan.
async function currentPlan(database, number, demand = null) {
  const [job] = await database.read(`
    SELECT j.number, j.name, j.delivery_date::text AS delivery_date, p.plan, coalesce(p.demand = $2::jsonb, false) AS same_lines
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN inv.lumber_cut_plans p ON p.sheet_id = s.id
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper($1)`, [String(number), JSON.stringify(demand)]);
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

// Each family's catalog under its line keys (catalogKeys), read once for
// every sheet of a batch. One family after the other: each read holds two of
// the pool's three connections.
async function readCatalogKeys(database) {
  const behindByFamily = {};
  for (const family of Object.keys(FAMILIES)) {
    behindByFamily[family] = catalogKeys(family, (await readInventory(database, family)).items);
  }
  return behindByFamily;
}

// The dropped file read and matched to the catalog: { refusal } for a file
// that cannot be committed whatever is fixed, else { sheet, rows, plan }.
// rows end with the lumber lines the plan cannot place, flagged and with no
// item. A job already in the app keeps the cut plan saved with it while
// the sheet's lumber lines are the same, never planned again (S32, J138):
// its lumber lines are that plan's boards, so the same sheet is found
// unchanged after the buying options change (S20, S22). `behindByFamily`,
// the catalog as readCatalogKeys reads it, when the caller has read it.
async function matchSheet(database, file, behindByFamily) {
  if (!isCsvFile(file)) return { refusal: { status: 400, body: { ok: false, error: 'The sheet must carry a name and its text.' } } };
  const sheet = await readSheet(file.text, database);
  if (sheet.error) return { refusal: { status: 400, body: { ok: false, error: sheet.error } } };
  const number = sheet.meta.job_number;
  if (!sheet.lines.length && !sheet.unplaced.length) {
    return { refusal: { status: 400, body: { ok: false, error: `Job ${number} has no lines to commit.` } } };
  }
  behindByFamily ??= await readCatalogKeys(database);
  const found = sheet.lumber && await currentPlan(database, number, sheet.lumber.demand);
  const saved = found?.same_lines ? found : null;
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

// The sheet as inv.commit_job takes it, with what a revised sheet's change
// screen sends: the version it saw and the date choice (undefined, and so
// left out, for any other sheet).
function jobPayload(sheet, rows, plan, { version, keep_date } = {}) {
  return {
    number: sheet.meta.job_number, name: sheet.meta.job_name, delivery_date: sheet.meta.delivery_date,
    lines: rows.filter((r) => r.family !== 'lumber').map(({ item_id, quantity }) => ({ item_id, quantity })),
    ...(plan && { lumber: { demand: sheet.lumber.demand, plan } }),
    version, keep_date,
  };
}

// A revised sheet's change screen (story 28): each line added, removed or
// changed against `current`, the job's current revision's lines, was → now,
// in the families' order, then by SKU. A removed line is named as the
// catalog names it. `consumed(family, item_id)`, for a built job, is what
// is settled of an item of a family consumed at Built (inv.job_settled): its line adds `consumed` and the `more` saving
// consumes (Q27).
function sheetChanges(current, rows, consumed = () => undefined) {
  const was = new Map(current.map((l) => [String(l.item_id), l]));
  const changes = [];
  const change = ({ family, sku, item_id }, before, now) => {
    const c = consumed(family, item_id);
    changes.push({ family, sku, was: before, now, ...(c !== undefined && { consumed: c, more: Math.max((now ?? 0) - c, 0) }) });
  };
  for (const row of rows) {
    const before = was.get(String(row.item_id));
    was.delete(String(row.item_id));
    if (before?.quantity !== row.quantity) change(row, before?.quantity ?? null, row.quantity);
  }
  for (const line of was.values()) change(line, line.quantity, null);
  return changes.sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.sku.localeCompare(b.sku));
}

// What committing the dropped sheet would save, shown before the person
// commits it (J27): the job and every line, each with what fixes it. Saves
// nothing. For a job already in the app, `status` says so. For a committed,
// built or cancelled job (#120, #121) the job adds its version and whether
// the sheet is `unchanged` (its current revision: never for a cancelled
// job, whose sheet commits it again, S64); a revised sheet lists its
// `changes`, for a built job with what each plate, lumber and LVL line
// consumed and consumes more (Q27), and, when its date is not the job's,
// `date_choice`: the job's date and who set it by hand, and when (story
// 34); when its name is not the job's, `name_was`: the job's name, which
// the revision replaces (Q142). A cancelled job adds `cancelled`: who
// cancelled it, when, and the revision saving makes (J156). A shipped job
// lists a changed sheet's `changes` and the `refusal` the commit gives
// (S30, J155). No other job's line asks for a fix: the commit then answers
// "unchanged" or "already shipped" ….
async function checkSheet(database, { file } = {}) {
  const { refusal, sheet, rows, plan } = await matchSheet(database, file);
  if (refusal) return refusal;
  const { job_number: number, job_name: name, delivery_date } = sheet.meta;
  const [found] = await database.read(`
    SELECT j.number, j.status, j.version, j.delivery_date::text AS delivery_date, u.name AS set_by, l.at AS set_at,
           CASE WHEN j.name IS DISTINCT FROM inv.tidy($3) THEN j.name END AS name_was,
           inv.is_current_sheet($2) AS unchanged, inv.job_handled(j) AS handled,
           (SELECT max(s.revision) FROM inv.job_sheets s WHERE s.job_id = j.id) AS revision,
           (SELECT coalesce(pg_catalog.jsonb_object_agg(t.item_id, t.quantity), '{}') FROM inv.job_settled(j) t) AS settled,
           ARRAY(SELECT f.code FROM inv.families f WHERE f.consumed_when = 'built' AND f.live) AS built_families,
           (SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                     'item_id', jl.item_id, 'family', i.family, 'sku', inv.item_label(i), 'quantity', jl.quantity)), '[]')
              FROM inv.job_lines jl JOIN inv.items i ON i.id = jl.item_id
             WHERE jl.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = j.id ORDER BY s.revision DESC LIMIT 1)) AS current
      FROM inv.jobs j
      LEFT JOIN LATERAL (SELECT * FROM inv.activity_log WHERE target_table = 'jobs' AND target_id = j.id
                            AND action = 'set delivery date' ORDER BY id DESC LIMIT 1) l ON j.delivery_date_edited
      LEFT JOIN inv.users u ON u.id = l.actor_id
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy($1))`, [number, jobPayload(sheet, rows, plan), name]);
  const status = found?.status ?? null;
  const same = found?.unchanged;
  const open = ['committed', 'built', 'cancelled'].includes(status);
  const unchanged = status !== 'cancelled' && same;
  const revising = open && !unchanged;
  const consumed = (family, id) => (status === 'built' && found.built_families.includes(family) ? found.settled[id] ?? 0 : undefined);
  const changes = (status === 'shipped' || revising) && !same ? sheetChanges(found.current, rows, consumed) : [];
  const revision = status === 'shipped' ? {
    changes,
    refusal: `Job ${found.number} was already ${found.handled}${same ? '' : '; un-ship it first'}.`,
  } : !open ? {} : {
    changes,
    date_choice: revising && found.delivery_date !== (delivery_date ?? null)
      ? { current: found.delivery_date, set_by: found.set_by, set_at: found.set_at } : null,
    name_was: revising ? found.name_was : null,
    ...(status === 'cancelled' && { cancelled: { handled: found.handled, revision: found.revision + 1 } }),
  };
  return { status: 200, body: { ok: true,
    job: { number, name, delivery_date, status, ...(open && { version: found.version, unchanged }) },
    lines: rows.map(({ item_id, key, flag, ...line }) => ({ ...line, flag: !status || revising ? flag : null })),
    // LVL's linear feet per depth, as the Planner shows them (Q59).
    lvl_by_depth: planLvl([{ name: 'sheet', text: file.text }]).jobs[0].byDepth.map(({ label, lf }) => ({ label, lf })),
    warnings: sheet.warnings, ...revision } };
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

// The refusal of a sheet with flagged lines (J8): each line with what fixes it.
function flagRefusal(sheet, rows) {
  const flagged = rows.filter((r) => r.flag).map(({ item_id, key, ...line }) => line);
  return { status: 422, body: { ok: false, error: refusalText(sheet.meta.job_number, flagged), lines: flagged } };
}

// Commits the job on the dropped sheet as `person`, or, with `deduct`,
// commits it and marks it shipped in one save (Deduct directly, story 19);
// `timing` answers "before or after the count?"; `version` and `keep_date`
// come from a revised sheet's change screen (#120). Returns { status, body };
// the database's own refusals are thrown, for the app's error shaping.
async function commitSheet(database, person, { key, file, timing = null, version, keep_date } = {}, { deduct = false } = {}) {
  const { refusal, sheet, rows, plan } = await matchSheet(database, file);
  if (refusal) return refusal;
  const refused = flagRefusal(sheet, rows);
  const n = refused.body.lines.length;
  // A line not in the catalog was never committed; a retired line may have
  // been, so the database answers first: a retry answers as the commit it
  // repeats, the same sheet again is unchanged (S20, S22), and a different
  // sheet is refused as one. Otherwise it refuses the retired lines.
  if (rows.some((r) => !r.item_id)) return refused;
  try {
    const job = await database.save(deduct ? 'deduct_directly' : 'commit_job',
      [person.id, key, jobPayload(sheet, rows, plan, { version, keep_date }), timing]);
    return { status: 200, body: { ok: true, job, warnings: sheet.warnings } };
  } catch (err) {
    if (n && err.code === 'IV422' && err.detail === 'inactive items') return refused;
    throw err;
  }
}

// Commits the jobs on many dropped sheets as `person` in one save (stories
// 3–5): a sheet the server refuses, or a line not in the catalog, saves
// none, and the refusal names its job (S21, J298). A revised sheet commits
// on its own (inv.commit_jobs). Returns { status, body }.
async function commitSheets(database, person, { key, files } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50) {
    return { status: 400, body: { ok: false, error: 'Pick 1 to 50 sheets to commit.' } };
  }
  const catalog = await readCatalogKeys(database);
  const jobs = [];
  for (const file of files) {
    const { refusal, sheet, rows, plan } = await matchSheet(database, file, catalog);
    if (refusal) return refusal;
    if (rows.some((r) => !r.item_id)) return flagRefusal(sheet, rows);
    jobs.push(jobPayload(sheet, rows, plan));
  }
  return { status: 200, body: { ok: true, ...await database.save('commit_jobs', [person.id, key, JSON.stringify(jobs)]) } };
}

// The Planner's "Already handled" (story 49, J299), read through the
// Planner's login: each dropped sheet whose job is already committed, built
// or shipped, with who and when, and whether the sheet differs from the
// job's current one, as the check before a commit finds it.
async function alreadyHandled(database, files) {
  const handled = await handledSheets(database, files);
  const catalog = handled.length ? await readCatalogKeys(database) : null;
  const jobs = [];
  for (const { file, job } of handled) {
    const { refusal, sheet, rows, plan } = await matchSheet(database, file, catalog);
    const [{ same }] = refusal ? [{ same: false }]
      : await database.read('SELECT inv.is_current_sheet($1) AS same', [jobPayload(sheet, rows, plan)]);
    jobs.push({ file: file.name, number: job.number, name: job.name, status: job.status, handled: job.handled, differs: !same });
  }
  return { status: 200, body: { ok: true, jobs } };
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
           (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', f.code, 'name', f.name, 'live', f.live)
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

// One job opened from the board (#102, stories 33, 40–43): its delivery
// date, whether a person set it by hand (J103) and whether it can be set
// (as inv.set_delivery_date allows), its version for that; its current
// sheet's lines, each an item's name without the length (J105), in the
// Planner's order; and its History, newest first: who did what, when, and
// the change in the Activity Log's words.
async function jobView(database, number) {
  const [job] = await database.read(`
    SELECT j.id, j.number, j.version, j.delivery_date::text AS delivery_date, j.delivery_date_edited,
           j.status <> 'cancelled' AS can_set_date,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'family', i.family, 'label', n.label, 'length_ft', i.length_ft, 'quantity', l.quantity,
                              'menu_key', i.size || '|' || i.grade)
                              ORDER BY n.label, i.length_ft)
                       FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id, LATERAL (SELECT inv.item_name(i) AS label) n
                      WHERE l.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = j.id ORDER BY s.revision DESC LIMIT 1)), '[]') AS lines
      FROM inv.jobs j WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy($1))`, [number ?? '']);
  if (!job) return { status: 404, body: { ok: false, error: `Job ${number} is not in the app.` } };
  const { id, lines: rows, ...shown } = job;
  // In the families' order; lumber by size, then grade, as the Planner
  // orders its groups. The sort is stable, so lines keep the query's order
  // by name and length.
  const lines = rows.sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family)
      || (a.family === 'lumber' ? compareMenuKeys(a.menu_key, b.menu_key) : 0))
    .map(({ menu_key, ...line }) => line);
  const history = await database.read(`
    SELECT l.action, l.at, u.name AS by, l.old_value, l.new_value
      FROM inv.activity_log l JOIN inv.users u ON u.id = l.actor_id
     WHERE l.target_table = 'jobs' AND l.target_id = $1 ORDER BY l.id DESC`, [id]);
  return { status: 200, body: { ok: true, job: shown, lines,
    history: history.map((h) => ({ action: h.action, at: h.at, by: h.by, change: describeChange(h.action, 'jobs', h.old_value, h.new_value) })) } };
}

// Sets job `number`'s delivery date, as the job view showed it at
// `version` (story 33, J103); a blank date clears it.
async function setDeliveryDate(database, person, { key, number, version, delivery_date: date } = {}) {
  const job = await database.save('set_delivery_date', [person.id, key, number, version, date || null]);
  return { status: 200, body: { ok: true, job } };
}

module.exports = { checkSheet, commitSheet, commitSheets, alreadyHandled, markJobs, toConsume, undoJob, toGiveBack, listJobs, pullList, jobView, setDeliveryDate };
