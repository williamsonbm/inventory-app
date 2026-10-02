// =============================================================
// index.test.js — the Vercel entry point's preview guard.
// Run with: npm test  (node --test)
// =============================================================
// index.js opens the database pool at module scope and throws to refuse a
// start, so each case runs it as a child process with placeholder settings,
// and the exit status is the answer. Nothing connects: pg's Pool opens no
// connection until a query, and attachDatabasePool does nothing outside
// Vercel, so an entry point that starts simply exits.
//
// The guard is wiring whose failure writes a branch's trial rows into the
// live database, so it is tested however few lines it is
// (docs/CODING-STANDARDS.md, Tests: risk overrides size).
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', 'index.js');

// The settings a deployment has, as placeholders: enough to pass the checks
// for a missing one, none of them reachable.
const SETTINGS = {
  DATABASE_URL: 'postgres://inv_app@127.0.0.1:1/inv',
  DATABASE_CA_CERT: 'a placeholder certificate',
  SESSION_SECRET: 'a test signing secret, at least 32 characters long',
};

// Runs index.js once with exactly these settings (PATH aside). An uncaught
// throw exits 1.
function start(env) {
  return spawnSync(process.execPath, [INDEX],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 15000 });
}

test('a preview deployment starts only when its database is declared a preview\'s, with the exact word yes', () => {
  for (const extra of [{}, { DATABASE_IS_PREVIEW: 'true' }]) {
    const refused = start({ ...SETTINGS, VERCEL_ENV: 'preview', ...extra });
    assert.equal(refused.status, 1, `${JSON.stringify(extra)}: the entry point throws, so the deploy fails`);
    assert.match(refused.stderr, /DATABASE_IS_PREVIEW/, 'the message names the setting to add');
  }
  const started = start({ ...SETTINGS, VERCEL_ENV: 'preview', DATABASE_IS_PREVIEW: 'yes' });
  assert.equal(started.status, 0, started.stderr);
});

test('production starts with or without the preview setting: the check never reads it there', () => {
  for (const extra of [{}, { DATABASE_IS_PREVIEW: 'yes' }]) {
    const r = start({ ...SETTINGS, VERCEL_ENV: 'production', ...extra });
    assert.equal(r.status, 0, `${JSON.stringify(extra)}: ${r.stderr}`);
  }
});
