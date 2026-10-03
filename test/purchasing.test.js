// =============================================================
// purchasing.test.js — POs and Incoming (#81 part 2; seam 1).
// Run with: pg-test-up, then npm test  (node --test)
// =============================================================
// Each test builds a fresh database with the migration runner and calls the
// database's functions as the app's login, then reads the figures through
// the one calculation (inv.item_figures), as #81's Testing Decisions ask.
// Switching a family live is an owner command, so it runs as the owner.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { freshDatabase, as, APP, firstUser, call, goLive, logRows, refused } = require('./support/database.js');

async function incoming(db) {
  return as(db, APP, async (app) => Object.fromEntries((await app.query(
    'SELECT item_id::int, incoming FROM inv.item_figures')).rows.map((r) => [r.item_id, r.incoming])));
}

// A database with Ann, one supplier and a hanger, with hangers live.
async function withHanger() {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const supplier = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'Simpson');
  const hanger = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'LUS28' });
  await goLive(db, 'hangers');
  return { db, ann, supplier, hanger };
}

test('a PO for a live family shows its lines as incoming, and one log row records it (S12)', async () => {
  const { db, ann, supplier, hanger } = await withHanger();
  const po = await call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, ' 4501 ', '2026-10-03',
    JSON.stringify([{ item_id: hanger.id, ordered: 100, pack_size: 50 }, { item_id: hanger.id, ordered: 30, pack_size: null }]));
  assert.deepEqual(po, {
    id: po.id, version: 1, supplier_id: supplier.id, supplier: 'Simpson', number: '4501', po_date: '2026-10-03',
    lines: [
      { id: po.lines[0].id, item_id: hanger.id, ordered: 100, pack_size: 50, closed_reason: null },
      { id: po.lines[1].id, item_id: hanger.id, ordered: 30, pack_size: null, closed_reason: null },
    ],
  });
  assert.equal((await incoming(db))[hanger.id], 130);

  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'enter PO');
  assert.equal(last.target_table, 'purchase_orders');
  assert.equal(Number(last.target_id), po.id);
  assert.deepEqual(last.new_value, po);
});

test('a PO line for a family not live in Inventory is refused, whatever writes it (story 57)', async () => {
  const { db, ann, supplier, hanger } = await withHanger();
  const plate = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'plates', { sku: 'MT20 3x4' });
  const before = (await logRows(db)).length;
  const err = await refused(call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, '4502', '2026-10-03',
    JSON.stringify([{ item_id: hanger.id, ordered: 10 }, { item_id: plate.id, ordered: 5 }])), 'IV422', 'plates are off');
  assert.equal(err.message, 'The Plates family is not live in Inventory yet, so it takes no POs, receipts or counts.');
  assert.equal((await logRows(db)).length, before, 'nothing saved: no log row');
  assert.deepEqual(await incoming(db), { [hanger.id]: 0, [plate.id]: 0 }, 'nothing saved: no line counts as incoming');

  // The guarantee: even the owner's own insert is refused.
  await as(db, null, async (owner) => {
    const { rows: [{ id }] } = await owner.query(
      "INSERT INTO inv.purchase_orders (supplier_id, number, po_date) VALUES ($1, 'X1', '2026-10-03') RETURNING id", [supplier.id]);
    await refused(owner.query('INSERT INTO inv.po_lines (po_id, item_id, ordered) VALUES ($1, $2, 1)', [id, plate.id]),
      'IV422', 'a direct insert for plates');
  });
});

