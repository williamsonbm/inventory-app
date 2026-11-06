// =============================================================
// jobs.test.js — committing a job (#97; seams 1 and 2).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds a fresh database with the migration runner and calls the
// database's functions as the app's login (seam 1), or boots the whole app
// and sends it a job's material sheet over HTTP (seam 2), as #96's Testing
// Decisions ask.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, urlFor, as, APP, firstUser, call, logRows, refused, contents, goLive, figure, reasonId } = require('./support/database.js');
const { withAdmin, get, post } = require('./support/app.js');
const { openDatabase } = require('../src/db/database.js');
const { migrate } = require('../src/db/migrate.js');
const { readItemJobs } = require('../src/inventory/item-jobs.js');
const { checkSheet } = require('../src/jobs/jobs.js');
const { planLvlCuts } = require('../src/lvl/planLvlCuts.js');

// A database with Ann, a supplier, a plate and two hangers in the catalog;
// receive(item, quantity) receives from the supplier.
async function withCatalog() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const add = (family, sku) => call(db, 'add_item', ann.id, crypto.randomUUID(), family, { sku });
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Simpson');
  const receive = (item, quantity) => call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: item.id, quantity }]));
  return { db, ann, receive, plate: await add('plates', 'MT20 3x4'), lus28: await add('hangers', 'LUS28'), hus: await add('hangers', 'HUS26') };
}

// Commits a job as Ann. `lines` are [item, quantity] pairs; an LVL item's
// boards go in the sheet's LVL plan, one entry per board, as the app sends
// them (#182). A revised sheet carries the version its change screen saw
// and, when its date differs from the job's, keepDate: whether the job
// keeps its own.
function commit(ctx, lines, { number = '33864R', name = 'Smith Residence', deliveryDate = '2026-11-02', key = crypto.randomUUID(),
  version, keepDate, timing } = {}) {
  const lvl = lines.filter(([item]) => item.family === 'lvl');
  return call(ctx.db, 'commit_job', ctx.ann.id, key, {
    number, name, delivery_date: deliveryDate,
    lines: lines.filter(([item]) => item.family !== 'lvl').map(([item, quantity]) => ({ item_id: item.id, quantity })),
    ...(lvl.length && { lvl: {
      demand: lvl.map(([item, quantity]) => ({ depth: item.size, length_ft: item.length_ft, quantity })),
      plan: lvl.flatMap(([item, quantity]) => Array(quantity).fill({ item_id: item.id, depth: item.size, length_ft: item.length_ft,
        source: 'buy', pieces_ft: [item.length_ft], remainder_ft: 0, kept_ft: null })),
    } }),
    version, keep_date: keepDate,
  }, ...(timing ? [JSON.stringify(timing)] : []));
}

// The current lines of job `number` as item id → quantity.
async function currentLines(db, number) {
  return as(db, APP, async (app) => Object.fromEntries((await app.query(`
    SELECT l.item_id::int, l.quantity
      FROM inv.job_lines l JOIN inv.job_sheets s ON s.id = l.sheet_id
      JOIN inv.jobs j ON j.id = s.job_id
     WHERE j.number = $1 AND s.revision = (SELECT max(revision) FROM inv.job_sheets WHERE job_id = j.id)`,
  [number])).rows.map((r) => [r.item_id, r.quantity])));
}

test('a commit saves the job as committed, revision 1 with its lines, logged once (stories 1, 35)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  // LUS28 twice: a sheet lists one item in two sections; the job holds it once.
  const job = await commit(ctx, [[plate, 930], [lus28, 12], [hus, 4], [lus28, 3]]);
  assert.deepEqual(job, { number: '33864R', name: 'Smith Residence', revision: 1 });
  assert.deepEqual(await currentLines(db, '33864R'), { [plate.id]: 930, [lus28.id]: 15, [hus.id]: 4 });

  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'commit job');
  assert.equal(log.target_table, 'jobs');
  assert.deepEqual(log.new_value, job);
});

test('committing the same sheet twice changes nothing; a retry answers as the first commit did (S20, S22)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  const key = crypto.randomUUID();
  const job = await commit(ctx, [[plate, 930], [lus28, 12]], { key });
  const before = await contents(db);

  // The same lines in another order, and the number in small letters, are the same sheet.
  const again = await commit(ctx, [[lus28, 12], [plate, 930]], { number: '33864r' });
  assert.deepEqual(again, { ...job, unchanged: true });
  assert.deepEqual(await contents(db), before, 'the same sheet again writes no row');

  assert.deepEqual(await commit(ctx, [[plate, 930], [lus28, 12]], { key }), job);
  assert.deepEqual(await contents(db), before, 'a retry writes no row');
  await refused(commit(ctx, [[plate, 931], [lus28, 12]], { key }), 'IV410', 'a used key for another sheet');
});

test('a different sheet for a committed job is its next revision: it replaces the lines, moves the version and shows in History (J7, S29, story 28)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await commit(ctx, [[plate, 930], [lus28, 12]]);
  const { version } = await onBoard(db, '33864R');

  const job = await commit(ctx, [[plate, 900], [hus, 4]], { name: 'Smith Residence West', version });
  assert.deepEqual(job, { number: '33864R', name: 'Smith Residence West', revision: 2, delivery_date: '2026-11-02' });
  assert.deepEqual(await currentLines(db, '33864R'), { [plate.id]: 900, [hus.id]: 4 }, 'the revision\'s lines replace the first sheet\'s');
  const committed = await figure(db, 'committed');
  assert.deepEqual([committed[plate.id], committed[lus28.id], committed[hus.id]], [900, 0, 4], 'Committed reads the revision');
  assert.equal((await onBoard(db, '33864R')).version, version + 1, 'a screen opened before the revision is stale');

  const log = (await logRows(db)).at(-1);
  assert.deepEqual([log.action, log.old_value, log.new_value],
    ['commit job', { number: '33864R', name: 'Smith Residence', revision: 1, delivery_date: '2026-11-02' }, job]);
  const { describeChange } = require('../src/settings/activity.js');
  assert.equal(describeChange(log.action, 'jobs', log.old_value, log.new_value), 'revision 1 → 2; name: Smith Residence → Smith Residence West');
});

test('a return to an earlier revision\'s content is a new revision; a stale screen is refused; a retry acts once (S65, Q48, S22)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  const first = [[plate, 930], [lus28, 12]];
  await commit(ctx, first);
  const stale = (await onBoard(db, '33864R')).version;
  const key = crypto.randomUUID();
  const second = await commit(ctx, [[plate, 900]], { version: stale, key });
  assert.equal(second.revision, 2);

  const before = await contents(db);
  const err = await refused(commit(ctx, first, { version: stale }), 'IV409', 'a change screen opened before revision 2');
  assert.equal(err.message, 'Someone else changed job 33864R since you opened this screen.');
  await refused(commit(ctx, first), 'IV409', 'no version');
  assert.deepEqual(await commit(ctx, [[plate, 900]], { version: stale, key }), second, 'the retry answers as the revision did');
  assert.deepEqual(await contents(db), before, 'neither the refusals nor the retry write a row');

  const back = await commit(ctx, first, { version: stale + 1 });
  assert.equal(back.revision, 3, 'the first sheet again is a new revision');
  assert.deepEqual(await currentLines(db, '33864R'), { [plate.id]: 930, [lus28.id]: 12 });
  assert.equal((await commit(ctx, first)).unchanged, true, 'only the current revision is unchanged');
});

test('a revised sheet with another delivery date needs a choice: keep the job\'s, or take the sheet\'s (story 34, J137)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 30]]);
  await setDate(ctx, '33864R', '2026-11-09');
  const version = () => onBoard(db, '33864R').then((j) => j.version);

  const err = await refused(commit(ctx, [[plate, 31]], { deliveryDate: '2026-11-16', version: await version() }), 'IV400', 'no choice');
  assert.equal(err.message, 'Job 33864R has another delivery date; choose which date to keep.');
  await commit(ctx, [[plate, 31]], { deliveryDate: '2026-11-16', version: await version(), keepDate: true });
  assert.deepEqual(await dated(db, '33864R'), { delivery_date: '2026-11-09', delivery_date_edited: true }, 'the hand-set date stays hand-set');

  // The sheet's own date again is no change of date, so no choice.
  await commit(ctx, [[plate, 32]], { deliveryDate: '2026-11-16', version: await version(), keepDate: false });
  assert.deepEqual(await dated(db, '33864R'), { delivery_date: '2026-11-16', delivery_date_edited: false }, 'the sheet\'s date is not an edit');
  await commit(ctx, [[plate, 33]], { deliveryDate: '2026-11-16', version: await version() });
  const [third, fourth] = (await logRows(db)).slice(-2);
  assert.equal(fourth.new_value.revision, 4);
  const { describeChange } = require('../src/settings/activity.js');
  assert.equal(describeChange(third.action, 'jobs', third.old_value, third.new_value), 'revision 2 → 3; delivery date: 2026-11-09 → 2026-11-16');
});

test('two first commits of one job at once save it once; the second finds the first (S20)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  const lines = [[plate, 930], [lus28, 12]];
  // The first commit holds its save open while the second starts, so the two meet every time.
  await as(db, APP, async (first) => {
    await first.query('BEGIN');
    await first.query('SELECT inv.commit_job($1, $2, $3)', [ctx.ann.id, crypto.randomUUID(),
      { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-02',
        lines: lines.map(([item, quantity]) => ({ item_id: item.id, quantity })) }]);
    const second = commit(ctx, lines);
    await as(db, null, async (owner) => {
      for (let waiting = 0; !waiting;) {
        waiting = (await owner.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity
                                       WHERE wait_event_type = 'Lock' AND query LIKE '%commit_job%'`)).rows[0].n;
      }
    });
    await first.query('COMMIT');
    assert.equal((await second).unchanged, true, await second);
  });
  assert.equal((await logRows(db)).filter((r) => r.target_table === 'jobs').length, 1);
});

test('a sheet with a retired or unknown item is refused whole, and leaves no row (J8)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate, lus28 } = ctx;
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), lus28.id, lus28.version);
  const before = await contents(db);
  const err = await refused(commit(ctx, [[plate, 930], [lus28, 12], [{ id: 999999 }, 1]]), 'IV422', 'retired and unknown');
  assert.equal(err.message, 'Job 33864R was not committed: LUS28, item 999999 is not in the catalog or is retired.');
  assert.deepEqual(await contents(db), before);
});

test('impossible sheets are refused before anything is saved', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  const before = await contents(db);
  await refused(commit(ctx, [[plate, 930]], { number: '  ' }), 'IV400', 'no job number');
  await refused(commit(ctx, []), 'IV400', 'no lines');
  for (const quantity of [0, -2, 1.5, '4', 2 ** 31]) {
    await refused(commit(ctx, [[plate, quantity]]), 'IV400', `quantity ${quantity}`);
  }
  await refused(commit(ctx, [[{}, 4]]), 'IV400', 'a line with no item');
  assert.deepEqual(await contents(db), before);
});

test('a saved sheet and its lines cannot be changed, even by the owner (design table 19)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 930]]);
  await as(db, null, async (owner) => {
    await refused(owner.query('UPDATE inv.job_lines SET quantity = 1'), 'IV422', 'edit a line');
    await refused(owner.query('DELETE FROM inv.job_sheets'), 'IV422', 'delete a sheet');
  });
});

// ── Seam 1: lumber lines and the saved cut plan (#99) ──────────────────────

// The catalog with two 2x4 #2 lengths; lumberJob(ctx) is p_job's lumber for
// a sheet that asks for 6 pieces at 8′ and 4 at 5′: 6 boards of 8′ whole,
// and 2 boards of 10′ cut 2 × 5′ each.
async function withLumber() {
  const ctx = await withCatalog();
  const add = (length_ft) => call(ctx.db, 'add_item', ctx.ann.id, crypto.randomUUID(), 'lumber', { size: '2x4', grade: '#2', length_ft });
  return { ...ctx, at8: await add(8), at10: await add(10) };
}
function lumberJob({ at8, at10 }) {
  return {
    demand: [{ material: '2x4 SP No.2', qty: 6, length: '8-00-00' }, { material: '2x4 SP No.2', qty: 4, length: '5-00-00' }],
    plan: [{ label: '2x4 #2', draws: [
      { item_id: at10.id, stock_length_ft: 10, boards: 2, required_length_ft: 5, contents: null, waste_ft: 0 },
      { item_id: at8.id, stock_length_ft: 8, boards: 6, required_length_ft: 8, contents: null, waste_ft: 0 },
    ] }],
  };
}

// The saved cut plan (or, with `table` lvl_cut_plans, the LVL plan) of job
// `number`'s current sheet, or null.
async function savedPlan(db, number, table = 'lumber_cut_plans') {
  return as(db, APP, async (app) => (await app.query(`
    SELECT p.plan FROM inv.${table} p JOIN inv.job_sheets s ON s.id = p.sheet_id
      JOIN inv.jobs j ON j.id = s.job_id
     WHERE j.number = $1 ORDER BY s.revision DESC LIMIT 1`, [number])).rows[0]?.plan ?? null);
}

test("a job's lumber lines are the boards of its cut plan, saved with its sheet (#99, story 13)", async () => {
  const ctx = await withLumber();
  const { db, plate, at8, at10 } = ctx;
  const lumber = lumberJob(ctx);
  await call(db, 'commit_job', ctx.ann.id, crypto.randomUUID(), {
    number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-02',
    lines: [{ item_id: plate.id, quantity: 930 }], lumber,
  });
  assert.deepEqual(await currentLines(db, '33864R'), { [plate.id]: 930, [at8.id]: 6, [at10.id]: 2 });
  assert.deepEqual(await savedPlan(db, '33864R'), lumber.plan);
});

test('the same sheet after the buying options change is unchanged, and keeps its saved plan (#99, story 13, S20)', async () => {
  const ctx = await withLumber();
  const { db, at10 } = ctx;
  const job = (lumber) => call(db, 'commit_job', ctx.ann.id, crypto.randomUUID(), { number: '33864R', lines: [], lumber });
  const first = lumberJob(ctx);
  await job(first);
  // 10′ switched off: the plan would now cut the 5′ pieces from 8′ boards.
  const replanned = { ...first, plan: [{ label: '2x4 #2', draws: [{ ...first.plan[0].draws[1], boards: 10 }] }] };
  assert.equal((await job(replanned)).unchanged, true);
  assert.deepEqual(await savedPlan(db, '33864R'), first.plan);

  const otherSheet = { ...first, demand: [{ material: '2x4 SP No.2', qty: 7, length: '8-00-00' }] };
  await refused(job(otherSheet), 'IV409', 'a different sheet is a revision, which carries the version its change screen saw');
});

test('lumber comes only from the cut plan, which holds only lumber; a retired board refuses the sheet (#99, J8)', async () => {
  const ctx = await withLumber();
  const { db, ann, plate, at8, at10 } = ctx;
  const job = (p) => call(db, 'commit_job', ann.id, crypto.randomUUID(), { number: '33864R', lines: [], ...p });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), at10.id, at10.version);
  const before = await contents(db);
  await refused(job({ lines: [{ item_id: at8.id, quantity: 6 }] }), 'IV400', 'a lumber line beside the plan');
  await refused(job({ lumber: { demand: [], plan: [{ label: 'MT20', draws: [{ item_id: plate.id, boards: 1 }] }] } }), 'IV400', 'a plate in the plan');
  await refused(job({ lumber: { demand: [], plan: [{ label: '2x4 #2' }] } }), 'IV400', 'a plan entry with no draws');
  const err = await refused(job({ lumber: lumberJob(ctx) }), 'IV422', 'a retired board');
  assert.match(err.message, /not in the catalog or is retired/);
  assert.deepEqual(await contents(db), before);

  await job({ lines: [{ item_id: plate.id, quantity: 1 }], lumber: { demand: [], plan: [{ label: '2x4 #2', draws: [{ item_id: at8.id, boards: 1 }] }] } });
  await as(db, null, async (owner) => {
    await refused(owner.query('UPDATE inv.lumber_cut_plans SET plan = \'[]\''), 'IV422', 'edit a saved plan');
  });
});

// ── Seam 1: committed and available through the one calculation (#98) ───────

test('a committed job commits its lines; available is on hand minus committed, and Reorder follows; a family not live shows no change (#98, J4)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate, lus28, hus } = ctx;
  await call(db, 'edit_item', ann.id, crypto.randomUUID(), lus28.id, lus28.version, { threshold: 3 });
  await goLive(db, 'hangers');
  await ctx.receive(lus28, 12);
  await commit(ctx, [[plate, 30], [lus28, 5]]);
  await commit(ctx, [[lus28, 4], [hus, 2]], { number: '33865R' });

  // Plates are not live, so the plate line is not tracked yet (J4). On hand
  // alone would leave LUS28 (12 > 3) and HUS26 (0) OK.
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 9, [hus.id]: 2 });
  assert.deepEqual(await figure(db, 'available'), { [plate.id]: 0, [lus28.id]: 3, [hus.id]: -2 });
  assert.deepEqual(await figure(db, 'reorder'), { [plate.id]: 'OK', [lus28.id]: 'Low', [hus.id]: 'Short' });
});

test("an LVL depth's linear feet count what jobs commit, so its lengths turn Low together (#98, Q35)", async () => {
  const ctx = await withCatalog();
  const { db, ann } = ctx;
  const lvl = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft });
  const long = await lvl(16);
  const short = await lvl(12);
  await call(db, 'set_lvl_depth_threshold', ann.id, crypto.randomUUID(), '11-7/8', null, 960);
  await goLive(db, 'lvl');
  await ctx.receive(long, 70);
  // 70 × 16′ = 1,120 LF on hand; the job takes 10 × 16′, leaving 960 LF, at the threshold.
  await call(db, 'commit_job', ann.id, crypto.randomUUID(), { number: '33864R', lines: [], lvl: {
    demand: [{ depth: '11-7/8', length_ft: 16, quantity: 10 }],
    plan: Array(10).fill({ item_id: long.id, depth: '11-7/8', length_ft: 16, source: 'on hand', pieces_ft: [16], remainder_ft: 0, kept_ft: null }),
  } });

  const reorder = await figure(db, 'reorder');
  assert.deepEqual([reorder[long.id], reorder[short.id]], ['Low', 'Low']);
  const depths = await as(db, APP, async (app) => (await app.query(
    'SELECT depth, available_lf, reorder FROM inv.lvl_depth_figures')).rows);
  assert.deepEqual(depths, [{ depth: '11-7/8', available_lf: 960, reorder: 'Low' }]);
});

// ── Seam 2: the commit route over HTTP ──────────────────────────────────────

// One job's material sheet in MiTek's layout: plates and hangers, and a
// lumber section with no lines. "MT20  3x4" has two spaces, as MiTek writes
// it; "Two HUS26" is 2 per unit; STC26 is bought as TC26.
const SHEET = [
  'Quote Date:,1/5/2026,Job Number:,33864R',
  'Order Date:,1/12/2026,Product:,Roof',
  'Delivery Date:,11/2/2026,,',
  'Job Name:,Smith Residence,Delivery Area,',
  'LUMBER SUMMARY,,,,',
  'SKU,Qty,LENGTH,MATERIAL NAME,USAGE',
  'PLATE SUMMARY,,,,',
  'SKU,QUANTITY,SIZE-GAUGE,WEIGHT,SQ. INCHES',
  ',,,,',
  ',930,MT20  3x4,64.18,5580',
  ',"1,000",,,',
  'Hangers,,,,,,,',
  'QTY,TYPE,SIZE,LENGTH,,NOTE,SELL,SELL',
  '12,Hanger,LUS28,,,,$1.00,$12.00',
  '4,Hanger,Two HUS26,,,,$1.00,$4.00',
  '6,Hanger,STC26,,,,$1.00,$6.00',
  'Total Hangers:,,$22.00',
].join('\n');

test('a sheet with a delivery date that does not exist is refused in plain words, before and after its job is in the app (#120)', async () => {
  const ctx = await appWithCatalog();
  const text = SHEET.replace('Delivery Date:,11/2/2026', 'Delivery Date:,2/30/2026');
  const check = () => post(ctx.base, '/api/jobs/check', { file: { name: '33864R-materials.csv', text } }, ctx.cookie);
  const refusal = { ok: false, error: 'The sheet\'s delivery date, 2/30/2026, is not a date.' };
  for (const res of [await check(), await commitFile(ctx, text)]) {
    assert.deepEqual([res.status, await res.json()], [400, refusal], 'a new job');
  }
  assert.equal((await commitFile(ctx)).status, 200);
  const res = await check();
  assert.deepEqual([res.status, await res.json()], [400, refusal], 'a job in the app');
});

// The app with Ann signed in and the sheet's items in the catalog.
async function appWithCatalog(skus = { plates: ['MT20 3x4'], hangers: ['LUS28', 'HUS26', 'TC26'] }) {
  const ctx = await withAdmin();
  const items = {};
  for (const [family, list] of Object.entries(skus)) {
    for (const sku of list) {
      const res = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family, identity: { sku } }, ctx.cookie);
      assert.equal(res.status, 200, `adding ${sku}: ${await res.clone().text()}`);
      items[sku] = (await res.json()).item;
    }
  }
  return { ...ctx, items };
}

// `revision`: a revised sheet's version and date choice, as the change screen sends them.
function commitFile(ctx, text = SHEET, key = crypto.randomUUID(), revision = {}) {
  return post(ctx.base, '/api/jobs/commit', { key, file: { name: '33864R-materials.csv', text }, ...revision }, ctx.cookie);
}

async function board(ctx) {
  const res = await get(ctx.base, '/api/jobs', ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).jobs;
}

function checkFile(ctx, text = SHEET) {
  return post(ctx.base, '/api/jobs/check', { file: { name: '33864R-materials.csv', text } }, ctx.cookie);
}

test('a dropped sheet shows its job and every line, each with what fixes it, and saves nothing (story 1, J27)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4'], hangers: ['LUS28', 'HUS26'] });
  const { LUS28 } = ctx.items;
  const retired = await post(ctx.base, '/api/items/retire', { key: crypto.randomUUID(), id: LUS28.id, version: LUS28.version }, ctx.cookie);
  assert.equal(retired.status, 200, await retired.clone().text());
  const before = await contents(ctx.db);

  const res = await checkFile(ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const { warnings, ...body } = await res.json();
  assert.deepEqual(body, {
    ok: true,
    job: { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-02', status: null },
    lines: [
      { family: 'plates', sku: 'MT20 3x4', quantity: 930, flag: null },
      { family: 'hangers', sku: 'LUS28', quantity: 12, flag: { retired: [{ id: LUS28.id, version: LUS28.version + 1 }] } },
      { family: 'hangers', sku: 'HUS26', quantity: 8, flag: null },
      { family: 'hangers', sku: 'TC26', quantity: 6,
        flag: { notInCatalog: true, addToCatalog: { family: 'hangers', identity: { sku: 'TC26' } } } },
    ],
    lvl_by_depth: [],
  });
  assert.ok(warnings.some((w) => /Two HUS26/.test(w)), 'the ply word is shown before the commit too');
  assert.deepEqual(await contents(ctx.db), before, 'nothing saved');

  const bad = await checkFile(ctx, 'not a sheet');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).ok, false);
});

test('the check of a job already in the app says so and asks for no catalog fix (J27)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const { LUS28 } = ctx.items;
  const retired = await post(ctx.base, '/api/items/retire', { key: crypto.randomUUID(), id: LUS28.id, version: LUS28.version }, ctx.cookie);
  assert.equal(retired.status, 200, await retired.clone().text());
  const body = await (await checkFile(ctx)).json();
  assert.equal(body.job.status, 'committed');
  assert.deepEqual(body.lines.filter((l) => l.flag), [], 'committing it again changes nothing, so nothing needs fixing');
});

test('a job sheet commits its plate and hanger lines and shows on the Job board (stories 1, 2, 11, 35, 36)', async () => {
  const ctx = await appWithCatalog();
  const { db, items } = ctx;
  const res = await commitFile(ctx);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.job.number, '33864R');
  assert.ok(body.warnings.some((w) => /Two HUS26/.test(w)), 'the ply word is shown, never silent');

  assert.deepEqual(await currentLines(db, '33864R'),
    { [items['MT20 3x4'].id]: 930, [items.LUS28.id]: 12, [items.HUS26.id]: 8, [items.TC26.id]: 6 });

  const [row, ...others] = await board(ctx);
  assert.equal(others.length, 0);
  assert.deepEqual({ ...row, changed_at: typeof row.changed_at }, {
    number: '33864R', name: 'Smith Residence', status: 'committed', delivery_date: '2026-11-02',
    // Neither family is live in a fresh database, so both are kept but not tracked yet (J4).
    families: [{ code: 'plates', name: 'Plates', live: false }, { code: 'hangers', name: 'Hangers', live: false }],
    version: 1, can_build: true, can_ship: true, can_cancel: true, can_unbuild: false, can_unship: false, pull_list: false, changed_by: 'Ann Lee', changed_at: 'string',
  });

  // The Activity Log names the job, and its family filter finds it by its lines.
  for (const [family, found] of [['hangers', 1], ['lumber', 0]]) {
    const log = await (await get(ctx.base, `/api/activity?action=commit+job&family=${family}`, ctx.cookie)).json();
    assert.deepEqual(log.entries.map(({ target, change }) => ({ target, change })),
      found ? [{ target: 'Job 33864R', change: 'added: Smith Residence, revision 1' }] : [], family);
  }
});

test('a second file with the same job number shows what changed and asks which date to keep; the commit saves it as the next revision (J7, stories 28, 34)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4'], hangers: ['LUS28', 'HUS26', 'TC26', 'HGUS26'] });
  assert.equal((await commitFile(ctx)).status, 200);
  const same = await (await checkFile(ctx)).json();
  assert.deepEqual([same.job.unchanged, same.changes, same.date_choice], [true, [], null], 'the same file again changes nothing');
  const dated = await post(ctx.base, '/api/jobs/delivery-date', { key: crypto.randomUUID(), number: '33864R', version: 1, delivery_date: '2026-11-05' }, ctx.cookie);
  assert.equal(dated.status, 200, await dated.clone().text());

  const revised = SHEET.replace(',930,MT20  3x4', ',900,MT20  3x4').replace('12,Hanger,LUS28,,,,$1.00,$12.00', '2,Hanger,HGUS26,,,,$1.00,$2.00')
    .replace('Delivery Date:,11/2/2026', 'Delivery Date:,11/9/2026');
  const res = await checkFile(ctx, revised);
  assert.equal(res.status, 200, await res.clone().text());
  const { warnings, lvl_by_depth, date_choice: { set_at, ...choice }, ...check } = await res.json();
  assert.deepEqual(check, {
    ok: true,
    job: { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-09', status: 'committed', version: 2, unchanged: false },
    lines: [
      { family: 'plates', sku: 'MT20 3x4', quantity: 900, flag: null },
      { family: 'hangers', sku: 'HGUS26', quantity: 2, flag: null },
      { family: 'hangers', sku: 'HUS26', quantity: 8, flag: null },
      { family: 'hangers', sku: 'TC26', quantity: 6, flag: null },
    ],
    changes: [
      { family: 'plates', sku: 'MT20 3x4', was: 930, now: 900 },
      { family: 'hangers', sku: 'HGUS26', was: null, now: 2 },
      { family: 'hangers', sku: 'LUS28', was: 12, now: null },
    ],
    name_was: null,
  });
  assert.deepEqual(choice, { current: '2026-11-05', set_by: 'Ann Lee' }, 'the current date was set by hand, by Ann');
  assert.ok(!Number.isNaN(Date.parse(set_at)), 'and when');

  const committed = await commitFile(ctx, revised, crypto.randomUUID(), { version: 2, keep_date: false });
  assert.equal(committed.status, 200, await committed.clone().text());
  assert.equal((await committed.json()).job.revision, 2);
  const [job] = await board(ctx);
  assert.deepEqual([job.delivery_date, job.version, (await (await checkFile(ctx, revised)).json()).job.unchanged], ['2026-11-09', 3, true]);
  const stale = await commitFile(ctx, SHEET, crypto.randomUUID(), { version: 2, keep_date: true });
  assert.equal(stale.status, 409, 'a change screen opened before the revision');
});

test('the check of a built, shipped or cancelled job says what saving does: what a built job consumes more, the refusal for a shipped one, the cancel it undoes (#121, J154–J156)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4', 'MT20 2x4'], hangers: ['LUS28', 'HUS26', 'TC26'] });
  await goLive(ctx.db, 'hangers');
  assert.equal((await commitFile(ctx)).status, 200);
  await mark(ctx, 'built', ['33864R']);
  await goLive(ctx.db, 'plates');

  const revised = SHEET.replace(',930,MT20  3x4,64.18,5580', ',950,MT20  3x4,64.18,5580\n,8,MT20  2x4,1.00,48')
    .replace('12,Hanger,LUS28,,,,$1.00,$12.00', '14,Hanger,LUS28,,,,$1.00,$14.00');
  const built = await (await checkFile(ctx, revised)).json();
  assert.deepEqual([built.job.status, built.job.version, built.job.unchanged, built.refusal, built.cancelled], ['built', 2, false, undefined, undefined]);
  assert.deepEqual(built.changes, [
    { family: 'plates', sku: 'MT20 2x4', was: null, now: 8, consumed: 0, more: 8 },
    { family: 'plates', sku: 'MT20 3x4', was: 930, now: 950, consumed: 930, more: 20 },
    { family: 'hangers', sku: 'LUS28', was: 12, now: 14 },
  ], 'a plate line says what Built settled, though plates went live after it, and what saving consumes more; a live hanger line waits for Shipped');
  assert.equal((await commitFile(ctx, revised, crypto.randomUUID(), { version: 2 })).status, 200);

  await mark(ctx, 'shipped', ['33864R']);
  const shipped = await (await checkFile(ctx, SHEET.replace('Job Number:,33864R', 'Job Number:,33864r'))).json();
  assert.deepEqual([shipped.job.status, shipped.refusal], ['shipped', `Job 33864R was already shipped by Ann Lee on ${today()}; un-ship it first.`]);
  assert.deepEqual(shipped.changes.map((c) => [c.sku, c.was, c.now]), [['MT20 2x4', 8, null], ['MT20 3x4', 950, 930], ['LUS28', 14, 12]],
    'the refusal names the job as the app does, and shows the difference');
  const sameShipped = await (await checkFile(ctx, revised)).json();
  assert.deepEqual([sameShipped.refusal, sameShipped.changes], [`Job 33864R was already shipped by Ann Lee on ${today()}.`, []]);

  await undo(ctx, 'unship_job', '33864R');
  await undo(ctx, 'cancel_job', '33864R');
  const cancelled = await (await checkFile(ctx, revised)).json();
  assert.deepEqual([cancelled.job.status, cancelled.job.unchanged, cancelled.changes, cancelled.refusal, cancelled.cancelled],
    ['cancelled', false, [], undefined, { handled: `cancelled by Ann Lee on ${today()}`, revision: 3 }], 'the same sheet commits a cancelled job again, as revision 3');
});

test('a revised sheet that changes only the job name shows the name it replaces (#120, Q142)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const renamed = SHEET.replace('Job Name:,Smith Residence', 'Job Name:,Jones Residence');
  const { job, changes, date_choice, name_was } = await (await checkFile(ctx, renamed)).json();
  assert.deepEqual({ name: job.name, unchanged: job.unchanged, changes, date_choice, name_was },
    { name: 'Jones Residence', unchanged: false, changes: [], date_choice: null, name_was: 'Smith Residence' });
  assert.equal((await (await checkFile(ctx)).json()).name_was, null, 'the same sheet again');
});

test('a retry after a line is retired answers as the first commit did; the same file again is unchanged (S20, S22)', async () => {
  const ctx = await appWithCatalog();
  const key = crypto.randomUUID();
  const first = await commitFile(ctx, SHEET, key);
  assert.equal(first.status, 200);
  const { job } = await first.json();
  const { LUS28 } = ctx.items;
  const retired = await post(ctx.base, '/api/items/retire', { key: crypto.randomUUID(), id: LUS28.id, version: LUS28.version }, ctx.cookie);
  assert.equal(retired.status, 200, await retired.clone().text());

  const retry = await commitFile(ctx, SHEET, key);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual((await retry.json()).job, job);
  const again = await commitFile(ctx);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await again.json()).job.unchanged, true);

  // A revised sheet with the retired line is refused for it, with what fixes it (J8, #120).
  const changed = await commitFile(ctx, SHEET.replace('12,Hanger,LUS28', '13,Hanger,LUS28'), crypto.randomUUID(), { version: 1 });
  assert.equal(changed.status, 422);
  const { error, lines } = await changed.json();
  assert.equal(error, 'Job 33864R was not committed: 1 line is not in the catalog or is retired.');
  assert.deepEqual(lines.map((l) => [l.sku, Object.keys(l.flag)]), [['LUS28', ['retired']]]);
});

test('a sheet with an unknown or a retired line is refused whole, each line with what fixes it (J8)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4'], hangers: ['LUS28', 'HUS26'] });
  const { cookie, items } = ctx;
  const { LUS28 } = items;
  const retired = await post(ctx.base, '/api/items/retire', { key: crypto.randomUUID(), id: LUS28.id, version: LUS28.version }, cookie);
  assert.equal(retired.status, 200, await retired.clone().text());
  const before = await contents(ctx.db);

  const res = await commitFile(ctx);
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), {
    ok: false,
    error: 'Job 33864R was not committed: 2 lines are not in the catalog or are retired.',
    lines: [
      { family: 'hangers', sku: 'LUS28', quantity: 12, flag: { retired: [{ id: LUS28.id, version: LUS28.version + 1 }] } },
      { family: 'hangers', sku: 'TC26', quantity: 6,
        flag: { notInCatalog: true, addToCatalog: { family: 'hangers', identity: { sku: 'TC26' } } } },
    ],
  });
  assert.deepEqual(await contents(ctx.db), before, 'nothing saved');

  // With every line in the catalog, the database refuses the retired line, and the lines still say what fixes it.
  const added = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family: 'hangers', identity: { sku: 'TC26' } }, cookie);
  assert.equal(added.status, 200, await added.clone().text());
  const retiredOnly = await commitFile(ctx);
  assert.equal(retiredOnly.status, 422);
  assert.deepEqual((await retiredOnly.json()).lines.map((l) => [l.sku, Object.keys(l.flag)]), [['LUS28', ['retired']]]);
});

test('a file that is not a job material sheet is refused with the reason', async () => {
  const ctx = await appWithCatalog();
  const res = await commitFile(ctx, 'sku,on_hand\nLUS28,4\n');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Job Number/);
  const none = await commitFile(ctx, SHEET.replace(/PLATE SUMMARY[^]*$/, ''));
  assert.equal(none.status, 400);
  assert.equal((await none.json()).error, 'Job 33864R has no lines to commit.');
});

// ── Seam 2: lumber and LVL over HTTP (#99) ─────────────────────────────────

// A job with lumber and LVL only. The lumber asks for 6 pieces of 2x4 #2 at
// 8′, 4 at 5′ and 3 of 2x6 DSS at 16′; the LVL is 4 × 20′ and 4 × 12′ of
// 11-7/8 and 2 × 14′ of 14.
const LUMBER_SHEET = [
  'Quote Date:,1/5/2026,Job Number:,33865R',
  'Order Date:,1/12/2026,Product:,Roof',
  'Delivery Date:,11/3/2026,,',
  'Job Name:,Jones Garage,Delivery Area,',
  'LUMBER SUMMARY,,,,,,,,',
  'SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT,COST,COST PER,TOTAL',
  '2x4sp2,6,8-00-00,2x4 SP No.2,Regular,,48.00,,,,',
  '2x4sp2,4,5-00-00,2x4 SP No.2,Regular,,20.00,,,,',
  '2x6spdss,3,16-00-00,2x6 SP DSS,Regular,,48.00,,,,',
  'Rectangular EWP,,,,,,,',
  'LABEL,SIZE,QTY,LENGTH,,,,',
  '1BM1-4,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,4,20-00-00,,,,',
  '1BM4-4,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,4,12-00-00,,,,',
  '1BM3-2,2.1 RigidLam DF LVL 1-3/4 x 14,2,14-00-00,,,,',
].join('\n');
const LUMBER_ONLY_SHEET = LUMBER_SHEET.slice(0, LUMBER_SHEET.indexOf('\nRectangular EWP'));

// The app with Ann signed in and LUMBER_SHEET's boards and LVL in the catalog.
async function appWithLumber() {
  const ctx = await withAdmin();
  const items = {};
  const add = async (family, identity, name) => {
    const res = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family, identity }, ctx.cookie);
    assert.equal(res.status, 200, `adding ${name}: ${await res.clone().text()}`);
    items[name] = (await res.json()).item;
  };
  for (const length_ft of [8, 10]) await add('lumber', { size: '2x4', grade: '#2', length_ft }, `2x4 #2 ${length_ft}`);
  await add('lumber', { size: '2x6', grade: 'DSS', length_ft: 16 }, '2x6 DSS 16');
  for (const [size, length_ft] of [['11-7/8', 20], ['11-7/8', 12], ['14', 14]]) {
    await add('lvl', { product: '2.1 RigidLam LVL 1-3/4', size, length_ft }, `LVL ${size} ${length_ft}`);
  }
  // The LVL on hand at the sheet's lengths, so its plan pulls those boards (#182).
  await goLive(ctx.db, 'lvl');
  const supplier = await call(ctx.db, 'add_supplier', ctx.ann.id, crypto.randomUUID(), 'Boise');
  const onHand = (name, quantity) => call(ctx.db, 'receive', ctx.ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: items[name].id, quantity }]));
  await onHand('LVL 11-7/8 20', 4);
  await onHand('LVL 11-7/8 12', 4);
  await onHand('LVL 14 14', 2);
  return { ...ctx, items, onHand };
}

const lumberFile = (text = LUMBER_SHEET) => ({ name: '33865R-materials.csv', text });

test('a lumber and LVL sheet commits the boards of its cut plan and its LVL lengths (#99, stories 1, 13)', async () => {
  const ctx = await appWithLumber();
  const { db, items } = ctx;
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile() }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  // 6 whole 8′ boards; the four 5′ pieces two to a 10′ board.
  assert.deepEqual(await currentLines(db, '33865R'), {
    [items['2x4 #2 8'].id]: 6, [items['2x4 #2 10'].id]: 2, [items['2x6 DSS 16'].id]: 3,
    [items['LVL 11-7/8 20'].id]: 4, [items['LVL 11-7/8 12'].id]: 4, [items['LVL 14 14'].id]: 2,
  });
  const [row] = await board(ctx);
  assert.deepEqual(row.families.map((f) => f.name), ['Lumber', 'LVL']);
});

test('the check shows each board of the cut plan, each LVL length with its linear feet, and LVL feet by depth (#99, Q59)', async () => {
  const ctx = await appWithLumber();
  const res = await post(ctx.base, '/api/jobs/check', { file: lumberFile() }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const { lines, lvl_by_depth } = await res.json();
  // Each LVL board's cuts: #184's tests.
  assert.deepEqual(lines.map(({ cuts, ...l }) => l), [
    { family: 'lumber', sku: '2x4 #2 10′', quantity: 2, flag: null },
    { family: 'lumber', sku: '2x4 #2 8′', quantity: 6, flag: null },
    { family: 'lumber', sku: '2x6 DSS 16′', quantity: 3, flag: null },
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 11-7/8 · 20′', quantity: 4, lf: 80, flag: null },
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 11-7/8 · 12′', quantity: 4, lf: 48, flag: null },
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 14 · 14′', quantity: 2, lf: 28, flag: null },
  ]);
  assert.deepEqual(lvl_by_depth, [{ label: '11-7/8"', lf: 128 }, { label: '14"', lf: 28 }]);
});

test('a lumber line the plan cannot place refuses the whole job, with the reason on the line (#99, J58)', async () => {
  const ctx = await appWithLumber();
  // 18′ is longer than any 2x6 DSS length bought; No.3 is a grade not bought.
  const text = LUMBER_SHEET.replace('2x6spdss,3,16-00-00', '2x6spdss,3,18-00-00')
    .replace('Rectangular EWP', '2x4sp3,5,8-00-00,2x4 SP No.3,Regular,,40.00,,,,\nRectangular EWP');
  const before = await contents(ctx.db);
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile(text) }, ctx.cookie);
  assert.equal(res.status, 422, await res.clone().text());
  const body = await res.json();
  assert.equal(body.error, 'Job 33865R was not committed: 2 lumber lines cannot be planned with the lengths we buy.');
  assert.deepEqual(body.lines.map((l) => [l.sku, l.quantity, Object.keys(l.flag)]), [
    ['2x4 SP No.3', 5, ['notPlanned']], ['2x6 DSS 18′', 3, ['notPlanned']],
  ]);
  assert.deepEqual(await contents(ctx.db), before, 'nothing saved');
});

test('each lumber line the plan cannot place says its own fix (#114)', async () => {
  const ctx = await appWithLumber();
  // 18′ is longer than any 2x6 DSS length bought; No.3 is a grade not known; 2x8 #2 is a known grade with no lengths bought;
  // "Mystery" has a size that cannot be read.
  const text = LUMBER_SHEET.replace('2x6spdss,3,16-00-00', '2x6spdss,3,18-00-00')
    .replace('Rectangular EWP', '2x4sp3,5,8-00-00,2x4 SP No.3,Regular,,40.00,,,,\n2x8sp2,2,8-00-00,2x8 SP No.2,Regular,,16.00,,,,\n'
      + 'mystery,1,8-00-00,Mystery board,Regular,,8.00,,,,\nRectangular EWP');
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile(text) }, ctx.cookie);
  assert.equal(res.status, 422, await res.clone().text());
  const { lines } = await res.json();
  assert.deepEqual(Object.fromEntries(lines.map((l) => [l.sku, l.flag.notPlanned])), {
    '2x4 SP No.3': 'Unrecognized grade — not in the purchase menu. The app does not know this grade. Ask for the grade to be added.',
    '2x8 #2 8′': 'Unknown size/grade: 2x8 #2. In the Planner\'s Stock lengths panel, add this size and grade if it is missing '
      + 'and turn on lengths for it, or redirect it to a stronger grade we buy.',
    '2x6 DSS 18′': 'Required length 18 exceeds longest stocked length for 2x6 DSS. Add a longer length in the Planner\'s Stock lengths panel.',
    'Mystery board 8-00-00': 'Its size cannot be read.',
  });
});

