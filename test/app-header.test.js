// =============================================================
// test/app-header.test.js — the date helper in the shared page header.
// Run with: node --test test/app-header.test.js
// app-header.js is browser code with no module.exports, and the rest of it
// (theme switch, sign-out, family bar) needs a DOM and is checked by hand.
// This loads it in a Node vm with stub DOM objects and calls showDay only.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A stub that answers any property, call or construction with another stub.
const stub = () => new Proxy(function () {}, {
  get: (_, key) => (key === Symbol.toPrimitive ? () => '' : stub()),
  apply: () => stub(),
  construct: () => stub(),
});

function loadAppHeader() {
  const context = vm.createContext({
    window: {},
    document: stub(),
    localStorage: stub(),
    location: stub(),
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/settings/app-header.js'), 'utf8'), context);
  return context.window.AppHeader;
}

test('showDay shows a date with no time as that same day, not the evening before', () => {
  const { showDay } = loadAppHeader();
  // Midnight UTC on these days is the evening before in Eastern Time.
  assert.equal(showDay('2026-08-17'), 'Aug 17, 2026');
  assert.equal(showDay('2026-09-07'), 'Sep 7, 2026');
  // Across a change of month and of year.
  assert.equal(showDay('2026-10-01'), 'Oct 1, 2026');
  assert.equal(showDay('2027-01-01'), 'Jan 1, 2027');
});

test('showDay shows a missing date as a dash', () => {
  const { showDay } = loadAppHeader();
  assert.equal(showDay(null), '—');
  assert.equal(showDay(undefined), '—');
  assert.equal(showDay(''), '—');
});
