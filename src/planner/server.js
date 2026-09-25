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
// TEST-ONLY SEAM: `jsonError` is exported for test/port-guards.test.js alone.
// No route can reach its 500 branch on purpose, so a direct call is the only
// guard on the "every failure leaves as JSON" rule.
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
// 1 MB, not the inherited 5 MB: the real batch (50 sheets and an on-hand file)
// measures ~0.22 MB, and Vercel caps a body at 4.5 MB regardless
// (docs/CODING-STANDARDS.md §Platform). Guarded in test/port-guards.test.js.
// The same number feeds the 413 message below, so the two cannot drift.
const BODY_LIMIT_MB = 1;
app.use(express.json({ limit: `${BODY_LIMIT_MB}mb` }));

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
// "/" is the front door and serves the Planner: one page with a section per
// family (spec #72, step 1). It replaced the four family pages, and "/"
// served the lumber page before it (owner, 2026-09-14).
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'planner.html')));

// Per family: the old page address redirects to the Planner with that family
// selected in its filter, so bookmarks keep working, and /<family>-section.js
// serves the family's section of the Planner (its buy list and plan route).
// Deliberately 302, not 301: a browser keeps a 301 for good, so a later change
// to these addresses could never reach a browser that has seen one.
for (const family of ['lumber', 'plates', 'hangers', 'lvl']) {
  app.get(`/${family}`, (_req, res) => res.redirect(302, `/?family=${family}`));
  const section = path.join(__dirname, `${family}-section.js`);
  app.get(`/${family}-section.js`, (_req, res) => res.type('application/javascript').sendFile(section));
}

// Served as EXPLICIT ROUTES rather than a static mount, per the reasoning above.
const SHARED_ASSETS = {
  // The one shared stylesheet + UI helper the Planner links. Live next to the HTML.
  '/planner.css': [path.join(__dirname, 'planner.css'), 'text/css'],
  '/planner-ui.js': [path.join(__dirname, 'planner-ui.js'), 'application/javascript'],
  // The shared, durable CSV pile (drop once, use in every family's plan).
  '/csvPile.js': [path.join(__dirname, 'csvPile.js'), 'application/javascript'],
};
for (const [route, [file, type]] of Object.entries(SHARED_ASSETS)) {
  app.get(route, (_req, res) => res.type(type).sendFile(file));
}

// The default carried-lengths menu the editor seeds from, straight from the
// engine constant, so the page and the planner cannot disagree about it.
// gradeOrder rides along so the "Redirect to" picker's stronger-grade filter
// reads the SAME ranking resolveRedirects enforces server-side, instead of
// keeping its own copy that could drift from it.
app.get('/api/lumber/menu', (_req, res) => {
  res.json({ ok: true, menu: DEFAULT_LUMBER_MENU, gradeOrder: GRADE_STRENGTH_ORDER });
});

// ── The plan endpoint — one code path for all four families ───────────────────
// Each family has its own endpoint: they answer different questions — how many
// boxes of plates, how many hangers, how many linear feet of LVL, how many
// boards of lumber. LVL is not a cut-optimization question at all but a
// linear-footage roll-up: it reuses readStockCsv.js's generic reader and
// sniffer as-is, and does NOT use parseJobCsv (src/lvl/parseLvlSheet.js says
// why it parses the sheet itself; src/lvl/planLvl.js why qty × length already
// accounts for plies). Lumber answers linear feet AND whole boards to buy, via
// its own cut-optimizer; its on-hand schema is size,grade,length, so it has its
// own reader and sniffer (src/lumber/planLumber.js).
//
// The four families differ only in DATA — which sniffer routes a dropped stock
// file, which reader parses it, which planner runs, and the noun in the "nothing
// usable" message — never in the shape of the operation. So the operation lives
// once in planHandler, and PLAN_ROUTES keys that data by the family's route
// (docs/CODING-STANDARDS.md §Seams). The key is the full literal path, so a grep
// for "/api/plates/plan" still lands on its registration (§Readers). Lumber
// alone carries page-editable options — an edited menu and grade redirects — so
// it supplies `readOptions`; the other three pass none.
const PLAN_ROUTES = {
  '/api/plates/plan': { sniff: looksLikePlateStockCsv, parseStock: parsePlateStockCsv, plan: planPlates, noun: 'plate' },
  '/api/hangers/plan': { sniff: looksLikeHangerStockCsv, parseStock: parseHangerStockCsv, plan: planHangers, noun: 'hanger' },
  '/api/lvl/plan': { sniff: looksLikeStockCsv, parseStock: parseStockCsv, plan: planLvl, noun: 'LVL' },
  '/api/lumber/plan': {
    sniff: looksLikeLumberStockCsv, parseStock: parseLumberStockCsv, plan: planLumber, noun: 'lumber',
    readOptions: (body) => ({ menu: body.menu, redirects: body.redirects }),
  },
};

