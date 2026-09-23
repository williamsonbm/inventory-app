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
// changes, both tests move together. The footer test needs no baseline: it
// compares each route's answer for the raw and the redacted sheets directly.
//
// Two corpus limits (spec #41 "The proof corpus"): the owner's Python scrub
// masked the one phone number and stripped the two footer rows before these
// sheets entered git, so the 50 sheets cannot exercise the PHONE clause or the
// FOOTER clause of §5. The phone clause is covered by the synthetic fixture in
// test/planner-ui.test.js ('redact: removes money, percentages, …'); the footer
// clause by three plate fixtures that still carry it, in the test 'redaction
// invariance: the footer rows go, …'. Every other clause — money, percentages,
// sales rep, designer, address, customer ID, customer P.O. number, the SOLD TO
// / SHIP TO customer block — is exercised by the 50 sheets, which carry values
// for them.

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

function startServer(t) {
  const { app } = require('../src/planner/server.js');
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function loadRecorded(family, withStock) {
  const p = path.join(FIXTURES, 'recorded', `${family}-${withStock ? 'with-stock' : 'no-stock'}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('redaction invariance: redacted sheets plan to the same buy lists, all four routes, all 50 sheets, with and without stock', async (t) => {
  const base = startServer(t);

  const sheets = loadSheets();
  assert.equal(sheets.length, 50, 'the committed corpus should still hold 50 sheets');

  for (const { family, route, stockFile } of ROUTES) {
    for (const withStock of [false, true]) {
      const body = { files: sheets };
      if (withStock) body.stock = loadStock(stockFile);

      const res = await post(base, route, body);
      const recorded = loadRecorded(family, withStock);

      assert.equal(res.status, recorded.status, `${family} ${withStock ? 'with' : 'no'}-stock: status changed under redaction`);
      assert.deepEqual(res.body, recorded.body, `${family} ${withStock ? 'with' : 'no'}-stock: redaction changed the buy list`);
    }
  }
});

// The 50-sheet corpus has its footer rows stripped. These three plate fixtures
// still carry the real two-row footer, so they prove the footer pass: the
// footer text goes, and every route plans them exactly as it plans the raw file.
test('redaction invariance: the footer rows go, and the three sheets that still carry them plan the same on all four routes', async (t) => {
  const base = startServer(t);

  const dir = path.join(__dirname, 'plate-fixtures');
  const names = ['10001R-materials.csv', '10002J-materials.csv', '10004F-materials-fullexport.csv'];
  const raw = names.map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
  const redacted = raw.map(({ name, text }) => ({ name, text: redact(text) }));

  for (const { name, text } of redacted) {
    assert.ok(!/Page: ?\d/.test(text), `${name}: the page-count footer row survived`);
    assert.ok(!text.includes('Phone:'), `${name}: the company footer row survived`);
  }
  for (const { family, route } of ROUTES) {
    const before = await post(base, route, { files: raw });
    const after = await post(base, route, { files: redacted });
    // Two empty answers would also be equal: require a real plan of all three jobs.
    assert.equal(before.body.jobs?.length, 3, `${family}: the raw sheets did not plan all three jobs`);
    assert.deepEqual(after, before, `${family}: redaction changed the buy list`);
  }
});
