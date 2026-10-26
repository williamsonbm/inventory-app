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

const { freshDatabase, as, APP, firstUser, call, logRows, refused, contents, goLive, figure } = require('./support/database.js');
const { withAdmin, get, post } = require('./support/app.js');

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

// Commits a job as Ann. `lines` are [item, quantity] pairs.
function commit(ctx, lines, { number = '33864R', name = 'Smith Residence', deliveryDate = '2026-11-02', key = crypto.randomUUID() } = {}) {
  return call(ctx.db, 'commit_job', ctx.ann.id, key, {
    number, name, delivery_date: deliveryDate,
    lines: lines.map(([item, quantity]) => ({ item_id: item.id, quantity })),
  });
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

test('a different sheet for a job already in the app is refused with who committed it (story 8)', async () => {
  const ctx = await withCatalog();
  const { db, plate, lus28 } = ctx;
  await commit(ctx, [[plate, 930]]);
  const before = await contents(db);
  const err = await refused(commit(ctx, [[plate, 930], [lus28, 1]]), 'IV422', 'a different sheet');
  assert.match(err.message, /^Job 33864R was already committed by Ann Lee on \w+ \d+, \d{4}, from a different sheet\.$/);
  // The same lines with another delivery date or job name are a different sheet too (J19).
  await refused(commit(ctx, [[plate, 930]], { deliveryDate: '2026-11-09' }), 'IV422', 'another delivery date');
  await refused(commit(ctx, [[plate, 930]], { deliveryDate: null }), 'IV422', 'no delivery date');
  await refused(commit(ctx, [[plate, 930]], { name: 'Jones Residence' }), 'IV422', 'another job name');
  assert.deepEqual(await contents(db), before);
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

// The saved cut plan of job `number`'s current sheet, or null.
async function savedPlan(db, number) {
  return as(db, APP, async (app) => (await app.query(`
    SELECT p.plan FROM inv.lumber_cut_plans p JOIN inv.job_sheets s ON s.id = p.sheet_id
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
  await refused(job(otherSheet), 'IV422', 'a different sheet is not the same sheet');
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
  await commit(ctx, [[long, 10]]);

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

function commitFile(ctx, text = SHEET, key = crypto.randomUUID()) {
  return post(ctx.base, '/api/jobs/commit', { key, file: { name: '33864R-materials.csv', text } }, ctx.cookie);
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

test('the same file twice commits once; a different sheet for the job is refused (S20, story 8)', async () => {
  const ctx = await appWithCatalog();
  assert.equal((await commitFile(ctx)).status, 200);
  const again = await commitFile(ctx);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).job.unchanged, true);

  for (const [from, to] of [['12,Hanger,LUS28', '13,Hanger,LUS28'], ['Delivery Date:,11/2/2026', 'Delivery Date:,11/9/2026']]) {
    assert.ok(SHEET.includes(from), from);
    const changed = await commitFile(ctx, SHEET.replace(from, to));
    assert.equal(changed.status, 422, to);
    assert.match((await changed.json()).error, /^Job 33864R was already committed by Ann Lee on /);
  }
  assert.equal((await board(ctx))[0].delivery_date, '2026-11-02');
  assert.equal((await board(ctx)).length, 1);
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

  // A different sheet is refused as one, not for its retired line: un-retiring would not commit it.
  const changed = await commitFile(ctx, SHEET.replace('12,Hanger,LUS28', '13,Hanger,LUS28'));
  assert.equal(changed.status, 422);
  assert.deepEqual(Object.keys(await changed.clone().json()), ['ok', 'error']);
  assert.match((await changed.json()).error, /^Job 33864R was already committed by Ann Lee on /);
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
  return { ...ctx, items };
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
  assert.deepEqual(lines, [
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

test('the lumber pull list prints the saved cut plan, after the buying options change too (#99, story 48, story 13, Q57)', async () => {
  const ctx = await appWithLumber();
  const { db, ann } = ctx;
  const res = await post(ctx.base, '/api/jobs/commit', { key: crypto.randomUUID(), file: lumberFile() }, ctx.cookie);
  assert.equal(res.status, 200, await res.clone().text());
  // 10′ 2x4 #2 no longer bought: a new plan would cut the 5′ pieces from 6′ boards.
  const [{ version }] = await as(db, APP, async (app) => (await app.query(
    "SELECT version FROM inv.lumber_purchasable_lengths WHERE size = '2x4' AND grade = '#2'")).rows);
  await call(db, 'set_lumber_lengths', ann.id, crypto.randomUUID(), '2x4', '#2', version, [6, 7, 8, 12, 14, 16, 20]);

  const page = await get(ctx.base, '/api/jobs/pull-list?number=33865r', ctx.cookie);
  assert.equal(page.status, 200, await page.clone().text());
  assert.match(page.headers.get('content-type'), /text\/html/);
  const text = (await page.text()).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
  assert.match(text, /Pull List — Job 33865R Jones Garage Delivery 11\/3\/2026/);
  assert.match(text, /2x4 #2 Boards Length Cut instruction LF ×2 10′ 2 × 5′ per board 20 ×6 8′ full length 48 /);
  assert.match(text, /2x6 DSS Boards Length Cut instruction LF ×3 16′ full length 48 /);
  assert.match(text, /11 boards 116 LF 0 ft scrap/);

  assert.deepEqual((await board(ctx)).map((j) => j.pull_list), [true]);
  assert.equal((await get(ctx.base, '/api/jobs/pull-list?number=99999', ctx.cookie)).status, 404);
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

test('an LVL line shows its linear feet to two decimals (#99, Q59)', async () => {
  const ctx = await appWithLumber();
  const text = LUMBER_SHEET.replace('1-3/4 x 14,2,14-00-00', '1-3/4 x 14,3,11-04-00');
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

// Today as a refusal says it: October 26, 2026.
const today = () => new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });

test('a sheet for a job already built or shipped is refused with who handled it and when, the same sheet too (S28, J75)', async () => {
  const ctx = await withCatalog();
  const { plate, lus28 } = ctx;
  await commit(ctx, [[plate, 5], [lus28, 2]]);
  await mark(ctx, 'built', ['33864R']);
  const sameBuilt = await refused(commit(ctx, [[plate, 5], [lus28, 2]]), 'IV422', 'the same sheet, built');
  assert.equal(sameBuilt.message, `Job 33864R was already built by Ann Lee on ${today()}.`);
  const changed = await refused(commit(ctx, [[plate, 6], [lus28, 2]]), 'IV422', 'a different sheet, built');
  assert.equal(changed.message, `Job 33864R was already built by Ann Lee on ${today()}.`);

  await mark(ctx, 'shipped', ['33864R']);
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
    { number: '33864R', name: 'Smith Residence', lines: [{ item: 'MT20 3x4', family: 'Plates', quantity: 930, live: false }, ...hangers] },
    { number: '33865R', name: 'Smith Residence', lines: hangers },
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
  assert.deepEqual(await preview.json(), { ok: true, number: '33864R', name: 'Smith Residence', to: 'built', lines: hangers });

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

test('a sheet for a job cancelled, un-built or un-shipped is refused with who did that and what they did (#101, S28, J92)', async () => {
  const ctx = await withCatalog();
  const { db, ann, plate, lus28 } = ctx;
  const bob = await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in for a password hash');
  await commit(ctx, [[plate, 5], [lus28, 2]], { number: '1S' });
  await commit(ctx, [[plate, 5]], { number: '2C' });
  await mark(ctx, 'shipped', ['1S']);
  for (const [action, number] of [['unship_job', '1S'], ['cancel_job', '2C']]) {
    await call(db, action, bob.id, crypto.randomUUID(), number, (await onBoard(db, number)).version);
  }
  const unshipped = await refused(commit(ctx, [[plate, 6], [lus28, 2]], { number: '1S' }), 'IV422', 'a sheet for an un-shipped job');
  assert.equal(unshipped.message, `Job 1S was already built (un-shipped by Bob Ray on ${today()}).`);
  const cancelled = await refused(commit(ctx, [[plate, 6]], { number: '2C' }), 'IV422', 'a sheet for a cancelled job');
  assert.equal(cancelled.message, `Job 2C was already cancelled by Bob Ray on ${today()}.`);

  await commit(ctx, [[plate, 5]], { number: '3U' });
  await goLive(db, 'plates');
  await mark(ctx, 'built', ['3U']);
  await call(db, 'unbuild_job', bob.id, crypto.randomUUID(), '3U', (await onBoard(db, '3U')).version);
  const unbuilt = await refused(commit(ctx, [[plate, 6]], { number: '3U' }), 'IV422', 'a sheet for an un-built job');
  assert.equal(unbuilt.message, `Job 3U was already committed (un-built by Bob Ray on ${today()}), from a different sheet.`);
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
    job: { number: '33864R', version: 1, delivery_date: '2026-11-02', delivery_date_edited: false, can_set_date: true },
    lines: [
      { family: 'plates', label: 'MT20 3x4', length_ft: null, quantity: 930 },
      { family: 'hangers', label: 'HUS26', length_ft: null, quantity: 8 },
      { family: 'hangers', label: 'LUS28', length_ft: null, quantity: 12 },
      { family: 'hangers', label: 'TC26', length_ft: null, quantity: 6 },
    ],
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