// Job `number`'s pull list as text, tags and spacing dropped.
async function pullListText(ctx, number) {
  const page = await get(ctx.base, '/api/jobs/pull-list?' + new URLSearchParams({ number }), ctx.cookie);
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(page.headers.get('content-type'), /text\/html/);
  return (await page.text()).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
}

test('the lumber pull list prints the saved cut plan, after the buying options change too (#99, story 48, story 13, Q57)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile() }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  // 10′ 2x4 #2 no longer bought: a new plan would cut the 5′ pieces from 6′ boards.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '#2'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x4', '#2', version, [6, 7, 8, 12, 14, 16, 20]);

  const text = await pullListText(ctx, '33865r');
  assert.match(text, /Pull List — Job 33865R Jones Garage Delivery 11\/3\/2026/);
  assert.match(text, /2x4 #2 Boards Length Cut instruction LF ×2 10′ 2 × 5′ per board 20 ×6 8′ full length 48 /);
  assert.match(text, /2x6 DSS Boards Length Cut instruction LF ×3 16′ full length 48 /);
  assert.match(text, /11 boards 116 LF 0 ft scrap LVL Boards Depth /, 'the lumber totals close the lumber part, before LVL (#184)');

  assert.deepEqual((await board(ctx)).map((j) => j.pull_list), [true]);
  assert.equal((await get(ctx.base, '/api/jobs/pull-list?number=99999', ctx.cookie)).status, 404);
});

test('a job with lumber and no LVL prints its lumber pull list with no LVL part (#184)', async () => {
  const ctx = await appWithLumber();
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile(LUMBER_ONLY_SHEET) }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());

  const text = await pullListText(ctx, '33865R');
  assert.match(text, /11 boards 116 LF 0 ft scrap/);
  assert.doesNotMatch(text, /LVL/);
});

test('a committed job keeps its saved cut plan after the buying options change: the check shows it, the same sheet is unchanged, a retry answers as before (#99, S20, S22)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  const key = crypto.randomUUID();
  const first = await post(ctx.base, '/api/jobs/commit', { key, file: lumberFile() }, ctx.cookie);
  assert.equal(first.status, 200, await first.clone().text());
  const committed = await first.json();
  // 10′ 2x4 #2 no longer bought: a new plan would use a 20′ board, not in the catalog.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '#2'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x4', '#2', version, [6, 7, 8, 12, 14, 16, 20]);

  const check = await (await post(ctx.base, '/api/jobs/check', { file: lumberFile() }, ctx.cookie)).json();
  assert.deepEqual(check.lines.filter((l) => l.family === 'lumber'), [
    { family: 'lumber', sku: '2x4 #2 10′', quantity: 2, flag: null },
    { family: 'lumber', sku: '2x4 #2 8′', quantity: 6, flag: null },
    { family: 'lumber', sku: '2x6 DSS 16′', quantity: 3, flag: null },
  ]);
  const again = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile() }, ctx.cookie);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await again.json()).job.unchanged, true);
  const retry = await post(ctx.base, '/api/jobs/commit', { key, file: lumberFile() }, ctx.cookie);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.deepEqual(await retry.json(), committed);
});

test('a revised sheet saves its own cut plan when its lumber lines changed, and keeps the saved one when they did not; the pull list prints the current one (#120, J138, story 48)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  const commitLumber = (text, version) => post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile(text), version }, ctx.cookie);
  const check = async (text) => (await post(ctx.base, '/api/jobs/check', { file: lumberFile(text) }, ctx.cookie)).json();
  const pullList = () => pullListText(ctx, '33865R');
  assert.equal((await commitLumber(LUMBER_SHEET)).status, 200);

  const moreLumber = LUMBER_SHEET.replace('2x4sp2,6,8-00-00', '2x4sp2,7,8-00-00');
  assert.deepEqual((await check(moreLumber)).changes, [{ family: 'lumber', sku: '2x4 #2 8′', was: 6, now: 7 }]);
  const res = await commitLumber(moreLumber, 1);
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(await pullList(), /×7 8′ full length 56 /, 'the pull list prints the revision\'s plan');

  // 10′ 2x4 #2 no longer bought: a new plan would cut the 5′ pieces otherwise.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '#2'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x4', '#2', version, [6, 7, 8, 12, 14, 16, 20]);
  const moreLvl = moreLumber.replace('1BM3-2,2.1 RigidLam DF LVL 1-3/4 x 14,2,', '1BM3-2,2.1 RigidLam DF LVL 1-3/4 x 14,3,');
  await ctx.onHand('LVL 14 14', 1);
  assert.deepEqual((await check(moreLvl)).changes, [{ family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 14 · 14′', was: 2, now: 3 }],
    'the lumber lines did not change, so neither did the plan');
  assert.equal((await commitLumber(moreLvl, 2)).status, 200);
  assert.match(await pullList(), /×2 10′ 2 × 5′ per board 20 ×7 8′ full length 56 /, 'the saved plan, from before the buying options changed');
});

test('a cut plan saved before 014 has no lumber lines, so a sheet for its job is planned again; the same sheet stays unchanged (#120, 014)', async () => {
  const ctx = await appWithLumber();
  const check = async (text) => (await post(ctx.base, '/api/jobs/check', { file: lumberFile(text) }, ctx.cookie)).json();
  assert.equal((await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile() }, ctx.cookie)).status, 200);
  // As 014 left every plan saved before it.
  await as(ctx.db, null, (owner) => owner.query(`ALTER TABLE inv.lumber_cut_plans DISABLE TRIGGER refuse_edit;
    UPDATE inv.lumber_cut_plans SET demand = NULL;
    ALTER TABLE inv.lumber_cut_plans ENABLE TRIGGER refuse_edit;`));

  assert.equal((await check(LUMBER_SHEET)).job.unchanged, true, 'the same sheet, planned again, is the current revision');
  const moreLumber = await check(LUMBER_SHEET.replace('2x4sp2,6,8-00-00', '2x4sp2,7,8-00-00'));
  assert.deepEqual(moreLumber.changes, [{ family: 'lumber', sku: '2x4 #2 8′', was: 6, now: 7 }], 'the new plan, not the saved one');
});

test('an LVL line shows its linear feet to two decimals (#99, Q59)', async () => {
  const ctx = await appWithLumber();
  // 24″ is bought at the sheet's lengths (#182), so its line is 3 × 11′4″.
  const text = LUMBER_SHEET.replace('1-3/4 x 14,2,14-00-00', '1-3/4 x 24,3,11-04-00');
  const { lines } = await (await post(ctx.base, '/api/jobs/check', { file: lumberFile(text) }, ctx.cookie)).json();
  assert.equal(lines.at(-1).lf, 34);
});

test('LVL lines whose depth cannot be read stay separate lines (#99)', async () => {
  const ctx = await appWithLumber();
  const text = LUMBER_SHEET.replace('1BM3-2,2.1 RigidLam DF LVL 1-3/4 x 14,2,14-00-00',
    '1BM3-2,Mystery Beam A,2,14-00-00,,,,\n1BM5-3,Mystery Beam B,3,20-00-00,,,,');
  const { lines } = await (await post(ctx.base, '/api/jobs/check', { file: lumberFile(text) }, ctx.cookie)).json();
  assert.deepEqual(lines.filter((l) => /Mystery/.test(l.sku)).map(({ sku, quantity, lf }) => [sku, quantity, lf]), [
    ['Mystery Beam A · 14′', 2, 28], ['Mystery Beam B · 20′', 3, 60],
  ]);
});

test('the pull list with no job number asks for one (#99)', async () => {
  const ctx = await withAdmin();
  const res = await get(ctx.base, '/api/jobs/pull-list', ctx.cookie);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Name the job whose pull list to print.');
});

test('Jobs is in the header of every signed-in page (J9)', async () => {
  const ctx = await withAdmin();
  for (const page of ['/', '/jobs', '/inventory', '/inventory/receive', '/inventory/count', '/inventory/month-end',
    '/settings/users', '/settings/suppliers', '/activity']) {
    const res = await get(ctx.base, page, ctx.cookie);
    assert.equal(res.status, 200, page);
    assert.match(await res.text(), /<nav class="appbar-nav"[^>]*>.*<a href="\/jobs"[^>]*>Jobs<\/a>/, `${page} links to Jobs`);
  }
});

// ── Seam 1: Built, Shipped and Deduct directly (#100) ───────────────────────

// The job's number and version as the board shows them, for marking.
async function onBoard(db, number) {
  return as(db, APP, async (app) =>
    (await app.query('SELECT number, version FROM inv.jobs WHERE number = $1', [number])).rows[0]);
}

// The status of job `number`.
async function jobStatus(db, number) {
  return as(db, APP, async (app) => (await app.query('SELECT status FROM inv.jobs WHERE number = $1', [number])).rows[0].status);
}

