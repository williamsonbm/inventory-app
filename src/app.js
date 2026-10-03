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

const { app: planner, BODY_LIMIT_MB, BODY_ERROR_MESSAGES } = require('./planner/server.js');
const { isRefusal } = require('./db/database.js');
const { readSession, sessionCookie, clearedCookie, checkSecret } = require('./auth/session.js');
const { signIn, loadPerson, changePassword } = require('./auth/sign-in.js');
const { listUsers, saveUserChange, USER_CHANGES } = require('./settings/users.js');
const { readActivity } = require('./settings/activity.js');
const {
  listCatalog, saveCatalogChange, CATALOG_CHANGES, listSettings, SETTINGS_LISTS, readLumberOptions, readLumberSizes,
} = require('./inventory/catalog.js');
const { GRADE_STRENGTH_ORDER } = require('./lumber/lumberMenu.js');

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
// (never express.static; see src/planner/server.js). Paths are from src/.
// The four catalog Settings pages are one file, which shows the section its
// address names.
const PAGE_FILES = {
  '/inventory': ['inventory/overview.html', 'text/html'],
  '/settings/users': ['settings/users.html', 'text/html'],
  '/settings/pack-sizes': ['settings/catalog.html', 'text/html'],
  '/settings/suppliers': ['settings/catalog.html', 'text/html'],
  '/settings/reasons': ['settings/catalog.html', 'text/html'],
  '/settings/lvl-thresholds': ['settings/catalog.html', 'text/html'],
  '/activity': ['settings/activity.html', 'text/html'],
  '/password': ['settings/password.html', 'text/html'],
  '/app-header.js': ['settings/app-header.js', 'application/javascript'],
};

// Express 4 does not catch a rejected promise: without this, an async
// handler that fails leaves the request unanswered until it times out.
const catchAsync = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// A browser opening a page gets a redirect; anything else gets JSON.
function wantsPage(req) {
  return req.method === 'GET' && !req.path.startsWith('/api/');
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
  app.use(catchAsync(async (req, res, next) => {
    if (OPEN.has(`${req.method} ${req.path}`)) return next();
    const session = readSession(req.headers.cookie, sessionSecret);
    const person = session && await loadPerson(database, session.userId);
    // Read from the database on every request, so a removal stops the person
    // on their very next click. A cookie from before the person's latest
    // password change or sign-out is refused (see src/auth/session.js).
    if (!person || !person.active || person.password_changed_at !== session.passwordChangedAt
        || person.sign_outs !== session.signOuts) {
      return refuseSignedOut(req, res);
    }
    req.user = person;
    // Renewed on every use, so the browser's cap on a cookie's life
    // (400 days in Chrome) never signs out a person who keeps using the app.
    // Known limitation (PR #79 review): a slow request that began before a
    // password change can put back the older cookie, which is then refused,
    // so the person signs in again. It lets no one in.
    signInHere(res, person);
    if (person.password_temporary && !TEMPORARY_OPEN.has(`${req.method} ${req.path}`)) {
      if (wantsPage(req)) return res.redirect(302, '/password');
      return res.status(403).json({ ok: false, error: 'Choose your own password first.' });
    }
    next();
  }));

  app.get('/sign-in', (_req, res) => res.sendFile(path.join(__dirname, 'auth', 'sign-in.html')));
  app.post('/api/sign-in', catchAsync(async (req, res) => {
    // Any database failure here is "not answering" (#77, story 13): a lost
    // answer to the attempt's save changes nothing the person can check.
    const person = await signIn(database, req.body?.email, req.body?.password).catch((err) => {
      if (err.unconfirmed) Object.assign(err, { unconfirmed: false, unreachable: true });
      throw err;
    });
    if (!person) return res.status(401).json({ ok: false, error: 'The email or password is wrong.' });
    signInHere(res, person);
    res.json({ ok: true, next: pathOnThisSite(req.body.next) });
  }));

  for (const [route, [file, type]] of Object.entries(PAGE_FILES)) {
    app.get(route, (_req, res) => res.type(type).sendFile(path.join(__dirname, file)));
  }

  // Settings → Your password, and "choose your password" after a temporary one.
  app.post('/api/password', catchAsync(async (req, res) => {
    const { error, person } = await changePassword(database, req.user, req.body || {});
    if (error) return res.status(400).json({ ok: false, error });
    signInHere(res, person);
    res.json({ ok: true });
  }));

  // The cookie is cleared first, so this computer is signed out even when the
  // save that signs out the other computers fails (PR #79 review). The page
  // tells the person when that happens.
  app.post('/api/sign-out', catchAsync(async (req, res) => {
    res.set('Set-Cookie', clearedCookie());
    await database.save('sign_out', [req.user.id]);
    res.json({ ok: true });
  }));

  // Settings → Users. Everyone sees the list; only an admin changes it. The
  // role was decided by the identity middleware above; the database function
  // checks it again.
  app.get('/api/users', catchAsync(async (_req, res) => {
    res.json({ ok: true, users: await listUsers(database) });
  }));
  for (const route of Object.keys(USER_CHANGES)) {
    app.post(route, adminOnly, catchAsync(async (req, res) => {
      const { error, user } = await saveUserChange(database, req.user, route, req.body || {});
      if (error) return res.status(400).json({ ok: false, error });
      res.json({ ok: true, user });
    }));
  }

  // Inventory → Overview and the catalog's Settings. Everyone reads them and
  // makes most changes (#81, "Admin-only actions"); renaming an item is for
  // admins (owner, 2026-10-01).
  app.get('/api/items', catchAsync(async (_req, res) => {
    res.json({ ok: true, ...await listCatalog(database) });
  }));
  for (const route of Object.keys(SETTINGS_LISTS)) {
    app.get(route, catchAsync(async (_req, res) => {
      res.json({ ok: true, ...await listSettings(database, route) });
    }));
  }
  for (const [route, { adminOnly: forAdmins }] of Object.entries(CATALOG_CHANGES)) {
    app.post(route, forAdmins ? adminOnly : (_req, _res, next) => next(), catchAsync(async (req, res) => {
      res.json({ ok: true, ...await saveCatalogChange(database, req.user, route, req.body || {}) });
    }));
  }

  // The Activity Log, its own mode (owner, 2026-10-01). Everyone can read it.
  app.get('/api/activity', catchAsync(async (req, res) => {
    const { error, ...page } = await readActivity(database, req.query);
    if (error) return res.status(400).json({ ok: false, error });
    res.json({ ok: true, ...page });
  }));

  // The signed-in person, for the header.
  app.get('/api/me', (req, res) => {
    const { name, admin, password_temporary: passwordTemporary } = req.user;
    res.json({ ok: true, user: { name, admin, passwordTemporary } });
  });

  // The Planner's lumber buying options come from the database, shared by
  // every computer (S37). The menu route answers ahead of the Planner's own,
  // which serves only the engine's default. A lumber plan always runs with
  // the shared options: whatever menu or redirects the request carries are
  // replaced here, so an old page's own copy cannot change a buy list.
  // Deliberately here and not in src/planner/server.js: the Planner module
  // reaches no database (test/port-guards.test.js).
  app.get('/api/lumber/menu', catchAsync(async (_req, res) => {
    // One after the other: readLumberOptions already holds two of the pool's
    // three connections (src/db/database.js), so a third read beside it would
    // let one page load take the whole pool.
    const options = await readLumberOptions(database);
    res.json({ ok: true, ...options, lumberSizes: await readLumberSizes(database), gradeOrder: GRADE_STRENGTH_ORDER });
  }));
  // With every length switched off the engine would plan with its own
  // default, so that plan is refused instead.
  app.post('/api/lumber/plan', catchAsync(async (req, res, next) => {
    const { menu, redirects } = await readLumberOptions(database);
    if (!Object.keys(menu).length) {
      return res.status(400).json({ ok: false, error: 'No lumber lengths are switched on. Switch on the lengths you buy in the "Stock lengths we buy" panel of the Planner.' });
    }
    Object.assign(req.body, { menu, redirects });
    next();
  }));

  app.use(planner);
  // An API address nobody registered answers JSON, like every other refusal.
  app.use('/api/', (_req, res) => res.status(404).json({ ok: false, error: 'There is no such address.' }));
  app.use(appError);

  function signInHere(res, person) {
    res.set('Set-Cookie', sessionCookie(
      { userId: Number(person.id), passwordChangedAt: person.password_changed_at, signOuts: person.sign_outs },
      sessionSecret));
  }
  return app;
}

