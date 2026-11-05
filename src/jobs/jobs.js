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
const { planLvlCuts } = require('../lvl/planLvlCuts.js');
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

// The LVL boards job `number` may plan, per depth and length
// (inv.lvl_available): on hand − committed by other jobs.
async function lvlAvailable(database, number) {
  const rows = await database.read('SELECT size, length_ft, quantity FROM inv.lvl_available($1)', [String(number ?? '')]);
  return rows.map((r) => ({ depth: extractDepth(r.size, 'LVL'), lengthFt: r.length_ft, quantity: r.quantity }));
}

// Each LVL depth's purchasable lengths and shortest remainder kept (#181),
// keyed as extractDepth keys a sheet's depth.
async function lvlSettings(database) {
  const rows = await database.read('SELECT depth, purchasable_lengths, shortest_remainder_kept_ft FROM inv.lvl_depth_settings');
  const purchasable = {};
  const shortestKept = {};
  const names = {};
  for (const r of rows) {
    const depth = extractDepth(r.depth, 'LVL');
    purchasable[depth] = r.purchasable_lengths;
    shortestKept[depth] = r.shortest_remainder_kept_ft;
    names[depth] = r.depth;
  }
  return { purchasable, shortestKept, names };
}

// LVL's lines are the boards of the job's LVL plan (#182, #178 story 1):
// planned with the boards available and the LVL settings, one line per
// depth and board length, so "2 × 10′" of 9-1/2 is one 48′ board when only
// 48′ is on hand. A piece no board holds is its own line at its length. A
// piece whose depth cannot be read, or that has no LVL settings (22″),
// matches no item and stays its own line, out of the plan (PR #190 review,
// finding 2). A sheet with no LVL keeps no note about it. The boards are planned by
// `planned()`, which readSheet calls only for a job with no plan saved for
// the sheet's LVL pieces; `taken`, the on-hand boards the sheets before it
// in a batch took, by family and key.
async function lvlLines(text, database, { taken }) {
  const read = parseLvlSheet(text);
  if (!read.ok) return { error: read.reason };
  if (!read.items.length) return { warnings: [], lines: [] };
  const pieces = read.items.map((it) => ({ ...it, depth: extractDepth(it.size, 'LVL') }));
  const label = (depth) => pieces.find((p) => p.depth === depth).size;
  // A depth and length's line key, as catalogKeys keys an LVL item; under
  // `lvl` in a batch's `taken`.
  const lengthKey = (depth, lengthFt) => `${depth} ${lengthFt}`;
  const line = (key, sku, quantity, lengthFt) => ({ key, sku: `${sku} · ${feet(lengthFt)}`, quantity, length_ft: lengthFt });
  const { names, ...settings } = pieces.some((p) => p.depth) ? await lvlSettings(database) : { names: {} };
  const lines = [];
  const toPlan = [];
  for (const p of pieces) {
    if (names[p.depth]) toPlan.push(p);
    else lines.push(line(p.depth ? lengthKey(p.depth, p.decimalFeet) : `unread ${p.size} ${p.decimalFeet}`, p.size, p.qty, p.decimalFeet));
  }
  if (!toPlan.length) return { warnings: read.warnings, lines };
  // The sheet's own LVL pieces, per depth and length, so the same sheet
  // finds its saved plan (J138) whatever order its rows come in.
  const demand = new Map();
  for (const p of toPlan) {
    const k = lengthKey(p.depth, p.decimalFeet);
    demand.set(k, { depth: names[p.depth], length_ft: p.decimalFeet, quantity: (demand.get(k)?.quantity ?? 0) + p.qty });
  }
  const planned = async () => {
    // After the settings, not beside them: each read holds a pool connection (readCatalogKeys).
    const available = (await lvlAvailable(database, read.meta.jobNumber))
      .map((a) => ({ ...a, quantity: Math.max(0, a.quantity - (taken.get(`lvl ${lengthKey(a.depth, a.lengthFt)}`) ?? 0)) }));
    const plan = planLvlCuts({ lines: toPlan.map((p) => ({ depth: p.depth, lengthFt: p.decimalFeet, quantity: p.qty })), available, ...settings });
    // The plan as inv.commit_sheet saves it, one entry per board; lvlPlan
    // adds each board's item.
    const boards = [];
    const boardLines = [];
    const drawn = [];
    const add = (depth, lengthFt, entry) => {
      const key = lengthKey(depth, lengthFt);
      boards.push({ key, depth: names[depth], length_ft: lengthFt, ...entry });
      if (entry.source === 'on hand') drawn.push(`lvl ${key}`);
      const seen = boardLines.find((l) => l.key === key);
      if (seen) seen.quantity += 1;
      else boardLines.push({ ...line(key, label(depth), 1, lengthFt), ...(entry.reason && { at_length: entry.reason }) });
    };
    for (const { depth, boards: cut } of plan.depths) {
      for (const b of cut) {
        add(depth, b.lengthFt, { source: b.source, pieces_ft: b.pieces, remainder_ft: b.remainderFt, kept_ft: b.keptFt });
      }
    }
    for (const a of plan.atLength) {
      const reason = a.reason === 'no purchasable length'
        ? `We buy no set length of ${names[a.depth]}″ LVL, so it is bought at its length.`
        : `Longer than every length we buy of ${names[a.depth]}″ LVL (${settings.purchasable[a.depth].map(feet).join(', ')}), so it is bought at its length.`;
      for (let n = 0; n < a.quantity; n += 1) {
        add(a.depth, a.lengthFt, { source: 'at length', pieces_ft: [a.lengthFt], remainder_ft: 0, kept_ft: null, reason });
      }
    }
    return { lines: boardLines, boards, drawn };
  };
  return { warnings: read.warnings, lines,
    lvl: { demand: [...demand.values()].sort((a, b) => a.depth.localeCompare(b.depth) || a.length_ft - b.length_ft), planned,
      labels: Object.fromEntries(toPlan.map((p) => [names[p.depth], label(p.depth)])) } };
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
// line per size, grade and stock length, given by `planned()` with the
// sheet lines the plan cannot place (a grade not bought, a piece longer
// than any length, a size it cannot read) as `unplaced`, which refuse the
// job (J58).
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
  // From the draws the plan saves (cutPlan), summed per length by readSheet.
  const lines = groups.flatMap((g) => g.draws.map(({ stockLengthFt, pieces }) =>
    ({ key: `${g.key} ${stockLengthFt}`, sku: `${g.label} ${feet(stockLengthFt)}`, quantity: pieces })));
  return { warnings: plan.warnings, lines: [], lumber: { demand: job.items, groups, planned: async () => ({ lines, unplaced }) } };
}

