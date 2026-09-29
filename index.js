// Vercel entry point. Vercel's Node runtime finds the app by scanning the root
// entrypoint for an express import and an express app to serve, so this file is
// that app: it imports express, mounts the whole app (built in src/app.js) as
// middleware, and exports it. A re-export that only forwarded the app failed
// to deploy — "No entrypoint found which imports express" — because the
// express import sat one file down, out of the scan.
//
// Three environment variables, all set in Vercel (#77):
//   DATABASE_URL      the transaction-mode pooler, port 6543, as the app's own
//                     login, with no sslmode (see src/db/database.js)
//   DATABASE_CA_CERT  Supabase's CA certificate, the text of the .crt file
//   SESSION_SECRET    at least 32 random characters; changing it signs everyone out
//
// The pool is made once, at module scope: Vercel shares one instance across
// concurrent requests, and a pool per request would multiply connections (#28).
//
// It never calls listen. Vercel owns the listener in the cloud. `npm start`
// runs the same app on this computer against a local database (src/local.js).
const express = require('express');
const { createApp } = require('./src/app.js');
const { openDatabase } = require('./src/db/database.js');

const { DATABASE_URL, DATABASE_CA_CERT } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set (the pooled connection, port 6543).');
if (!DATABASE_CA_CERT) throw new Error('DATABASE_CA_CERT is not set (Supabase\'s CA certificate, as text).');

const server = express();
server.use(createApp({
  database: openDatabase(DATABASE_URL, { ca: DATABASE_CA_CERT }),
  sessionSecret: process.env.SESSION_SECRET,
}));

module.exports = server;