// Marks jobs `numbers` built or shipped (`status`) as Ann, at the versions
// the board shows now.
async function mark(ctx, status, numbers, { timing = null, key = crypto.randomUUID() } = {}) {
  const jobs = await Promise.all(numbers.map((n) => onBoard(ctx.db, n)));
  return call(ctx.db, `mark_${status}`, ctx.ann.id, key, JSON.stringify(jobs), timing && JSON.stringify(timing));
}

test('Built consumes the plates; the hangers stay committed until Shipped (stories 15, 16)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 1000);
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 930], [lus28, 12]]);

  const [built] = (await mark(ctx, 'built', ['33864R'])).jobs;
  assert.deepEqual([built.number, built.status, built.version], ['33864R', 'built', 2]);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 70, [lus28.id]: 20, [ctx.hus.id]: 0 });
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 12, [ctx.hus.id]: 0 });

  await mark(ctx, 'shipped', ['33864R']);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 70, [lus28.id]: 8, [ctx.hus.id]: 0 });
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 0, [ctx.hus.id]: 0 });
  const log = (await logRows(db)).slice(-2).map((l) => l.action);
  assert.deepEqual(log, ['mark built', 'mark shipped']);
});

test('Shipped from committed consumes everything; a family not live in Inventory writes no ledger rows (stories 17, 22; J4, J5)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'hangers');
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 930], [lus28, 12], [hus, 4]]);

  const [shipped] = (await mark(ctx, 'shipped', ['33864R'])).jobs;
  assert.equal(shipped.status, 'shipped');
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 0, [lus28.id]: 8, [hus.id]: -4 });
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 0, [hus.id]: 0 });
  const rows = await as(db, APP, async (app) => (await app.query(
    "SELECT item_id::int, quantity, kind FROM inv.ledger WHERE kind <> 'receipt' ORDER BY item_id")).rows);
  assert.deepEqual(rows, [{ item_id: lus28.id, quantity: -12, kind: 'ship' }, { item_id: hus.id, quantity: -4, kind: 'ship' }],
    'no plate row: plates are not live');
});

test('Built and Shipped follow the allowed paths; Built is refused on a job with no plates, lumber or LVL (stories 18; #96 "Database rules")', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await commit(ctx, [[lus28, 2]], { number: '1H' });
  await commit(ctx, [[plate, 5]], { number: '2P' });
  const before = (await logRows(db)).length;
  const hangersOnly = await refused(mark(ctx, 'built', ['1H']), 'IV422', 'Built on a hangers-only job');
  assert.equal(hangersOnly.message, 'Job 1H has no plates, lumber or LVL to build; mark it shipped.');

  await mark(ctx, 'built', ['2P']);
  const twice = await refused(mark(ctx, 'built', ['2P']), 'IV422', 'Built twice');
  assert.equal(twice.message, 'Job 2P is built, so it cannot be marked built.');
  await mark(ctx, 'shipped', ['2P']);
  for (const to of ['built', 'shipped']) {
    const err = await refused(mark(ctx, to, ['2P']), 'IV422', `a shipped job marked ${to}`);
    assert.equal(err.message, `Job 2P is shipped, so it cannot be marked ${to}.`);
  }
  assert.equal((await logRows(db)).length, before + 2, 'only the two allowed marks are logged');
});

test('a stale save is refused; a batch that fails on one job saves none; a retry acts once (Q48, S21, S22)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await goLive(db, 'plates');
  await ctx.receive(plate, 100);
  await commit(ctx, [[plate, 10]], { number: '1P' });
  await commit(ctx, [[plate, 20]], { number: '2P' });
  const stale = [await onBoard(db, '1P'), await onBoard(db, '2P')];
  await mark(ctx, 'built', ['2P']);

  const before = await contents(db);
  const err = await refused(call(db, 'mark_built', ctx.ann.id, crypto.randomUUID(), JSON.stringify(stale), null),
    'IV409', 'the board showed 2P before it was built');
  assert.equal(err.message, 'Someone else changed job 2P since you opened this screen.');
  assert.deepEqual(await contents(db), before, '1P is not built either');

  const key = crypto.randomUUID();
  const first = await mark(ctx, 'shipped', ['1P', '2P'], { key });
  const again = await call(db, 'mark_shipped', ctx.ann.id, key,
    JSON.stringify([{ number: '1P', version: 1 }, { number: '2P', version: 2 }]), null);
  assert.deepEqual(again, first, 'the retry answers as the first save did');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70, 'consumed once: 100 − 10 − 20');
  assert.deepEqual(first.jobs.map((j) => [j.number, j.status, j.version]), [['1P', 'shipped', 2], ['2P', 'shipped', 3]]);
});

test('count 8:00, Built 11:00, approval 14:00: on hand includes the build (ADR 0002; story 21)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate } = ctx;
  await goLive(db, 'plates');
  await ctx.receive(plate, 100);
  await commit(ctx, [[plate, 30]]);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  const started = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'plates', 'spot check', null);
  const lines = JSON.stringify([{ item_id: plate.id, loose: 100 }]);
  const count = await call(db, 'submit_count', ann.id, crypto.randomUUID(), started.id, started.version, started.closes, lines);

  const asked = await refused(mark(ctx, 'built', ['33864R']), 'IV409', 'Built after a count, with no answer');
  assert.equal(asked.message, 'Was this before or after the count? Pick one, then save again.');
  const [built] = (await mark(ctx, 'built', ['33864R'], { timing: { after: count.id } })).jobs;
  assert.deepEqual(built.timed, { before: false, counted_at: count.counted_at });

  await call(db, 'approve_count', bob.id, crypto.randomUUID(), count.id, count.version, '{}');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70, "the count's 100 less the build's 30");
});

test('a revised sheet that consumes more of a built job asks "before or after the count?" as Built does; one that consumes nothing does not ask (#121, J154)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate } = ctx;
  await goLive(db, 'plates');
  await ctx.receive(plate, 100);
  await commit(ctx, [[plate, 30]]);
  await mark(ctx, 'built', ['33864R']);
  const started = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'plates', 'spot check', null);
  const lines = JSON.stringify([{ item_id: plate.id, loose: 70 }]);
  const count = await call(db, 'submit_count', ann.id, crypto.randomUUID(), started.id, started.version, started.closes, lines);

  const version = (await onBoard(db, '33864R')).version;
  const asked = await refused(commit(ctx, [[plate, 40]], { version }), 'IV409', 'a revision that consumes more, after a count, with no answer');
  assert.equal(asked.message, 'Was this before or after the count? Pick one, then save again.');
  const revised = await commit(ctx, [[plate, 40]], { version, timing: { after: count.id } });
  assert.deepEqual([revised.revision, revised.timed], [2, { before: false, counted_at: count.counted_at }]);
  const less = await commit(ctx, [[plate, 35]], { version: (await onBoard(db, '33864R')).version });
  assert.equal(less.revision, 3, 'a revision that consumes nothing more saves without asking');
});

// Today as a refusal says it: October 26, 2026.
const today = () => new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });

test('a revised sheet for a built job consumes only what it needs beyond what the job consumed; the same sheet is unchanged (Q27, S66, J154, J157)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 100);
  await ctx.receive(hus, 10);
  await commit(ctx, [[plate, 30], [lus28, 2]]);
  await mark(ctx, 'built', ['33864R']);
  const same = await commit(ctx, [[plate, 30], [lus28, 2]]);
  assert.equal(same.unchanged, true, 'the same sheet for a built job changes nothing');

  const more = await commit(ctx, [[plate, 40], [lus28, 2], [hus, 3]], { version: (await onBoard(db, '33864R')).version });
  assert.equal(more.revision, 2);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 60, [lus28.id]: 0, [hus.id]: 10 }, 'the revision takes the 10 plates beyond the 30 built');
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 2, [hus.id]: 3 }, 'hangers stay committed until Shipped');
  assert.equal(await jobStatus(db, '33864R'), 'built', 'the job stays built');

  await commit(ctx, [[plate, 25], [lus28, 2], [hus, 3]], { version: (await onBoard(db, '33864R')).version });
  assert.equal((await figure(db, 'on_hand'))[plate.id], 60, 'what was consumed stays consumed when the sheet needs less');
  await call(db, 'unbuild_job', ctx.ann.id, crypto.randomUUID(), '33864R', (await onBoard(db, '33864R')).version);
  assert.equal((await figure(db, 'on_hand'))[plate.id], 100, 'Un-build gives back the 40 the job consumed');
});

test('a revision of a built job consumes a line of a family that went live after Built or Shipped only beyond what any sheet since then asked; who built the job stays its builder (J4, PR #126 findings 1 and 2)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate, lus28 } = ctx;
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  await goLive(db, 'hangers');
  await commit(ctx, [[plate, 930], [lus28, 12]]);
  await mark(ctx, 'built', ['33864R']);
  await commit(ctx, [[plate, 930], [lus28, 12]], { number: '2P' });
  await mark(ctx, 'shipped', ['2P']);
  await undo(ctx, 'unship_job', '2P');
  assert.equal(await jobStatus(db, '2P'), 'built', 'Un-ship of a job with plates makes it built, with no Built of its own');
  await goLive(db, 'plates');
  await ctx.receive(plate, 70);
  const version = async (number = '33864R') => (await onBoard(db, number)).version;
  await commit({ ...ctx, ann: bob }, [[plate, 930], [lus28, 14]], { version: await version() });
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70, 'Built settled the 930 plates, though plates were not live then');
  await commit(ctx, [[plate, 930], [lus28, 14]], { number: '2P', version: await version('2P') });
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70, 'Shipped settled the 930 plates of job 2P too');
  await commit(ctx, [[plate, 1000], [lus28, 14]], { version: await version() });
  assert.equal((await figure(db, 'on_hand'))[plate.id], 0, 'the revision consumes the 70 beyond the 930');
  await commit(ctx, [[plate, 930], [lus28, 14]], { version: await version() });
  await commit(ctx, [[plate, 1000], [lus28, 14]], { version: await version() });
  assert.equal((await figure(db, 'on_hand'))[plate.id], 0, 'a sheet since Built already asked for 1,000, so nothing is consumed again');

  await commit({ ...ctx, ann: bob }, [[plate, 1000], [lus28, 15]], { version: await version() });
  const refusal = await refused(deduct(ctx, [[plate, 1000], [lus28, 15]]), 'IV422', 'a built job');
  assert.equal(refusal.message, `Job 33864R was already built by Ann Lee on ${today()}.`, 'Bob saved a revision; Ann built the job');
});

// How many plates `step` takes off on hand.
async function platesConsumedBy(ctx, step) {
  const before = (await figure(ctx.db, 'on_hand'))[ctx.plate.id] ?? 0;
  await step();
  return before - ((await figure(ctx.db, 'on_hand'))[ctx.plate.id] ?? 0);
}

// Saves sheet `lines` for job `number` as a revision, with the version the
// board shows; a step for platesConsumedBy.
function revise(ctx, number, lines) {
  return async () => commit(ctx, lines, { number, version: (await onBoard(ctx.db, number)).version });
}

test('a Cancel or an Un-ship to committed ends what a Built settled, so a revision after the next Built consumes beyond it (PR #126 third review, finding 1)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'hangers');
  await goLive(db, 'plates');
  await ctx.receive(plate, 2000);

  await commit(ctx, [[plate, 500]], { number: '1C' });
  await mark(ctx, 'built', ['1C']);
  await undo(ctx, 'cancel_job', '1C');
  await revise(ctx, '1C', [[plate, 1000]])();
  await revise(ctx, '1C', [[plate, 600]])();
  assert.equal(await platesConsumedBy(ctx, () => mark(ctx, 'built', ['1C'])), 100, 'Built takes the 100 beyond the 500 kept at Cancel');
  assert.equal(await platesConsumedBy(ctx, revise(ctx, '1C', [[plate, 1000]])), 400,
    'the sheets saved while the job was committed again settle nothing');

  await commit(ctx, [[lus28, 12]], { number: '2U' });
  await mark(ctx, 'shipped', ['2U']);
  await undo(ctx, 'unship_job', '2U');
  assert.equal(await jobStatus(db, '2U'), 'committed', 'Un-ship of a hangers-only job makes it committed');
  await revise(ctx, '2U', [[plate, 900], [lus28, 12]])();
  await revise(ctx, '2U', [[plate, 500], [lus28, 12]])();
  assert.equal(await platesConsumedBy(ctx, () => mark(ctx, 'built', ['2U'])), 500);
  assert.equal(await platesConsumedBy(ctx, revise(ctx, '2U', [[plate, 900], [lus28, 12]])), 400,
    'the Shipped before the Un-ship settles nothing');
});

test('what is settled starts at the first Built or Shipped since the job was last committed or cancelled (PR #126 third review, findings 2 and 3; J171)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'hangers');

  await commit(ctx, [[plate, 930], [lus28, 2]], { number: '1F' });
  await mark(ctx, 'built', ['1F']);
  await revise(ctx, '1F', [[plate, 500], [lus28, 2]])();
  await mark(ctx, 'shipped', ['1F']);
  await undo(ctx, 'unship_job', '1F');
  await commit(ctx, [[plate, 930]], { number: '2B' });
  await mark(ctx, 'built', ['2B']);
  await undo(ctx, 'unbuild_job', '2B');
  await revise(ctx, '2B', [[plate, 500]])();
  await commit(ctx, [[plate, 930]], { number: '3C' });
  await mark(ctx, 'built', ['3C']);
  await undo(ctx, 'cancel_job', '3C');

  await goLive(db, 'plates');
  await ctx.receive(plate, 3000);
  assert.equal(await platesConsumedBy(ctx, revise(ctx, '1F', [[plate, 930], [lus28, 2]])), 0,
    'the first Built, not the later Shipped, settled the 930');
  assert.equal(await platesConsumedBy(ctx, () => mark(ctx, 'built', ['2B'])), 500);
  assert.equal(await platesConsumedBy(ctx, revise(ctx, '2B', [[plate, 930]])), 430, 'the Built before the Un-build settles nothing');
  await revise(ctx, '3C', [[plate, 100]])();
  assert.equal(await platesConsumedBy(ctx, () => mark(ctx, 'built', ['3C'])), 100);
  assert.equal(await platesConsumedBy(ctx, revise(ctx, '3C', [[plate, 930]])), 830, 'the Built before the Cancel settles nothing');
});

test('a sheet for a shipped job is refused with who shipped it and when; a changed one says to un-ship it first (S28, S30, Q61, J155)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await commit(ctx, [[plate, 5], [lus28, 2]]);
  await mark(ctx, 'shipped', ['33864R']);
  const changed = await refused(commit(ctx, [[plate, 6], [lus28, 2]], { version: (await onBoard(db, '33864R')).version }),
    'IV422', 'a changed sheet, shipped');
  assert.equal(changed.message, `Job 33864R was already shipped by Ann Lee on ${today()}; un-ship it first.`);
  const same = await refused(commit(ctx, [[plate, 5], [lus28, 2]]), 'IV422', 'the same sheet, shipped');
  assert.equal(same.message, `Job 33864R was already shipped by Ann Lee on ${today()}.`);
});

// Deduct directly as Ann: commits the job and marks it shipped.
function deduct(ctx, lines, { number = '33864R', key = crypto.randomUUID(), timing = null } = {}) {
  return call(ctx.db, 'deduct_directly', ctx.ann.id, key, {
    number, name: 'Smith Residence', delivery_date: '2026-11-02',
    lines: lines.map(([item, quantity]) => ({ item_id: item.id, quantity })),
  }, timing && JSON.stringify(timing));
}

test('Deduct directly commits a sheet and marks it shipped in one step; a retry acts once; a job already in the app is refused (story 19, S22, S28)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'plates');
  await ctx.receive(plate, 100);
  const key = crypto.randomUUID();
  const job = await deduct(ctx, [[plate, 30], [lus28, 2]], { key });
  assert.deepEqual([job.number, job.status, job.version], ['33864R', 'shipped', 2]);
  assert.deepEqual(await deduct(ctx, [[plate, 30], [lus28, 2]], { key }), job, 'the retry answers as the first did');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70, 'consumed once');
  assert.equal((await figure(db, 'committed'))[plate.id], 0);
  assert.deepEqual((await logRows(db)).slice(-2).map((l) => l.action), ['commit job', 'mark shipped']);

  await commit(ctx, [[plate, 5]], { number: '2P' });
  const committed = await refused(deduct(ctx, [[plate, 5]], { number: '2P' }), 'IV422', 'a committed job');
  assert.equal(committed.message, `Job 2P was already committed by Ann Lee on ${today()}; mark it shipped on the Job board.`);
  const shipped = await refused(deduct(ctx, [[plate, 30], [lus28, 2]]), 'IV422', 'a shipped job');
  assert.equal(shipped.message, `Job 33864R was already shipped by Ann Lee on ${today()}.`);
});

// ── Seam 2: Built, Shipped and Deduct directly over HTTP (#100) ─────────────

test('the board gives each job its version and what it can be marked; the confirmation lists what each job consumes; marking several jobs saves them together (stories 18, 20, 22)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'hangers');
  assert.equal((await commitFile(ctx)).status, 200);
  assert.equal((await commitFile(ctx, SHEET.replace('33864R', '33865R').replace(',930,MT20  3x4', ',,'))).status, 200);
  const jobs = await board(ctx);
  assert.deepEqual(jobs.map((j) => [j.number, j.version, j.can_build, j.can_ship]), [
    ['33865R', 1, false, true],
    ['33864R', 1, true, true],
  ], 'a hangers-only job has no Built (story 18)');

  const res = await get(ctx.base, '/api/jobs/to-consume?to=shipped&number=33864R&number=33865R', ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const hangers = [
    { item: 'HUS26', family: 'Hangers', quantity: 8, live: true },
    { item: 'LUS28', family: 'Hangers', quantity: 12, live: true },
    { item: 'TC26', family: 'Hangers', quantity: 6, live: true },
  ];
  assert.deepEqual((await res.json()).jobs, [
    { number: '33864R', name: 'Smith Residence', lines: [{ item: 'MT20 3x4', family: 'Plates', quantity: 930, live: false }, ...hangers], remainders: [] },
    { number: '33865R', name: 'Smith Residence', lines: hangers, remainders: [] },
  ], 'plates are listed, not tracked yet (J4)');

  const marked = await post(ctx.base, '/api/jobs/mark',
    { key: crypto.randomUUID(), to: 'shipped', jobs: jobs.map(({ number, version }) => ({ number, version })) }, ctx.cookie);
  assert.equal(marked.status, 200, await marked.clone().text());
  assert.deepEqual((await board(ctx)).map((j) => [j.number, j.status, j.version, j.can_build, j.can_ship]),
    [['33865R', 'shipped', 2, false, false], ['33864R', 'shipped', 2, false, false]]);
  const bad = await post(ctx.base, '/api/jobs/mark', { key: crypto.randomUUID(), to: 'cancelled', jobs: [] }, ctx.cookie);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Mark jobs built or shipped.');
});

test('Deduct directly takes the dropped sheet, commits it and marks it shipped (story 19)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'hangers');
  const res = await post(ctx.base, '/api/jobs/deduct', { key: crypto.randomUUID(), file: { name: '33864R-materials.csv', text: SHEET } }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).job, { number: '33864R', name: 'Smith Residence', status: 'shipped', version: 2 });
  assert.equal((await figure(ctx.db, 'on_hand'))[ctx.items.LUS28.id], -12);
});

test('a job\'s build or ship row cannot be reversed from History (review of #115, 1)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 1000);
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 930], [lus28, 12]]);
  await mark(ctx, 'built', ['33864R']);
  await mark(ctx, 'shipped', ['33864R']);
  const rows = await as(db, APP, async (app) => (await app.query(
    'SELECT id, kind FROM inv.ledger WHERE job_id IS NOT NULL ORDER BY id')).rows);
  assert.deepEqual(rows.map((r) => r.kind), ['build', 'ship']);
  for (const row of rows) {
    const err = await refused(call(db, 'reverse', ctx.ann.id, crypto.randomUUID(), row.id, 'by mistake'), 'IV422', `reversing a ${row.kind} row`);
    assert.equal(err.message, 'A job\'s Built or Shipped cannot be reversed here.');
  }
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 70, [lus28.id]: 8, [hus.id]: 0 });
});

test('a family that goes live after Built is not consumed again at Shipped (review of #115, 2; J4)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'hangers');
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 930], [lus28, 12]]);
  await mark(ctx, 'built', ['33864R']);
  await goLive(db, 'plates');
  await ctx.receive(plate, 70);   // the go-live count: what is left after the shop cut the 930
  assert.equal((await figure(db, 'committed'))[plate.id], 0, 'the plates were cut at Built');

  await mark(ctx, 'shipped', ['33864R']);
  assert.equal((await figure(db, 'on_hand'))[plate.id], 70);
  assert.equal((await figure(db, 'on_hand'))[lus28.id], 8);
});

