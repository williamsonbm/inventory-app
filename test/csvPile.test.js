// =============================================================
// test/csvPile.test.js — Pure-core unit tests for the shared CSV pile.
// Run with: node --test test/csvPile.test.js
// The browser store (localStorage, cross-tab `storage` events, subscribe) has
// no Node harness and is verified manually; these cover the pure helpers the
// tabs and the browser store both build on.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { serialize, parseStored, mergeFiles, pickStock } = require('../src/planner/csvPile.js');

test('mergeFiles: stamps a strictly-increasing addedAt in batch order', () => {
  const files = mergeFiles([], [{ name: 'a.csv', text: '1' }, { name: 'b.csv', text: '2' }], 1000);
  assert.equal(files.length, 2);
  const a = files.find((f) => f.name === 'a.csv');
  const b = files.find((f) => f.name === 'b.csv');
  assert.ok(b.addedAt > a.addedAt, 'later file in the batch stamps newer');
  assert.ok(a.addedAt >= 1000, 'addedAt seeded from `now`');
});

test('mergeFiles: re-dropping a filename replaces it, newest wins', () => {
  const first = mergeFiles([], [{ name: 'a.csv', text: 'old' }, { name: 'b.csv', text: 'b' }], 1000);
  const bAt = first.find((f) => f.name === 'b.csv').addedAt;
  const merged = mergeFiles(first, [{ name: 'a.csv', text: 'new' }], 2000);
  const a = merged.filter((f) => f.name === 'a.csv');
  assert.equal(a.length, 1, 'one entry per name');
  assert.equal(a[0].text, 'new', 'newest content wins');
  assert.ok(a[0].addedAt > bAt, 'the replacement is now the newest file');
});

test('mergeFiles: a new file always stamps newer than everything present', () => {
  // Even when `now` is behind the existing stamps (clock skew across tabs), the
  // added file must sort last — pickStock depends on it.
  const existing = [{ name: 'a.csv', text: 'a', addedAt: 5000 }];
  const merged = mergeFiles(existing, [{ name: 'b.csv', text: 'b' }], 100);
  assert.ok(merged.find((f) => f.name === 'b.csv').addedAt > 5000);
});

test('mergeFiles: skips entries with no filename', () => {
  const files = mergeFiles([], [{ text: 'no name' }, { name: '', text: 'empty' }, { name: 'ok.csv', text: 'y' }], 1);
  assert.deepEqual(files.map((f) => f.name), ['ok.csv']);
});

test('pickStock: returns the last-added file its predicate accepts', () => {
  const isStock = (t) => t.includes('STOCK');
  const files = [
    { name: 'job.csv', text: 'jobs', addedAt: 1 },
    { name: 's1.csv', text: 'STOCK one', addedAt: 2 },
    { name: 's2.csv', text: 'STOCK two', addedAt: 3 },
  ];
  assert.equal(pickStock(files, isStock).name, 's2.csv');
});

test('pickStock: null when nothing matches', () => {
  assert.equal(pickStock([{ name: 'job.csv', text: 'jobs', addedAt: 1 }], (t) => t.includes('STOCK')), null);
});

test('serialize/parseStored: round-trips the pile', () => {
  const files = [{ name: 'a.csv', text: 'hello,world', addedAt: 10 }];
  assert.deepEqual(parseStored(serialize(files)).files, files);
});

test('parseStored: missing / corrupt / wrong-version reads as empty', () => {
  assert.deepEqual(parseStored(null).files, []);
  assert.deepEqual(parseStored('').files, []);
  assert.deepEqual(parseStored('{not json').files, []);
  assert.deepEqual(parseStored(JSON.stringify({ v: 2, files: [{ name: 'x', text: 'y' }] })).files, []);
  assert.deepEqual(parseStored(JSON.stringify({ v: 1, files: 'nope' })).files, []);
});

test('parseStored: drops malformed file entries, coerces types', () => {
  const raw = JSON.stringify({ v: 1, files: [
    { name: 'good.csv', text: 'x', addedAt: 3 },
    { text: 'no name' },
    { name: 'coerce.csv' },   // missing text/addedAt
  ] });
  const files = parseStored(raw).files;
  assert.deepEqual(files.map((f) => f.name), ['good.csv', 'coerce.csv']);
  assert.equal(files[1].text, '');
  assert.equal(files[1].addedAt, 0);
});
