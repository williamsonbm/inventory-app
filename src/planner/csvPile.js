/* =============================================================
   csvPile.js — the one shared, durable CSV pile for every tab.
   =============================================================
   Served at /csvPile.js by src/planner/server.js and loaded by every page.
   The five planner tabs are five separate documents; switching tabs is a full
   navigation that drops all in-memory state. This is the bridge: a single pile
   of uploaded CSVs kept in localStorage (shared across every same-origin page),
   so you drop your files once on any tab and every tab reads the same pile until
   you clear it.

   ONE writer. Both intakes (the shared PlannerUI.dropZones and EWP's bespoke
   drop panel) call CsvPile.add/remove/clear; nobody keeps a second copy of the
   files. Each tab derives its own view (which files are jobs, which one is its
   stock file) from CsvPile.list() — the pile stores no per-file "type", because
   type is intrinsic to the CSV and every tab already sniffs it server-side; a
   cached type would just be a second source of truth waiting to disagree.

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

  // A tab's one stock file: of the pile files its own predicate accepts, the
  // last-added. None accepted → null (the tab plans greenfield, today's
  // no-stock behavior).
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

  // Cross-tab: another same-origin planner page wrote the pile. Refresh the
  // cache from the new value and fire local listeners so this tab re-derives.
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