test('two batches of the same jobs in a different order wait for each other instead of deadlocking (review of #115, 5)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 10]], { number: '1P' });
  await commit(ctx, [[plate, 20]], { number: '2P' });
  const { Client } = require('pg');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${db}`;
  const other = new Client({ connectionString: url.toString() });
  const marker = new Client({ connectionString: url.toString() });
  await other.connect();
  await marker.connect();
  try {
    // Another save holds 1P; a batch listing 2P first must take no lock
    // while it waits, so the other save can still take 2P.
    await other.query('BEGIN');
    await other.query("SELECT 1 FROM inv.jobs WHERE number = '1P' FOR UPDATE");
    const batch = marker.query('SELECT inv.mark_built($1, $2, $3, NULL)', [ctx.ann.id, crypto.randomUUID(),
      JSON.stringify([{ number: '2P', version: 1 }, { number: '1P', version: 1 }])]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await other.query("SELECT 1 FROM inv.jobs WHERE number = '2P' FOR UPDATE NOWAIT").then(
      () => {}, (err) => assert.fail(`the batch holds 2P while it waits for 1P: ${err.message}`));
    await other.query('ROLLBACK');
    await batch;
  } finally {
    await other.end();
    await marker.end();
  }
});

test('History names the job behind a build or ship row and offers no Reverse on it; the Activity Log says the change of status (review of #115)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'hangers');
  assert.equal((await commitFile(ctx)).status, 200);
  const [job] = await board(ctx);
  const marked = await post(ctx.base, '/api/jobs/mark',
    { key: crypto.randomUUID(), to: 'shipped', jobs: [{ number: job.number, version: job.version }] }, ctx.cookie);
  assert.equal(marked.status, 200, await marked.clone().text());

  const res = await get(ctx.base, `/api/items/history?id=${ctx.items.LUS28.id}`, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const [shipped] = (await res.json()).entries;
  assert.deepEqual([shipped.action, shipped.change, shipped.detail, shipped.from_job], ['mark shipped', -12, 'Job 33864R, Smith Residence', true]);

  const log = await (await get(ctx.base, '/api/activity?family=hangers', ctx.cookie)).json();
  assert.deepEqual(log.entries.slice(0, 2).map((e) => e.action), ['mark shipped', 'commit job'], 'the Hangers filter shows the mark (second review, 1)');

  const { describeChange } = require('../src/settings/activity.js');
  const was = { number: '33864R', name: 'Smith Residence', status: 'committed', version: 1 };
  assert.equal(describeChange('mark built', 'jobs', was, { ...was, status: 'built', version: 2 }), 'status: committed → built');
  assert.match(describeChange('mark built', 'jobs', was,
    { ...was, status: 'built', version: 2, timed: { before: true, counted_at: '2026-10-26T12:00:00Z' } }),
  /^status: committed → built; timed before the count of Oct 26, 2026, 8:00\sAM$/);
});

// ── Seam 1: Cancel, Un-build and Un-ship (#101) ─────────────────────────────

// Cancels, un-builds or un-ships (`action`: 'cancel_job', 'unbuild_job',
// 'unship_job') job `number` as Ann, at the version the board shows now.
async function undo(ctx, action, number, { key = crypto.randomUUID() } = {}) {
  const { version } = await onBoard(ctx.db, number);
  return call(ctx.db, action, ctx.ann.id, key, number, version);
}

test('Un-build gives back the plates the job consumed and puts it back to committed (#101, story 24)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 1000);
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 930], [lus28, 12]]);
  await mark(ctx, 'built', ['33864R']);

  const job = await undo(ctx, 'unbuild_job', '33864R');
  assert.deepEqual([job.number, job.status, job.version], ['33864R', 'committed', 3]);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 1000, [lus28.id]: 20, [ctx.hus.id]: 0 });
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 930, [lus28.id]: 12, [ctx.hus.id]: 0 });
  assert.equal((await logRows(db)).at(-1).action, 'un-build');
});

test('Un-ship gives back what Shipped consumed: a job shipped from committed goes back to built with its plates still consumed, a hangers-only job to committed (#101, J85)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 1000);
  await ctx.receive(lus28, 20);
  await ctx.receive(hus, 10);
  await commit(ctx, [[plate, 100], [lus28, 12]], { number: '1B' });
  await commit(ctx, [[plate, 200], [lus28, 3]], { number: '2D' });
  await commit(ctx, [[hus, 4]], { number: '3H' });
  await mark(ctx, 'built', ['1B']);
  await mark(ctx, 'shipped', ['1B', '2D', '3H']);

  const back = [];
  for (const n of ['1B', '2D', '3H']) back.push(await undo(ctx, 'unship_job', n));
  assert.deepEqual(back.map((j) => [j.number, j.status]), [['1B', 'built'], ['2D', 'built'], ['3H', 'committed']]);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 700, [lus28.id]: 20, [hus.id]: 10 },
    'the plates stay consumed; every hanger is back');
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 15, [hus.id]: 4 });
  assert.equal((await logRows(db)).at(-1).action, 'un-ship');

  await undo(ctx, 'unbuild_job', '2D');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 900, "Un-build then gives back 2D's plates, which Shipped consumed");
});

test('Cancel returns only unconsumed material: a built job keeps its plates consumed; no Un-cancel (#101, S25, story 23)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 1000);
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 100], [lus28, 12]], { number: '1B' });
  await commit(ctx, [[plate, 200], [hus, 3]], { number: '2C' });
  await mark(ctx, 'built', ['1B']);

  const cancelled = [await undo(ctx, 'cancel_job', '1B'), await undo(ctx, 'cancel_job', '2C')];
  assert.deepEqual(cancelled.map((j) => [j.number, j.status]), [['1B', 'cancelled'], ['2C', 'cancelled']]);
  assert.deepEqual(await figure(db, 'on_hand'), { [plate.id]: 900, [lus28.id]: 20, [hus.id]: 0 }, "1B's plates stay consumed");
  assert.deepEqual(await figure(db, 'committed'), { [plate.id]: 0, [lus28.id]: 0, [hus.id]: 0 });
  assert.equal((await logRows(db)).at(-1).action, 'cancel job');

  for (const action of ['cancel_job', 'unbuild_job', 'unship_job']) {
    const err = await refused(undo(ctx, action, '1B'), 'IV422', `${action} on a cancelled job`);
    assert.match(err.message, /^Job 1B is cancelled, so it cannot be /);
  }
  await commit(ctx, [[lus28, 1]], { number: '3S' });
  const unbuilt = await refused(undo(ctx, 'unbuild_job', '3S'), 'IV422', 'Un-build on a committed job');
  assert.equal(unbuilt.message, 'Job 3S is committed, so it cannot be un-built.');
  await mark(ctx, 'shipped', ['3S']);
  const shipped = await refused(undo(ctx, 'cancel_job', '3S'), 'IV422', 'Cancel on a shipped job');
  assert.equal(shipped.message, 'Job 3S is shipped, so it cannot be cancelled.');
});

test('Un-ship after a later approved count leaves on hand unchanged and corrects only the job (#101, S27, Q40, story 25)', async () => {
  const ctx = await withCatalog();
  const { db, ann, hus } = ctx;
  await goLive(db, 'hangers');
  await ctx.receive(hus, 10);
  await commit(ctx, [[hus, 4]]);
  await mark(ctx, 'shipped', ['33864R']);
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  const started = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'hangers', 'spot check', null);
  const count = await call(db, 'submit_count', ann.id, crypto.randomUUID(), started.id, started.version, started.closes,
    JSON.stringify([{ item_id: hus.id, loose: 6 }]));
  await call(db, 'approve_count', bob.id, crypto.randomUUID(), count.id, count.version, '{}');

  await undo(ctx, 'unship_job', '33864R');
  assert.equal((await figure(db, 'on_hand'))[hus.id], 6, "the count's 6, not 6 + 4");
  assert.equal((await figure(db, 'committed'))[hus.id], 4, 'the job commits its hangers again');
});

test('Cancel, Un-build and Un-ship refuse a stale save; a retry acts once (#101, Q48, S22)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await goLive(db, 'plates');
  await ctx.receive(plate, 100);
  await commit(ctx, [[plate, 30]]);
  const stale = await onBoard(db, '33864R');
  await mark(ctx, 'built', ['33864R']);

  const before = await contents(db);
  for (const action of ['cancel_job', 'unbuild_job']) {
    const err = await refused(call(db, action, ctx.ann.id, crypto.randomUUID(), '33864R', stale.version),
      'IV409', `${action} from the board as it was before Built`);
    assert.equal(err.message, 'Someone else changed job 33864R since you opened this screen.');
  }
  assert.deepEqual(await contents(db), before, 'nothing saved');

  const key = crypto.randomUUID();
  const logged = (await logRows(db)).length;
  const first = await undo(ctx, 'unbuild_job', '33864R', { key });
  const again = await call(db, 'unbuild_job', ctx.ann.id, key, '33864R', 2);
  assert.deepEqual(again, first, 'the retry answers as the first save did');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 100, 'given back once');
  assert.equal((await logRows(db)).length, logged + 1, 'one Activity Log row for the save and its retry');
});

test('a job shipped or built again after an undo consumes once more, and each undo gives back once (#101, J85)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await ctx.receive(plate, 100);
  await ctx.receive(lus28, 20);
  await commit(ctx, [[plate, 30], [lus28, 12]]);
  const figures = async () => {
    const [onHand, committed] = [await figure(db, 'on_hand'), await figure(db, 'committed')];
    return [onHand[plate.id], committed[plate.id], onHand[lus28.id], committed[lus28.id]];
  };
  // Each step, then [plate on hand, plate committed, LUS28 on hand, LUS28 committed] after it.
  const steps = [
    [() => mark(ctx, 'shipped', ['33864R']), 'mark shipped', [70, 0, 8, 0]],
    [() => undo(ctx, 'unship_job', '33864R'), 'un-ship', [70, 0, 20, 12]],
    [() => mark(ctx, 'shipped', ['33864R']), 'mark shipped', [70, 0, 8, 0]],
    [() => undo(ctx, 'unship_job', '33864R'), 'un-ship', [70, 0, 20, 12]],
    [() => undo(ctx, 'unbuild_job', '33864R'), 'un-build', [100, 30, 20, 12]],
    [() => mark(ctx, 'built', ['33864R']), 'mark built', [70, 0, 20, 12]],
    [() => undo(ctx, 'unbuild_job', '33864R'), 'un-build', [100, 30, 20, 12]],
  ];
  for (const [step, action, after] of steps) {
    const logged = (await logRows(db)).length;
    await step();
    const log = await logRows(db);
    assert.deepEqual([log.length, log.at(-1).action], [logged + 1, action], `${action}: one Activity Log row`);
    assert.deepEqual(await figures(), after, `after ${action}`);
  }
});

test('the board says what each job can undo; the confirmation lists what comes back; Un-ship shows in History and the Activity Log (#101, stories 23, 24, 43; J85–J87)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'plates');
  await goLive(ctx.db, 'hangers');
  assert.equal((await commitFile(ctx)).status, 200);
  for (const to of ['built', 'shipped']) {
    const [job] = await board(ctx);
    const marked = await post(ctx.base, '/api/jobs/mark',
      { key: crypto.randomUUID(), to, jobs: [{ number: job.number, version: job.version }] }, ctx.cookie);
    assert.equal(marked.status, 200, await marked.clone().text());
  }
  const can = (j) => [j.status, j.can_cancel, j.can_unbuild, j.can_unship];
  const [shipped] = await board(ctx);
  assert.deepEqual(can(shipped), ['shipped', false, false, true]);

  const hangers = [
    { item: 'HUS26', quantity: 8 },
    { item: 'LUS28', quantity: 12 },
    { item: 'TC26', quantity: 6 },
  ];
  const preview = await get(ctx.base, '/api/jobs/to-give-back?action=unship&number=33864R', ctx.cookie);
  assert.equal(preview.status, 200, await preview.clone().text());
  assert.deepEqual(await preview.json(), { ok: true, number: '33864R', name: 'Smith Residence', to: 'built', lines: hangers, remainders: [] });

  const res = await post(ctx.base, '/api/jobs/undo',
    { key: crypto.randomUUID(), action: 'unship', number: '33864R', version: shipped.version }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).job.status, 'built');
  assert.deepEqual(can((await board(ctx))[0]), ['built', true, true, false]);

  const cancel = await (await get(ctx.base, '/api/jobs/to-give-back?action=cancel&number=%2033864r%20', ctx.cookie)).json();
  assert.deepEqual([cancel.to, cancel.lines], ['cancelled', hangers],
    'the plates stay consumed; the hangers return to available; the number matches as inv.undo_job matches it');

  const history = await (await get(ctx.base, `/api/items/history?id=${ctx.items.LUS28.id}`, ctx.cookie)).json();
  const [back, out] = history.entries;
  assert.deepEqual([back.action, back.change, back.detail, back.from_job], ['un-ship', 12, 'Job 33864R, Smith Residence', true]);
  assert.equal(out.reversed, true, 'the ship row shows as reversed');
  const log = await (await get(ctx.base, '/api/activity?family=hangers', ctx.cookie)).json();
  assert.deepEqual([log.entries[0].action, log.entries[0].change], ['un-ship', 'status: shipped → built']);

  const bad = await post(ctx.base, '/api/jobs/undo', { key: crypto.randomUUID(), action: 'delete', number: '33864R', version: 1 }, ctx.cookie);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Cancel, un-build or un-ship a job.');
});

test('a cancelled job\'s sheet, the same one too, commits it again as its next revision, keeping what it consumed; un-shipped and un-built jobs take a revision (#121, S64, story 14, J156)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate, lus28 } = ctx;
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  await goLive(db, 'plates');
  await ctx.receive(plate, 20);
  await commit(ctx, [[plate, 5], [lus28, 2]], { number: '1S' });
  await commit(ctx, [[plate, 5]], { number: '2C' });
  await mark(ctx, 'shipped', ['1S']);
  await mark(ctx, 'built', ['2C']);
  for (const [action, number] of [['unship_job', '1S'], ['cancel_job', '2C']]) {
    await call(db, action, bob.id, crypto.randomUUID(), number, (await onBoard(db, number)).version);
  }
  const unshipped = await commit(ctx, [[plate, 6], [lus28, 2]], { number: '1S', version: (await onBoard(db, '1S')).version });
  assert.equal(unshipped.revision, 2, 'an un-shipped job is built again, so a different sheet is its next revision');

  const again = await commit(ctx, [[plate, 7]], { number: '2C', version: (await onBoard(db, '2C')).version });
  assert.equal(again.revision, 2, 'a cancelled job\'s sheet is its next revision');
  assert.equal(await jobStatus(db, '2C'), 'committed', 'and puts it back to committed');
  assert.equal((await figure(db, 'on_hand'))[plate.id], 20 - 6 - 5, 'the 5 built before the cancel stay consumed');
  assert.equal((await figure(db, 'committed'))[plate.id], 2, 'it commits only the 2 beyond the 5 it consumed');
  await call(db, 'cancel_job', bob.id, crypto.randomUUID(), '2C', (await onBoard(db, '2C')).version);
  const same = await commit(ctx, [[plate, 7]], { number: '2C', version: (await onBoard(db, '2C')).version });
  assert.equal(same.revision, 3, 'the same content after a cancel is a new revision (S64)');

  await commit(ctx, [[plate, 5]], { number: '3U' });
  await mark(ctx, 'built', ['3U']);
  await call(db, 'unbuild_job', bob.id, crypto.randomUUID(), '3U', (await onBoard(db, '3U')).version);
  // Un-built, the job is committed again and has consumed nothing, so a different sheet is its next revision (#120).
  const unbuilt = await commit(ctx, [[plate, 6]], { number: '3U', version: (await onBoard(db, '3U')).version });
  assert.equal(unbuilt.revision, 2, 'a sheet for an un-built job');
});

// Sets job `number`'s delivery date as Ann, at the version the board shows now.
async function setDate(ctx, number, date, { key = crypto.randomUUID() } = {}) {
  const { version } = await onBoard(ctx.db, number);
  return call(ctx.db, 'set_delivery_date', ctx.ann.id, key, number, version, date);
}

// The delivery date and its override flag of job `number`.
async function dated(db, number) {
  return as(db, APP, async (app) => (await app.query(
    'SELECT delivery_date::text AS delivery_date, delivery_date_edited FROM inv.jobs WHERE number = $1', [number])).rows[0]);
}

test('editing the delivery date saves it, sets the override flag and logs one row; clearing it is an edit too (#102, story 33, J103)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 30]]);
  assert.deepEqual(await dated(db, '33864R'), { delivery_date: '2026-11-02', delivery_date_edited: false }, 'a committed sheet\'s date is not an edit');

  const job = await setDate(ctx, '33864R', '2026-11-09');
  assert.deepEqual(job, { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-09', version: 2 });
  assert.deepEqual(await dated(db, '33864R'), { delivery_date: '2026-11-09', delivery_date_edited: true });
  const log = (await logRows(db)).at(-1);
  assert.deepEqual([log.action, log.target_table, log.old_value.delivery_date, log.new_value], ['set delivery date', 'jobs', '2026-11-02', job]);

  await call(db, 'set_delivery_date', ctx.ann.id, crypto.randomUUID(), ' 33864r ', 2, null);
  assert.deepEqual(await dated(db, '33864R'), { delivery_date: null, delivery_date_edited: true });
});

test('a delivery date save refuses a stale screen and a cancelled job; a retry acts once (#102, Q48, S22, J103)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 30]]);
  const stale = await onBoard(db, '33864R');
  await setDate(ctx, '33864R', '2026-11-09');

  const before = await contents(db);
  const err = await refused(call(db, 'set_delivery_date', ctx.ann.id, crypto.randomUUID(), '33864R', stale.version, '2026-11-16'),
    'IV409', 'a save from the screen as it was before the first edit');
  assert.equal(err.message, 'Someone else changed job 33864R since you opened this screen.');
  assert.deepEqual(await contents(db), before, 'nothing saved');

  const key = crypto.randomUUID();
  const first = await setDate(ctx, '33864R', '2026-11-16', { key });
  const logged = (await logRows(db)).length;
  assert.deepEqual(await call(db, 'set_delivery_date', ctx.ann.id, key, '33864R', 2, '2026-11-16'), first, 'the retry answers as the first save did');
  assert.equal((await logRows(db)).length, logged, 'a retry writes no row');

  await mark(ctx, 'built', ['33864R']);
  await setDate(ctx, '33864R', '2026-11-20');
  assert.equal((await dated(db, '33864R')).delivery_date, '2026-11-20', 'a built job takes a new date');
  await undo(ctx, 'cancel_job', '33864R');
  const cancelled = await refused(setDate(ctx, '33864R', '2026-11-23'), 'IV422', 'a cancelled job');
  assert.equal(cancelled.message, 'Job 33864R is cancelled, so its delivery date cannot be changed.');
  await refused(call(db, 'set_delivery_date', ctx.ann.id, crypto.randomUUID(), '99999X', 1, '2026-11-23'), 'IV400', 'a job not in the app');
});

test('a delivery date edit moves the version, so a Built from the board as it was is refused (#102, Q48)', async () => {
  const ctx = await withCatalog();
  const { db, plate } = ctx;
  await commit(ctx, [[plate, 30]]);
  const stale = await onBoard(db, '33864R');
  await setDate(ctx, '33864R', '2026-11-09');
  await refused(call(db, 'mark_built', ctx.ann.id, crypto.randomUUID(), JSON.stringify([stale]), null), 'IV409', 'Built from before the date edit');
});

test('the job view shows the saved lines, the delivery date and its History; a date edit there sets the override flag and shows in History and the Activity Log (#102, stories 33, 40, 43; J103, J105)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const view = async (number) => {
    const res = await get(ctx.base, '/api/jobs/view?' + new URLSearchParams({ number }), ctx.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const first = await view(' 33864r ');
  assert.deepEqual({ ...first, history: first.history.map(({ at, ...h }) => ({ ...h, at: typeof at })) }, {
    ok: true,
    job: { number: '33864R', version: 1, delivery_date: '2026-11-02', delivery_date_edited: false, can_set_date: true, can_swap: false, can_return: false },
    lines: [
      { item_id: ctx.items['MT20 3x4'].id, family: 'plates', label: 'MT20 3x4', length_ft: null, quantity: 930 },
      { item_id: ctx.items.HUS26.id, family: 'hangers', label: 'HUS26', length_ft: null, quantity: 8 },
      { item_id: ctx.items.LUS28.id, family: 'hangers', label: 'LUS28', length_ft: null, quantity: 12 },
      { item_id: ctx.items.TC26.id, family: 'hangers', label: 'TC26', length_ft: null, quantity: 6 },
    ],
    swaps: [],
    plates: [],
    returnable: [],
    history: [{ action: 'commit job', by: 'Ann Lee', change: 'added: Smith Residence, revision 1', at: 'string' }],
  });

  const set = (body) => post(ctx.base, '/api/jobs/delivery-date', { key: crypto.randomUUID(), number: '33864R', ...body }, ctx.cookie);
  const res = await set({ version: 1, delivery_date: '2026-11-09' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).job.delivery_date, '2026-11-09');

  const now = await view('33864R');
  assert.deepEqual([now.job.delivery_date, now.job.delivery_date_edited, now.job.version], ['2026-11-09', true, 2]);
  assert.deepEqual(now.history.map((h) => [h.action, h.change]), [
    ['set delivery date', 'delivery date: 2026-11-02 → 2026-11-09'],
    ['commit job', 'added: Smith Residence, revision 1'],
  ], 'newest first');
  const log = await (await get(ctx.base, '/api/activity?action=set+delivery+date', ctx.cookie)).json();
  assert.deepEqual(log.entries.map(({ target, change }) => [target, change]), [['Job 33864R', 'delivery date: 2026-11-02 → 2026-11-09']]);
  const [row] = await board(ctx);
  assert.equal(row.delivery_date, '2026-11-09', 'the board shows the new date');

  const stale = await set({ version: 1, delivery_date: '2026-11-16' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'Someone else changed job 33864R since you opened this screen.');
  const cleared = await set({ version: 2, delivery_date: '' });
  assert.equal(cleared.status, 200, 'a blank date clears it: ' + await cleared.clone().text());
  assert.equal((await view('33864R')).history[0].change, 'delivery date: 2026-11-09 → none');

  const missing = await get(ctx.base, '/api/jobs/view?number=99999X', ctx.cookie);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'Job 99999X is not in the app.');
});

test('the Job board names the families for its family filter (#102, story 39)', async () => {
  const ctx = await appWithCatalog();
  const res = await get(ctx.base, '/api/jobs', ctx.cookie);
  assert.deepEqual((await res.json()).families, [
    { code: 'lumber', name: 'Lumber' }, { code: 'plates', name: 'Plates' }, { code: 'hangers', name: 'Hangers' }, { code: 'lvl', name: 'LVL' },
  ]);
});

test('the job view lists a job\'s lumber in the Planner\'s size and grade order, not as text (review of #119, 3)', async () => {
  const ctx = await appWithLumber();
  const add = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family: 'lumber', identity: { size: '2x10', grade: 'DSS', length_ft: 12 } }, ctx.cookie);
  assert.equal(add.status, 200, await add.clone().text());
  const text = LUMBER_SHEET.replace('2x6spdss,', '2x10spdss,2,12-00-00,2x10 SP DSS,Regular,,24.00,,,,\n2x6spdss,');
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile(text) }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const { lines } = await (await get(ctx.base, '/api/jobs/view?number=33865R', ctx.cookie)).json();
  assert.deepEqual(lines.filter((l) => l.family === 'lumber').map((l) => l.label + ' ' + l.length_ft), [
    '2x4 #2 8', '2x4 #2 10', '2x6 DSS 16', '2x10 DSS 12',
  ]);
});

test('an item with no name parts is labelled by its length alone, as in 003 (review of #119, 4)', async () => {
  const ctx = await appWithCatalog();
  const label = await as(ctx.db, APP, async (app) => (await app.query(
    `SELECT inv.item_label(pg_catalog.jsonb_populate_record(NULL::inv.items, '{"length_ft": 16}')) AS label`)).rows[0].label);
  assert.equal(label, '16′');
});

// ── Jobs behind an item on the Overview (#112) ───────────────────────────────

// The jobs listed behind `item`, as [number, quantity] pairs, through the
// module the route calls.
async function jobsBehind(db, item) {
  const database = openDatabase(urlFor(db, 'inv_app'));
  try {
    const { jobs } = await readItemJobs(database, String(item.id));
    return jobs.map((j) => [j.number, j.quantity]);
  } finally {
    await database.end();
  }
}

test('the jobs behind an item add up to its Committed, in delivery order; a built job lists under a hanger only (#112)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28, hus } = ctx;
  await goLive(db, 'plates');
  await goLive(db, 'hangers');
  await commit(ctx, [[plate, 100], [lus28, 12], [hus, 4]], { number: '2B', deliveryDate: '2026-11-09' });
  await commit(ctx, [[lus28, 3]], { number: '1B', deliveryDate: '2026-11-02' });
  await commit(ctx, [[plate, 50], [lus28, 6]], { number: '1A', deliveryDate: '2026-11-02' });
  await commit(ctx, [[lus28, 7]], { number: '0N', deliveryDate: null });
  await commit(ctx, [[lus28, 2]], { number: '9E', deliveryDate: '2026-11-01' });
  await commit(ctx, [[lus28, 99]], { number: '3C', deliveryDate: '2026-11-01' });
  await mark(ctx, 'built', ['2B']);
  await mark(ctx, 'shipped', ['3C']);

  assert.deepEqual(await jobsBehind(db, lus28), [['9E', 2], ['1A', 6], ['1B', 3], ['2B', 12], ['0N', 7]],
    'delivery date first (9E has the highest number), then job number (1B was saved before 1A), no date last');
  assert.deepEqual(await jobsBehind(db, plate), [['1A', 50]], 'built 2B no longer commits its plates; shipped 3C is gone');
  const committed = await figure(db, 'committed');
  for (const item of [plate, lus28, hus]) {
    const sum = (await jobsBehind(db, item)).reduce((n, [, q]) => n + q, 0);
    assert.equal(sum, committed[item.id], `the jobs behind item ${item.id} add up to its Committed`);
  }
});

test('a family not live in Inventory shows no jobs; an unknown item is refused (#112, J4)', async () => {
  const ctx = await withCatalog();
  await commit(ctx, [[ctx.plate, 100], [ctx.lus28, 5]]);
  assert.deepEqual(await jobsBehind(ctx.db, ctx.plate), [], 'plates are not live');
  assert.deepEqual(await jobsBehind(ctx.db, ctx.lus28), [], 'hangers are not live');
  const database = openDatabase(urlFor(ctx.db, 'inv_app'));
  try {
    assert.deepEqual(await readItemJobs(database, '999999'), { error: 'That item is not in the catalog.' });
  } finally {
    await database.end();
  }
});

test('the route lists the jobs behind an item, and says so for a bad id (#112)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  await goLive(ctx.db, 'hangers');
  const hanger = ctx.items.LUS28;
  const res = await get(ctx.base, `/api/items/jobs?id=${hanger.id}`, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).jobs, [
    { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-02', quantity: 12 },
  ]);
  const bad = await get(ctx.base, '/api/items/jobs?id=abc', ctx.cookie);
  assert.deepEqual([bad.status, (await bad.json()).error], [400, 'That item is not in the catalog.']);
});

// ── #103: many sheets commit in one action ──────────────────────────────────

// Sheet SHEET as job `number`; `extra` adds a hanger line.
const sheetFor = (number, extra = '') => ({
  name: number + '-materials.csv',
  text: SHEET.replace('Job Number:,33864R', 'Job Number:,' + number)
    .replace('Total Hangers:', (extra ? extra + '\n' : '') + 'Total Hangers:'),
});
const commitMany = (ctx, files, key = crypto.randomUUID()) => post(ctx.base, '/api/jobs/commit-many', { key, files }, ctx.cookie);

test('a batch of 50 sheets commits in one action, one Activity Log row per job; a retry acts once (stories 3, 5, S22)', async () => {
  const ctx = await appWithCatalog();
  const files = Array.from({ length: 50 }, (_, n) => sheetFor('4' + String(n).padStart(4, '0')));
  const key = crypto.randomUUID();
  const res = await commitMany(ctx, files, key);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.jobs.length, 50);
  assert.deepEqual(body.jobs.map((j) => j.number).slice(0, 2), ['40000', '40001']);
  const rows = await board(ctx);
  assert.deepEqual([rows.length, new Set(rows.map((j) => j.status))], [50, new Set(['committed'])]);
  const commits = (await logRows(ctx.db)).filter((l) => l.action === 'commit job');
  assert.equal(commits.length, 50, 'one row per job');

  const again = await commitMany(ctx, files, key);
  assert.equal(again.status, 200, await again.clone().text());
  assert.deepEqual((await again.json()).jobs.map((j) => j.number), body.jobs.map((j) => j.number));
  assert.equal((await logRows(ctx.db)).filter((l) => l.action === 'commit job').length, 50, 'the retry commits nothing more');
});

test('a batch with one bad sheet saves none: an unknown line, a job already shipped, or a revised sheet (S21, J8, J298)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const res0 = await post(ctx.base, '/api/jobs/mark', { key: crypto.randomUUID(), to: 'shipped', jobs: [{ number: '33864R', version: 1 }] }, ctx.cookie);
  assert.equal(res0.status, 200, await res0.clone().text());
  const rowsBefore = (await logRows(ctx.db)).length;
  const good = sheetFor('50001');
  const cases = [
    [sheetFor('50002', '3,Hanger,HGUS26,,,,$1.00,$3.00'), 422, /^Job 50002 was not committed: 1 line is not in the catalog or is retired\.$/],
    [sheetFor('33864R'), 422, /Job 33864R was already shipped by /],
    [sheetFor('33864R', '1,Hanger,LUS28,,,,$1.00,$1.00'), 422, /Job 33864R was already shipped by .*; un-ship it first/],
  ];
  for (const [bad, status, error] of cases) {
    const res = await commitMany(ctx, [good, bad]);
    const body = await res.json();
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(body.error, error);
  }
  assert.equal((await board(ctx)).length, 1, 'job 50001 was never saved');
  assert.equal((await logRows(ctx.db)).length, rowsBefore, 'no Activity Log row either');
});

test('a batch refuses a revised sheet of a job in the app, which commits on its own; the same sheet again is unchanged (J7, J298)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const revised = await commitMany(ctx, [sheetFor('50001'), sheetFor('33864R', '1,Hanger,LUS28,,,,$1.00,$1.00')]);
  assert.deepEqual([revised.status, (await revised.json()).error],
    [422, 'Job 33864R is already in the app, and this is a revised sheet: commit it on its own.']);
  assert.equal((await board(ctx)).length, 1);

  const same = await commitMany(ctx, [sheetFor('50001'), sheetFor('33864R')]);
  assert.equal(same.status, 200, await same.clone().text());
  assert.deepEqual((await same.json()).jobs.map((j) => [j.number, !!j.unchanged]), [['50001', false], ['33864R', true]]);

  // A cancelled job's sheet puts it back to committed: that too is its own commit (story 14).
  const cancel = await post(ctx.base, '/api/jobs/undo', { key: crypto.randomUUID(), action: 'cancel', number: '33864R', version: 1 }, ctx.cookie);
  assert.equal(cancel.status, 200, await cancel.clone().text());
  const cancelled = await commitMany(ctx, [sheetFor('50002'), sheetFor('33864R')]);
  assert.equal(cancelled.status, 422);
  assert.match((await cancelled.json()).error, /^Job 33864R was cancelled by .+ on .+: commit its sheet on its own\.$/);
  assert.equal((await board(ctx)).length, 2, 'job 50002 was never saved');
});

test('a batch is a list of 1 to 50 sheets (#103)', async () => {
  const ctx = await appWithCatalog();
  for (const files of [undefined, [], Array.from({ length: 51 }, (_, n) => sheetFor('6' + n))]) {
    const res = await commitMany(ctx, files);
    assert.deepEqual([res.status, (await res.json()).error], [400, 'Pick 1 to 50 sheets to commit.'], String(files?.length));
  }
});

// ── #151: many sheets checked in one request ──────────────────────────────

const checkMany = (ctx, files) => post(ctx.base, '/api/jobs/check-many', { files }, ctx.cookie);

test('many sheets check in one request: each answers as its own check does, with the reason a batch commit leaves it out (#151)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  assert.equal((await commitMany(ctx, [sheetFor('50003'), sheetFor('50004')])).status, 200);
  await mark(ctx, 'shipped', ['50003']);
  await undo(ctx, 'cancel_job', '50004');
  const files = [
    sheetFor('50001'),
    sheetFor('50002', '3,Hanger,HGUS26,,,,$1.00,$3.00'),
    sheetFor('33864R'),
    sheetFor('33864R', '1,Hanger,LUS28,,,,$1.00,$1.00'),
    sheetFor('50003'),
    sheetFor('50004'),
    { name: 'stock.csv', text: 'sku,on_hand\nLUS28,4\n' },
  ];
  const res = await checkMany(ctx, files);
  assert.equal(res.status, 200, await res.clone().text());
  const { sheets } = await res.json();
  assert.equal(sheets.length, files.length);
  for (const [i, file] of files.entries()) {
    const own = await (await checkFile(ctx, file.text)).json();
    const { left_out, ...answer } = sheets[i];
    assert.deepEqual(answer, own, file.name + ': the same answer as its own check');
    if (!own.ok) { assert.equal(left_out, undefined); continue; }
    // A sheet a batch commit refuses gives the refusal's own words.
    const alone = await commitMany(ctx, [file]);
    if (alone.status === 422 && !own.lines.some((l) => l.flag)) assert.equal(left_out, (await alone.json()).error, file.name);
  }
  assert.deepEqual(sheets.map((s) => s.left_out), [
    null, null,
    'Job 33864R already has this sheet; nothing to commit.',
    'Job 33864R is already in the app, and this is a revised sheet: commit it on its own.',
    `Job 50003 was already shipped by Ann Lee on ${today()}.`,
    `Job 50004 was cancelled by Ann Lee on ${today()}: commit its sheet on its own.`,
    undefined,
  ]);
});

test('a check of many is a list of 1 to 50 sheets (#151)', async () => {
  const ctx = await appWithCatalog();
  for (const files of [undefined, [], Array.from({ length: 51 }, (_, n) => sheetFor('6' + n))]) {
    const res = await checkMany(ctx, files);
    assert.deepEqual([res.status, (await res.json()).error], [400, 'Pick 1 to 50 sheets to check.'], String(files?.length));
  }
  assert.equal((await checkMany(ctx, Array.from({ length: 50 }, (_, n) => sheetFor('6' + n)))).status, 200);
});

test('a batch with one job on two sheets saves none, and names the job (PR #149 review F1)', async () => {
  const ctx = await appWithCatalog();
  const first = sheetFor('70001');
  const cases = [
    [sheetFor('50001'), first, { ...sheetFor('70001', '1,Hanger,LUS28,,,,$1.00,$1.00'), name: 'other.csv' }],
    [first, { ...first, name: 'copy.csv' }],
    [first, { ...sheetFor(' 70001 '), name: 'spaced.csv' }],
    [sheetFor('k1'), sheetFor('K1')],
  ];
  for (const files of cases) {
    const res = await commitMany(ctx, files);
    const body = await res.json();
    assert.equal(res.status, 422, JSON.stringify(body));
    assert.match(body.error, /^Job (70001|k1|K1) is on more than one sheet: remove all but one\.$/);
  }
  assert.equal((await board(ctx)).length, 0, 'no job was saved');
});

// The jobs a count of `family` lists before it starts (#105).
async function beforeCount(ctx, family) {
  const res = await get(ctx.base, '/api/counts/jobs?' + new URLSearchParams({ family }), ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}

test('before a plates count, the start lists each committed job with plates: number, name, delivery date (#105, story 51, Q25)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'plates');
  await goLive(ctx.db, 'hangers');
  assert.equal((await commitFile(ctx)).status, 200);
  assert.equal((await commitFile(ctx, SHEET.replace('33864R', '33865R').replace(',930,MT20  3x4', ',,'))).status, 200);
  assert.equal((await commitFile(ctx, SHEET.replace('33864R', '33866R').replace('Smith Residence', 'Jones Barn'))).status, 200);
  await mark(ctx, 'built', ['33864R']);
  // PR #153 review F4: a cancelled job; a job with no delivery date; a job
  // whose newest revision has no plates.
  const job = (number, edit = (t) => t) => edit(SHEET.replace('33864R', number));
  assert.equal((await commitFile(ctx, job('33867R'))).status, 200);
  const cancel = await post(ctx.base, '/api/jobs/undo', { key: crypto.randomUUID(), action: 'cancel', number: '33867R', version: 1 }, ctx.cookie);
  assert.equal(cancel.status, 200, await cancel.clone().text());
  assert.equal((await commitFile(ctx, job('33868R', (t) => t.replace('Delivery Date:,11/2/2026', 'Delivery Date:,')))).status, 200);
  assert.equal((await commitFile(ctx, job('33869R'))).status, 200);
  const revised = await commitFile(ctx, job('33869R', (t) => t.replace(',930,MT20  3x4', ',,')), crypto.randomUUID(), { version: 1 });
  assert.equal(revised.status, 200, await revised.clone().text());

  assert.deepEqual(await beforeCount(ctx, 'plates'), { ok: true, consumed_when: 'built', jobs: [
    { number: '33866R', name: 'Jones Barn', delivery_date: '2026-11-02' },
    { number: '33868R', name: 'Smith Residence', delivery_date: null },
  ] }, 'built, hangers-only, cancelled and revised-without-plates jobs are left out; no delivery date sorts last');

  const res = await get(ctx.base, '/api/counts/jobs', ctx.cookie);
  assert.deepEqual([res.status, (await res.json()).error], [400, 'Pick a family to count.'], 'no family');
});

test('before a hangers count, the start lists each job with hangers not yet shipped, built ones too, soonest delivery first; a family not live lists none (#105, J307, J4)', async () => {
  const ctx = await appWithCatalog();
  await goLive(ctx.db, 'hangers');
  const sheet = (number, date) => SHEET.replace('33864R', number).replace('11/2/2026', date);
  for (const [number, date] of [['33864R', '11/20/2026'], ['33865R', '11/9/2026'], ['33866R', '11/2/2026']]) {
    assert.equal((await commitFile(ctx, sheet(number, date))).status, 200, number);
  }
  await mark(ctx, 'built', ['33864R']);
  await mark(ctx, 'shipped', ['33866R']);

  assert.deepEqual(await beforeCount(ctx, 'hangers'), { ok: true, consumed_when: 'shipped', jobs: [
    { number: '33865R', name: 'Smith Residence', delivery_date: '2026-11-09' },
    { number: '33864R', name: 'Smith Residence', delivery_date: '2026-11-20' },
  ] });
  assert.deepEqual(await beforeCount(ctx, 'plates'), { ok: true, consumed_when: 'built', jobs: [] }, 'plates are not live');

  const res = await get(ctx.base, '/api/counts/jobs?family=nails', ctx.cookie);
  assert.deepEqual([res.status, (await res.json()).error], [400, 'Pick a family to count.']);
});

// ── Seam 1: a swap on a built job's plate line (#106) ───────────────────────

// Swaps `quantity` of `planned` for `used` on job `number` as Ann, at
// `version`, or the one the board shows now.
async function swap(ctx, planned, used, quantity, { number = '33864R', key = crypto.randomUUID(), timing = null, version } = {}) {
  version ??= (await onBoard(ctx.db, number)).version;
  return call(ctx.db, 'swap_plate', ctx.ann.id, key, number, version, planned.id, used.id, quantity, timing && JSON.stringify(timing));
}

// A built job 33864R that consumed 930 of ctx.plate, with a second plate
// ctx.used in the catalog; 1,000 of each on hand before Built.
async function withBuiltJob() {
  const ctx = await withCatalog();
  ctx.used = await call(ctx.db, 'add_item', ctx.ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 4x6' });
  await goLive(ctx.db, 'plates');
  await ctx.receive(ctx.plate, 1000);
  await ctx.receive(ctx.used, 1000);
  await commit(ctx, [[ctx.plate, 930]]);
  await mark(ctx, 'built', ['33864R']);
  return ctx;
}

test('a swap moves what a built job consumed from the planned plate to the plate used, logged once; a retry acts once (#106, Q36, S22)', async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  const key = crypto.randomUUID();
  const job = await swap(ctx, plate, used, 40, { key });
  assert.deepEqual([job.number, job.status, job.version], ['33864R', 'built', 3], 'a swap moves the version');
  assert.deepEqual(await swap(ctx, plate, used, 40, { key, version: 2 }), job, 'the retry answers as the first swap did');
  const onHand = await figure(db, 'on_hand');
  assert.deepEqual([onHand[plate.id], onHand[used.id]], [110, 960], '1,000 − 930 + 40; 1,000 − 40');
  assert.equal((await logRows(db)).at(-1).action, 'swap plate');
  assert.equal((await logRows(db)).filter((l) => l.action === 'swap plate').length, 1);
});

test('a swap is refused unless the job is built, on a stale screen and for a job not in the app; a refusal saves nothing (#106, Q36, Q48)', async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  await commit(ctx, [[plate, 5]], { number: '2P' });
  const before = await contents(db);
  const committed = await refused(swap(ctx, plate, used, 1, { number: '2P' }), 'IV422', 'a committed job');
  assert.equal(committed.message, 'Job 2P is committed. Only a built job takes a swap.');
  const stale = await refused(swap(ctx, plate, used, 1, { version: 1 }), 'IV409', 'the screen showed 33864R before Built');
  assert.equal(stale.message, 'Someone else changed job 33864R since you opened this screen.');
  const unknown = await refused(swap(ctx, plate, used, 1, { number: 'NOPE', version: 1 }), 'IV400', 'no such job');
  assert.equal(unknown.message, 'Job NOPE is not in the app.');
  assert.deepEqual(await contents(db), before, 'no row and no log entry');
  await mark(ctx, 'shipped', ['33864R']);
  const shipped = await refused(swap(ctx, plate, used, 1), 'IV422', 'a shipped job');
  assert.equal(shipped.message, 'Job 33864R is shipped. Only a built job takes a swap.');
});

test('a swap is refused beyond what the job consumed of the planned plate, for a used plate that is the planned one, not a plate or retired, and for a count that is not whole pieces (#106, Q36, J319)', async () => {
  const ctx = await withBuiltJob();
  const { db, ann, plate, used, lus28 } = ctx;
  const old = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 5x8' });
  const { version } = await onBoard(db, '33864R');
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), old.id, old.version);
  const before = await contents(db);
  const cases = [
    [plate, used, 931, 'IV422', 'Job 33864R consumed 930 of MT20 3x4, so at most 930 can be swapped.'],
    [used, plate, 1, 'IV422', 'Job 33864R consumed 0 of MT20 4x6, so at most 0 can be swapped.'],
    [plate, plate, 1, 'IV400', 'Pick a plate other than the planned one.'],
    [plate, lus28, 1, 'IV400', 'LUS28 is not a plate. Pick a plate.'],
    [lus28, used, 1, 'IV400', 'LUS28 is not a plate. Pick a plate.'],
    [plate, old, 1, 'IV422', 'MT20 5x8 is retired. Pick a plate in use.'],
    ...[0, -3, 1.5, null].map((n) => [plate, used, n, 'IV400', 'Type the pieces swapped: a whole number above 0.']),
  ];
  for (const [planned, usedPlate, quantity, code, message] of cases) {
    const err = await refused(swap(ctx, planned, usedPlate, quantity, { version }), code, `${planned.sku} → ${usedPlate.sku} × ${quantity}`);
    assert.equal(err.message, message);
  }
  assert.deepEqual(await contents(db), before, 'no row and no log entry');

  await swap(ctx, plate, used, 900);
  const err = await refused(swap(ctx, plate, used, 31), 'IV422', 'a second swap counts what is left');
  assert.equal(err.message, 'Job 33864R consumed 30 of MT20 3x4, so at most 30 can be swapped.');
  await swap(ctx, plate, used, 30);
});

test('after a swap, a revised sheet consumes only beyond what is settled, counting the swap as the planned plate consumed, as a sheet committed again does; Shipped consumes no plate again, and a swap back undoes it (#106, Q27, J321, J325)', async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  const onHand = async () => { const f = await figure(db, 'on_hand'); return [f[plate.id], f[used.id]]; };
  await swap(ctx, plate, used, 40);
  assert.deepEqual(await onHand(), [110, 960]);
  const settled = await as(db, APP, async (app) => (await app.query(
    `SELECT pg_catalog.jsonb_object_agg(t.item_id, t.quantity) AS s FROM inv.jobs j, inv.job_settled(j) t WHERE j.number = '33864R'`)).rows[0].s);
  assert.deepEqual(settled, { [plate.id]: 930 }, 'what is settled, as the check before a commit shows it, counts the swap as MT20 3x4 consumed');

  await commit(ctx, [[plate, 930], [used, 50]], { version: (await onBoard(db, '33864R')).version });
  assert.deepEqual(await onHand(), [110, 910], 'the sheet now plans 50 of MT20 4x6; the swap counts as MT20 3x4 consumed, so all 50, as when the job is cancelled and this sheet committed again (J325)');
  await commit(ctx, [[plate, 950], [used, 50]], { version: (await onBoard(db, '33864R')).version });
  assert.deepEqual(await onHand(), [90, 910], '20 more of MT20 3x4: the swap does not lower what is settled');

  const err = await refused(swap(ctx, used, plate, 91), 'IV422', 'more back than the job consumed of MT20 4x6: 40 swapped in, 50 by the sheet');
  assert.equal(err.message, 'Job 33864R consumed 90 of MT20 4x6, so at most 90 can be swapped.');
  await swap(ctx, used, plate, 40);
  assert.deepEqual(await onHand(), [50, 950], 'a swap back moves the 40 again');

  await mark(ctx, 'shipped', ['33864R']);
  assert.deepEqual(await onHand(), [50, 950], 'Shipped consumes no plate');
});

test('Un-build after swaps gives back every plate the job consumed, and drops the swaps: Built again consumes the sheet as planned (#106, J321)', async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  const onHand = async () => { const f = await figure(db, 'on_hand'); return [f[plate.id], f[used.id]]; };
  await swap(ctx, plate, used, 40);
  await swap(ctx, used, plate, 15);
  assert.deepEqual(await onHand(), [95, 975]);
  await undo(ctx, 'unbuild_job', '33864R');
  assert.deepEqual(await onHand(), [1000, 1000]);
  assert.equal((await figure(db, 'committed'))[plate.id], 930);
  await mark(ctx, 'built', ['33864R']);
  assert.deepEqual(await onHand(), [70, 1000]);
});

test('a job cancelled after a swap and committed again counts the swap as the planned plate consumed: Built has nothing to take and Shipped takes none; a sheet that adds the plate used takes it in full (#106, J322)', async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  const onHand = async () => { const f = await figure(db, 'on_hand'); return [f[plate.id], f[used.id]]; };
  const committed = async () => { const f = await figure(db, 'committed'); return [f[plate.id], f[used.id]]; };
  await swap(ctx, plate, used, 40);
  assert.deepEqual(await onHand(), [110, 960]);
  await undo(ctx, 'cancel_job', '33864R');
  await commit(ctx, [[plate, 930]], { version: (await onBoard(db, '33864R')).version });
  assert.deepEqual(await committed(), [0, 0], 'the 40 swapped out of MT20 3x4 were used, as MT20 4x6');
  const err = await refused(mark(ctx, 'built', ['33864R']), 'IV422', 'Built has nothing to take, as with no swap');
  assert.equal(err.message, 'Job 33864R has no plates, lumber or LVL to build; mark it shipped.');
  await mark(ctx, 'shipped', ['33864R']);
  assert.deepEqual(await onHand(), [110, 960], 'nor does Shipped from committed');

  const ctx2 = await withBuiltJob();
  await swap(ctx2, ctx2.plate, ctx2.used, 40);
  await undo(ctx2, 'cancel_job', '33864R');
  await commit(ctx2, [[ctx2.plate, 930], [ctx2.used, 50]], { version: (await onBoard(ctx2.db, '33864R')).version });
  assert.equal((await figure(ctx2.db, 'committed'))[ctx2.used.id], 50, 'the trade-off: the swap does not count toward a line of the plate used');
});

test('a swap near a count asks "before or after the count?"; before, the count already shows it (#106, Q36, ADR 0002)', async () => {
  const ctx = await withBuiltJob();
  const { db, ann, plate, used } = ctx;
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  const started = await call(db, 'start_count', ann.id, crypto.randomUUID(), 'plates', 'spot check', null);
  const lines = JSON.stringify([{ item_id: used.id, loose: 960 }]);
  const count = await call(db, 'submit_count', ann.id, crypto.randomUUID(), started.id, started.version, started.closes, lines);

  const asked = await refused(swap(ctx, plate, used, 40), 'IV409', 'a swap of a counted plate, with no answer');
  assert.equal(asked.message, 'Was this before or after the count? Pick one, then save again.');
  const job = await swap(ctx, plate, used, 40, { timing: { before: count.id } });
  assert.deepEqual(job.timed, { before: true, counted_at: count.counted_at });
  assert.deepEqual(job.swap, { planned: 'MT20 3x4', used: 'MT20 4x6', quantity: 40 });

  await call(db, 'approve_count', bob.id, crypto.randomUUID(), count.id, count.version, '{}');
  const onHand = await figure(db, 'on_hand');
  assert.deepEqual([onHand[plate.id], onHand[used.id]], [110, 960], 'the count of 960 already took the 40 off');
});

test("a swap shows in the job's History and in each plate's History, with the reason Substitution and no Reverse (#106, Q36, story 43)", async () => {
  const ctx = await withBuiltJob();
  const { db, plate, used } = ctx;
  await swap(ctx, plate, used, 40);
  const { readHistory } = require('../src/inventory/history.js');
  const { jobView } = require('../src/jobs/jobs.js');
  const database = openDatabase(urlFor(db, 'inv_app'));
  try {
    const { body } = await jobView(database, '33864R');
    assert.deepEqual(body.history.slice(0, 2).map((h) => [h.action, h.change]),
      [['swap plate', '40 of MT20 3x4 swapped to MT20 4x6'], ['mark built', 'status: committed → built']]);
    for (const [item, change] of [[plate, 40], [used, -40]]) {
      const [row] = (await readHistory(database, item.id)).entries;
      assert.deepEqual([row.action, row.change, row.detail, row.from_job],
        ['swap plate', change, 'Job 33864R, Smith Residence; Substitution', true]);
    }
  } finally {
    await database.end();
  }
});

// ── Seam 2: the swap route and the job view (#106) ─────────────────────────

test('the swap route saves a swap on a built job; the job view offers Substitute… only then, and shows each plate line\'s swaps net of swaps back (#106, stories 43–45, J320, J321)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4', 'MT20 4x6', 'MT20 5x8'], hangers: ['LUS28', 'HUS26', 'TC26'] });
  const { 'MT20 3x4': planned, 'MT20 4x6': used, 'MT20 5x8': other } = ctx.items;
  await goLive(ctx.db, 'plates');
  assert.equal((await commitFile(ctx)).status, 200);
  const view = async () => (await get(ctx.base, '/api/jobs/view?number=33864R', ctx.cookie)).json();
  const swap = async (from, to, quantity, version) => post(ctx.base, '/api/jobs/swap',
    { key: crypto.randomUUID(), number: '33864R', version, planned: from.id, used: to.id, quantity, timing: null }, ctx.cookie);

  const committed = await view();
  assert.equal(committed.job.can_swap, false, 'a committed job takes no swap');
  assert.equal(committed.lines[0].item_id, planned.id, 'a line names its item, for the swap');
  const refusal = await swap(planned, used, 40, 1);
  assert.equal(refusal.status, 422);
  assert.equal((await refusal.json()).error, 'Job 33864R is committed. Only a built job takes a swap.');

  const marked = await post(ctx.base, '/api/jobs/mark', { key: crypto.randomUUID(), to: 'built', jobs: [{ number: '33864R', version: 1 }] }, ctx.cookie);
  assert.equal(marked.status, 200, await marked.clone().text());
  const built = await view();
  assert.equal(built.job.can_swap, true);
  assert.deepEqual(built.plates, [{ id: planned.id, label: 'MT20 3x4' }, { id: used.id, label: 'MT20 4x6' }, { id: other.id, label: 'MT20 5x8' }],
    'a built job offers every active plate to pick from');
  assert.deepEqual(committed.plates, [], 'a committed job offers none');
  const res = await swap(planned, used, 40, 2);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).job.swap, { planned: 'MT20 3x4', used: 'MT20 4x6', quantity: 40 });
  assert.equal((await swap(planned, other, 10, 3)).status, 200);
  assert.equal((await swap(used, planned, 15, 4)).status, 200, 'a swap back');

  const after = await view();
  assert.deepEqual(after.swaps, [
    { planned_id: planned.id, planned: 'MT20 3x4', used_id: used.id, used: 'MT20 4x6', quantity: 25 },
    { planned_id: planned.id, planned: 'MT20 3x4', used_id: other.id, used: 'MT20 5x8', quantity: 10 },
  ], '40 swapped to MT20 4x6, 15 of them back; 10 to MT20 5x8');
  assert.deepEqual(after.history.slice(0, 3).map((h) => h.action), ['swap plate', 'swap plate', 'swap plate']);
  const filed = async (family) => (await (await get(ctx.base, `/api/activity?action=swap+plate&family=${family}`, ctx.cookie)).json()).entries.length;
  assert.deepEqual([await filed('plates'), await filed('hangers')], [3, 0], 'a swap is Plates\', not every family on the job\'s sheet (#157)');

  assert.equal((await swap(used, planned, 25, 5)).status, 200);
  assert.deepEqual((await view()).swaps.map((w) => [w.used, w.quantity]), [['MT20 5x8', 10]], 'a swap swapped all the way back is gone');
  const unbuilt = await post(ctx.base, '/api/jobs/undo', { key: crypto.randomUUID(), action: 'unbuild', number: '33864R', version: 6 }, ctx.cookie);
  assert.equal(unbuilt.status, 200, await unbuilt.clone().text());
  assert.deepEqual((await view()).swaps, [], 'Un-build drops the swaps (J321)');
});

test('a swap back beyond what was swapped, of a plate also on the sheet, shows as a swap the other way (#106, J320, J321)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4', 'MT20 4x6'], hangers: ['LUS28', 'HUS26', 'TC26'] });
  const { 'MT20 3x4': a, 'MT20 4x6': b } = ctx.items;
  await goLive(ctx.db, 'plates');
  assert.equal((await commitFile(ctx, SHEET.replace(',930,MT20  3x4,64.18,5580', ',930,MT20  3x4,64.18,5580\n,20,MT20  4x6,1.00,48'))).status, 200);
  const marked = await post(ctx.base, '/api/jobs/mark', { key: crypto.randomUUID(), to: 'built', jobs: [{ number: '33864R', version: 1 }] }, ctx.cookie);
  assert.equal(marked.status, 200, await marked.clone().text());
  const swap = async (from, to, quantity, version) => post(ctx.base, '/api/jobs/swap',
    { key: crypto.randomUUID(), number: '33864R', version, planned: from.id, used: to.id, quantity }, ctx.cookie);
  assert.equal((await swap(a, b, 10, 2)).status, 200);
  assert.equal((await swap(b, a, 25, 3)).status, 200);
  const view = await (await get(ctx.base, '/api/jobs/view?number=33864R', ctx.cookie)).json();
  assert.deepEqual(view.swaps, [{ planned_id: b.id, planned: 'MT20 4x6', used_id: a.id, used: 'MT20 3x4', quantity: 15 }],
    '10 of MT20 3x4 swapped to MT20 4x6, then 25 back: 15 of MT20 4x6 swapped to MT20 3x4');
});

test('the reason Substitution is for a swap only: a correction with it is refused, and it cannot be retired (#106)', async () => {
  const ctx = await withBuiltJob();
  const { db, ann, plate } = ctx;
  const substitution = await reasonId(db, 'Substitution');
  const err = await refused(call(db, 'correct', ann.id, crypto.randomUUID(), plate.id, 5, substitution, null, null), 'IV422', 'a correction');
  assert.equal(err.message, '"Substitution" is set by a swap on a job. Use Substitute… on the job\'s Plates tab.');
  const retire = await refused(call(db, 'retire_reason', ann.id, crypto.randomUUID(), substitution, 1), 'IV422', 'a built-in reason');
  assert.equal(retire.message, 'The app relies on "Substitution", so it cannot be retired.');
});

test('a job\'s build row with a reason other than Substitution is refused, whatever writes it (#106, PR #155 review F4)', async () => {
  const ctx = await withBuiltJob();
  const { db, ann, plate, used } = ctx;
  await swap(ctx, plate, used, 40);
  const other = await call(db, 'add_reason', ann.id, crypto.randomUUID(), 'Found on site');
  await as(db, null, async (owner) => {
    const insert = (reason) => owner.query(`
      INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id, reason_id)
      SELECT item_id, quantity, kind, effective_at, action_id, job_id, $1 FROM inv.ledger
       WHERE kind = 'build' AND reason_id IS NOT NULL AND quantity > 0`, [reason]);
    const err = await refused(insert(other.id), '23514', 'the owner\'s own insert');
    assert.equal(err.message, 'A job\'s build row with a reason is a swap, so its reason is Substitution.');
    await owner.query('BEGIN');
    await insert(await reasonId(db, 'Substitution'));
    await owner.query('ROLLBACK');
  });
});

test('migration 021 stops with a clear message, and changes nothing, on a database where a person already added a reason "Substitution" (#106)', async () => {
  const db = await freshDatabase({ before: '021' });
  const ann = await firstUser(db);
  await call(db, 'add_reason', ann.id, crypto.randomUUID(), 'substitution');
  const before = await contents(db);
  await assert.rejects(migrate(urlFor(db)), { message: 'migration 021-plate-swaps.sql failed, nothing from it was applied: '
    + 'A reason "substitution" is already in the app; 021 adds the built-in reason Substitution. Rename that reason in the database (its rows keep it), then run 021 again.' });
  assert.deepEqual(await contents(db), before, 'nothing from 021');
});

// ── Seam 1: a return from the job site on a shipped job (#107) ──────────────

// Records `quantity` of `item` returned on job `number` as Ann, at `version`,
// or the one the board shows now; `lengthFt`, an LVL board's actual length.
async function returnTo(ctx, item, quantity, { number = '33864R', key = crypto.randomUUID(), lengthFt = null, timing = null, version } = {}) {
  version ??= (await onBoard(ctx.db, number)).version;
  return call(ctx.db, 'record_return', ctx.ann.id, key, number, version, item.id, quantity, lengthFt, timing && JSON.stringify(timing));
}

// A shipped job 33864R that consumed 30 of ctx.lus28 and 930 of ctx.plate;
// 100 LUS28 and 1,000 plates on hand before.
async function withShippedJob() {
  const ctx = await withCatalog();
  await goLive(ctx.db, 'plates');
  await goLive(ctx.db, 'hangers');
  await ctx.receive(ctx.plate, 1000);
  await ctx.receive(ctx.lus28, 100);
  await commit(ctx, [[ctx.plate, 930], [ctx.lus28, 30]]);
  await mark(ctx, 'shipped', ['33864R']);
  return ctx;
}

test('a return on a shipped job adds the pieces back to on hand, linked to the job and logged once; the job is not edited; a retry acts once (#107, story 46, Q7, S22)', async () => {
  const ctx = await withShippedJob();
  const { db, lus28 } = ctx;
  assert.equal((await figure(db, 'on_hand'))[lus28.id], 70, '100 − 30 shipped');
  const key = crypto.randomUUID();
  const job = await returnTo(ctx, lus28, 4, { key });
  assert.deepEqual([job.number, job.status, job.version], ['33864R', 'shipped', 3], 'still shipped; a return moves the version');
  assert.deepEqual(job.returned, { item: 'LUS28', quantity: 4 });
  assert.deepEqual(await returnTo(ctx, lus28, 4, { key, version: 2 }), job, 'the retry answers as the first return did');
  assert.equal((await figure(db, 'on_hand'))[lus28.id], 74, '70 + 4 returned');
  assert.equal((await logRows(db)).filter((l) => l.action === 'record return').length, 1);
  const rows = await as(db, APP, async (app) => (await app.query(
    `SELECT g.kind, g.quantity FROM inv.ledger g JOIN inv.jobs j ON j.id = g.job_id
      WHERE j.number = '33864R' AND g.item_id = $1 ORDER BY g.id`, [lus28.id])).rows);
  assert.deepEqual(rows, [{ kind: 'ship', quantity: -30 }, { kind: 'return', quantity: 4 }], 'the shipped row stands; the return is its own row on the job');
});

test('a return is refused unless the job is shipped, on a stale screen, for a job not in the app, for plates and lumber, for an item not on the job, and for a count that is not whole pieces; a refusal saves nothing (#107, J330, J342, Q7, Q48)', async () => {
  const ctx = await withShippedJob();
  const { db, ann, plate, lus28, hus } = ctx;
  const board = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lumber', { size: '2x4', grade: '#2', length_ft: 12 });
  await goLive(db, 'lumber');
  await commit(ctx, [[lus28, 5]], { number: '2P' });
  const { version } = await onBoard(db, '33864R');
  const before = await contents(db);
  const cases = [
    [lus28, 1, { number: '2P', version: 1 }, 'IV422', 'Job 2P is committed. Only a shipped job takes a return.'],
    [lus28, 1, { version: 1 }, 'IV409', 'Someone else changed job 33864R since you opened this screen.'],
    [lus28, 1, { number: 'NOPE', version: 1 }, 'IV400', 'Job NOPE is not in the app.'],
    [plate, 1, {}, 'IV422', 'MT20 3x4 does not come back from a job site: it is used up on the job.'],
    [board, 1, {}, 'IV422', /^2x4 .*12′ does not come back from a job site: it is used up on the job\.$/],
    [board, 1, { lengthFt: 12.5 }, 'IV422', /^2x4 .*12′ does not come back from a job site: it is used up on the job\.$/],
    [{ id: -1 }, 1, {}, 'IV400', 'Pick the item from the catalog.'],
    [hus, 1, {}, 'IV422', 'HUS26 is not on job 33864R. Only an item on the job comes back from its job site.'],
    ...[0, -3, 1.5, null].map((n) => [lus28, n, {}, 'IV400', 'Type the pieces returned: a whole number above 0.']),
  ];
  for (const [item, quantity, opts, code, message] of cases) {
    const err = await refused(returnTo(ctx, item, quantity, { version, ...opts }), code, `${item.sku ?? item.id} × ${quantity} ${JSON.stringify(opts)}`);
    if (message instanceof RegExp) assert.match(err.message, message); else assert.equal(err.message, message);
  }
  assert.deepEqual(await contents(db), before, 'no row and no log entry');
  await as(db, null, async (owner) => {
    const err = await refused(owner.query(
      `INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
       SELECT $1, 1, 'return', now(), max(l.id), (SELECT id FROM inv.jobs WHERE number = '33864R') FROM inv.activity_log l`, [plate.id]),
      'IV422', 'the owner\'s own insert of a plates return');
    assert.equal(err.message, 'MT20 3x4 does not come back from a job site: it is used up on the job.');
    const offJob = await refused(owner.query(
      `INSERT INTO inv.ledger (item_id, quantity, kind, effective_at, action_id, job_id)
       SELECT $1, 1, 'return', now(), max(l.id), (SELECT id FROM inv.jobs WHERE number = '33864R') FROM inv.activity_log l`, [hus.id]),
      'IV422', 'the owner\'s own insert of a return of a hanger not on the job');
    assert.equal(offJob.message, 'HUS26 is not on job 33864R. Only an item on the job comes back from its job site.');
  });
});

test('returned LVL is entered at its actual length: a length not in the catalog is added as Non-Stock; only the product and depth of a job line; a length is for LVL only and LVL needs one; a retired item is refused, also at a new length (#107, Q11, Q21, J331, J342, PR #156 review F2, F3)', async () => {
  const ctx = await withShippedJob();
  const { db, ann, lus28 } = ctx;
  const lvl = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.0 LVL 1-3/4', size: '11-7/8', length_ft });
  const twenty = await lvl(20);
  await goLive(db, 'lvl');
  await ctx.receive(twenty, 10);
  await commit(ctx, [[twenty, 4]], { number: '41L' });
  await mark(ctx, 'shipped', ['41L']);

  await returnTo(ctx, twenty, 1, { number: '41L', lengthFt: 20 });
  const job = await returnTo(ctx, twenty, 2, { number: '41L', lengthFt: 14 });
  assert.deepEqual(job.returned, { item: '2.0 LVL 1-3/4 x 11-7/8 14′', quantity: 2, added: true });
  const fourteen = await as(db, APP, async (app) => (await app.query(
    `SELECT id, stocking, active FROM inv.items WHERE family = 'lvl' AND length_ft = 14`)).rows);
  assert.deepEqual(fourteen.map((i) => [i.stocking, i.active]), [['Non-Stock', true]], 'one new length, Non-Stock (Q21)');
  const onHand = await figure(db, 'on_hand');
  assert.deepEqual([onHand[twenty.id], onHand[fourteen[0].id]], [7, 2], '10 − 4 shipped + 1 at 20′; 2 at 14′');
  assert.deepEqual((await returnTo(ctx, twenty, 1, { number: '41L', lengthFt: 14 })).returned,
    { item: '2.0 LVL 1-3/4 x 11-7/8 14′', quantity: 1 }, 'the length is in the catalog now');

  const deeper = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.0 LVL 1-3/4', size: '14', length_ft: 20 });
  const before = await contents(db);
  for (const [item, number, lengthFt, code, message] of [
    [twenty, '41L', 0, 'IV400', 'Type the length returned in whole feet, above 0.'],
    [twenty, '41L', 12.5, 'IV400', 'Type the length returned in whole feet, above 0.'],
    [twenty, '41L', null, 'IV400', 'Type the length returned in whole feet, above 0.'],
    [lus28, '33864R', 8, 'IV400', 'Only LVL is returned at a length.'],
    [twenty, '33864R', 14, 'IV422', '2.0 LVL 1-3/4 x 11-7/8 is not on job 33864R. Only an item on the job comes back from its job site.'],
    [deeper, '41L', 20, 'IV422', '2.0 LVL 1-3/4 x 14 is not on job 41L. Only an item on the job comes back from its job site.'],
    [deeper, '41L', 15, 'IV422', '2.0 LVL 1-3/4 x 14 is not on job 41L. Only an item on the job comes back from its job site.'],
  ]) {
    const err = await refused(returnTo(ctx, item, 1, { number, lengthFt }), code, `${item.sku ?? 'LVL'} on ${number} at ${lengthFt}′`);
    assert.equal(err.message, message);
  }
  assert.deepEqual(await contents(db), before, 'no row, no log entry and no 15′ item added');
  const version = async (item) => (await as(db, APP, async (app) => (await app.query('SELECT version FROM inv.items WHERE id = $1', [item.id])).rows[0])).version;
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), lus28.id, await version(lus28));
  const retired = await refused(returnTo(ctx, lus28, 1), 'IV422', 'a retired hanger on the job');
  assert.equal(retired.message, 'LUS28 is retired. Un-retire it before you record the return.');
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), twenty.id, await version(twenty));
  const items = (await contents(db)).items;
  const retiredLvl = await refused(returnTo(ctx, twenty, 1, { number: '41L', lengthFt: 13 }), 'IV422', 'a retired LVL at a new length');
  assert.equal(retiredLvl.message, '2.0 LVL 1-3/4 x 11-7/8 20′ is retired. Un-retire it before you record the return.');
  const after = await contents(db);
  assert.deepEqual(after.items, items, 'no 13′ item added');
  assert.deepEqual(after.ledger, before.ledger, 'no row');
});

test('Un-ship is refused while the job has a return; reversed, the return gives its pieces back and Un-ship then gives back what was shipped (#107, J332, Q55)', async () => {
  const ctx = await withShippedJob();
  const { db, lus28 } = ctx;
  await returnTo(ctx, lus28, 4);
  const before = await contents(db);
  const err = await refused(undo(ctx, 'unship_job', '33864R'), 'IV422', 'Un-ship with a return standing');
  assert.equal(err.message, 'Job 33864R has a return from the job site. Reverse it in the item\'s History, then Un-ship.');
  assert.deepEqual(await contents(db), before, 'no row and no log entry');

  const [ret] = await as(db, APP, async (app) => (await app.query(`SELECT id FROM inv.ledger WHERE kind = 'return'`)).rows);
  const { version } = await onBoard(db, '33864R');
  await call(db, 'reverse', ctx.ann.id, crypto.randomUUID(), ret.id, 'entered on the wrong job');
  assert.equal((await onBoard(db, '33864R')).version, version + 1, 'a reversed return moves the job\'s version (PR #156 review F1)');
  assert.equal((await figure(db, 'on_hand'))[lus28.id], 70, '74 − the 4 reversed');
  await undo(ctx, 'unship_job', '33864R');
  assert.equal(await jobStatus(db, '33864R'), 'built');
  assert.equal((await figure(db, 'on_hand'))[lus28.id], 100, 'Un-ship gives back the 30 shipped, and only those');
});

test('the return route saves a return on a shipped job; the job view offers Return… only then, with the job\'s active hangers and its LVL by product and depth, and shows the return and its reversal in its History; the item\'s History offers Reverse on it; the Activity Log files it under its own family (#107, stories 43, 46, 56, J330–J332, J342, PR #156 review F1, F5, F6)', async () => {
  const ctx = await appWithCatalog({ plates: ['MT20 3x4'], hangers: ['LUS28', 'HUS26', 'TC26', 'HU210'] });
  const lvl = async (size, length_ft) => (await (await post(ctx.base, '/api/items/add',
    { key: crypto.randomUUID(), family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size, length_ft } }, ctx.cookie)).json()).item;
  const twenty = await lvl('11-7/8', 20);
  await lvl('11-7/8', 12);
  await lvl('14', 20);
  await goLive(ctx.db, 'hangers');
  await goLive(ctx.db, 'lvl');
  // On hand, so the job's plan pulls the four 20′ (#182).
  const supplier = await call(ctx.db, 'add_supplier', ctx.ann.id, crypto.randomUUID(), 'Boise');
  await call(ctx.db, 'receive', ctx.ann.id, crypto.randomUUID(), null, null, supplier.id, null, JSON.stringify([{ item_id: twenty.id, quantity: 4 }]));
  const withLvl = SHEET + '\nRectangular EWP,,,,,,,\nLABEL,SIZE,QTY,LENGTH,,,,\n1BM1-4,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,4,20-00-00,,,,';
  assert.equal((await commitFile(ctx, withLvl)).status, 200);
  const view = async () => (await get(ctx.base, '/api/jobs/view?number=33864R', ctx.cookie)).json();
  const returnOver = (item, quantity, version, length_ft = null) => post(ctx.base, '/api/jobs/return',
    { key: crypto.randomUUID(), number: '33864R', version, item: item.id, quantity, length_ft, timing: null }, ctx.cookie);

  const committed = await view();
  assert.deepEqual([committed.job.can_return, committed.returnable], [false, []], 'a committed job takes no return and offers nothing');
  const marked = await post(ctx.base, '/api/jobs/mark', { key: crypto.randomUUID(), to: 'shipped', jobs: [{ number: '33864R', version: 1 }] }, ctx.cookie);
  assert.equal(marked.status, 200, await marked.clone().text());
  const shipped = await view();
  assert.equal(shipped.job.can_return, true);
  const { HUS26, LUS28, TC26 } = ctx.items;
  assert.deepEqual(shipped.returnable, [
    { id: twenty.id, family: 'lvl', label: '2.1 RigidLam LVL 1-3/4 x 11-7/8', by_length: true },
    { id: HUS26.id, family: 'hangers', label: 'HUS26', by_length: false },
    { id: LUS28.id, family: 'hangers', label: 'LUS28', by_length: false },
    { id: TC26.id, family: 'hangers', label: 'TC26', by_length: false },
  ], 'the job\'s hangers one by one; its LVL once per product and depth; no HU210 or 14″ LVL, which are not on the job, and LVL by the job line, not the 12′; no plates, which are not live and never come back');

  const res = await returnOver(LUS28, 2, 2);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).job.returned, { item: 'LUS28', quantity: 2 });
  const lvlRes = await returnOver(twenty, 1, 3, 9);
  assert.equal(lvlRes.status, 200, await lvlRes.clone().text());
  const after = await view();
  assert.deepEqual(after.history.slice(0, 2).map((h) => [h.action, h.change]), [
    ['record return', '1 of 2.1 RigidLam LVL 1-3/4 x 11-7/8 9′ returned from the job site, added as Non-Stock'],
    ['record return', '2 of LUS28 returned from the job site'],
  ]);
  const refusal = await returnOver(LUS28, 1, 1);
  assert.equal(refusal.status, 409, 'a stale screen');

  const filed = async (family) => (await (await get(ctx.base, `/api/activity?family=${family}`, ctx.cookie)).json()).entries
    .filter((e) => e.action === 'record return').map((e) => e.change);
  assert.deepEqual(await filed('lvl'), ['1 of 2.1 RigidLam LVL 1-3/4 x 11-7/8 9′ returned from the job site, added as Non-Stock'],
    'an LVL return is LVL\'s');
  assert.deepEqual(await filed('hangers'), ['2 of LUS28 returned from the job site']);

  const itemHistory = async () => (await (await get(ctx.base, `/api/items/history?id=${LUS28.id}`, ctx.cookie)).json()).entries;
  const [returned] = (await itemHistory()).filter((e) => e.action === 'record return');
  assert.deepEqual([returned.change, returned.from_job, returned.reversal], [2, false, false], 'the item\'s History offers Reverse on a return');
  const reversed = await post(ctx.base, '/api/ledger/reverse', { key: crypto.randomUUID(), id: returned.id, note: 'wrong job' }, ctx.cookie);
  assert.equal(reversed.status, 200, await reversed.clone().text());
  const [reversal] = (await itemHistory()).filter((e) => e.action === 'reverse');
  assert.deepEqual([reversal.change, reversal.from_job, reversal.reversal], [-2, true, true], 'the reversal offers no Reverse');
  const undone = await view();
  assert.equal(undone.job.version, after.job.version + 1, 'the job\'s version moves');
  assert.deepEqual(undone.history.slice(0, 2).map((h) => [h.action, h.change]), [
    ['reverse', 'added: reversal of the return: LUS28 −2; note: wrong job'],
    ['record return', '1 of 2.1 RigidLam LVL 1-3/4 x 11-7/8 9′ returned from the job site, added as Non-Stock'],
  ], 'the job\'s History shows the return reversed');
});

// ── Seam 1 of #178: a job's LVL committed as the boards the yard pulls (#182) ──

// Sheet 33591R as #178 tells it: 2 × 10′ of 9-1/2″ LVL, and `more` LVL lines.
const lvlSheet = (more = []) => [
  'Quote Date:,3/2/2026,Job Number:,33591R',
  'Order Date:,3/4/2026,Product:,EWP',
  'Delivery Date:,7/1/2026,,',
  'Job Name:,Sample Job A,Delivery Area,',
  'Rectangular EWP,,,,,,,',
  'LABEL,SIZE,QTY,LENGTH,,,,',
  '1BM1-2,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,2,10-00-00,,,,',
  ...more,
].join('\n');

// The app with Ann signed in, LVL live and one item per [depth, length] in
// `lengths`; onHand(item, quantity) receives it, so it is on hand.
async function appWithLvl(lengths = [['9-1/2', 48], ['9-1/2', 10]]) {
  const ctx = await withAdmin();
  const items = {};
  for (const [size, length_ft] of lengths) {
    const res = await post(ctx.base, '/api/items/add',
      { key: crypto.randomUUID(), family: 'lvl', identity: { product: '2.1 RigidLam LVL 1-3/4', size, length_ft } }, ctx.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    items[`${size} ${length_ft}`] = (await res.json()).item;
  }
  await goLive(ctx.db, 'lvl');
  const supplier = await call(ctx.db, 'add_supplier', ctx.ann.id, crypto.randomUUID(), 'Boise');
  const onHand = (item, quantity) => call(ctx.db, 'receive', ctx.ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: item.id, quantity }]));
  const commitLvl = async (text = lvlSheet()) => {
    const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: { name: 'sheet.csv', text } }, ctx.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  return { ...ctx, items, onHand, commitLvl };
}

test('33591R with only 48′ available commits 1 × 48′; with 2 × 10′ available, the two 10′ (#182, stories 1–5)', async () => {
  const only48 = await appWithLvl();
  await only48.onHand(only48.items['9-1/2 48'], 1);
  await only48.commitLvl();
  assert.deepEqual(await currentLines(only48.db, '33591R'), { [only48.items['9-1/2 48'].id]: 1 });

  const two10 = await appWithLvl();
  await two10.onHand(two10.items['9-1/2 48'], 1);
  await two10.onHand(two10.items['9-1/2 10'], 2);
  await two10.commitLvl();
  assert.deepEqual(await currentLines(two10.db, '33591R'), { [two10.items['9-1/2 10'].id]: 2 });
});

test('a board committed to another job is left out of the plan (#182, story 7)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.onHand(ctx.items['9-1/2 10'], 2);
  await ctx.commitLvl();
  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  assert.deepEqual(await currentLines(ctx.db, '33592R'), { [ctx.items['9-1/2 48'].id]: 1 }, 'the two 10′ are 33591R\'s');
});

test('24″ LVL is committed at the sheet\'s lengths, and a piece longer than every purchasable length at its own; the check says why for each (#182, stories 10, 11)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 50], ['24', 16]]);
  const text = lvlSheet(['1BM2-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,50-00-00,,,,', '1BM3-2,2.1 RigidLam DF LVL 1-3/4 x 24,2,16-00-00,,,,']);
  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text } }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).lines, [
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', quantity: 1, lf: 48, flag: null,
      cuts: [{ boards: 1, from: 'to buy', cut: '2 × 10′', remainder: '28′ back on hand' }] },
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 50′', quantity: 1, lf: 50, flag: null,
      at_length: 'Longer than every length we buy of 9-1/2″ LVL (48′), so it is bought at its length.',
      cuts: [{ boards: 1, from: 'to buy', cut: '1 × 50′', remainder: 'none' }] },
    { family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 24 · 16′', quantity: 2, lf: 32, flag: null,
      at_length: 'We buy no set length of 24″ LVL, so it is bought at its length.',
      cuts: [{ boards: 2, from: 'to buy', cut: '1 × 16′', remainder: 'none' }] },
  ]);
  await ctx.commitLvl(text);
  assert.deepEqual(await currentLines(ctx.db, '33591R'),
    { [ctx.items['9-1/2 48'].id]: 1, [ctx.items['9-1/2 50'].id]: 1, [ctx.items['24 16'].id]: 2 });
});

test('a job\'s LVL lines are the boards of its LVL plan, saved with its sheet, which holds only LVL and cannot be edited (#182, story 13)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate } = ctx;
  const lvl = (size, length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size, length_ft });
  const at48 = await lvl('9-1/2', 48);
  const at50 = await lvl('9-1/2', 50);
  const job = (p) => call(db, 'commit_job', ann.id, crypto.randomUUID(), { number: '33591R', lines: [], ...p });
  const plan = [
    { item_id: at48.id, depth: '9-1/2', length_ft: 48, source: 'buy', pieces_ft: [10, 10], remainder_ft: 28, kept_ft: 28 },
    { item_id: at50.id, depth: '9-1/2', length_ft: 50, source: 'at length', pieces_ft: [50], remainder_ft: 0, kept_ft: null },
  ];
  const demand = [{ depth: '9-1/2', length_ft: 10, quantity: 2 }, { depth: '9-1/2', length_ft: 50, quantity: 1 }];

  const before = await contents(db);
  await refused(job({ lines: [{ item_id: at48.id, quantity: 1 }] }), 'IV400', 'an LVL line beside the plan');
  await refused(job({ lvl: { demand, plan: [{ ...plan[0], item_id: plate.id }] } }), 'IV400', 'a plate in the plan');
  await refused(job({ lvl: { demand, plan: [] } }), 'IV400', 'an empty plan');
  assert.deepEqual(await contents(db), before, 'a refusal saves nothing');

  await job({ lines: [{ item_id: plate.id, quantity: 930 }], lvl: { demand, plan } });
  assert.deepEqual(await currentLines(db, '33591R'), { [plate.id]: 930, [at48.id]: 1, [at50.id]: 1 });
  assert.deepEqual(await savedPlan(db, '33591R', 'lvl_cut_plans'), plan);
  await as(db, null, async (owner) => {
    await refused(owner.query('UPDATE inv.lvl_cut_plans SET plan = \'[]\''), 'IV422', 'edit a saved plan');
    await refused(owner.query('DELETE FROM inv.lvl_cut_plans'), 'IV422', 'delete a saved plan');
  });
});

test('the saved LVL plan is kept when on hand changes: the same sheet again is unchanged and keeps it (#182, stories 14, 16, J138)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const plan = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  assert.deepEqual(plan, [{ item_id: ctx.items['9-1/2 48'].id, depth: '9-1/2', length_ft: 48, source: 'on hand',
    pieces_ft: [10, 10], remainder_ft: 28, kept_ft: 28 }]);

  // Two 10′ now on hand: a new plan would take them instead.
  await ctx.onHand(ctx.items['9-1/2 10'], 2);
  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text: lvlSheet() } }, ctx.cookie);
  const check = await res.json();
  assert.equal(check.job.unchanged, true, JSON.stringify(check));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity]), [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1]]);
  assert.equal((await ctx.commitLvl()).job.unchanged, true);
  assert.deepEqual(await savedPlan(ctx.db, '33591R', 'lvl_cut_plans'), plan);
  assert.deepEqual(await currentLines(ctx.db, '33591R'), { [ctx.items['9-1/2 48'].id]: 1 });
});

// The settings are still read: they name the depths the saved plan's demand is in.
test('a sheet that keeps its saved LVL plan is not planned again: the check reads no LVL availability (#182, owner L22)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const database = openDatabase(urlFor(ctx.db, 'inv_app'));
  try {
    const checked = async (text) => {
      const reads = [];
      const counting = Object.create(database, { read: { value: (sql, params) => { reads.push(sql); return database.read(sql, params); } } });
      const { status, body } = await checkSheet(counting, { file: { name: 'sheet.csv', text } });
      assert.equal(status, 200, JSON.stringify(body));
      return reads.filter((sql) => sql.includes('inv.lvl_available')).length;
    };
    assert.equal(await checked(lvlSheet()), 0, 'the same sheet keeps its saved plan');
    assert.equal(await checked(lvlSheet().replace('33591R', '33592R')), 1, 'a new job is planned');
  } finally {
    await database.end();
  }
});

// A third 10′ piece for 33591R, as a revised sheet adds it.
const oneMore10 = '1BM3,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,10-00-00,,,,';

test('a revised sheet with other LVL lines is planned again from the job\'s own boards; the same boards with new cuts is one change; the new plan is saved beside the earlier one (#183, story 17, Q53)', async () => {
  const ctx = await appWithLvl();
  const at48 = ctx.items['9-1/2 48'];
  await ctx.onHand(at48, 1);
  await ctx.commitLvl();

  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text: lvlSheet([oneMore10]) } }, ctx.cookie);
  const check = await res.json();
  assert.equal(check.job.unchanged, false, JSON.stringify(check));
  // The job's own 48′, not a new one to buy: 48 − 3 × 10 = 18′ back on hand.
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, l.cuts]), [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1,
    [{ boards: 1, from: 'on hand', cut: '3 × 10′', remainder: '18′ back on hand' }]]]);
  assert.deepEqual(check.changes, [{ family: 'lvl', sku: '9-1/2″ LVL', was: '48′: 2 × 10′', now: '48′: 3 × 10′', same_boards: true }]);

  const first = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  const commit = await post(ctx.base, '/api/jobs/commit',
    { key: crypto.randomUUID(), file: { name: 'sheet.csv', text: lvlSheet([oneMore10]) }, version: check.job.version }, ctx.cookie);
  assert.equal((await commit.json()).job.revision, 2);
  const plans = await as(ctx.db, APP, async (app) => (await app.query(`
    SELECT s.revision, p.plan FROM inv.lvl_cut_plans p JOIN inv.job_sheets s ON s.id = p.sheet_id ORDER BY s.revision`)).rows);
  assert.deepEqual(plans, [{ revision: 1, plan: first }, { revision: 2, plan: [{ item_id: at48.id, depth: '9-1/2', length_ft: 48,
    source: 'on hand', pieces_ft: [10, 10, 10], remainder_ft: 18, kept_ft: 18 }] }]);
});

test('a revised sheet whose LVL boards change lists the board lines was → now, and no "same boards" line for that depth (#183, Q53)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await ctx.onHand(ctx.items['9-1/2 10'], 2);

  // 30′ first, from the job's own 48′; one 10′ beside it (8′ left), the
  // other from a 10′ on hand.
  const more30 = '1BM4,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,30-00-00,,,,';
  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text: lvlSheet([more30]) } }, ctx.cookie);
  const check = await res.json();
  assert.deepEqual(check.changes, [{ family: 'lvl', sku: '2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 10′', was: null, now: 1 }]);
});

test('a revised sheet that cuts a depth\'s same pieces from the same boards another way lists that depth\'s new cuts, board by board (#183, PR #195 review F1, Q56)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 36], ['11-7/8', 48]]);
  await call(ctx.db, 'set_lvl_purchasable_lengths', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, [36, 48]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  const more30 = '1BM4,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,30-00-00,,,,';
  const deeper = (n) => `1BM5,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,${n},10-00-00,,,,`;
  // 30′ and 10′ from the 48′ on hand, the other 10′ from a 36′ to buy.
  await ctx.commitLvl(lvlSheet([more30, deeper(1)]));
  await ctx.onHand(ctx.items['9-1/2 36'], 1);

  // Another 11-7/8″ piece plans 9-1/2″ again: 30′ from the 36′ now on
  // hand, both 10′ from the 48′. The same two boards, cut another way.
  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text: lvlSheet([more30, deeper(2)]) } }, ctx.cookie);
  const check = await res.json();
  assert.deepEqual(check.changes, [
    { family: 'lvl', sku: '9-1/2″ LVL', was: '36′: 1 × 10′; 48′: 1 × 30′, 1 × 10′', now: '36′: 1 × 30′; 48′: 2 × 10′', same_boards: true },
    { family: 'lvl', sku: '11-7/8″ LVL', was: '48′: 1 × 10′', now: '48′: 2 × 10′', same_boards: true },
  ]);
});

// The sheet holds only LVL, so a new delivery date is what revises it here.
test('a revised sheet whose LVL lines are the same lists no LVL change and keeps the saved plan (#183, PR #195 review F2)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const plan = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  // Two 10′ now on hand: a new plan would take them instead.
  await ctx.onHand(ctx.items['9-1/2 10'], 2);

  const text = lvlSheet().replace('7/1/2026', '7/8/2026');
  const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text } }, ctx.cookie);
  const check = await res.json();
  assert.equal(check.job.unchanged, false, JSON.stringify(check));
  assert.deepEqual(check.changes, []);
  const commit = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: { name: 'sheet.csv', text },
    version: check.job.version, keep_date: false }, ctx.cookie);
  assert.equal((await commit.json()).job.revision, 2);
  assert.deepEqual(await savedPlan(ctx.db, '33591R', 'lvl_cut_plans'), plan);
});

test('a revised sheet whose lumber pieces change but whose boards stay lists that size and grade\'s pieces was → now (#196, Q81)', async () => {
  const ctx = await appWithLumber();
  const res = await commitFile(ctx, LUMBER_SHEET);
  assert.equal(res.status, 200, await res.clone().text());

  // Two 4′6″ pieces fit on a 10′ board, as two 5′ pieces did: still 2 × 10′.
  const text = LUMBER_SHEET.replace('2x4sp2,4,5-00-00', '2x4sp2,4,4-06-00');
  const check = await (await checkFile(ctx, text)).json();
  assert.equal(check.job.unchanged, false, JSON.stringify(check));
  assert.deepEqual(check.changes, [{ family: 'lumber', sku: '2x4 #2', was: '6 × 8′, 4 × 5′', now: '6 × 8′, 4 × 4′ 6″', same_boards: true }]);
});

test('a revised sheet whose lumber boards change lists the board lines was → now, and no "same boards" line for that size and grade (#196)', async () => {
  const ctx = await appWithLumber();
  const res = await commitFile(ctx, LUMBER_SHEET);
  assert.equal(res.status, 200, await res.clone().text());

  const text = LUMBER_SHEET.replace('2x6spdss,3,16-00-00', '2x6spdss,4,16-00-00');
  const check = await (await checkFile(ctx, text)).json();
  assert.deepEqual(check.changes, [{ family: 'lumber', sku: '2x6 DSS 16′', was: 3, now: 4 }]);
});

test('a revised sheet with fewer lumber pieces on the same boards and the same cut lists the pieces was → now (#196, Q81)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  // Only 10′ 2x4 #2 bought: three 5′ pieces take two boards, as four did.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '#2'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x4', '#2', version, [10]);
  const res = await commitFile(ctx, LUMBER_SHEET);
  assert.equal(res.status, 200, await res.clone().text());

  const text = LUMBER_SHEET.replace('2x4sp2,4,5-00-00', '2x4sp2,3,5-00-00');
  const check = await (await checkFile(ctx, text)).json();
  assert.deepEqual(check.changes, [{ family: 'lumber', sku: '2x4 #2', was: '6 × 8′, 4 × 5′', now: '6 × 8′, 3 × 5′', same_boards: true }]);
});

test('a revised sheet that changes a piece cut from a mixed board, on the same boards, lists the pieces was → now (#196)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  // Only 16′ 2x6 DSS bought: a 7′ and a 6′ piece cut from one board.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x6' AND grade = 'DSS'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x6', 'DSS', version, [16]);
  const sheet = (other) => LUMBER_SHEET.replace('2x6spdss,3,16-00-00,2x6 SP DSS,Regular,,48.00,,,,', ['2x6spdss,3,16-00-00,2x6 SP DSS,Regular,,48.00,,,,',
    '2x6spdss,1,7-00-00,2x6 SP DSS,Regular,,7.00,,,,', `2x6spdss,1,${other},2x6 SP DSS,Regular,,6.00,,,,`].join('\n'));
  const res = await commitFile(ctx, sheet('6-00-00'));
  assert.equal(res.status, 200, await res.clone().text());

  const check = await (await checkFile(ctx, sheet('5-06-00'))).json();
  assert.deepEqual(check.changes, [{ family: 'lumber', sku: '2x6 DSS', was: '3 × 16′, 1 × 7′, 1 × 6′', now: '3 × 16′, 1 × 7′, 1 × 5′ 6″', same_boards: true }]);
});

test('a changed purchasable length affects only jobs committed or checked after the change (#182, story 32)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 24]]);
  await ctx.commitLvl();
  const before = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  await call(ctx.db, 'set_lvl_purchasable_lengths', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, [24, 48]);

  assert.equal((await ctx.commitLvl()).job.unchanged, true, 'the committed job keeps its plan');
  assert.deepEqual(await savedPlan(ctx.db, '33591R', 'lvl_cut_plans'), before);
  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  assert.deepEqual(await currentLines(ctx.db, '33592R'), { [ctx.items['9-1/2 24'].id]: 1 }, 'a job committed after it buys 24′');
  assert.deepEqual(await currentLines(ctx.db, '33591R'), { [ctx.items['9-1/2 48'].id]: 1 });
});

test('the Overview shows 48′ Short when jobs need more 48′ than are available, not 10′; a board a saved plan pulls that is gone shows Short (#182, stories 15, 34)', async () => {
  const ctx = await appWithLvl();
  const at48 = ctx.items['9-1/2 48'].id;
  const at10 = ctx.items['9-1/2 10'].id;
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const reorder = async () => { const r = await figure(ctx.db, 'reorder'); return { at48: r[at48], at10: r[at10] }; };
  assert.deepEqual(await reorder(), { at48: 'OK', at10: 'OK' });

  // The 48′ the plan pulls is scrapped: the saved plan still pulls it.
  await call(ctx.db, 'correct', ctx.ann.id, crypto.randomUUID(), at48, -1, await reasonId(ctx.db, 'Damaged – scrapped'), null);
  assert.deepEqual(await currentLines(ctx.db, '33591R'), { [at48]: 1 });
  assert.deepEqual(await reorder(), { at48: 'Short', at10: 'OK' });

  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  assert.deepEqual(await figure(ctx.db, 'available').then((a) => [a[at48], a[at10]]), [-2, 0], 'a second job needs a 48′ more');
  assert.deepEqual(await reorder(), { at48: 'Short', at10: 'OK' });
});

test('a job committed before 025 keeps the LVL it committed, with no data step, while its sheet is the same (#182, story 36, PR #190 review F1)', async () => {
  const db = await freshDatabase({ before: '025' });
  const ann = await firstUser(db);
  const at10 = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '9-1/2', length_ft: 10 });
  await goLive(db, 'lvl');
  const sheet = { number: '33591R', name: 'Sample Job A', delivery_date: '2026-07-01' };
  await call(db, 'commit_job', ann.id, crypto.randomUUID(), { ...sheet, lines: [{ item_id: at10.id, quantity: 2 }] });

  await migrate(urlFor(db));
  assert.deepEqual(await currentLines(db, '33591R'), { [at10.id]: 2 });
  assert.equal((await figure(db, 'committed'))[at10.id], 2);
  const current = async (quantity) => (await as(db, APP, async (app) => (await app.query('SELECT inv.is_current_sheet($1) AS current',
    [{ ...sheet, lines: [], lvl: { demand: [{ depth: '9-1/2', length_ft: 10, quantity }], plan: [] } }])).rows))[0].current;
  assert.equal(await current(2), true, 'the same sheet is its current sheet');
  await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: 'Microllam LVL 1-3/4', size: '9-1/2', length_ft: 10 });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), at10.id, at10.version);
  assert.equal(await current(2), true, 'whatever the catalog holds now');
  assert.equal(await current(3), false, 'a changed sheet is a revised sheet, planned as boards');
});

test('a built job committed before 025 consumes no LVL again when its same sheet is dropped; a shipped one is not told to un-ship (#182, story 36, PR #190 review F1)', async () => {
  const ctx = await withAdmin({ db: await freshDatabase({ before: '025' }) });
  const { db, ann } = ctx;
  const add = (length_ft) => call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '9-1/2', length_ft });
  const at10 = await add(10);
  const at48 = await add(48);
  await goLive(db, 'lvl');
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Boise');
  await call(db, 'receive', ann.id, crypto.randomUUID(), null, null, supplier.id, null,
    JSON.stringify([{ item_id: at10.id, quantity: 4 }, { item_id: at48.id, quantity: 1 }]));
  for (const number of ['B1', 'S1']) {
    await call(db, 'commit_job', ann.id, crypto.randomUUID(),
      { number, name: 'Sample Job A', delivery_date: '2026-07-01', lines: [{ item_id: at10.id, quantity: 2 }] });
  }
  await mark(ctx, 'built', ['B1']);
  await mark(ctx, 'shipped', ['S1']);
  await migrate(urlFor(db));
  const before = await contents(db);

  const sheet = (number, text = lvlSheet()) => text.replace('33591R', number);
  const check = async (text) => {
    const res = await checkFile(ctx, text);
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  };
  const built = await check(sheet('B1'));
  assert.equal(built.job.unchanged, true, JSON.stringify(built));
  const res = await commitFile(ctx, sheet('B1'));
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).job.unchanged, true);
  const { refusal } = await check(sheet('S1'));
  assert.match(refusal, /^Job S1 was already shipped/);
  assert.doesNotMatch(refusal, /un-ship/);
  assert.deepEqual(await contents(db), before, 'nothing saved, nothing consumed again');

  const changed = lvlSheet().replace(',2,10-00-00', ',3,10-00-00');
  assert.equal((await check(sheet('B1', changed))).job.unchanged, false, 'a changed sheet is a revised sheet');
});

test('a lumber job committed before 025 checks as unchanged (#182, story 36, PR #190 review F9)', async () => {
  const ctx = await withAdmin({ db: await freshDatabase({ before: '025' }) });
  const add = async (identity) => {
    const res = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family: 'lumber', identity }, ctx.cookie);
    assert.equal(res.status, 200, await res.clone().text());
  };
  for (const length_ft of [8, 10]) await add({ size: '2x4', grade: '#2', length_ft });
  await add({ size: '2x6', grade: 'DSS', length_ft: 16 });
  // The server reads every sheet's job for a saved LVL plan (PR #198
  // review, finding 2), which 024 has no table for: an empty stand-in,
  // dropped before 025 and 026 make the real ones.
  const standIn = (sql) => as(ctx.db, null, (owner) => owner.query(sql));
  await standIn(`CREATE TABLE inv.lvl_cut_plans (sheet_id bigint, plan jsonb, demand jsonb);
    CREATE FUNCTION inv.lvl_plan_today(jsonb, inv.jobs) RETURNS jsonb LANGUAGE sql AS 'SELECT $1';
    GRANT SELECT ON inv.lvl_cut_plans TO PUBLIC; GRANT EXECUTE ON FUNCTION inv.lvl_plan_today(jsonb, inv.jobs) TO PUBLIC`);
  const res = await commitFile(ctx, LUMBER_ONLY_SHEET);
  assert.equal(res.status, 200, await res.clone().text());
  await standIn('DROP TABLE inv.lvl_cut_plans; DROP FUNCTION inv.lvl_plan_today(jsonb, inv.jobs)');

  await migrate(urlFor(ctx.db));
  const check = await checkFile(ctx, LUMBER_ONLY_SHEET);
  assert.equal(check.status, 200, await check.clone().text());
  assert.equal((await check.json()).job.unchanged, true);
});

test('a sheet with a 22″ LVL line beside another depth is checked, the 22″ line flagged as not in the catalog (#182, PR #190 review F2)', async () => {
  const ctx = await appWithLvl();
  const text = lvlSheet(['1BM9,2.1 RigidLam DF LVL 1-3/4 x 22,1,10-00-00,,,,']);
  const res = await checkFile(ctx, text);
  assert.equal(res.status, 200, await res.clone().text());
  const lines = (await res.json()).lines.map((l) => [l.sku, l.quantity, Object.keys(l.flag ?? {})]);
  assert.deepEqual(lines, [['2.1 RigidLam DF LVL 1-3/4 x 22 · 10′', 1, ['notInCatalog']], ['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1, []]]);
});

test('an LVL line whose depth cannot be read beside a saved LVL plan is shown and flagged, and refuses the commit (#182, PR #190 review F3)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const before = await contents(ctx.db);
  const text = lvlSheet(['1BM7,2.1 RigidLam DF LVL 1-3/4 x 7,3,10-00-00,,,,']);
  const res = await checkFile(ctx, text);
  assert.equal(res.status, 200, await res.clone().text());
  const check = await res.json();
  assert.equal(check.job.unchanged, false);
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, Object.keys(l.flag ?? {})]),
    [['2.1 RigidLam DF LVL 1-3/4 x 7 · 10′', 3, ['notInCatalog']], ['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1, []]]);
  const commitRes = await commitFile(ctx, text);
  assert.equal(commitRes.status, 422, await commitRes.clone().text());
  assert.deepEqual(await contents(ctx.db), before, 'a refusal saves nothing');
});

test('a cancelled job committed again plans its LVL again, without the boards another job took meanwhile (#182, story 7, PR #190 review F4)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl(lvlSheet().replace('33591R', 'A1'));
  const { version } = await onBoard(ctx.db, 'A1');
  await call(ctx.db, 'cancel_job', ctx.ann.id, crypto.randomUUID(), 'A1', version);
  await ctx.commitLvl(lvlSheet().replace('33591R', 'B1'));
  const res = await commitFile(ctx, lvlSheet().replace('33591R', 'A1'), crypto.randomUUID(), { version: (await onBoard(ctx.db, 'A1')).version });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await savedPlan(ctx.db, 'A1', 'lvl_cut_plans')).map((b) => b.source), ['buy'], 'B1 has the one 48′ on hand');
});

test('an LVL plan that pulls more boards than are available is refused, unless it is the plan saved with the sheet (#182, story 34, PR #190 review F5)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate } = ctx;
  const at48 = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lvl', { product: '2.1 RigidLam LVL 1-3/4', size: '9-1/2', length_ft: 48 });
  await goLive(db, 'lvl');
  await ctx.receive(at48, 1);
  const board = { item_id: at48.id, depth: '9-1/2', length_ft: 48, source: 'on hand', pieces_ft: [10, 10], remainder_ft: 28, kept_ft: 28 };
  const lvl = (boards) => ({ demand: [{ depth: '9-1/2', length_ft: 10, quantity: 2 * boards }], plan: Array(boards).fill(board) });
  const job = (number, p) => call(db, 'commit_job', ann.id, crypto.randomUUID(), { number, name: 'J', delivery_date: '2026-07-01', lines: [], ...p });

  const before = await contents(db);
  await refused(job('A1', { lvl: lvl(2) }), 'IV409', 'two 48′ on hand pulled, one on hand');
  assert.deepEqual(await contents(db), before, 'a refusal saves nothing');
  await job('A1', { lvl: lvl(1) });
  await refused(job('B1', { lvl: lvl(1) }), 'IV409', 'the one 48′ is A1\'s');

  // The 48′ is scrapped: A1's saved plan still pulls it, and a revised sheet keeps it.
  await call(db, 'correct', ann.id, crypto.randomUUID(), at48.id, -1, await reasonId(db, 'Damaged – scrapped'), null);
  const { version } = await onBoard(db, 'A1');
  await job('A1', { lines: [{ item_id: plate.id, quantity: 10 }], lvl: lvl(1), version });
  assert.deepEqual(await currentLines(db, 'A1'), { [plate.id]: 10, [at48.id]: 1 });
});

test('sheets checked or committed together plan their LVL earliest delivery first, each without the boards the ones before it took (#182, owner L19)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.onHand(ctx.items['9-1/2 10'], 2);
  const later = lvlSheet().replace('33591R', '33592R').replace('7/1/2026', '8/1/2026');
  const files = [{ name: 'later.csv', text: later }, { name: 'sooner.csv', text: lvlSheet() }];
  const check = await post(ctx.base, '/api/jobs/check-many', { files }, ctx.cookie);
  assert.equal(check.status, 200, await check.clone().text());
  assert.deepEqual((await check.json()).sheets.map((s) => [s.job.number, s.lines.map((l) => [l.sku, l.quantity])]), [
    ['33592R', [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1]]],
    ['33591R', [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 10′', 2]]],
  ], 'shown in the order dropped; the sooner one takes the two 10′');

  const res = await post(ctx.base, '/api/jobs/commit-many', { key: crypto.randomUUID(), files }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await currentLines(ctx.db, '33591R'), { [ctx.items['9-1/2 10'].id]: 2 }, 'delivered first, so it takes the two 10′');
  assert.deepEqual(await currentLines(ctx.db, '33592R'), { [ctx.items['9-1/2 48'].id]: 1 });
});

test('the Planner\'s "Already handled" reads a committed job\'s LVL sheet as the check does: the same sheet does not differ (#182, story 49)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await ctx.onHand(ctx.items['9-1/2 10'], 2);
  const res = await post(ctx.base, '/api/planner/already-handled', { files: [{ name: 'sheet.csv', text: lvlSheet() }] }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).jobs.map((j) => [j.number, j.differs]), [['33591R', false]]);
});

// ── Seam 1 of #178: the LVL plan on the pull list and the check (#184) ──────

test('33591R\'s pull list prints its LVL board: one line with depth, length, to buy, the pieces and the remainder back on hand (#184, stories 18, 19)', async () => {
  const ctx = await appWithLvl();
  await ctx.commitLvl();
  const text = await pullListText(ctx, '33591R');
  assert.match(text, /Pull List — Job 33591R Sample Job A Delivery 7\/1\/2026/);
  assert.match(text, /LVL Boards Depth Length From Cut Remainder ×1 9-1\/2″ 48′ to buy 2 × 10′ 28′ back on hand /);
  assert.deepEqual((await board(ctx)).map((j) => j.pull_list), [true], 'a job with LVL and no lumber has a pull list');
});

test('the LVL part marks on hand or to buy, scrap below the shortest remainder kept, a remainder off the even foot, and boards alike as one line; its boards stay as saved after on hand and the settings change, its remainders follow today\'s shortest remainder kept (#184 Q34 and Q36, #185 Q42)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  // 40′, 4 × 24′, 20′8″ and 9′ of 9-1/2″: the on-hand 48′ takes the 40′.
  await ctx.commitLvl(lvlSheet([
    '1BM2-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,40-00-00,,,,',
    '1BM3-4,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,4,24-00-00,,,,',
    '1BM4-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,20-08-00,,,,',
  ]).replace(',2,10-00-00,', ',1,9-00-00,'));
  const lines = '×1 9-1/2″ 48′ on hand 1 × 40′ 8′ scrap ×2 9-1/2″ 48′ to buy 2 × 24′ none ' +
    '×1 9-1/2″ 48′ to buy 1 × 20′ 8″, 1 × 9′ 18′ 4″ left, 18′ back on hand ';
  assert.match(await pullListText(ctx, '33591R'), new RegExp('Cut Remainder ' + lines));

  await ctx.onHand(ctx.items['9-1/2 48'], 5);
  await call(ctx.db, 'set_lvl_shortest_remainder_kept', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, 20);
  assert.match(await pullListText(ctx, '33591R'), new RegExp('Cut Remainder ' + lines.replace('18′ 4″ left, 18′ back on hand', '18′ 4″ scrap')),
    'the saved boards; 18′ is below 20′ now, so scrap, as Built treats it');
});

test('the check shows under each LVL board its pieces and remainder, for a sheet not yet committed and for one committed, from its saved plan (#184, story 12)', async () => {
  const ctx = await appWithLvl();
  const checked = async () => {
    const res = await post(ctx.base, '/api/jobs/check', { file: { name: 'sheet.csv', text: lvlSheet() } }, ctx.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).lines.map((l) => [l.sku, l.cuts]);
  };
  const shown = [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', [{ boards: 1, from: 'to buy', cut: '2 × 10′', remainder: '28′ back on hand' }]]];
  assert.deepEqual(await checked(), shown);
  await ctx.commitLvl();
  await ctx.onHand(ctx.items['9-1/2 10'], 2);
  assert.deepEqual(await checked(), shown, 'the saved plan, though 2 × 10′ are now on hand');
});

// ── Seam 1 of #178: remainders back on hand at Built, out again at Un-build (#185) ──

// Item `item`'s on-hand figure.
const onHandOf = async (db, item) => (await figure(db, 'on_hand'))[item.id];

test('33591R built consumes the 48′ and puts a 28′ back on hand; the depth\'s linear feet drop by 20 (#185, stories 21, 22, 33)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 48']), 0, 'the 48′ is consumed');
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 28']), 1, 'the 28′ remainder is back on hand');
  assert.equal((await figure(ctx.db, 'depth_lf'))[ctx.items['9-1/2 28'].id], 28, '48 LF on hand before, 20 LF cut');
});

// Job `number`'s remainder rows, as [item id, quantity].
const remainders = (db, number) => as(db, APP, async (app) => (await app.query(
  `SELECT g.item_id::int, g.quantity FROM inv.ledger g JOIN inv.jobs j ON j.id = g.job_id
    WHERE j.number = $1 AND g.kind = 'remainder' ORDER BY g.id`, [number])).rows.map((r) => [r.item_id, r.quantity]));

test('a 9′ remainder, below the shortest remainder kept of 10′, is scrap and makes no entry (#185, story 23)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl(lvlSheet().replace(',2,10-00-00,', ',1,39-00-00,'));
  await mark(ctx, 'built', ['33591R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), []);
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 48']), 0);
});

test('a shortest remainder kept changed after the commit applies at the next Built (#185, story 22)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await call(ctx.db, 'set_lvl_shortest_remainder_kept', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, 30);
  await mark(ctx, 'built', ['33591R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [], 'the 28′ is below 30′ now, so scrap');
});

test('a remainder at a length not in the catalog is added as a Non-Stock item of the same product and depth (#185, story 24, Q21)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  const [added] = await as(ctx.db, APP, async (app) => (await app.query(
    "SELECT id::int, product, size, length_ft, stocking FROM inv.items WHERE family = 'lvl' AND length_ft = 28")).rows);
  assert.deepEqual({ ...added, id: undefined },
    { id: undefined, product: '2.1 RigidLam LVL 1-3/4', size: '9-1/2', length_ft: 28, stocking: 'Non-Stock' });
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[added.id, 1]]);
  assert.equal(await onHandOf(ctx.db, added), 1);
});

test('Un-build takes the remainders back out with the boards it puts back: on hand is as before, each remainder credited once and reversed once (#185, stories 25, 26, S49)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const before = await figure(ctx.db, 'on_hand');
  await mark(ctx, 'built', ['33591R']);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.deepEqual(await figure(ctx.db, 'on_hand'), before);
  const rows = await as(ctx.db, APP, async (app) => (await app.query(
    `SELECT g.kind, o.kind AS reverses, g.quantity, l.action FROM inv.ledger g
       LEFT JOIN inv.ledger o ON o.id = g.reverses_id JOIN inv.activity_log l ON l.id = g.action_id
      WHERE g.item_id = $1 ORDER BY g.id`, [ctx.items['9-1/2 28'].id])).rows);
  assert.deepEqual(rows, [
    { kind: 'remainder', reverses: null, quantity: 1, action: 'mark built' },
    { kind: 'reversal', reverses: 'remainder', quantity: -1, action: 'un-build' },
  ]);

  await mark(ctx, 'built', ['33591R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1], [ctx.items['9-1/2 28'].id, 1]],
    'built again, its new build credits the 28′ again');
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 28']), 1);
});

test('the Built confirmation lists the remainders going back on hand, also at a length not in the catalog yet; the Un-build one lists them going out again (#185 Q41)', async () => {
  const ctx = await appWithLvl();
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  const res = await get(ctx.base, '/api/jobs/to-consume?to=built&number=33591R', ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).jobs, [{ number: '33591R', name: 'Sample Job A',
    lines: [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 48′', family: 'LVL', quantity: 1, live: true }],
    remainders: [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1 }] }]);

  await mark(ctx, 'built', ['33591R']);
  const back = await get(ctx.base, '/api/jobs/to-give-back?action=unbuild&number=33591R', ctx.cookie);
  assert.equal(back.status, 200, await back.clone().text());
  assert.deepEqual(await back.json(), { ok: true, number: '33591R', name: 'Sample Job A', to: 'committed',
    lines: [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 48′', quantity: 1 }],
    remainders: [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1, on_hand_after: 0 }] });
});

test('Shipped from committed, which consumes the LVL then, puts the remainders back on hand; Un-ship, to built (J85), keeps them and Un-build takes them out (#185, stories 22, 25)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const [at48, at28] = [ctx.items['9-1/2 48'], ctx.items['9-1/2 28']];
  await ctx.onHand(at48, 1);
  await ctx.commitLvl();
  await mark(ctx, 'shipped', ['33591R']);
  assert.deepEqual([await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], [0, 1], 'shipped from committed');
  await undo(ctx, 'unship_job', '33591R');
  assert.deepEqual([await jobStatus(ctx.db, '33591R'), await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], ['built', 0, 1]);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.deepEqual([await jobStatus(ctx.db, '33591R'), await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], ['committed', 1, 0]);

  await mark(ctx, 'built', ['33591R']);
  await mark(ctx, 'shipped', ['33591R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[at28.id, 1], [at28.id, 1]], 'Shipped after Built credits none again');
  await undo(ctx, 'unship_job', '33591R');
  assert.deepEqual([await jobStatus(ctx.db, '33591R'), await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], ['built', 0, 1]);
});

test('a remainder at the length of a retired item refuses Built, saying what to do, and saves nothing (#185, story 24)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await call(ctx.db, 'retire_item', ctx.ann.id, crypto.randomUUID(), ctx.items['9-1/2 28'].id, ctx.items['9-1/2 28'].version);
  const before = await contents(ctx.db);
  const err = await refused(mark(ctx, 'built', ['33591R']), 'IV422', 'a retired remainder item');
  assert.match(err.message, /9-1\/2 28′ is retired, and job 33591R puts a remainder back on hand at that length\. Un-retire it, then mark the job built\./);
  assert.deepEqual(await contents(ctx.db), before);
});

test('a job that pulls an on-hand 28′ and leaves a 28′ remainder: Shipped after Built takes no LVL again, and Un-build lists and gives back each, restoring on hand (#185, stories 25, 26)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const [at48, at28] = [ctx.items['9-1/2 48'], ctx.items['9-1/2 28']];
  await ctx.onHand(at48, 1);
  await ctx.onHand(at28, 1);
  await ctx.commitLvl(lvlSheet(['1BM2-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,28-00-00,,,,']));
  assert.deepEqual(await currentLines(ctx.db, '33591R'), { [at48.id]: 1, [at28.id]: 1 }, 'the 28′ piece takes the on-hand 28′');
  const before = await figure(ctx.db, 'on_hand');
  await mark(ctx, 'built', ['33591R']);
  assert.deepEqual([await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], [0, 1], 'the 28′ pulled, a 28′ back');

  const back = await (await get(ctx.base, '/api/jobs/to-give-back?action=unbuild&number=33591R', ctx.cookie)).json();
  assert.deepEqual([back.lines, back.remainders], [
    [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1 }, { item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 48′', quantity: 1 }],
    [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1, on_hand_after: 1 }],
  ]);
  await mark(ctx, 'shipped', ['33591R']);
  assert.deepEqual([await onHandOf(ctx.db, at48), await onHandOf(ctx.db, at28)], [0, 1], 'Shipped takes no LVL');
  await undo(ctx, 'unship_job', '33591R');
  await undo(ctx, 'unbuild_job', '33591R');
  assert.deepEqual(await figure(ctx.db, 'on_hand'), before);
});

test('a remainder row cannot be reversed by hand, as Built cannot; the item\'s History names it as the job\'s remainder back on hand, then its Un-build as out again (#185, story 26, PR #192 review, finding 6)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const at28 = ctx.items['9-1/2 28'];
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  const [{ id }] = await as(ctx.db, APP, async (app) => (await app.query("SELECT id FROM inv.ledger WHERE kind = 'remainder'")).rows);
  const before = await contents(ctx.db);
  const err = await refused(call(ctx.db, 'reverse', ctx.ann.id, crypto.randomUUID(), id, 'by mistake'), 'IV422', 'reversing a remainder row');
  assert.equal(err.message, 'A job\'s Built or Shipped cannot be reversed here.');
  assert.deepEqual(await contents(ctx.db), before);

  await undo(ctx, 'unbuild_job', '33591R');
  const history = await (await get(ctx.base, `/api/items/history?id=${at28.id}`, ctx.cookie)).json();
  assert.deepEqual(history.entries.filter((e) => e.change !== null).map((e) => [e.action, e.change, e.detail, e.from_job]), [
    ['un-build', -1, 'Job 33591R, Sample Job A; remainder out again', true],
    ['mark built', 1, 'Job 33591R, Sample Job A; remainder back on hand', true],
  ]);
});

// ── #186: a revised sheet for a built job consumes only what is not settled ──

const sku = (length) => `2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · ${length}′`;
const piece = (length) => `1BM2-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,${length}-00-00,,,,`;

// On hand of 9-1/2″ LVL at each of `lengths`.
const onHands = async (ctx, lengths) => {
  const all = await figure(ctx.db, 'on_hand');
  return lengths.map((l) => all[ctx.items[`9-1/2 ${l}`].id]);
};

// 33591R committed with `received` × 48′ on hand and built: one 48′ cut
// 2 × 10′, its 28′ back on hand.
async function builtLvl(lengths, received = 2) {
  const ctx = await appWithLvl(lengths);
  await ctx.onHand(ctx.items['9-1/2 48'], received);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  return ctx;
}

// Checks then commits revised sheet `text` for built job 33591R, the commit
// answering `status`: the check's answer, and the commit's.
async function reviseBuilt(ctx, text, status = 200) {
  const check = await (await post(ctx.base, '/api/jobs/check', { file: { name: 's.csv', text } }, ctx.cookie)).json();
  const res = await post(ctx.base, '/api/jobs/commit',
    { key: crypto.randomUUID(), version: check.job.version, file: { name: 's.csv', text } }, ctx.cookie);
  assert.equal(res.status, status, await res.clone().text());
  return Object.assign(check, { committed: await res.json() });
}

test('a built job revised to 3 × 10′ keeps its 48′ as cut and cuts the one more 10′ from its own 28′ remainder, 18′ back on hand; the change screen shows the 28′ consumed 0, 1 more (#186, Q59, Q60)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 18], ['9-1/2', 10]]);
  const check = await reviseBuilt(ctx, lvlSheet([oneMore10]));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, l.cuts]), [
    [sku(48), 1, [{ boards: 1, from: 'on hand', cut: '2 × 10′', remainder: '28′ back on hand' }]],
    [sku(28), 1, [{ boards: 1, from: 'on hand', cut: '1 × 10′', remainder: '18′ back on hand' }]],
  ]);
  assert.deepEqual(check.changes, [{ family: 'lvl', sku: sku(28), was: null, now: 1, consumed: 0, more: 1 }]);
  assert.deepEqual(await onHands(ctx, [48, 28, 18]), [1, 0, 1], 'the 28′ cut, its 18′ back on hand; the 48′ consumed once');
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1], [ctx.items['9-1/2 18'].id, 1]]);
});

test('a built job revised twice: the second revision keeps the first one\'s board as cut and puts back no remainder again (#186, Q59)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 18], ['9-1/2', 10]]);
  await reviseBuilt(ctx, lvlSheet([oneMore10]));
  const check = await reviseBuilt(ctx, lvlSheet([oneMore10, oneMore10.replace('1BM3', '1BM4')]));
  assert.deepEqual(check.changes, [{ family: 'lvl', sku: sku(18), was: null, now: 1, consumed: 0, more: 1 }]);
  assert.deepEqual(await onHands(ctx, [48, 28, 18]), [1, 0, 0], 'the 18′ remainder cut; its 8′ is scrap');
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1], [ctx.items['9-1/2 18'].id, 1]]);
});

test('a built job revised to add a 40′ piece cuts it from a new 48′, not the boards cut at Built; its 8′ is scrap (#186, Q59)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 10]]);
  const check = await reviseBuilt(ctx, lvlSheet([piece(40)]));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, l.cuts]), [[sku(48), 2, [
    { boards: 1, from: 'on hand', cut: '2 × 10′', remainder: '28′ back on hand' },
    { boards: 1, from: 'on hand', cut: '1 × 40′', remainder: '8′ scrap' },
  ]]]);
  assert.deepEqual(check.changes, [{ family: 'lvl', sku: sku(48), was: 1, now: 2, consumed: 1, more: 1 }]);
  assert.deepEqual(await onHands(ctx, [48, 28]), [0, 1], 'the second 48′ consumed; the 28′ from Built stays on hand');
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1]], 'an 8′ scrap makes no entry');
});

test('a built job whose only 48′ was consumed at Built keeps it as cut, not to buy, when revised (#186, Q59)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]], 1);
  const check = await reviseBuilt(ctx, lvlSheet([oneMore10]));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.cuts.map((c) => c.from)]), [[sku(48), ['on hand']], [sku(28), ['on hand']]]);
});

test('a built job revised to fewer pieces keeps its boards as cut and consumes nothing more (#186, Q27)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const check = await reviseBuilt(ctx, lvlSheet().replace(',2,10-00-00', ',1,10-00-00'));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, l.cuts]), [[sku(48), 1,
    [{ boards: 1, from: 'on hand', cut: '2 × 10′', remainder: '28′ back on hand' }]]]);
  assert.deepEqual(check.changes, []);
  assert.deepEqual(await onHands(ctx, [48, 28]), [1, 1]);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1]]);
});

test('a depth a built job\'s revision drops stays on its board, named by its depth, also when the same sheet is checked again (#186, Q27)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['11-7/8', 48], ['11-7/8', 38]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.onHand(ctx.items['11-7/8 48'], 1);
  await ctx.commitLvl(lvlSheet(['1BM5,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,1,10-00-00,,,,']));
  await mark(ctx, 'built', ['33591R']);
  const kept = [['2.1 RigidLam DF LVL 1-3/4 x 9-1/2 · 48′', 1], ['11-7/8″ LVL · 48′', 1]];
  const check = await reviseBuilt(ctx, lvlSheet());
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity]), kept);
  const again = await (await post(ctx.base, '/api/jobs/check', { file: { name: 's.csv', text: lvlSheet() } }, ctx.cookie)).json();
  assert.equal(again.job.unchanged, true);
  assert.deepEqual(again.lines.map((l) => [l.sku, l.quantity]), kept);
});

test('a built job given its same LVL lines keeps its plan and consumes nothing more: the same sheet is unchanged, a new job name is a revision with no LVL change (#186)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]]);
  assert.equal((await ctx.commitLvl()).job.unchanged, true);
  const check = await reviseBuilt(ctx, lvlSheet().replace('Sample Job A', 'Sample Job B'));
  assert.deepEqual([check.job.unchanged, check.changes], [false, []]);
  assert.deepEqual(await onHands(ctx, [48, 28]), [1, 1]);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1]]);
});

test('the database refuses an LVL plan for a built job that does not start with the boards it cut, and saves nothing (#186, Q59)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const [cut] = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  const before = await contents(ctx.db);
  const { version } = await onBoard(ctx.db, '33591R');
  const added = { ...cut, item_id: ctx.items['9-1/2 28'].id, length_ft: 28, pieces_ft: [10], remainder_ft: 18, kept_ft: 18 };
  const err = await refused(call(ctx.db, 'commit_job', ctx.ann.id, crypto.randomUUID(), {
    number: '33591R', name: 'Sample Job A', delivery_date: '2026-07-01', lines: [], version,
    lvl: { demand: [{ depth: '9-1/2', length_ft: 10, quantity: 3 }], plan: [added, cut] } }), 'IV422', 'a plan with its cut board second');
  assert.match(err.message, /The LVL plan for built job 33591R does not keep the boards it cut\./);
  assert.deepEqual(await contents(ctx.db), before);
});

test('Un-build after a revision gives back every board consumed and takes out every remainder, Built\'s and the revision\'s, once each (#186)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 18]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 2);
  await ctx.commitLvl();
  const before = await figure(ctx.db, 'on_hand');
  await mark(ctx, 'built', ['33591R']);
  await reviseBuilt(ctx, lvlSheet([oneMore10]));
  await undo(ctx, 'unbuild_job', '33591R');
  assert.deepEqual(await figure(ctx.db, 'on_hand'), before);
  const rows = await as(ctx.db, APP, async (app) => (await app.query(
    `SELECT g.item_id::int AS item, pg_catalog.count(*)::int AS reversals FROM inv.ledger g JOIN inv.ledger o ON o.id = g.reverses_id
      WHERE o.kind = 'remainder' GROUP BY 1 ORDER BY 1`)).rows);
  assert.deepEqual(rows, [{ item: ctx.items['9-1/2 28'].id, reversals: 1 }, { item: ctx.items['9-1/2 18'].id, reversals: 1 }]);
});

test('a revision\'s remainder at the length of a retired item refuses the commit, saying what to do (#186, Q60)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 18]]);
  await call(ctx.db, 'retire_item', ctx.ann.id, crypto.randomUUID(), ctx.items['9-1/2 18'].id, ctx.items['9-1/2 18'].version);
  const { committed } = await reviseBuilt(ctx, lvlSheet([oneMore10]), 422);
  assert.match(committed.error, /18′ is retired, and job 33591R puts a remainder back on hand at that length\. Un-retire it, then commit the sheet again\./);
  assert.deepEqual(await onHands(ctx, [48, 28]), [1, 1], 'nothing saved');
});

test('Un-build after another job used the remainder goes ahead, and its confirmation gives the remainder\'s on hand after Un-build, so it can warn of on hand below zero (PR #192 review, finding 2, #185 Q45)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 10]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  await mark(ctx, 'built', ['33592R']);
  const back = await (await get(ctx.base, '/api/jobs/to-give-back?action=unbuild&number=33591R', ctx.cookie)).json();
  assert.deepEqual(back.remainders, [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1, on_hand_after: -1 }]);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 28']), -1, 'on hand may go below zero (Q30)');
});

test('the Un-build confirmation counts the boards Un-build gives back of the remainder\'s item: on hand after is 0, not −1, when the job also pulled that 28′ (second PR #192 review, finding 8)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 10]]);
  const at28 = ctx.items['9-1/2 28'];
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.onHand(at28, 1);
  await ctx.commitLvl(lvlSheet().replace('1BM1-2,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,2,10-00-00,,,,',
    '1BM1-1,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,26-00-00,,,,\n1BM1-2,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,1,20-00-00,,,,'));
  await mark(ctx, 'built', ['33591R']);
  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  await mark(ctx, 'built', ['33592R']);
  assert.equal(await onHandOf(ctx.db, at28), 0, '33592R took the 28′ that 33591R put back');
  const back = await (await get(ctx.base, '/api/jobs/to-give-back?action=unbuild&number=33591R', ctx.cookie)).json();
  assert.deepEqual([back.lines, back.remainders], [
    [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1 }, { item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 48′', quantity: 1 }],
    [{ item: '2.1 RigidLam LVL 1-3/4 x 9-1/2 28′', quantity: 1, on_hand_after: 0 }],
  ]);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.equal(await onHandOf(ctx.db, at28), 0);
});

test('a built job\'s pull list shows the remainders Built put back, whatever the setting now; after Un-build it follows today\'s setting again (PR #192 review, finding 3, #185 Q46)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 10]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'built', ['33591R']);
  await call(ctx.db, 'set_lvl_shortest_remainder_kept', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, 30);
  assert.match(await pullListText(ctx, '33591R'), /9-1\/2″ 48′ on hand 2 × 10′ 28′ back on hand /);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.match(await pullListText(ctx, '33591R'), /9-1\/2″ 48′ on hand 2 × 10′ 28′ scrap /);
});

test('a job shipped from committed shows the remainders Shipped put back, whatever the setting now (second PR #192 review, finding 9, #185 Q46)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 10]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  await ctx.commitLvl();
  await mark(ctx, 'shipped', ['33591R']);
  await call(ctx.db, 'set_lvl_shortest_remainder_kept', ctx.ann.id, crypto.randomUUID(), '9-1/2', 1, 30);
  assert.match(await pullListText(ctx, '33591R'), /9-1\/2″ 48′ on hand 2 × 10′ 28′ back on hand /);
});

test('two boards whose remainders are one item put back one row of 2; Un-build takes both out (PR #192 review, finding 7)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 18]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 2);
  await ctx.commitLvl(lvlSheet().replace(',2,10-00-00,', ',2,30-00-00,'));
  await mark(ctx, 'built', ['33591R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 18'].id, 2]]);
  await undo(ctx, 'unbuild_job', '33591R');
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 18']), 0);
});

test('one mark of two jobs puts back each job\'s remainders, under its own job (PR #192 review, finding 7)', async () => {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 2);
  await ctx.commitLvl();
  await ctx.commitLvl(lvlSheet().replace('33591R', '33592R'));
  await mark(ctx, 'built', ['33591R', '33592R']);
  assert.deepEqual(await remainders(ctx.db, '33591R'), [[ctx.items['9-1/2 28'].id, 1]]);
  assert.deepEqual(await remainders(ctx.db, '33592R'), [[ctx.items['9-1/2 28'].id, 1]]);
  assert.equal(await onHandOf(ctx.db, ctx.items['9-1/2 28']), 2);
});

test('the check and Built round a remainder to its even foot as a plan not yet saved does, also 1/16″ short of it (PR #192 review, finding 4)', async () => {
  const ctx = await withAdmin();
  const ft = (feet, inches = 0) => feet + inches / 12;
  for (const piece of [ft(20, 1 / 16), ft(20), ft(20, 1 / 8), ft(20, 4), ft(36, 2), ft(38, 2)]) {
    const { depths: [{ boards: [board] }] } = planLvlCuts({ lines: [{ depth: '9-1/2', lengthFt: piece, quantity: 1 }],
      available: [], purchasable: { '9-1/2': [48] }, shortestKept: { '9-1/2': 10 } });
    const [{ kept }] = await as(ctx.db, APP, async (app) => (await app.query(
      "SELECT inv.lvl_plan_today(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('depth', '9-1/2', 'remainder_ft', $1::float8)), NULL) -> 0 -> 'kept_ft' AS kept",
      [board.remainderFt])).rows);
    assert.equal(kept, board.keptFt, `a ${board.remainderFt} ft remainder`);
    if (piece === ft(20, 1 / 16)) assert.equal(kept, 28, '27′11-15/16″ is within 1/16″ of 28′');
  }
});

// 33591R committed with one plate line and no LVL, and built; one 48′ on hand.
async function builtPlatesOnly() {
  const ctx = await appWithLvl([['9-1/2', 48], ['9-1/2', 28]]);
  await ctx.onHand(ctx.items['9-1/2 48'], 1);
  const res = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family: 'plates', identity: { sku: 'MT20 3x4' } }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const plate = (await res.json()).item;
  await goLive(ctx.db, 'plates');
  await call(ctx.db, 'commit_job', ctx.ann.id, crypto.randomUUID(), {
    number: '33591R', name: 'Sample Job A', delivery_date: '2026-07-01', lines: [{ item_id: plate.id, quantity: 1 }] });
  await mark(ctx, 'built', ['33591R']);
  return { ...ctx, plate };
}

test('a built job with no LVL at Built, revised to add 2 × 10′ cut from a 48′, puts the 28′ remainder back on hand (PR #198 review, finding 1; Q60)', async () => {
  const ctx = await builtPlatesOnly();
  await reviseBuilt(ctx, lvlSheet());
  assert.deepEqual(await onHands(ctx, [48, 28]), [0, 1], 'the 48 consumed; its 28 back on hand');
});

test('the database refuses a sheet for a built job that drops the LVL boards it cut, and saves nothing (PR #198 review, finding 2)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const res = await post(ctx.base, '/api/items/add', { key: crypto.randomUUID(), family: 'plates', identity: { sku: 'MT20 3x4' } }, ctx.cookie);
  const plate = (await res.json()).item;
  const { version } = await onBoard(ctx.db, '33591R');
  const before = await contents(ctx.db);
  let err = null;
  try {
    await call(ctx.db, 'commit_job', ctx.ann.id, crypto.randomUUID(), {
      number: '33591R', name: 'Sample Job B', delivery_date: '2026-07-01', lines: [{ item_id: plate.id, quantity: 1 }], version });
  } catch (e) { err = e; }
  assert.ok(err, 'accepted: the built job now has a sheet with no LVL plan and no 48 line');
  assert.equal(err.code, 'IV422');
  assert.match(err.message, /The LVL plan for built job 33591R does not keep the boards it cut\./);
  assert.deepEqual(await contents(ctx.db), before);
});

test('a built job revised to a sheet with no LVL keeps its cut 48′ on its board and consumes nothing more (PR #198 review, finding 2; Q27)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28]]);
  const [cut] = await savedPlan(ctx.db, '33591R', 'lvl_cut_plans');
  const check = await reviseBuilt(ctx, lvlSheet().split('\n').filter((l) => !l.includes('LVL 1-3/4')).join('\n'));
  assert.deepEqual(check.lines.map((l) => [l.sku, l.quantity, l.flag]), [['9-1/2″ LVL · 48′', 1, null]], 'named by its depth');
  assert.deepEqual(check.changes, []);
  assert.deepEqual((await savedPlan(ctx.db, '33591R', 'lvl_cut_plans')).map((b) => b.pieces_ft), [cut.pieces_ft], 'the 48′ stays on its board');
  assert.deepEqual(await onHands(ctx, [48, 28]), [1, 1], 'nothing more consumed');
});

test('a built job whose cut 48′ was retired after Built can still be revised to add a 10′; the 48′ line is not flagged (PR #198 review, finding 3; Q87)', async () => {
  const ctx = await builtLvl([['9-1/2', 48], ['9-1/2', 28], ['9-1/2', 18]], 1);
  const i48 = (await as(ctx.db, APP, async (app) => (await app.query('SELECT id, version FROM inv.items WHERE id = $1', [ctx.items['9-1/2 48'].id])).rows))[0];
  await call(ctx.db, 'retire_item', ctx.ann.id, crypto.randomUUID(), i48.id, i48.version);
  const { lines, committed } = await reviseBuilt(ctx, lvlSheet([oneMore10]));
  assert.ok(!committed.error, committed.error);
  assert.deepEqual(lines.filter((l) => l.sku === sku(48)).map((l) => [l.quantity, l.flag]), [[1, null]]);
});