// Each family's lines, in the order the check shows them. `byLength`: one
// item per line key and length. `plan`: a family whose lines are the boards
// of a plan saved with the sheet in `table`, under the payload's family key
// (inv.commit_sheet): `rows(plan, part)`, a saved plan's boards as lines,
// and `fresh(part, rows)`, a new plan as it is saved, each board with its
// item; `part` is what the family's reader says of the sheet;
// `print(plan)`, the plan's part of the pull list; `cuts(plan)`, if given,
// what the check shows under each of its lines, by item.
const FAMILIES = {
  plates: { read: skuLines(parsePlateSummary, plateKey) },
  hangers: { read: skuLines(parseHangerSheet, hangerKey, hangerCanon) },
  lumber: { read: lumberLines, byLength: true, plan: { table: 'lumber_cut_plans', rows: lumberPlanRows, fresh: cutPlan, print: lumberPrint } },
  lvl: { read: lvlLines, byLength: true,
    plan: { table: 'lvl_cut_plans', today: 'inv.lvl_plan_today', rows: lvlPlanRows, fresh: lvlPlan, print: lvlPrint, cuts: lvlCuts } },
};

// SQL: whether sheet `s` has a saved plan of any family, so its job has a pull list.
const HAS_PLAN = Object.values(FAMILIES).filter((f) => f.plan)
  .map(({ plan }) => `EXISTS (SELECT 1 FROM inv.${plan.table} p WHERE p.sheet_id = s.id)`).join(' OR ');

