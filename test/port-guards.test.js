// =============================================================
// port-guards.test.js — the negative constraints the port must keep.
// Run with: npm test  (node --test)
// =============================================================
// Three guards re-homed from `materials-planner`'s test/ewp-planner.test.js,
// which the port drops with the EWP tab. Each one asserts something that is
// invisible in normal use and easy to break by accident, so none of them has a
// natural home in a family test file:
//
//   1. the module graph reaches no database and no .env
//   2. every response is marked no-store
//   3. "/" serves the lumber page
//
// node --test runs each test FILE in its own process, so require.cache below
// reflects only what this file pulled in.
//
// Two further guards from that file did NOT come across, and both were dropped
// on purpose rather than forgotten. One asserted that the planner does not load
// a repository-root server.js; in `materials-planner` that file is the planner's
// own launcher, and `inventory-app` has no such file at all. The other expected
// /index.html, /optimize.html and /app.css to return 404; it named a public/
// directory that this repo does not have. A test that passes because its target
// does not exist is not a guard. See issue #41 §2.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../src/planner/server.js');

// A real lumber sheet, so the no-store probe below can assert a 200 rather than
// settling for an error response that carries the header just as well.
const LUMBER_SHEET = 'batch-0000-scrubbed.csv';

// Boot on an ephemeral port, run `fn`, always close.
async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---- 1. the negative constraint ---------------------------------------------
// The planner's defining constraint is NEGATIVE: it must run with no Postgres
// and no .env. That is easy to break by accident — one convenience `require`
// would drag in `pg` and `dotenv` and the tool would demand a database on
// startup. So the module graph is asserted here rather than left to a grep.

test('the planner reaches no database, in the graph or in the manifest', () => {
  const loaded = Object.keys(require.cache);
  const forbidden = ['node_modules/pg/', 'node_modules/pg-pool/', 'node_modules/dotenv/'];
  for (const f of forbidden) {
    const hit = loaded.find((m) => m.split(path.sep).join('/').includes(f));
    assert.equal(hit, undefined, `planner must not load ${f} (found ${hit})`);
  }

  // The denylist above names the packages that already tried to come across. It
  // cannot catch a driver nobody thought to type, and this repo is heading for
  // Supabase Postgres, so `@supabase/supabase-js` would walk straight past it.
  //
  // docs/CODING-STANDARDS.md states the general rule the denylist only
  // approximates: "A new dependency is a decision, named in the spec before it
  // is added." Assert THAT, so any new runtime dependency fails here — database
  // or not — until a spec names it and somebody updates this list on purpose.
  //
  // The two checks catch different mistakes and both are cheap. The manifest
  // check misses a package required without being declared; the graph check
  // above misses a package declared but not yet required.
  const { dependencies } = require('../package.json');
  assert.deepEqual(Object.keys(dependencies).sort(), ['express'],
    'a new runtime dependency must be named in the spec before it is added');
});

// ---- 2. caching --------------------------------------------------------------
// The pages and the API ship together and are versioned together, so a browser
// must never be able to pair new HTML with a cached old API body. That failure
// mode is silent and awful: the page throws reading a field that no longer
// exists and the user gets an error blaming them for a choice they never made.
//
// Probes "/" and /api/lumber/plan — the two the port keeps. The earlier version
// probed "/" and /api/menu, and /api/menu is one of the routes the port removes.

test('every response is marked no-store so a stale API body cannot be reused', async () => {
  const sheet = fs.readFileSync(
    path.join(__dirname, 'lumber-fixtures', LUMBER_SHEET), 'utf8',
  );
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, '/ must answer 200');
    assert.match(page.headers.get('cache-control') || '', /no-store/, '/ must be no-store');

    // A real plan, not an empty POST. A 400 would also carry the header, so it
    // would pass this test without ever exercising a successful response.
    const plan = await fetch(`${base}/api/lumber/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: LUMBER_SHEET, text: sheet }] }),
    });
    assert.equal(plan.status, 200, '/api/lumber/plan must answer 200 for a real sheet');
    assert.match(plan.headers.get('cache-control') || '', /no-store/,
      '/api/lumber/plan must be no-store');
  });
});

// ---- 3. the front door -------------------------------------------------------
// "/" served the EWP page before the port; it now serves LUMBER, decided by the
// owner 2026-09-14. "A signed-in Viewer reaches the lumber page" is a Done-when
// criterion on #41 with no other automated test, so it is asserted here.

test('GET / serves the lumber page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Lumber planner<\/title>/);
    // The page must be the real thing, not an empty shell that happens to carry
    // the right title: it posts to the lumber route.
    assert.match(html, /\/api\/lumber\/plan/);
  });
});
