// Hashing and checking a password (#77). The app keeps passwords itself, and
// only this scrambled form is stored: scrypt from node:crypto, a random 16-byte
// salt per password, compared with timingSafeEqual. The password is hashed in
// Node, so it never reaches the database, a log or an error message.
//
// A stored hash reads "scrypt$N$r$p$salt$key" (salt and key in base64), so the
// settings travel with each hash and can be raised later without breaking the
// hashes already stored.
//
// The settings below are a starting point: #77 asks that one check measure
// under 250 ms on Vercel before go-live. Measured in the pod on 2026-09-29:
// median 162 ms over 10 checks (146 to 184 ms). Not yet measured on Vercel.
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
// scrypt needs 128 × N × r bytes (32 MiB here); Node's default ceiling is
// exactly 32 MiB and refuses it, so the ceiling is raised to twice the need.
const MAX_MEM = 2 * 128 * N * R;

const MIN_LENGTH = 12;
const MAX_LENGTH = 200;  // caps the work one request can cause

// The refusal for a password that breaks the length rules, or null. Counted in
// characters as a person sees them, not in bytes.
function passwordProblem(password) {
  const length = typeof password === 'string' ? [...password].length : 0;
  if (length < MIN_LENGTH) return `A password needs at least ${MIN_LENGTH} characters.`;
  if (length > MAX_LENGTH) return `A password can have at most ${MAX_LENGTH} characters.`;
  return null;
}

// One accented letter can be typed as one character or as two; NFC makes both
// the same, so a password typed on another computer still matches.
function derive(password, salt, n, r, p) {
  return scrypt(password.normalize('NFC'), salt, KEY_BYTES, { N: n, r, p, maxmem: 2 * 128 * n * r });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

// True only when `stored` is one of our hashes and `password` produced it.
// Anything else, a malformed or missing hash included, is false.
async function checkPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)
      || 2 * 128 * n * r > MAX_MEM || salt.length === 0 || expected.length !== KEY_BYTES) {
    return false;
  }
  // scrypt refuses settings it cannot use (N not a power of two); that is a bad hash, not a crash.
  const key = await derive(String(password), salt, n, r, p).catch(() => null);
  return key !== null && crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, checkPassword, passwordProblem };
