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
    families: [{ name: 'Plates', live: false }, { name: 'Hangers', live: false }],
    pull_list: false, changed_by: 'Ann Lee', changed_at: 'string',
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