test('impossible POs are refused with a plain message, and none leaves a row', async () => {
  const { db, ann, supplier, hanger } = await withHanger();
  const retired = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), retired.id, 1);
  const line = (fields) => JSON.stringify([{ item_id: hanger.id, ordered: 10, ...fields }]);
  const enter = (supplierId, number, date, lines) =>
    call(db, 'enter_po', ann.id, crypto.randomUUID(), supplierId, number, date, lines);

  const before = (await logRows(db)).length;
  const cases = [
    ['a supplier not on the list', 999999, '4503', '2026-10-03', line({}), 'IV400', /Pick the supplier/],
    ['no PO number', supplier.id, '  ', '2026-10-03', line({}), 'IV400', /needs its number/],
    ['a date that does not exist', supplier.id, '4503', '2026-02-30', line({}), 'IV400', /real date/],
    ['a date in another form', supplier.id, '4503', '10/03/2026', line({}), 'IV400', /real date/],
    ['no lines', supplier.id, '4503', '2026-10-03', '[]', 'IV400', /at least one line/],
    ['an item not in the catalog', supplier.id, '4503', '2026-10-03', line({ item_id: 999999 }), 'IV400', /Line 1: pick the item/],
    ['a retired item', supplier.id, '4503', '2026-10-03', line({ item_id: retired.id }), 'IV422', /Line 1: HUS26 is retired/],
    ['an amount of 0', supplier.id, '4503', '2026-10-03', line({ ordered: 0 }), 'IV400', /whole number of pieces above 0/],
    ['an amount that is not whole', supplier.id, '4503', '2026-10-03', line({ ordered: 2.5 }), 'IV400', /whole number of pieces/],
    ['a pack size of 0 (S40)', supplier.id, '4503', '2026-10-03', line({ pack_size: 0 }), 'IV400', /pack size is a whole number/],
    ['an amount too large to save', supplier.id, '4503', '2026-10-03', line({ ordered: 3e9 }), 'IV400', /whole number of pieces/],
    ['a pack size too large to save', supplier.id, '4503', '2026-10-03', line({ pack_size: 3e9 }), 'IV400', /pack size is a whole number/],
    ['an item number too large to be one', supplier.id, '4503', '2026-10-03', line({ item_id: 1e20 }), 'IV400', /Line 1: pick the item/],
  ];
  for (const [label, supplierId, number, date, lines, code, message] of cases) {
    const err = await refused(enter(supplierId, number, date, lines), code, label);
    assert.match(err.message, message, label);
  }
  assert.equal((await logRows(db)).length, before, 'no refusal leaves a log row');
  assert.equal((await incoming(db))[hanger.id], 0, 'no refusal leaves a line');
});

test('one supplier\'s PO number is entered once, whatever the capitals; another supplier may use it', async () => {
  const { db, ann, supplier, hanger } = await withHanger();
  const other = await call(db, 'add_supplier', ann.id, crypto.randomUUID(), 'MiTek');
  const lines = JSON.stringify([{ item_id: hanger.id, ordered: 10 }]);
  await call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, 'A-17', '2026-10-03', lines);
  const err = await refused(call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, 'a-17', '2026-10-04', lines),
    'IV400', 'the same number again');
  assert.equal(err.message, 'PO a-17 from Simpson is already entered.');
  await call(db, 'enter_po', ann.id, crypto.randomUUID(), other.id, 'A-17', '2026-10-03', lines);
  assert.equal((await incoming(db))[hanger.id], 20);
});

test('a retry of a PO with the same key enters it once and answers the same PO (S22)', async () => {
  const { db, ann, supplier, hanger } = await withHanger();
  const key = crypto.randomUUID();
  const lines = JSON.stringify([{ item_id: hanger.id, ordered: 10 }]);
  const first = await call(db, 'enter_po', ann.id, key, supplier.id, '4504', '2026-10-03', lines);
  const again = await call(db, 'enter_po', ann.id, key, supplier.id, '4504', '2026-10-03', lines);
  assert.deepEqual(again, first);
  assert.equal((await incoming(db))[hanger.id], 10);
});

test('a lumber line orders linear feet, and its incoming is in linear feet (Q14)', async () => {
  const { db, ann, supplier } = await withHanger();
  await goLive(db, 'lumber');
  const board = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'lumber', { size: '2x4', grade: '#2', length_ft: 16 });
  const err = await refused(call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, '4505', '2026-10-03',
    JSON.stringify([{ item_id: board.id, ordered: 0 }])), 'IV400', 'no linear feet');
  assert.match(err.message, /whole number of linear feet above 0/);
  await call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, '4505', '2026-10-03',
    JSON.stringify([{ item_id: board.id, ordered: 1280, pack_size: 208 }]));
  assert.equal((await incoming(db))[board.id], 1280);
});

