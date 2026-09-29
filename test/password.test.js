// =============================================================
// password.test.js — hashing and checking a password (#77).
// Run with: npm test  (node --test)
// =============================================================
// Logic, tested directly: the hash, the check, and the length rules. The
// sign-in flow that uses them is tested over HTTP in sign-in.test.js.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, checkPassword, passwordProblem } = require('../src/auth/password.js');

test('a password checks true against its own hash and false against another\'s', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await checkPassword('correct horse battery', hash), true);
  assert.equal(await checkPassword('correct horse batterY', hash), false);
  const other = await hashPassword('a different password');
  assert.equal(await checkPassword('correct horse battery', other), false);
});

test('two hashes of one password differ, and neither contains the password', async () => {
  const one = await hashPassword('correct horse battery');
  const two = await hashPassword('correct horse battery');
  assert.notEqual(one, two, 'each hash has its own random salt');
  assert.ok(!one.includes('correct horse'), 'the hash must not carry the password');
});

test('a stored value that is not a hash of ours checks false, never throws', async () => {
  // The last one passes every shape check, so it reaches scrypt, which refuses
  // an N that is not a power of two.
  const salt = Buffer.alloc(16).toString('base64');
  const key = Buffer.alloc(32).toString('base64');
  for (const stored of ['', 'not a hash', 'scrypt$1$2$3$$', null, `scrypt$3$8$1$${salt}$${key}`]) {
    assert.equal(await checkPassword('correct horse battery', stored), false, `stored: ${stored}`);
  }
});

test('a password must be 12 to 200 characters; nothing else is required', () => {
  assert.equal(passwordProblem('x'.repeat(12)), null);
  assert.equal(passwordProblem('x'.repeat(200)), null);
  assert.match(passwordProblem('x'.repeat(11)), /at least 12/);
  assert.match(passwordProblem('x'.repeat(201)), /at most 200/);
  assert.match(passwordProblem(undefined), /at least 12/);
  // Characters, not bytes: 12 accented letters are 24 bytes but 12 characters.
  assert.equal(passwordProblem('é'.repeat(12)), null);
});
