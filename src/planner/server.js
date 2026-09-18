// =============================================================
// planner/server.js — the DB-FREE entry point.
// Run with: npm start   →  http://127.0.0.1:3000
// =============================================================
// A purchase planner for four material families — plates, hangers, LVL and
// lumber. Drop in one or more MiTek "Material Summary" CSVs and get back the
// buy list for the batch, netted against what the yard already holds.
//
// HARD CONSTRAINT — this file must never reach for a database. No `pg`, no
// `dotenv`. test/port-guards.test.js asserts that over the loaded module graph.
//
// The EWP cut-length search does not live here. It stays in `materials-planner`,
// where the owner still runs it locally; see issue #41 for why the exclusion
// exists only in this copy.
//
// UPLOADS — the browser reads the CSVs with FileReader and POSTs them as JSON
// text. That avoids a multipart parser (and a new npm dependency) entirely;
// material summaries are a few KB of text. express.json's limit is the DoS
// guard, mirroring the body-size reasoning in the main server.
// =============================================================

const express = require('express');
const path = require('node:path');

const { parseStockCsv, looksLikeStockCsv } = require('../ewp/readStockCsv.js');
const { planPlates } = require('../plates/planPlates.js');
const { parsePlateStockCsv, looksLikePlateStockCsv } = require('../plates/readPlateStockCsv.js');
const { planHangers } = require('../hangers/planHangers.js');
const { parseHangerStockCsv, looksLikeHangerStockCsv } = require('../hangers/readHangerStockCsv.js');
const { planLvl } = require('../lvl/planLvl.js');
const { planLumber } = require('../lumber/planLumber.js');
const { parseLumberStockCsv, looksLikeLumberStockCsv } = require('../lumber/readLumberStockCsv.js');
const { DEFAULT_LUMBER_MENU, GRADE_STRENGTH_ORDER } = require('../lumber/lumberMenu.js');