test('the owner switches a family live, logged with the admin they name; never twice, never EWP (story 99)', async () => {
  const db = await freshDatabase();
  const ann = await firstUser(db);
  const now = await goLive(db, 'plates');
  assert.deepEqual(now, { name: 'Plates', live: true });
  const last = (await logRows(db)).at(-1);
  assert.equal(last.action, 'switch family live');
  assert.equal(Number(last.actor_id), ann.id);
  assert.deepEqual(last.old_value, { name: 'Plates', live: false });

  await refused(goLive(db, 'plates'), 'IV422', 'already live');
  await refused(goLive(db, 'ewp'), 'IV422', 'EWP waits for step 5');
  await refused(goLive(db, 'nails'), 'IV400', 'no such family');
  await call(db, 'add_user', ann.id, crypto.randomUUID(), 'bob@example.com', 'Bob Ray', 'a stand-in hash');
  const err = await refused(as(db, null, (owner) => owner.query('SELECT inv.set_family_live($1, $2)', ['bob@example.com', 'hangers'])),
    'IV403', 'Bob is not an admin');
  assert.equal(err.message, 'No active admin has the address bob@example.com.');
  await refused(as(db, APP, (app) => app.query('SELECT inv.set_family_live($1, $2)', ['ann@example.com', 'hangers'])),
    '42501', 'the app login cannot run it');
});

// A saved line as an edit lists it, with any fields changed.
const keep = (line, fields = {}) => ({ id: line.id, item_id: line.item_id, ordered: line.ordered, pack_size: line.pack_size, ...fields });

// A hanger PO of two lines, 100 and 30, entered by Ann.
async function withPo() {
  const ctx = await withHanger();
  const po = await call(ctx.db, 'enter_po', ctx.ann.id, crypto.randomUUID(), ctx.supplier.id, '4501', '2026-10-03',
    JSON.stringify([{ item_id: ctx.hanger.id, ordered: 100 }, { item_id: ctx.hanger.id, ordered: 30 }]));
  const reason = await call(ctx.db, 'add_reason', ctx.ann.id, crypto.randomUUID(), 'Cancelled by supplier');
  return { ...ctx, po, reason };
}

test('a closed PO line leaves incoming, and re-opening it brings it back, each logged (S15, story 39)', async () => {
  const { db, ann, hanger, po, reason } = await withPo();
  const line = po.lines[1];
  const closed = await call(db, 'close_po_line', ann.id, crypto.randomUUID(), line.id, po.version, reason.id);
  assert.equal(closed.version, po.version + 1, 'closing a line moves its PO on');
  assert.deepEqual(closed.lines[1], { ...line, closed_reason: 'Cancelled by supplier' });
  assert.equal((await incoming(db))[hanger.id], 100);
  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'close PO line');
  assert.deepEqual([log.old_value, log.new_value], [po, closed]);

  await refused(call(db, 'close_po_line', ann.id, crypto.randomUUID(), line.id, closed.version, reason.id),
    'IV422', 'closed twice');
  const err = await refused(call(db, 'reopen_po_line', ann.id, crypto.randomUUID(), line.id, po.version),
    'IV409', 'a stale screen');
  assert.deepEqual(JSON.parse(err.detail), closed, 'the refusal carries the current PO');

  const reopened = await call(db, 'reopen_po_line', ann.id, crypto.randomUUID(), line.id, closed.version);
  assert.deepEqual(reopened.lines[1], line);
  assert.equal((await incoming(db))[hanger.id], 130);
  assert.equal((await logRows(db)).at(-1).action, 're-open PO line');
  await refused(call(db, 'reopen_po_line', ann.id, crypto.randomUUID(), line.id, reopened.version),
    'IV422', 're-opened twice');
});

