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
// This test boots the LOCAL src/planner/server.js and compares its
// response, for all 50 sheets, against the recorded JSON above. It cannot
// pass until that file exists (build order step 2) — that is expected, not
// a bug in this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function loadRecorded(family, withStock) {
  const p = path.join(FIXTURES, 'recorded', `${family}-${withStock ? 'with-stock' : 'no-stock'}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('recorded-output proof: all four routes match the pre-port build, all 50 sheets, with and without stock', async (t) => {
  const { app } = require('../src/planner/server.js');
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const sheets = loadSheets();
  assert.equal(sheets.length, 50, 'the committed corpus should still hold 50 sheets');

  for (const { family, route, stockFile } of ROUTES) {
    for (const withStock of [false, true]) {
      const body = { files: sheets };
      if (withStock) body.stock = loadStock(stockFile);

      const res = await fetch(base + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const recorded = loadRecorded(family, withStock);

      assert.equal(res.status, recorded.status, `${family} ${withStock ? 'with' : 'no'}-stock: status changed`);
      assert.deepEqual(json, recorded.body, `${family} ${withStock ? 'with' : 'no'}-stock: response body changed`);
    }
  }
});
