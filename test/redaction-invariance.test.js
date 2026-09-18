// Buy-list-invariance proof for the browser redaction (issue #41 §5, build
// order step 6). It is the test the redaction "exists for": it proves that
// stripping the sensitive values from a sheet does NOT change the buy list.
//
// Why this test is separate from recorded-output.test.js. That test posts the
// RAW fixtures to the server, so it exercises the port, not the redaction — it
// stays green even if redact() is broken or a no-op. This test posts every
// sheet AFTER running it through PlannerUI.redact(), exactly as the four pages
// do at getJobs()/getStock(), and asserts the response still matches the
// baseline captured from the raw sheets. "recorded-output green" is necessary
// but not sufficient for the redaction; this is the sufficient half.
//
// Baseline: the same recorded responses recorded-output.test.js uses, captured
// from materials-planner @ 9426d1f (see that file's header). If a plan route
// changes, both tests move together.
//
// Two corpus limits (spec #41 "The proof corpus"): the owner's Python scrub
// masked the one phone number and stripped the two footer rows before these
// sheets entered git, so this corpus cannot exercise the PHONE clause or the
// FOOTER clause of §5 — a redaction that dropped both passes would still pass
// here. Those two clauses are covered instead by the synthetic fixture in
// test/planner-ui.test.js ('redact: removes ... and phone'). Every other clause
// — money, percentages, sales rep, designer, address — is exercised here: the
// scrub left generated stand-in values for them in the corpus.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { redact } = require('../src/planner/planner-ui.js');

const FIXTURES = path.join(__dirname, 'port-fixtures');

const ROUTES = [
  { family: 'lumber', route: '/api/lumber/plan', stockFile: 'lumber-stock-20260902.csv' },
  { family: 'plates', route: '/api/plates/plan', stockFile: 'plate-stock-20260902.csv' },
  { family: 'hangers', route: '/api/hangers/plan', stockFile: 'hanger-stock-20260902.csv' },
  { family: 'lvl', route: '/api/lvl/plan', stockFile: 'ewp-stock-20260902.csv' },
];

// Read the sheets and stock exactly as the browser would send them: redacted.
function loadSheets() {
  const dir = path.join(FIXTURES, 'sheets');
  return fs.readdirSync(dir).sort().map((name) => ({
    name,
    text: redact(fs.readFileSync(path.join(dir, name), 'utf8')),
  }));
}

function loadStock(fileName) {
  const p = path.join(FIXTURES, 'stock', fileName);
  return { name: fileName, text: redact(fs.readFileSync(p, 'utf8')) };
}

function loadRecorded(family, withStock) {
  const p = path.join(FIXTURES, 'recorded', `${family}-${withStock ? 'with-stock' : 'no-stock'}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('redaction invariance: redacted sheets plan to the same buy lists, all four routes, all 50 sheets, with and without stock', async (t) => {
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

      assert.equal(res.status, recorded.status, `${family} ${withStock ? 'with' : 'no'}-stock: status changed under redaction`);
      assert.deepEqual(json, recorded.body, `${family} ${withStock ? 'with' : 'no'}-stock: redaction changed the buy list`);
    }
  }
});
