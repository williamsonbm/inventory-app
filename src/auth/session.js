// The session cookie (#77): the app's own signed cookie, no refresh tokens.
// It carries the person's id, the time their password last changed as the
// database reported it, and their count of sign-outs. The identity middleware
// refuses a cookie whose time or count differs from the row's, so a new
// password, a Sign out or a removal ends every session the person had.
//
// Deliberately the password's own time, not the time the cookie was issued:
// comparing an issue time taken from the app's clock with a change time taken
// from the database's clock would refuse a fresh cookie whenever the two
// clocks disagree by a millisecond. An exact match of one value needs no clock.
//
// Signed with HMAC-SHA256 over a secret held in SESSION_SECRET. Changing the
// secret signs everyone out (a runbook step, not a screen).
const crypto = require('node:crypto');

const COOKIE = 'inv_session';
// Chrome keeps a cookie at most 400 days; the middleware renews it on every
// signed-in request, so a person who comes back within that time stays signed in.
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

function mac(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// The Set-Cookie header that signs a person in on this computer.
function sessionCookie({ userId, passwordChangedAt, signOuts }, secret) {
  const payload = Buffer.from(JSON.stringify({ u: userId, p: passwordChangedAt, s: signOuts })).toString('base64url');
  return `${COOKIE}=${payload}.${mac(payload, secret)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

// The Set-Cookie header that signs this computer out.
function clearedCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// The session a request's Cookie header carries, or null if it carries none,
// or one that is unsigned, tampered with or malformed.
function readSession(cookieHeader, secret) {
  const value = (cookieHeader || '').split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const [payload, signature, extra] = (value || '').split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { u, p, s } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isSafeInteger(u) && typeof p === 'string' && Number.isSafeInteger(s)
      ? { userId: u, passwordChangedAt: p, signOuts: s } : null;
  } catch {
    return null;
  }
}

function checkSecret(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} random characters.`);
  }
}

module.exports = { sessionCookie, clearedCookie, readSession, checkSecret };
