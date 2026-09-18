// Vercel serverless entry point. It hands Vercel the Express app and nothing
// else. It never calls app.listen: Vercel owns the listener, and the app's own
// listener stays behind start() in src/planner/server.js for local `npm start`.
// vercel.json rewrites every path to this function, so one Express app serves
// the pages, the shared assets and the four plan routes.
const { app } = require('../src/planner/server.js');

module.exports = app;