// The file's job and its lines, one per family and key with quantities
// summed, and each planned family's part under its key. A job already in
// the app keeps the plan saved with its sheet while the sheet's lines of
// that family are the same, never planned again (S32, J138, #182): the
// part's `saved`, which stands for what `planned()` gives (the boards and
// the lines the plan cannot place); the family's other lines stay (PR #190
// review, finding 3). Returns { error } for a file that is not a job's
// material sheet.
async function readSheet(text, database, ctx) {
  let meta;
  const lines = new Map();
  const warnings = [];
  const unplaced = [];
  const parts = {};
  for (const [family, { read, plan }] of Object.entries(FAMILIES)) {
    const sheet = await read(text, database, ctx);
    if (sheet.error) return { error: sheet.error };
    meta ??= sheet.meta;
    warnings.push(...sheet.warnings);
    const { planned, ...part } = sheet[family] ?? {};
    const saved = planned && await savedPlan(database, plan, meta.job_number, part.demand);
    const { lines: boards = [], unplaced: notPlaced = [], ...fresh } = planned && !saved ? await planned() : {};
    if (planned) parts[family] = saved ? { ...part, saved: saved.plan } : { ...part, ...fresh };
    unplaced.push(...notPlaced.map((u) => ({ family, ...u })));
    for (const { key, sku, quantity, length_ft, at_length } of [...sheet.lines, ...boards]) {
      // Runs of blanks as one, as the catalog stores a SKU (inv.new_item).
      const seen = lines.get(`${family} ${key}`) ?? { family, key, sku: sku.trim().replace(/\s+/g, ' '), quantity: 0, length_ft, at_length };
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
  return { meta, lines: [...lines.values()], unplaced, warnings, ...parts };
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
  for (const { family, key, sku, quantity, length_ft, at_length } of lines) {
    const behind = behindByFamily[family].get(key) ?? [];
    const active = behind.filter((i) => i.active);
    const line = { family, sku, quantity, ...(length_ft && { lf: Math.round(quantity * length_ft * 100) / 100 }), ...(at_length && { at_length }) };
    if (active.length > 1) several.push(`${sku} (${active.map((i) => i.sku).join(', ')})`);
    else if (active.length === 1) rows.push({ ...line, key, flag: null, item_id: active[0].id });
    else rows.push({ ...line, key, flag: catalogFlag(family, behind, FAMILIES[family].byLength ? null : sku), item_id: behind.length === 1 ? behind[0].id : null });
  }
  return { rows, several };
}

// Job `number` with the plan saved in `plan.table` (lumber_cut_plans,
// lvl_cut_plans) with its current sheet, read through the function
// `plan.today` names, if any (an LVL plan's remainders by today's settings, #185 Q42), when that plan was worked out from
// the sheet's lines `demand` (#120, J138) and the job is not cancelled, as
// cancelling freed its boards for other jobs (PR #190 review, finding 4); or
// from any lines, whatever its status, when `demand` is not given. Nothing
// for a job not in the app or with no such plan.
async function savedPlan(database, { table, today = '' }, number, demand) {
  const [job] = await database.read(`
    SELECT j.number, j.name, j.delivery_date::text AS delivery_date, ${today}(p.plan) AS plan
      FROM inv.jobs j
      JOIN LATERAL (SELECT * FROM inv.job_sheets WHERE job_id = j.id ORDER BY revision DESC LIMIT 1) s ON true
      JOIN inv.${table} p ON p.sheet_id = s.id
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper($1) AND ($2::jsonb IS NULL OR (p.demand = $2::jsonb AND j.status <> 'cancelled'))`,
  [String(number), demand === undefined ? null : JSON.stringify(demand)]);
  return job;
}

// A saved LVL plan's boards as lines, one per item, named as the sheet
// names its depth (`labels`).
function lvlPlanRows(plan, { labels }) {
  const rows = new Map();
  for (const { item_id, depth, length_ft, reason } of plan) {
    const row = rows.get(item_id) ?? { family: 'lvl', sku: `${labels[depth]} · ${feet(length_ft)}`, quantity: 0, lf: 0, flag: null, item_id,
      ...(reason && { at_length: reason }) };
    row.quantity += 1;
    row.lf = Math.round(row.quantity * length_ft * 100) / 100;
    rows.set(item_id, row);
  }
  return [...rows.values()];
}

// An LVL plan's boards as the yard reads them (#184, story 19): from on
// hand or to buy, the pieces, and the remainder, which goes back on hand
// at its even foot (27′8″ left, 26′ back on hand) or is scrap. Boards
// alike in all of that are one entry with their count (#184 Q34), in plan order.
function lvlBoards(plan) {
  const boards = new Map();
  for (const { item_id, depth, length_ft, source, pieces_ft, remainder_ft, kept_ft } of plan) {
    const counts = new Map();
    for (const p of [...pieces_ft].sort((a, b) => b - a)) counts.set(p, (counts.get(p) ?? 0) + 1);
    const cut = [...counts].map(([p, n]) => `${n} × ${feet(p)}`).join(', ');
    // planLvlCuts rounds a remainder to 1/16″ and never below 0.
    const remainder = remainder_ft === 0 ? 'none'
      : kept_ft === null ? `${feet(remainder_ft)} scrap`
      : feet(remainder_ft) === feet(kept_ft) ? `${feet(kept_ft)} back on hand`
      : `${feet(remainder_ft)} left, ${feet(kept_ft)} back on hand`;
    const from = source === 'on hand' ? 'on hand' : 'to buy';
    const key = [item_id, from, cut, remainder].join('|');
    if (!boards.has(key)) boards.set(key, { boards: 0, item_id, depth: `${depth}″`, length: feet(length_ft), from, cut, remainder });
    boards.get(key).boards += 1;
  }
  return [...boards.values()];
}

// An LVL plan's boards by item, as the check shows them under each line.
function lvlCuts(plan) {
  const cuts = new Map();
  for (const { item_id, depth, length, ...cut } of lvlBoards(plan)) cuts.set(item_id, [...(cuts.get(item_id) ?? []), cut]);
  return cuts;
}

// An LVL plan's part of the pull list: one line per board as lvlBoards gives them.
function lvlPrint(plan) {
  return '<h2>LVL</h2><table><thead><tr><th>Boards</th><th>Depth</th><th>Length</th><th>From</th><th>Cut</th><th>Remainder</th></tr></thead><tbody>' +
    lvlBoards(plan).map((b) => `<tr><td class="q">×${fmtInt(b.boards)}</td><td>${esc(b.depth)}</td><td class="l">${esc(b.length)}</td>` +
      `<td>${esc(b.from)}</td><td>${esc(b.cut)}</td><td>${esc(b.remainder)}</td></tr>`).join('') + '</tbody></table>';
}

// A saved cut plan's boards as lines, one per item.
function lumberPlanRows(plan) {
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
// that cannot be committed whatever is fixed, else { sheet, rows, plans,
// drawn }: plans, each planned family's plan as inv.commit_sheet saves it
// (FAMILIES), and drawn the keys of the on-hand boards a new plan takes
// (for inDeliveryOrder). rows end with the lumber lines the plan cannot
// place, flagged and with no item. A family's lines are the boards of the
// plan saved with the job while the sheet's lines of that family are the
// same (readSheet), so the same sheet is found unchanged after the buying
// options, on hand or the LVL settings change (S20, S22).
// `behindByFamily`, the catalog as readCatalogKeys reads it, when the
// caller has read it; `taken`, the on-hand boards the sheets before it in a
// batch took, by family and key.
async function matchSheet(database, file, behindByFamily, taken = new Map()) {
  if (!isCsvFile(file)) return { refusal: { status: 400, body: { ok: false, error: 'The sheet must carry a name and its text.' } } };
  const sheet = await readSheet(file.text, database, { taken });
  if (sheet.error) return { refusal: { status: 400, body: { ok: false, error: sheet.error } } };
  const number = sheet.meta.job_number;
  const planned = Object.keys(FAMILIES).filter((f) => FAMILIES[f].plan && sheet[f]);
  if (!sheet.lines.length && !sheet.unplaced.length && !planned.some((f) => sheet[f].saved)) {
    return { refusal: { status: 400, body: { ok: false, error: `Job ${number} has no lines to commit.` } } };
  }
  behindByFamily ??= await readCatalogKeys(database);
  const { rows: matched, several } = matchLines(sheet.lines, behindByFamily);
  if (several.length) {
    return { refusal: { status: 422, body: { ok: false,
      error: `Job ${number} cannot be committed: ${several.join('; ')} each match more than one catalog item. Retire the one not used.` } } };
  }
  const rows = Object.keys(FAMILIES).flatMap((f) => [...matched.filter((r) => r.family === f),
    ...(sheet[f]?.saved ? FAMILIES[f].plan.rows(sheet[f].saved, sheet[f]) : [])]);
  for (const { reason, ...line } of sheet.unplaced) rows.push({ ...line, flag: { notPlanned: reason }, item_id: null });
  return { sheet, rows, plans: Object.fromEntries(planned.map((f) => [f, sheet[f].saved ?? FAMILIES[f].plan.fresh(sheet[f], rows)])),
    drawn: planned.flatMap((f) => sheet[f].drawn ?? []) };
}

// Sheets planned together plan their LVL earliest delivery first (owner,
// L19), as hanger-web-app commits EWP in ship-date order: `plan(file,
// taken)` for each of `files` in that order, ties and undated sheets in the
// order dropped, last. `taken` holds the on-hand boards the sheets before
// it planned, by family and key; `plan` answers { drawn, ... }, the
// keys of the boards it takes, or drawn: [] for a sheet a batch leaves out.
// Answers each sheet's result in the order dropped.
async function inDeliveryOrder(files, plan) {
  const date = (f) => (isCsvFile(f) && parsePlateSummary(f.text).meta?.delivery_date) || '9999-12-31';
  const order = files.map((f, i) => [date(f), i]).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  const taken = new Map();
  const results = [];
  for (const [, i] of order) {
    results[i] = await plan(files[i], taken);
    for (const key of results[i].drawn ?? []) taken.set(key, (taken.get(key) ?? 0) + 1);
  }
  return results;
}

// The cut plan as inv.commit_job saves it, each draw with its board's item.
function cutPlan({ groups }, rows) {
  const items = new Map(rows.filter((r) => r.family === 'lumber').map((r) => [r.key, r.item_id]));
  return groups.map((g) => ({ label: g.label, draws: g.draws.map((d) => ({
    item_id: items.get(`${g.key} ${d.stockLengthFt}`), stock_length_ft: d.stockLengthFt, boards: d.pieces,
    required_length_ft: d.requiredLengthFt, contents: d.contents, waste_ft: d.wasteFt,
  })) }));
}

// The LVL plan as inv.commit_sheet saves it, each board with its item.
function lvlPlan({ boards }, rows) {
  const items = new Map(rows.filter((r) => r.family === 'lvl').map((r) => [r.key, r.item_id]));
  return boards.map(({ key, ...b }) => ({ item_id: items.get(key), ...b }));
}

// The sheet as inv.commit_job takes it, with what a revised sheet's change
// screen sends: the version it saw and the date choice (undefined, and so
// left out, for any other sheet). Each of `plans` goes with its lines under
// its family's key, deliberately: the sheet's fingerprint reads `lumber`
// and `lvl` (inv.sheet_fingerprint), so another key would read every
// committed job's sheet as revised.
function jobPayload(sheet, rows, plans, { version, keep_date } = {}) {
  return {
    number: sheet.meta.job_number, name: sheet.meta.job_name, delivery_date: sheet.meta.delivery_date,
    // A line with no item is in no plan: here, so the fingerprint sees it.
    lines: rows.filter((r) => !FAMILIES[r.family].plan || !r.item_id).map(({ item_id, quantity }) => ({ item_id, quantity })),
    ...Object.fromEntries(Object.entries(plans).map(([f, plan]) => [f, { demand: sheet[f].demand, plan }])),
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
// `catalog`, when given, is the catalog as readCatalogKeys read it, for a
// caller that checks many sheets (#151).
async function checkSheet(database, { file } = {}, catalog, taken) {
  const { refusal, sheet, rows, plans, drawn } = await matchSheet(database, file, catalog, taken);
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
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy($1))`, [number, jobPayload(sheet, rows, plans), name]);
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
  const cuts = Object.fromEntries(Object.entries(plans).filter(([f]) => FAMILIES[f].plan.cuts).map(([f, plan]) => [f, FAMILIES[f].plan.cuts(plan)]));
  return { status: 200, body: { ok: true,
    job: { number, name, delivery_date, status, ...(open && { version: found.version, unchanged }) },
    // Each LVL board's pieces and remainder, from the plan the commit saves
    // or the one saved (story 12).
    lines: rows.map(({ item_id, key, flag, ...line }) => ({ ...line, flag: !status || revising ? flag : null,
      ...(cuts[line.family]?.has(item_id) && { cuts: cuts[line.family].get(item_id) }) })),
    // LVL's linear feet per depth, as the Planner shows them (Q59).
    lvl_by_depth: planLvl([{ name: 'sheet', text: file.text }]).jobs[0].byDepth.map(({ label, lf }) => ({ label, lf })),
    warnings: sheet.warnings, ...revision }, drawn };
}

// Many sheets checked in one request, the catalog read once (#151): each
// sheet's answer as its own check gives it, and for a sheet that reads, its
// `left_out`: why a batch commit leaves it out, in the words a batch commit
// with it refuses, or null. A job on two sheets is the page's to settle: it
// keeps the first, and a Remove changes which is first.
async function checkSheets(database, { files } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 50) {
    return { status: 400, body: { ok: false, error: 'Pick 1 to 50 sheets to check.' } };
  }
  const catalog = await readCatalogKeys(database);
  const checked = await inDeliveryOrder(files, async (file, taken) => {
    const { body, drawn } = await checkSheet(database, { file }, catalog, taken);
    const sheet = body.ok ? { ...body, left_out: leftOut(body) } : body;
    return { sheet, drawn: sheet.left_out === null ? drawn : [] };
  });
  return { status: 200, body: { ok: true, sheets: checked.map((c) => c.sheet) } };
}
// The words are inv.commit_jobs's refusals (migrations/020-commit-many-and-
// already-handled.sql); a test pins the two together (PR #165 review, finding 3).
function leftOut({ job, cancelled, refusal }) {
  if (refusal) return refusal;
  if (cancelled) return `Job ${job.number} was ${cancelled.handled}: commit its sheet on its own.`;
  if (!job.status) return null;
  return job.unchanged ? `Job ${job.number} already has this sheet; nothing to commit.`
    : `Job ${job.number} is already in the app, and this is a revised sheet: commit it on its own.`;
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
  const { refusal, sheet, rows, plans } = await matchSheet(database, file);
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
      [person.id, key, jobPayload(sheet, rows, plans, { version, keep_date }), timing]);
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
  // A job number once per batch, compared as the database compares it
  // (inv.tidy, upper): a second sheet would read as a revision of the first.
  const seen = new Map();
  for (const { refusal, sheet, rows, plans } of await inDeliveryOrder(files, (file, taken) => matchSheet(database, file, catalog, taken))) {
    if (refusal) return refusal;
    const number = String(sheet.meta.job_number).trim().toUpperCase();
    if (seen.has(number)) {
      return { status: 422, body: { ok: false, error: `Job ${seen.get(number)} is on more than one sheet: remove all but one.` } };
    }
    seen.set(number, sheet.meta.job_number);
    if (rows.some((r) => !r.item_id)) return flagRefusal(sheet, rows);
    jobs.push(jobPayload(sheet, rows, plans));
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
    const { refusal, sheet, rows, plans } = await matchSheet(database, file, catalog);
    const [{ same }] = refusal ? [{ same: false }]
      : await database.read('SELECT inv.is_current_sheet($1) AS same', [jobPayload(sheet, rows, plans)]);
    jobs.push({ file: file.name, number: job.number, name: job.name, status: job.status, handled: job.handled, differs: !same });
  }
  return { status: 200, body: { ok: true, jobs } };
}

// A date as the office writes it: 11/3/2026.
const usDate = (date) => new Intl.DateTimeFormat('en-US', { timeZone: OFFICE_TIME_ZONE }).format(date);

// A lumber plan's part of the pull list: one section per size and grade,
// longest boards first, then its totals of boards, linear feet and scrap.
function lumberPrint(plan) {
  let boards = 0, lf = 0, scrap = 0;
  const sections = plan.map(({ label, draws }) => {
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
  return sections.join('\n') + `\n<div class="foot"><span><b>${fmtInt(boards)}</b> boards</span><span><b>${fmtNum(lf)}</b> LF</span>` +
    `<span><b>${fmtInt(Math.round(scrap))}</b> ft scrap</span></div>`;
}

// The pull list of job `number`, printed from the plans saved with its
// current sheet (story 48, Q57; #184), whatever its status: each planned
// family's part, in FAMILIES order. Returns { status, html } or { status, error }.
async function pullList(database, number) {
  if (!number) return { status: 400, error: 'Name the job whose pull list to print.' };
  const parts = [];
  // Deliberately one read after another, not Promise.all: each read holds a
  // pool connection, so in parallel one print takes two of the pool's three.
  for (const { plan } of Object.values(FAMILIES).filter((f) => f.plan)) {
    const saved = await savedPlan(database, plan, number);
    if (saved) parts.push({ saved, html: plan.print(saved.plan) });
  }
  if (!parts.length) return { status: 404, error: `Job ${number} has no cut plan.` };
  const job = parts[0].saved;
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
${parts.map((p) => p.html).join('\n')}
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
// With the LVL remainders it puts back on hand (#185 Q41), each by the
// item at its length, which the mark adds if the catalog lacks it.
async function toConsume(database, to, numbers) {
  if (!MARK[to]) return { status: 400, body: { ok: false, error: 'Mark jobs built or shipped.' } };
  const jobs = await database.read(`
    SELECT j.number, j.name,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'item', inv.item_label(i), 'family', f.name, 'quantity', c.quantity, 'live', c.live)
                              ORDER BY pg_catalog.array_position($3::text[], f.code), inv.item_label(i))
                       FROM inv.job_to_consume(j, $1) c
                       JOIN inv.items i ON i.id = c.item_id JOIN inv.families f ON f.code = i.family), '[]') AS lines,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item', r.item, 'quantity', r.quantity) ORDER BY r.length_ft DESC, r.item)
                       FROM (SELECT inv.item_label(pg_catalog.jsonb_populate_record(i, pg_catalog.jsonb_build_object('length_ft', k.length_ft))) AS item,
                                    k.length_ft, pg_catalog.sum(k.quantity)::integer AS quantity
                               FROM inv.job_remainders(j, $1) k JOIN inv.items i ON i.id = k.item_id
                              GROUP BY 1, 2) r), '[]') AS remainders
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
// (S25); Un-build and Un-ship the consumed pieces they return to on hand,
// and the LVL remainders they take back out (#185 Q41).
async function toGiveBack(database, action, number) {
  if (!Object.hasOwn(UNDO, action)) return notUndo;
  const [job] = await database.read(`
    SELECT j.number, j.name, inv.undo_to(j, $1) AS "to",
           coalesce(b.lines, '[]') AS lines, coalesce(b.remainders, '[]') AS remainders
      FROM inv.jobs j
     CROSS JOIN LATERAL (
       SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item', inv.item_label(i), 'quantity', c.quantity)
                ORDER BY pg_catalog.array_position($3::text[], f.code), inv.item_label(i)) FILTER (WHERE NOT c.remainder) AS lines,
              pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('item', inv.item_label(i), 'quantity', -c.quantity)
                ORDER BY i.length_ft DESC, inv.item_label(i)) FILTER (WHERE c.remainder) AS remainders
         FROM (SELECT g.item_id, g.kind = 'remainder' AS remainder, -pg_catalog.sum(g.quantity)::integer AS quantity
                 FROM inv.job_to_give_back(j, $1) g GROUP BY 1, 2
               UNION ALL
               SELECT c.item_id, false, c.quantity FROM inv.job_to_consume(j, 'shipped') c WHERE $1 = 'cancel job' AND c.live) c
         JOIN inv.items i ON i.id = c.item_id JOIN inv.families f ON f.code = i.family) b
     WHERE pg_catalog.upper(j.number) = pg_catalog.upper(inv.tidy($2))`, [UNDO[action].logged, number ?? '', FAMILY_ORDER]);
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
           (${HAS_PLAN}) AS pull_list,
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
// the change in the Activity Log's words, a Reverse of one of its returns
// included (PR #156 review F1).
async function jobView(database, number) {
  const [job] = await database.read(`
    SELECT j.id, j.number, j.version, j.delivery_date::text AS delivery_date, j.delivery_date_edited,
           j.status <> 'cancelled' AS can_set_date, j.status = 'built' AS can_swap, j.status = 'shipped' AS can_return,
           coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                              'item_id', i.id, 'family', i.family, 'label', n.label, 'length_ft', i.length_ft, 'quantity', l.quantity,
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
  // History, the swaps, the plates a swap may pick as used (J319): every
  // active one, the plate planned included, which the page leaves out; and
  // what a return may pick (J342): each active item on the job's sheet of a
  // family that comes back and is live in Inventory, with its family's code,
  // for its tab (J343); one with a length (LVL) once per product and depth, its
  // length typed (Q11), as inv.refuse_off_job takes it.
  const [history, swapped, plates, returnable] = await Promise.all([database.read(`
    SELECT l.action, l.target_table, l.at, u.name AS by, l.old_value, l.new_value
      FROM inv.activity_log l JOIN inv.users u ON u.id = l.actor_id
     WHERE (l.target_table = 'jobs' AND l.target_id = $1)
        OR l.id IN (SELECT v.action_id FROM inv.ledger v WHERE v.job_id = $1)
     ORDER BY l.id DESC`, [id]),
    database.read(`
    SELECT p.item_id::int AS planned_id, inv.item_name(pi) AS planned, u.item_id::int AS used_id, inv.item_name(ui) AS used,
           p.quantity::int AS quantity
      FROM inv.ledger p
      JOIN inv.ledger u ON u.action_id = p.action_id AND u.job_id = p.job_id AND u.quantity < 0
      JOIN inv.reasons r ON r.id = p.reason_id AND r.entry = 'swap'
      JOIN inv.items pi ON pi.id = p.item_id JOIN inv.items ui ON ui.id = u.item_id
     WHERE p.job_id = $1 AND p.kind = 'build' AND p.quantity > 0
       AND NOT EXISTS (SELECT FROM inv.ledger v WHERE v.reverses_id = p.id)
     ORDER BY p.id`, [id]),
    !job.can_swap ? [] : database.read(`
    SELECT i.id::int, inv.item_name(i) AS label FROM inv.items i
     WHERE i.family = 'plates' AND i.active ORDER BY 2`),
    !job.can_return ? [] : database.read(`
    SELECT pg_catalog.min(i.id)::int AS id, i.family, inv.item_name(i) AS label, pg_catalog.bool_or(i.length_ft IS NOT NULL) AS by_length
      FROM inv.job_lines l JOIN inv.items i ON i.id = l.item_id JOIN inv.families f ON f.code = i.family
     WHERE l.sheet_id = (SELECT s.id FROM inv.job_sheets s WHERE s.job_id = $1 ORDER BY s.revision DESC LIMIT 1)
       AND f.returnable AND f.live AND i.active
     GROUP BY i.family, inv.item_name(i), CASE WHEN i.length_ft IS NULL THEN i.id END
     ORDER BY 3`, [id])]);
  return { status: 200, body: { ok: true, job: shown, lines, swaps: netSwaps(swapped), plates, returnable,
    history: history.map((h) => ({ action: h.action, at: h.at, by: h.by, change: describeChange(h.action, h.target_table, h.old_value, h.new_value) })) } };
}

// A job's swaps (J320) as each pair of plates nets out: a swap back
// (used → planned, J321) lowers the swap it undoes, and one swapped all
// the way back is gone. Each pair in the order it was first swapped.
function netSwaps(swapped) {
  const pairs = new Map();
  for (const w of swapped) {
    const [first, second] = [w.planned_id, w.used_id].sort((a, b) => a - b);
    const key = `${first}|${second}`;
    if (!pairs.has(key)) pairs.set(key, { ...w, quantity: 0 });
    const pair = pairs.get(key);
    pair.quantity += pair.planned_id === w.planned_id ? w.quantity : -w.quantity;
  }
  return [...pairs.values()].filter((w) => w.quantity !== 0).map((w) => (w.quantity > 0 ? w
    : { planned_id: w.used_id, planned: w.used, used_id: w.planned_id, used: w.planned, quantity: -w.quantity }));
}

// Swaps `quantity` of plate `planned` for plate `used` on built job
// `number`, as the job view showed it at `version` (stories 43–45, Q36),
// timed by `timing`, the answer to "before or after the count?".
async function swapPlate(database, person, { key, number, version, planned, used, quantity, timing = null } = {}) {
  const job = await database.save('swap_plate', [person.id, key, number, version, planned, used, quantity, timing]);
  return { status: 200, body: { ok: true, job } };
}

// Records `quantity` of item `item` returned from the job site on shipped
// job `number`, as the job view showed it at `version` (story 46, Q7); LVL
// at `length_ft`, its actual length (Q11); timed by `timing`, the answer to
// "before or after the count?".
async function recordReturn(database, person, { key, number, version, item, quantity, length_ft = null, timing = null } = {}) {
  const job = await database.save('record_return', [person.id, key, number, version, item, quantity, length_ft, timing]);
  return { status: 200, body: { ok: true, job } };
}

// Sets job `number`'s delivery date, as the job view showed it at
// `version` (story 33, J103); a blank date clears it.
async function setDeliveryDate(database, person, { key, number, version, delivery_date: date } = {}) {
  const job = await database.save('set_delivery_date', [person.id, key, number, version, date || null]);
  return { status: 200, body: { ok: true, job } };
}

// The jobs a count of `family` lists before it starts (#105, story 51, Q25):
// each job with lines of that family that Shipped would still consume, as
// inv.job_to_consume says and src/inventory/item-jobs.js lists them, so a
// built job lists only under the families consumed at Shipped (J307) and a
// family not live in Inventory lists none. `consumed_when` is the step
// that consumes the family, built or shipped. Returns { status, body }.
async function jobsBeforeCount(database, family) {
  const [found] = await database.read('SELECT consumed_when FROM inv.families WHERE code = $1', [family ?? '']);
  if (!found) return { status: 400, body: { ok: false, error: 'Pick a family to count.' } };
  const jobs = await database.read(`
    SELECT j.number, j.name, j.delivery_date::text AS delivery_date
      FROM inv.jobs j
     WHERE j.status IN ('committed', 'built')
       AND EXISTS (SELECT 1 FROM inv.job_to_consume(j, 'shipped') c JOIN inv.items i ON i.id = c.item_id
                    WHERE c.live AND i.family = $1)
     ORDER BY j.delivery_date NULLS LAST, j.number`, [family]);
  return { status: 200, body: { ok: true, consumed_when: found.consumed_when, jobs } };
}

module.exports = { checkSheet, checkSheets, commitSheet, commitSheets, alreadyHandled, markJobs, toConsume, undoJob, toGiveBack, listJobs, pullList, jobView, setDeliveryDate, swapPlate, recordReturn, jobsBeforeCount };
