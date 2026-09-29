// The whole app (#77): the Planner behind sign-in, plus Settings.
// Composed in this order, each piece applied once:
//   body limit → no-store → identity → open routes, signed-in routes, the Planner → error shaping
//
// DEFAULT-DENY. The identity middleware runs before every route; it is not
// added per route. The only addresses open to a signed-out request are in
// OPEN below. A signed-out page request is redirected to the sign-in page,
// which remembers where it came from; a signed-out API request gets a 401.
// test/sign-in.test.js walks every registered route to hold this in place.
const path = require('node:path');
const express = require('express');

const { app: planner, jsonError } = require('./planner/server.js');
const { isRefusal } = require('./db/database.js');
const { readSession, sessionCookie, clearedCookie, checkSecret } = require('./auth/session.js');
const { signIn, loadPerson, changePassword } = require('./auth/sign-in.js');
const { listUsers, saveUserChange, USER_CHANGES } = require('./settings/users.js');
const { readActivity } = require('./settings/activity.js');

const BODY_LIMIT_MB = 1;  // the Planner's own limit; see src/planner/server.js

// The exact open list: the sign-in page (its script and style are inline, so
// it needs no other address) and the sign-in route.
const OPEN = new Set(['GET /sign-in', 'POST /api/sign-in']);

// What a person with a temporary password can reach: "choose your password"
// (with the stylesheet and header script it loads, and the name in its
// header) and Sign out.
const TEMPORARY_OPEN = new Set([
  'GET /password', 'GET /planner.css', 'GET /app-header.js', 'GET /api/me',
  'POST /api/password', 'POST /api/sign-out',
]);

// The signed-in pages and script this file serves, each by an explicit route
// (never express.static; see src/planner/server.js).
const SETTINGS_FILES = {
  '/settings/users': ['users.html', 'text/html'],
  '/settings/activity': ['activity.html', 'text/html'],
  '/password': ['password.html', 'text/html'],
  '/app-header.js': ['app-header.js', 'application/javascript'],
};

// Express 4 does not catch a rejected promise: without this, an async
// handler that fails leaves the request unanswered until it times out.
const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function isApi(req) {
  return req.path.startsWith('/api/');
}

function createApp({ database, sessionSecret }) {
  checkSecret(sessionSecret);
  const app = express();
  app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, max-age=0');
    next();
  });

  // Identity and role, decided here for every request (CODING-STANDARDS.md, Seams).
  app.use(handle(async (req, res, next) => {
    if (OPEN.has(`${req.method} ${req.path}`)) return next();
    const session = readSession(req.headers.cookie, sessionSecret);
    const person = session && await loadPerson(database, session.userId);
    // Read from the database on every request, so a removal stops the person
    // on their very next click. A cookie from before the person's latest
    // password change is refused, so a new password signs them out everywhere else.
    if (!person || !person.active || person.password_changed_at !== session.passwordChangedAt) {
      return refuseSignedOut(req, res);
    }
    req.user = person;
    // Renewed on every use, so the browser's cap on a cookie's life
    // (400 days in Chrome) never signs out a person who keeps using the app.
    signInHere(res, person);
    if (person.password_temporary && !TEMPORARY_OPEN.has(`${req.method} ${req.path}`)) {
      if (req.method === 'GET' && !isApi(req)) return res.redirect(302, '/password');
      return res.status(403).json({ ok: false, error: 'Choose your own password first.' });
    }
    next();
  }));

  app.get('/sign-in', (_req, res) => res.sendFile(path.join(__dirname, 'auth', 'sign-in.html')));
  app.post('/api/sign-in', handle(async (req, res) => {
    const person = await signIn(database, req.body?.email, req.body?.password);
    if (!person) return res.status(401).json({ ok: false, error: 'The email or password is wrong.' });
    signInHere(res, person);
    res.json({ ok: true, next: pathOnThisSite(req.body.next) });
  }));

  for (const [route, [file, type]] of Object.entries(SETTINGS_FILES)) {
    app.get(route, (_req, res) => res.type(type).sendFile(path.join(__dirname, 'settings', file)));
  }

  // Settings → Your password, and "choose your password" after a temporary one.
  app.post('/api/password', handle(async (req, res) => {
    const { error, person } = await changePassword(database, req.user, req.body || {});
    if (error) return res.status(400).json({ ok: false, error });
    signInHere(res, person);
    res.json({ ok: true });
  }));

  app.post('/api/sign-out', (_req, res) => {
    res.set('Set-Cookie', clearedCookie());
    res.json({ ok: true });
  });

  // Settings → Users. Everyone sees the list; only an admin changes it. The
  // role was decided by the identity middleware above; the database function
  // checks it again.
  app.get('/api/users', handle(async (_req, res) => {
    res.json({ ok: true, users: await listUsers(database) });
  }));
  for (const route of Object.keys(USER_CHANGES)) {
    app.post(route, adminOnly, handle(async (req, res) => {
      const { error, user } = await saveUserChange(database, req.user, route, req.body || {});
      if (error) return res.status(400).json({ ok: false, error });
      res.json({ ok: true, user });
    }));
  }

  // Settings → Activity log. Everyone can read it.
  app.get('/api/activity', handle(async (req, res) => {
    const { error, ...page } = await readActivity(database, req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...page });
  }));

  // The signed-in person, for the header.
  app.get('/api/me', (req, res) => {
    const { name, admin, password_temporary: passwordTemporary } = req.user;
    res.json({ ok: true, user: { name, admin, passwordTemporary } });
  });

  app.use(planner);
  // An API address nobody registered answers JSON, like every other refusal.
  app.use('/api/', (_req, res) => res.status(404).json({ ok: false, error: 'There is no such address.' }));
  app.use(databaseError);
  app.use(jsonError);

  function signInHere(res, person) {
    res.set('Set-Cookie', sessionCookie(
      { userId: Number(person.id), passwordChangedAt: person.password_changed_at }, sessionSecret));
  }
  return app;
}

