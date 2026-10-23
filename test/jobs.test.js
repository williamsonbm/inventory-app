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

const { freshDatabase, as, APP, firstUser, call, logRows, refused, contents } = require('./support/database.js');
const { withAdmin, get, post } = require('./support/app.js');

// A database with Ann, a plate and two hangers in the catalog.
async function withCatalog() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const add = (family, sku) => call(db, 'add_item', ann.id, crypto.randomUUID(), family, { sku });
  return { db, ann, plate: await add('plates', 'MT20 3x4'), lus28: await add('hangers', 'LUS28'), hus: await add('hangers', 'HUS26') };
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

// ── Seam 2: the commit route over HTTP ──────────────────────────────────────

// One job's material sheet in MiTek's layout: plates, hangers, and a lumber
// line that waits for #99. "MT20  3x4" has two spaces, as MiTek writes it;
// "Two HUS26" is 2 per unit; STC26 is bought as TC26.
const SHEET = [
  'Quote Date:,1/5/2026,Job Number:,33864R',
  'Order Date:,1/12/2026,Product:,Roof',
  'Delivery Date:,11/2/2026,,',
  'Job Name:,Smith Residence,Delivery Area,',
  'LUMBER SUMMARY,,,,',
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
    changed_by: 'Ann Lee', changed_at: 'string',
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
  assert.equal((await none.json()).error, 'Job 33864R has no plate or hanger lines to commit.');
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