test('closing a line needs a reason in use from the list', async () => {
  const { db, ann, po, reason } = await withPo();
  await call(db, 'retire_reason', ann.id, crypto.randomUUID(), reason.id, 1);
  const close = (reasonId) => call(db, 'close_po_line', ann.id, crypto.randomUUID(), po.lines[0].id, po.version, reasonId);
  assert.match((await refused(close(null), 'IV400', 'no reason')).message, /needs a reason/);
  assert.match((await refused(close(reason.id), 'IV400', 'a retired reason')).message, /retired/);
  await refused(call(db, 'close_po_line', ann.id, crypto.randomUUID(), 999999, 1, reason.id), 'IV400', 'no such line');
});

test('an edit fixes the PO\'s header and lines and adds a line, logged was → now, moving the version once', async () => {
  const { db, ann, supplier, hanger, po } = await withPo();
  const other = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  const [first, second] = po.lines;
  const edited = await call(db, 'edit_po', ann.id, crypto.randomUUID(), po.id, po.version, supplier.id, ' 4510 ', '2026-10-04',
    JSON.stringify([
      { id: first.id, item_id: hanger.id, ordered: 80, pack_size: 40 },
      { id: second.id, item_id: other.id, ordered: 30, pack_size: null },
      { item_id: hanger.id, ordered: 5 },
    ]));
  assert.deepEqual(edited, {
    ...po, version: po.version + 1, number: '4510', po_date: '2026-10-04',
    lines: [
      { ...first, ordered: 80, pack_size: 40 },
      { ...second, item_id: other.id },
      { id: edited.lines[2].id, item_id: hanger.id, ordered: 5, pack_size: null, closed_reason: null },
    ],
  });
  assert.deepEqual(await incoming(db), { [hanger.id]: 85, [other.id]: 30 });
  const log = (await logRows(db)).at(-1);
  assert.equal(log.action, 'edit PO');
  assert.deepEqual([log.old_value, log.new_value], [po, edited]);
});

test('an edit never removes a line, never changes a closed one, and is refused on a stale screen', async () => {
  const { db, ann, supplier, hanger, po, reason } = await withPo();
  const [first, second] = po.lines;
  const edit = (version, lines, number = '4501') => call(db, 'edit_po', ann.id, crypto.randomUUID(), po.id, version,
    supplier.id, number, '2026-10-03', JSON.stringify(lines));

  const before = (await logRows(db)).length;
  assert.match((await refused(edit(1, [keep(first)]), 'IV422', 'a line left out')).message, /LUS28 is left out.*close it/);
  assert.match((await refused(edit(1, [keep(first), keep(first), keep(second)]), 'IV400', 'a line twice')).message, /Line 2 repeats/);
  const elsewhere = await call(db, 'enter_po', ann.id, crypto.randomUUID(), supplier.id, '4502', '2026-10-03',
    JSON.stringify([{ item_id: hanger.id, ordered: 1 }]));
  assert.match((await refused(edit(1, [keep(first), keep(second), keep(elsewhere.lines[0])]), 'IV400', 'another PO\'s line')).message,
    /Line 3: that line is not on this PO/);
  assert.match((await refused(edit(1, [keep(first), keep(second)], '4502'), 'IV400', 'a number in use')).message,
    /PO 4502 from Simpson is already entered/);
  assert.equal((await logRows(db)).length, before + 1, 'only the second PO was saved');

  const closed = await call(db, 'close_po_line', ann.id, crypto.randomUUID(), second.id, 1, reason.id);
  assert.match((await refused(edit(closed.version, [keep(first), keep(second, { ordered: 99 })]), 'IV422', 'a closed line'))
    .message, /Line 2: that line is closed/);
  // A closed line is left out of an edit, and stays closed.
  const edited = await edit(closed.version, [keep(first, { ordered: 7 })]);
  assert.deepEqual(edited.lines[1], closed.lines[1]);
  const err = await refused(edit(closed.version, [keep(first)]), 'IV409', 'a stale screen');
  assert.deepEqual(JSON.parse(err.detail), edited);
});