const PORT = Number(process.env.PORT || process.env.PLANNER_PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
// 1mb, not the inherited 5mb: the real batch (50 sheets and a stock file)
// measures ~0.22 MB, and Vercel caps a body at 4.5 MB regardless
// (docs/CODING-STANDARDS.md §Platform). Guarded in test/port-guards.test.js.
app.use(express.json({ limit: '1mb' }));

// Never let a browser cache this tool. /api/lumber/menu is a plain GET with no
// Cache-Control and no Last-Modified of its own, so a browser may heuristically
// reuse an older response. That already bit the planner once: a menu payload
// changed shape between restarts, the page kept the stale body, then threw
// reading a field that no longer existed and rendered an empty editor.
// test/port-guards.test.js holds this header in place.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// Deliberately NOT express.static(). Every served file is named by an explicit
// route below, so this server can never publish a file nobody chose to publish.
//
// "/" is the front door and it serves the LUMBER page — decided by the owner,
// 2026-09-14. Lumber is the tab the office opens first. /lumber stays registered
// alongside it, because the other three pages link to it by name.
//
// ONE handler serves both paths. Two handlers naming lumber.html separately
// would stay in step only by hand, so a header or a redirect added to one would
// silently miss the other.
function sendLumberPage(_req, res) {
  res.sendFile(path.join(__dirname, 'lumber.html'));
}
app.get('/', sendLumberPage);

// Served as EXPLICIT ROUTES rather than a static mount, per the reasoning above.
const SHARED_ASSETS = {
  // The one shared stylesheet + UI helper every planner tab links, so the four
  // pages stay one tool instead of four drifting copies. Live next to the HTML.
  '/planner.css': [path.join(__dirname, 'planner.css'), 'text/css'],
  '/planner-ui.js': [path.join(__dirname, 'planner-ui.js'), 'application/javascript'],
  // The shared, durable CSV pile every tab reads from (drop once, use anywhere).
  '/csvPile.js': [path.join(__dirname, 'csvPile.js'), 'application/javascript'],
};
for (const [route, [file, type]] of Object.entries(SHARED_ASSETS)) {
  app.get(route, (_req, res) => res.type(type).sendFile(file));
}

// ── PLATES ──────────────────────────────────────────────────────────────────
// One of four independent tools sharing this process. Each family gets its own
// page and its own endpoint rather than one page with a family toggle: they
// answer different questions — how many boxes of plates, how many hangers, how
// many linear feet of LVL, how many boards of lumber — and share no controls.
app.get('/plates', (_req, res) => {
  res.sendFile(path.join(__dirname, 'plates.html'));
});

app.post('/api/plates/plan', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  // Sniff the dropped files rather than trusting which zone they landed in — a
  // misfiled CSV is a two-second mistake that would otherwise cost a confusing
  // error. All four family routes below sniff the same way.
  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikePlateStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parsePlateStockCsv(String(stockFile.text || ''));
    } catch (err) {
      // A bad stock file must not refuse the plan outright — losing the netting
      // is annoying; refusing to plan because an OPTIONAL second input was wrong
      // is worse. All four family routes make the same call.
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planPlates(jobFiles, parsedStock);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable plate material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// ── HANGERS ─────────────────────────────────────────────────────────────────
app.get('/hangers', (_req, res) => {
  res.sendFile(path.join(__dirname, 'hangers.html'));
});

app.post('/api/hangers/plan', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikeHangerStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parseHangerStockCsv(String(stockFile.text || ''));
    } catch (err) {
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planHangers(jobFiles, parsedStock);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable hanger material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// ── LVL (linear feet) ───────────────────────────────────────────────────────
// Not a cut-optimization question at all — it is a linear-footage roll-up. It
// reuses readStockCsv.js's generic stock reader and sniffer as-is rather than
// duplicating them. It does NOT use parseJobCsv: src/lvl/parseLvlSheet.js says
// why it parses the sheet itself. See src/lvl/planLvl.js for why qty × length
// already accounts for plies without a separate multiplier.
app.get('/lvl', (_req, res) => {
  res.sendFile(path.join(__dirname, 'lvl.html'));
});

app.post('/api/lvl/plan', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikeStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parseStockCsv(String(stockFile.text || ''));
    } catch (err) {
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planLvl(jobFiles, parsedStock);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable LVL material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// ── LUMBER (linear feet + stock pieces) ──────────────────────────────────────
// The front door: "/" serves this page. Unlike LVL, it answers two questions at
// once — linear feet AND how many whole boards to buy, via cutMapLumber, its own
// cut-optimizer — netted against on-hand. Its stock schema is size,grade,length,
// so it uses its own reader and sniffer rather than the generic item,span one.
// See src/lumber/planLumber.js.
app.get('/lumber', sendLumberPage);

// The default carried-lengths menu the editor seeds from, straight from the
// engine constant, so the page and the planner cannot disagree about it.
// gradeOrder rides along so the "Redirect to" picker's stronger-grade filter
// reads the SAME ranking resolveRedirects enforces server-side, instead of
// keeping its own copy that could drift from it.
app.get('/api/lumber/menu', (_req, res) => {
  res.json({ ok: true, menu: DEFAULT_LUMBER_MENU, gradeOrder: GRADE_STRENGTH_ORDER });
});

app.post('/api/lumber/plan', (req, res) => {
  const { files, stock, menu, redirects } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikeLumberStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parseLumberStockCsv(String(stockFile.text || ''));
    } catch (err) {
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planLumber(jobFiles, parsedStock, { menu, redirects });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable lumber material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// Binds PORT/HOST and resolves once listening, or rejects with a plain-language
// Error (never a raw EADDRINUSE) once it is clear the bind failed. The one seam
// for "start the server", called by the CLI block below and by nothing else.
function start() {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST);
    server.once('listening', () => resolve(server));
    server.once('error', (err) => {
      reject(err.code === 'EADDRINUSE'
        ? new Error(`Port ${PORT} is already in use — another copy of the planner (or something else) is already running on it.`)
        : new Error(`The planner's server could not start: ${err.message}`));
    });
  });
}

if (require.main === module) {
  start()
    .then(() => {
      const url = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
      console.log(`Materials purchase planner  →  ${url}`);
      console.log('No database, no .env, localhost only. Ctrl-C to stop.');
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

// `app` alone. PORT, HOST and start() are used by the CLI block above and by
// nothing else in this repo: their only other caller was the Electron packaging
// in `materials-planner`, which the port leaves behind. An export with no reader
// does not ship (issue #39).
module.exports = { app };
