// Recorded-output proof for issue #41 (port the materials planner onto
// Vercel, without its EWP tab). Sanctioned by docs/CODING-STANDARDS.md
// "Tests" section: "A recorded-output test captured from the pre-port
// build is legitimate; its header names the commit it was captured from
// and the options that make the output deterministic."
//
// Captured from materials-planner @ 9426d1f22f29249549eb528cad1f93c45ecd1056
// ("docs: correct test count to 197 in the quickstart"), 2026-09-17. The
// working tree at capture time carried uncommitted changes to
// .claude/settings.json and CLAUDE.md only — nothing under src/ or test/ —
// so the capture matches that commit's code.
//
// Deterministic because: none of the four surviving routes (lumber, plates,
// hangers, lvl) imports the EWP search engine, so their output does not
// depend on a time budget the way /api/plan's does.
//
// Two corpus limits, from spec #41 "The proof corpus": the sheets went
// through the owner's Python scrub script, so they carry Python CSV
// quoting rather than MiTek's — parseCsv.js's own comment records that its
// two splitters differ in edge cases the Python quoting does not exercise.
// The scrub also strips the two footer rows and masks the one phone
// number, so this corpus cannot prove the footer clause or the phone
// clause of spec #41 section 5. Every other clause of section 5 is
// provable against it.
//
// Divergence, 2026-09-22: plates-no-stock.json and plates-with-stock.json
// were re-recorded from this repo after planPlates gained a top-level
// `warnings` list and lost the unread per-job `warnings` field on jobs[].
// Proven at re-record time: with those two keys removed from both, the new
// and the captured bodies are deep-equal, and the nine new top-level
// warnings are the nine old per-job warnings, job-prefixed.
//
// Divergence, 2026-10-21: plates-no-stock.json and plates-with-stock.json
// were re-recorded from this repo after the plate engine took its pack
// sizes from the database instead of src/plates/packFactors.json (#81
// change item 3). The database keeps no product line, so every buy
// option's `productLine` is now null (Q184). Proven at re-record time: with
// `productLine` removed from both, the new and the previous bodies are
// deep-equal; 170 options (no stock) and 12 (with stock) carried a product
// line before. The test seeds the database with every plate in that file.
// Then the always-null `productLine` key was deleted from both files, and
// from the engine, 182 lines in all (Q199); git diff shows only those lines.
// Every other recorded file is still the pre-port capture.
//
// Added, not recorded, 2026-10-21: the app adds one top-level `flags` field
// to every plan (#81 design item 4: last counted, retired, not in the
// catalog), keyed by line, so the engine's answer is unchanged. It reads
// the catalog, which the pre-port build had none of; this test drops it
// before comparing, and test/planner-inventory.test.js tests it.
//
// This test boots the whole app (src/app.js), signs in as a test user, and
// compares the response, for all 50 sheets, against the recorded JSON above.
// Since #77 every route sits behind the identity middleware; passing through
// it unchanged proves that signing in changed no buy list. It needs a test
// database for the sign-in (TEST_DATABASE_URL; see test/support/database.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withAdmin } = require('./support/app.js');
const { as, APP } = require('./support/database.js');

const FIXTURES = path.join(__dirname, 'port-fixtures');

const ROUTES = [
  { family: 'lumber', route: '/api/lumber/plan', stockFile: 'lumber-stock-20260902.csv' },
  { family: 'plates', route: '/api/plates/plan', stockFile: 'plate-stock-20260902.csv' },
  { family: 'hangers', route: '/api/hangers/plan', stockFile: 'hanger-stock-20260902.csv' },
  { family: 'lvl', route: '/api/lvl/plan', stockFile: 'ewp-stock-20260902.csv' },
];

function loadSheets() {
  const dir = path.join(FIXTURES, 'sheets');
  return fs.readdirSync(dir).sort().map((name) => ({
    name,
    text: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}

function loadStock(fileName) {
  const p = path.join(FIXTURES, 'stock', fileName);
  return { name: fileName, text: fs.readFileSync(p, 'utf8') };
}

// Every plate's pack sizes from the file the catalog import reads, put in
// the test database through the app's own functions: the plate engine takes
// them from the database (#81 change item 3).
async function seedPlatePacks(db, ann) {
  const packs = require('../src/plates/packFactors.json');
  await as(db, APP, async (app) => {
    const fn = async (name, ...args) => (await app.query(
      `SELECT inv.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)).rows[0].r;
    const ids = new Map();
    for (const p of packs) {
      if (!ids.has(p.sku)) ids.set(p.sku, (await fn('add_item', ann, crypto.randomUUID(), 'plates', { sku: p.sku })).id);
      await fn('add_pack_size', ann, crypto.randomUUID(), ids.get(p.sku), p.unit_label, p.eaches_per_unit);
      if (p.pallet_eaches != null) await fn('add_pack_size', ann, crypto.randomUUID(), ids.get(p.sku), 'pallet', p.pallet_eaches);
    }
  });
}

function loadRecorded(family, withStock) {
  const p = path.join(FIXTURES, 'recorded', `${family}-${withStock ? 'with-stock' : 'no-stock'}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('recorded-output proof: all four routes match the pre-port build, all 50 sheets, with and without stock', async () => {
  const { base, cookie, db, ann } = await withAdmin();
  await seedPlatePacks(db, ann.id);

  const sheets = loadSheets();
  assert.equal(sheets.length, 50, 'the committed corpus should still hold 50 sheets');

  for (const { family, route, stockFile } of ROUTES) {
    for (const withStock of [false, true]) {
      const body = { files: sheets };
      if (withStock) body.stock = loadStock(stockFile);

      const res = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
      const { flags, ...json } = await res.json();
      assert.equal(typeof flags, 'object', `${family}: every plan carries flags`);
      const recorded = loadRecorded(family, withStock);

      assert.equal(res.status, recorded.status, `${family} ${withStock ? 'with' : 'no'}-stock: status changed`);
      assert.deepEqual(json, recorded.body, `${family} ${withStock ? 'with' : 'no'}-stock: response body changed`);
    }
  }
});
