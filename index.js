// Vercel entry point. Vercel's Node runtime finds the app by scanning the root
// entrypoint for an express import and an express app to serve, so this file is
// that app: it imports express, mounts the real planner app (built in
// src/planner/server.js) as middleware, and exports it. A re-export that only
// forwarded the app failed to deploy — "No entrypoint found which imports
// express" — because the express import sat one file down, out of the scan.
//
// It never calls listen. Vercel owns the listener in the cloud, and the planner
// keeps its own behind start() in src/planner/server.js for local `npm start`.
const express = require('express');
const { app } = require('./src/planner/server.js');

const server = express();
server.use(app);

module.exports = server;
