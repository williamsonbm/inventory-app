// =============================================================
// test/app-header.test.js — the date helper, the changed-form check and the
// busy button in the shared page header.
// Run with: node --test test/app-header.test.js
// app-header.js is browser code with no module.exports, and the rest of it
// (theme switch, sign-out, family bar) needs a DOM and is checked by hand.
// This loads it in a Node vm with stub DOM objects and calls showDay,
// changed and busy only. changed and busy read plain properties, so plain
// objects stand in for a form's boxes and a button.
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

// A form's box as changed reads it: an input or button, or a pick list.
const box = (value, defaultValue = value, { tagName = 'INPUT', badInput = false } = {}) =>
  ({ tagName, value, defaultValue, validity: { badInput } });
const pick = (selectedIndex, marked = -1) =>
  ({ tagName: 'SELECT', selectedIndex, options: [0, 1, 2].map((i) => ({ defaultSelected: i === marked })) });
const form = (...elements) => ({ elements });

test('changed: a form as the page drew it has no changes', () => {
  const { changed } = loadAppHeader();
  assert.equal(changed(form(box('10'), box(''), pick(0), pick(2, 2))), false);
});

test('changed: a box with typed text, or with text taken out, has changes', () => {
  const { changed } = loadAppHeader();
  assert.equal(changed(form(box('7', '10'))), true);
  assert.equal(changed(form(box('rack 3', ''))), true);
  assert.equal(changed(form(box('', '10'))), true);
});

test('changed: a number box with text it cannot read ("-") has changes', () => {
  const { changed } = loadAppHeader();
  // The browser reports the unreadable text as blank, the same as the start.
  assert.equal(changed(form(box('', '', { badInput: true }))), true);
});

test('changed: a pick list starts on its marked option, or on its first if none is marked', () => {
  const { changed } = loadAppHeader();
  assert.equal(changed(form(pick(1))), true);
  assert.equal(changed(form(pick(0, 2))), true);
  assert.equal(changed(form(pick(2, 2))), false);
});

test('changed: a button is no box', () => {
  const { changed } = loadAppHeader();
  assert.equal(changed(form(box('Save', '', { tagName: 'BUTTON' }))), false);
});

// A button as busy reads and sets it. `save` resolves when the test says so.
const button = (textContent, busyText) => ({ disabled: false, textContent, dataset: busyText ? { busy: busyText } : {} });
const held = () => {
  let done;
  const save = () => new Promise((resolve) => { done = resolve; });
  return { save, done: () => done() };
};

test('busy: the button is off and says what runs until the save ends, then is back as it was', async () => {
  const { busy } = loadAppHeader();
  const b = button('Commit 2 jobs', 'Committing…');
  const s = held();
  const running = busy(b, s.save);
  assert.deepEqual([b.disabled, b.textContent], [true, 'Committing…']);
  s.done();
  await running;
  assert.deepEqual([b.disabled, b.textContent], [false, 'Commit 2 jobs']);
});

test('busy: a button with no busy text of its own says "Saving…"', async () => {
  const { busy } = loadAppHeader();
  const b = button('Save date');
  const s = held();
  const running = busy(b, s.save);
  assert.equal(b.textContent, 'Saving…');
  s.done();
  await running;
});

test('busy: a second click while the save runs sends nothing (#152)', async () => {
  const { busy } = loadAppHeader();
  const b = button('Commit 2 jobs', 'Committing…');
  const s = held();
  let saves = 0;
  const save = () => { saves++; return s.save(); };
  const first = busy(b, save);
  await busy(b, save);
  assert.equal(saves, 1, 'the second click started a second save');
  s.done();
  await first;
});

test('busy: a save that throws still puts the button back', async () => {
  const { busy } = loadAppHeader();
  const b = button('Save date');
  await assert.rejects(busy(b, async () => { throw new Error('no reply'); }), /no reply/);
  assert.deepEqual([b.disabled, b.textContent], [false, 'Save date']);
});
