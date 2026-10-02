// Vercel entry point. Vercel's Node runtime finds the app by scanning the root
// entrypoint for an express import and an express app to serve, so this file is
// that app: it imports express, mounts the whole app (built in src/app.js) as
// middleware, and exports it. A re-export that only forwarded the app failed
// to deploy — "No entrypoint found which imports express" — because the
// express import sat one file down, out of the scan.
//
// Four environment variables, all set in Vercel (#77, #81):
//   DATABASE_URL         the transaction-mode pooler, port 6543, as the app's own
//                        login, with no sslmode (see src/db/database.js)
//   DATABASE_CA_CERT     Supabase's CA certificate, the text of the .crt file
//   SESSION_SECRET       at least 32 random characters; changing it signs everyone out
//   DATABASE_IS_PREVIEW  "yes" in the Preview environment only, once its
//                        DATABASE_URL names the Preview database (#81)
//
// The pool is made once, at module scope: Vercel shares one instance across
// concurrent requests, and a pool per request would multiply connections (#28).
//
// It never calls listen. Vercel owns the listener in the cloud. `npm start`
// runs the same app on this computer against a local database (src/local.js).
const express = require('express');
const { createApp } = require('./src/app.js');
const { openDatabase } = require('./src/db/database.js');

// Until Preview has a database of its own (#81), Preview's DATABASE_URL is the
// live one, and a branch under test would write real rows there that can never
// be deleted. Vercel sets VERCEL_ENV. Deliberately a refusal to start, not a
// logged warning: a warning lets the preview write to the live database anyway,
// and runtime logs keep a day. A branch without this check has no guard at all;
// docs/runbook.md says how Preview's variables keep such a branch out too.
if (process.env.VERCEL_ENV === 'preview' && process.env.DATABASE_IS_PREVIEW !== 'yes') {
  throw new Error('DATABASE_IS_PREVIEW is not "yes": a preview starts only once its DATABASE_URL names the Preview database (docs/runbook.md).');
}

const { DATABASE_URL, DATABASE_CA_CERT } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set (the pooled connection, port 6543).');
if (!DATABASE_CA_CERT) throw new Error('DATABASE_CA_CERT is not set (Supabase\'s CA certificate, as text).');

const server = express();
server.use(createApp({
  database: openDatabase(DATABASE_URL, { ca: DATABASE_CA_CERT }),
  sessionSecret: process.env.SESSION_SECRET,
}));

module.exports = server;