// The page the person tried to open before signing in, if it is an address
// on this site; else the Planner. Deliberately resolved the way a browser
// resolves it, not matched by a pattern: a browser drops tabs and line breaks
// and reads "\" as "/", so "/\t/evil.example" passed a pattern and still
// went to another site.
function pathOnThisSite(next) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  const url = new URL(next, 'http://this.site');
  return url.origin === 'http://this.site' ? url.pathname + url.search + url.hash : '/';
}

function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ ok: false, error: 'Only an admin can do this.' });
  next();
}

function refuseSignedOut(req, res) {
  if (wantsPage(req)) {
    return res.redirect(302, `/sign-in?next=${encodeURIComponent(req.originalUrl)}`);
  }
  res.status(401).json({ ok: false, error: 'Please sign in.' });
}

// HTTP status for each of the database functions' own refusals (migration 001).
// Their messages are written for people, so they reach the page as they are.
const REFUSAL_STATUS = { IV400: 400, IV403: 403, IV409: 409, IV410: 409, IV422: 422 };

// Error shaping, applied once for the whole app: every failure leaves as
// { ok: false, error }. Fixed text only, except a database refusal written
// for people: an error's own message can carry SQL or a request body.
// The Planner keeps its own jsonError, for running it alone; its failures stop there.
function appError(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type in BODY_ERROR_MESSAGES) {
    return res.status(err.status).json({ ok: false, error: BODY_ERROR_MESSAGES[err.type] });
  }
  if (isRefusal(err)) {
    const body = { ok: false, error: err.message };
    // A first save that lost a race has no row to send back yet (migration 003).
    if (err.code === 'IV409' && err.detail) body.current = JSON.parse(err.detail);
    return res.status(REFUSAL_STATUS[err.code] || 400).json(body);
  }
  // A value the database could not take (class 22) or a constraint it
  // refused (class 23): the page sent something it never should. Nothing saved.
  if (/^2[23]/.test(err.code || '')) {
    return res.status(400).json({ ok: false, error: 'The request was refused.' });
  }
  // Same words as `send` in src/settings/app-header.js, for an answer that never arrives.
  if (err.unconfirmed) {
    console.error(`save not confirmed: ${err.code || ''} ${err.message}`);
    return res.status(503).json({ ok: false, error: 'The save was not confirmed. Check whether it happened before you try again.' });
  }
  if (err.unreachable) {
    console.error(`database not answering: ${err.code || ''} ${err.message}`);
    return res.status(503).json({ ok: false, error: 'The database is not answering. Try again in a minute.' });
  }
  if (err.status) return res.status(err.status).json({ ok: false, error: 'The request was refused.' });
  console.error(err.stack || String(err));
  res.status(500).json({ ok: false, error: 'The app hit an unexpected error.' });
}

module.exports = { createApp };
