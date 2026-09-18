// Vercel entry point. Vercel's Node runtime looks for a root entrypoint that
// exports the Express app, then routes every request to it — so this file
// exports the app and nothing else. It never calls app.listen: the app keeps
// its own listener behind start() in src/planner/server.js for local
// `npm start`, and Vercel owns the listener in the cloud.
module.exports = require('./src/planner/server.js').app;