// The page the person tried to open before signing in, if it is an address
// on this site; else the Planner. "//host" and "/\\host" are other sites to a
// browser, so a path must start with one "/" followed by neither.
function pathOnThisSite(next) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ ok: false, error: 'Only an admin can do this.' });
  next();
}

function refuseSignedOut(req, res) {
  if (req.method === 'GET' && !isApi(req)) {
    return res.redirect(302, `/sign-in?next=${encodeURIComponent(req.originalUrl)}`);
  }
  res.status(401).json({ ok: false, error: 'Please sign in.' });
}

// HTTP status for each of the database functions' own refusals (migration 001).
// Their messages are written for people, so they reach the page as they are.
const REFUSAL_STATUS = { IV400: 400, IV403: 403, IV409: 409, IV410: 409, IV422: 422 };

// Connection failures: the network, the pooler, or a database shutting down.
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
function isUnreachable(err) {
  return UNREACHABLE_CODES.has(err.code) || /^(08|53|57P)/.test(err.code || '')
    || /timeout|Connection terminated/i.test(err.message || '');
}

// Error shaping for the database. Every other failure goes on to the
// Planner's jsonError, which also answers body-size and bad-JSON refusals.
// Fixed text only, never the error's own message: that can carry SQL.
function databaseError(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (isRefusal(err)) {
    const body = { ok: false, error: err.message };
    if (err.code === 'IV409') body.current = JSON.parse(err.detail);
    return res.status(REFUSAL_STATUS[err.code] || 400).json(body);
  }
  // A value the database could not take (class 22) or a constraint it
  // refused (class 23): the page sent something it never should. Nothing saved.
  if (/^2[23]/.test(err.code || '')) {
    return res.status(400).json({ ok: false, error: 'The request was refused.' });
  }
  if (err.unconfirmed) {
    console.error(`save not confirmed: ${err.code || ''} ${err.message}`);
    return res.status(503).json({ ok: false, error: 'The save was not confirmed. Check whether it happened before you try again.' });
  }
  if (isUnreachable(err)) {
    console.error(`database not answering: ${err.code || ''} ${err.message}`);
    return res.status(503).json({ ok: false, error: 'The database is not answering. Try again in a minute.' });
  }
  next(err);
}

module.exports = { createApp };