test('a retry of an edit, a close or a re-open with the same key acts once and answers the same PO (S22)', async () => {
  const { db, ann, supplier, hanger, po, reason } = await withPo();
  const line = po.lines[1];
  const twice = async (fn, ...args) => {
    const key = crypto.randomUUID();
    const first = await call(db, fn, ann.id, key, ...args);
    assert.deepEqual(await call(db, fn, ann.id, key, ...args), first, `${fn} answers the same PO`);
    return first;
  };
  const before = (await logRows(db)).length;
  const edited = await twice('edit_po', po.id, po.version, supplier.id, '4501', '2026-10-03', JSON.stringify([
    { id: po.lines[0].id, item_id: hanger.id, ordered: 100 }, { id: line.id, item_id: hanger.id, ordered: 30 },
    { item_id: hanger.id, ordered: 5 }]));
  assert.equal(edited.lines.length, 3, 'the added line is added once');
  const closed = await twice('close_po_line', line.id, edited.version, reason.id);
  const reopened = await twice('reopen_po_line', line.id, closed.version);
  assert.equal(reopened.version, po.version + 3, 'each change moves the version once');
  assert.equal((await logRows(db)).length, before + 3, 'each change logs one row');
  assert.equal((await incoming(db))[hanger.id], 135);
});

test('an edit refuses a retired item it brings in, but keeps a line whose item was retired since', async () => {
  const { db, ann, supplier, hanger, po } = await withPo();
  const old = await call(db, 'add_item', ann.id, crypto.randomUUID(), 'hangers', { sku: 'HUS26' });
  await call(db, 'retire_item', ann.id, crypto.randomUUID(), old.id, 1);
  const lines = (extra) => JSON.stringify(po.lines.map((l) => ({ id: l.id, item_id: l.item_id, ordered: l.ordered })).concat(extra));
  const edit = (version, extra, date = '2026-10-03') =>
    call(db, 'edit_po', ann.id, crypto.randomUUID(), po.id, version, supplier.id, '4501', date, lines(extra));
  await refused(edit(1, [{ item_id: old.id, ordered: 1 }]), 'IV422', 'a retired item brought in');

  await call(db, 'retire_item', ann.id, crypto.randomUUID(), hanger.id, 1);
  const edited = await edit(1, [], '2026-10-05');
  assert.equal(edited.version, 2, 'lines whose item was retired since still save');
});

test('an edit that changes nothing is refused, so it leaves no log row and keeps the version', async () => {
  const { db, ann, supplier, po } = await withPo();
  const before = (await logRows(db)).length;
  const err = await refused(call(db, 'edit_po', ann.id, crypto.randomUUID(), po.id, po.version, supplier.id, ' 4501 ', '2026-10-03',
    JSON.stringify(po.lines.map((l) => keep(l)))),
  'IV422', 'nothing changed');
  assert.equal(err.message, 'Nothing changed, so nothing was saved.');
  assert.equal((await logRows(db)).length, before);
  const err2 = await refused(call(db, 'reopen_po_line', ann.id, crypto.randomUUID(), po.lines[0].id, po.version + 1),
    'IV409', 'the version did not move');
  assert.equal(JSON.parse(err2.detail).version, po.version);
});

test('an edit may list a closed line unchanged, so its refusals number lines as the Activity Log does', async () => {
  const { db, ann, supplier, hanger, po, reason } = await withPo();
  const [first, second] = po.lines;
  const closed = await call(db, 'close_po_line', ann.id, crypto.randomUUID(), first.id, po.version, reason.id);
  const edit = (lines) => call(db, 'edit_po', ann.id, crypto.randomUUID(), po.id, closed.version, supplier.id, '4501', '2026-10-03',
    JSON.stringify(lines));
  const err = await refused(edit([keep(first), keep(second, { ordered: 0 })]), 'IV400', 'line 2 has no amount');
  assert.match(err.message, /^Line 2: the amount ordered/);
  const edited = await edit([keep(first), keep(second, { ordered: 40 })]);
  assert.deepEqual(edited.lines, [closed.lines[0], { ...second, ordered: 40 }], 'the closed line stays closed');
  assert.equal((await incoming(db))[hanger.id], 40);
});
