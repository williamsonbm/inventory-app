/* =============================================================
   csvPile.js — the one shared, durable CSV pile.
   =============================================================
   Served at /csvPile.js by src/planner/server.js and loaded by the Planner.
   A single pile of uploaded CSVs kept in localStorage (shared across every
   same-origin page and browser tab), so dropped files survive a reload and
   stay until you clear them. It began as the bridge between four separate
   family pages; one Planner page (spec #72) still reads it on every load.

   ONE writer. The one intake, the shared PlannerUI.dropZones, calls
   CsvPile.add/remove/clear; nobody keeps a second copy of the files. The
   Planner derives its view (which files are jobs, which is each family's
   on-hand file) from CsvPile.list() — the pile stores no per-file "type",
   because type is intrinsic to the CSV and every plan route already sniffs it
   server-side; a cached type would just be a second source of truth waiting to
   disagree.

   Node (tests) gets the pure helpers via module.exports; the browser gets
   window.CsvPile. The pure core touches no localStorage, so it is unit-testable.
   ============================================================= */
(function () {
  'use strict';

  const STORE_KEY = 'csvPile.v1';

  /* ── Pure core (also exported for Node tests) ────────────────────────────── */

  function serialize(files) {
    return JSON.stringify({ v: 1, files });
  }

  // Any stored blob that isn't a v:1 pile — missing, corrupt JSON, a future
  // schema, a malformed entry — reads as an empty pile rather than throwing, so
  // a bad localStorage value can never wedge a page on load.
  function parseStored(raw) {
    if (!raw) return { v: 1, files: [] };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { v: 1, files: [] }; }
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.files)) return { v: 1, files: [] };
    const files = [];
    for (const f of parsed.files) {
      if (!f || typeof f.name !== 'string' || !f.name) continue;
      files.push({
        name: f.name,
        text: String(f.text == null ? '' : f.text),
        addedAt: Number(f.addedAt) || 0,
      });
    }
    return { v: 1, files };
  }

  // Merge incoming {name,text} into existing, newest-wins by filename. Each
  // incoming file gets a strictly-increasing addedAt so it sorts after
  // everything already in the pile AND after earlier files in the same batch —
  // that timestamp, never array position, is the tiebreaker the "last-added
  // stock file wins" rule leans on (a remove+re-add or a cross-tab write can
  // reorder the array, but never move a stamp backwards).
  function mergeFiles(existing, incoming, now) {
    const byName = new Map();
    for (const f of existing) byName.set(f.name, f);
    let seq = now;
    for (const f of existing) if (f.addedAt >= seq) seq = f.addedAt + 1;
    for (const inc of incoming) {
      if (!inc || typeof inc.name !== 'string' || !inc.name) continue;
      byName.set(inc.name, {
        name: inc.name,
        text: String(inc.text == null ? '' : inc.text),
        addedAt: seq++,
      });
    }
    return Array.from(byName.values());
  }

  // A family's one on-hand file: of the pile files its predicate accepts, the
  // last-added. None accepted → null (the family plans greenfield, with no
  // on-hand netting). Called by pickOnHand in planner-ui.js.
  function pickStock(files, isStock) {
    let best = null;
    for (const f of files) {
      if (!isStock(f.text)) continue;
      if (!best || f.addedAt > best.addedAt) best = f;
    }
    return best;
  }

  /* ── Browser store ───────────────────────────────────────────────────────── */

  const listeners = new Set();
  let mem = null;   // cached files array; also the fallback when a write throws

  function readFiles() {
    if (mem) return mem;
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { raw = null; }
    mem = parseStored(raw).files;
    return mem;
  }

  function writeFiles(files) {
    mem = files;   // set first, so a thrown setItem still leaves the page working
    try { localStorage.setItem(STORE_KEY, serialize(files)); }
    catch { /* private mode / quota exceeded: keep the in-memory copy */ }
    notify();
  }

  function notify() {
    for (const fn of listeners) {
      try { fn(); } catch { /* one bad listener must not wedge the others */ }
    }
  }

  const CsvPile = {
    // Current pile, sorted oldest→newest (a fresh copy — callers can't mutate it).
    list() { return readFiles().slice().sort((a, b) => a.addedAt - b.addedAt); },
    // Add already-read {name,text} objects (both intakes read the File first).
    add(fileObjs) { writeFiles(mergeFiles(readFiles(), fileObjs || [], Date.now())); },
    remove(name) { writeFiles(readFiles().filter((f) => f.name !== name)); },
    // Empties ONLY the pile. Never touches lumberMenu.v1 or any knob key — those
    // are other localStorage keys this module never writes.
    clear() { writeFiles([]); },
    // Fired after any add/remove/clear here, and on a cross-tab write below.
    // Returns an unsubscribe.
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    pickStock,
  };

  // Cross-tab: the Planner in another browser tab wrote the pile. Refresh the
  // cache from the new value and fire local listeners so this page re-derives.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY) return;
      mem = parseStored(e.newValue).files;
      notify();
    });
    window.CsvPile = CsvPile;
  }

  // Node (tests): the pure helpers only. CsvPile itself calls localStorage, so
  // it has no Node caller — exporting it here would be dead code with a trap
  // door (it'd throw the moment a test actually called a method on it).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { serialize, parseStored, mergeFiles, pickStock };
  }
})();