// A dropped file as the browser sends it: name and text, both strings.
function isCsvFile(f) {
  return typeof f?.name === 'string' && typeof f?.text === 'string';
}

// Shape check for every plan route, before any file is read. Valid JSON can
// still be a null entry or a numeric text; each used to throw past the
// handler's try/catch. Returns the refusal message, or null.
function planBodyError({ files, stock }) {
  if (!Array.isArray(files) || files.length === 0) return 'No CSV files were provided.';
  if (!files.every(isCsvFile)) return 'Each file must carry a name and its text.';
  if (stock != null && !isCsvFile(stock)) return 'The on-hand file must carry a name and its text.';
  return null;
}

function planHandler({ sniff, parseStock, plan, noun, readOptions }) {
  return (req, res) => {
    const bodyError = planBodyError(req.body);
    if (bodyError) return res.status(400).json({ ok: false, error: bodyError });
    const { files, stock } = req.body;

    // Sniff the dropped files rather than trusting which zone they landed in — a
    // misfiled CSV is a two-second mistake that would otherwise cost a confusing
    // error. A file that reads as stock, when none was named outright, is
    // rerouted to the stock slot and reported back in `rerouted`. A second such
    // file is ignored and named in `warnings`.
    const jobFiles = [];
    let stockFile = stock && stock.text.trim() ? stock : null;
    const rerouted = [];
    const ignored = [];
    for (const f of files) {
      if (sniff(f.text)) {
        if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
        // Same name in both slots is one file, not two.
        else if (f.name !== stockFile.name) ignored.push(`"${f.name}" ignored: "${stockFile.name}" is already the on-hand file.`);
      } else {
        jobFiles.push(f);
      }
    }

    // A bad stock file must not refuse the plan outright — losing the netting is
    // annoying; refusing to plan because an OPTIONAL second input was wrong is
    // worse. Surface the failure as `stockError` rather than throwing.
    let parsedStock = null;
    let stockError = null;
    if (stockFile) {
      try {
        parsedStock = parseStock(stockFile.text);
      } catch (err) {
        stockError = err.message;
      }
    }

    let result;
    try {
      result = readOptions
        ? plan(jobFiles, parsedStock, readOptions(req.body))
        : plan(jobFiles, parsedStock);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (!result.jobs.length) {
      return res.status(400).json({
        ok: false, error: `No usable ${noun} material summaries found.`, rejected: result.rejected,
      });
    }

    res.json({
      ok: true,
      ...result,
      warnings: [...result.warnings, ...ignored],
      rerouted,
      stockFileName: stockFile ? stockFile.name : null,
      stockError,
    });
  };
}

for (const [route, spec] of Object.entries(PLAN_ROUTES)) {
  app.post(route, planHandler(spec));
}

// Error shaping, applied once: every failure leaves as { ok: false, error },
// the one shape the pages can show. Fixed text only: a body-parser error
// carries the raw body, and a sheet never reaches a log or an error message.
// An unknown error is logged, stack only.
const BODY_ERROR_MESSAGES = {
  'entity.too.large': `The upload is too big. The limit is ${BODY_LIMIT_MB} MB per request.`,
  'entity.parse.failed': 'The request body is not valid JSON.',
};
function jsonError(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err.status) {
    return res.status(err.status).json({ ok: false, error: BODY_ERROR_MESSAGES[err.type] || 'The request was refused.' });
  }
  console.error(err.stack || String(err));
  res.status(500).json({ ok: false, error: 'The planner hit an unexpected error.' });
}
app.use(jsonError);

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

// `app`, plus jsonError, the test-only seam the file header names. PORT, HOST
// and start() are used by the CLI block above and by nothing else in this repo:
// their only other caller was the Electron packaging in `materials-planner`,
// which the port leaves behind. An export with no reader does not ship (#39).
module.exports = { app, jsonError };
