/* =============================================================
   planner-ui.js — shared browser helpers for every planner tab.
   =============================================================
   Served at /planner-ui.js by src/planner/server.js and loaded by every page.
   The tabs used to each inline their own copy of file-reading, drag-and-drop
   wiring, escaping, number formatting, the warnings block and the stat bar —
   the same code four times, drifting apart. This is the one copy.

   It owns the SHELL (drop zones, stats, warnings), never a tab's result table.
   Each page still writes its own render() for its own data; it just calls
   PlannerUI.dropZones() for intake and PlannerUI.renderStats()/renderWarnings()
   for the two blocks that are identical everywhere.

   Exposes a single global: window.PlannerUI.
   ============================================================= */
(function () {
  'use strict';

  // HTML-escape for text interpolated into innerHTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Integer formatter ("1,234"); "—" for null/NaN.
  function fmtInt(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString('en-US');
  }

  // Up-to-2-decimal formatter ("1,234.5"); "—" for null/NaN. For linear feet.
  function fmtNum(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // Read one File to { name, text }.
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ name: file.name, text: String(r.result || '') });
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  // The stat bar. items: [{ label, value, warn?:bool }]. Returns HTML.
  function renderStats(items) {
    return '<div class="stats">' + items.map((it) =>
      '<div class="stat"><div class="l">' + esc(it.label) + '</div>' +
      '<div class="v"' + (it.warn ? ' style="color:var(--warn)"' : '') + '>' +
      (it.html != null ? it.html : esc(it.value)) + '</div></div>'
    ).join('') + '</div>';
  }

  // The "Ingestion notices & warnings (N)" collapsible. Returns '' when empty,
  // so callers can concatenate unconditionally. `tone` picks the inner note
  // colour ('warn' default, or 'bad'). Kept tight against whatever follows it —
  // the old inline copies left a large gap above the stat cards.
  function renderWarnings(warnings, tone) {
    if (!warnings || !warnings.length) return '';
    const noteClass = tone === 'bad' ? 'note bad' : 'note';
    return '<details class="sec warnings">' +
      '<summary style="font-weight:500;font-size:13px;color:var(--muted)">' +
      'Ingestion notices &amp; warnings (' + warnings.length + ')</summary>' +
      '<div class="' + noteClass + '" style="margin-top:8px;font-size:12.5px;' +
      'max-height:220px;overflow-y:auto;line-height:1.6">' +
      warnings.map((w) => '<div>' + esc(w) + '</div>').join('') +
      '</div></details>';
  }

  // The "Skipped files (N)" collapsible — a dropped CSV that didn't parse as
  // that tab's material summary. Same shape as renderWarnings: returns '' when
  // there's nothing to show, so callers can concatenate unconditionally. A
  // buyer needs this list, or a dropped file just silently doesn't count.
  function renderRejected(rejected) {
    if (!rejected || !rejected.length) return '';
    return '<details class="sec"><summary>Skipped files (' + rejected.length + ')</summary>' +
      '<div class="tw" style="margin-top:10px"><table><thead><tr><th>File</th><th>Reason</th></tr></thead><tbody>' +
      rejected.map((r) => '<tr><td class="mono">' + esc(r.name) + '</td><td>' + esc(r.reason) + '</td></tr>').join('') +
      '</tbody></table></div></details>';
  }

  // The bare "Expand all" button row that sits above a collapsible section's
  // table (Included Jobs, Covered in Stock, By depth, …) — right-aligned, no
  // title. PlannerUI.wireExpandAll wires the click; this just returns the
  // matching markup so every call site isn't hand-copying it.
  function expandAllButtonHtml(buttonId) {
    return '<div class="row" style="justify-content:flex-end;margin-top:10px">' +
      '<button class="ghost" id="' + buttonId + '" style="padding:4px 12px;font-size:12.5px">Expand all</button></div>';
  }

  /* ── Collapsible drop-zone component ───────────────────────────────────────
     Builds the whole intake panel into `mount` and manages its state. The panel
     starts COLLAPSED so the action button is visible without scrolling; the
     whole panel accepts drops even while collapsed, and it auto-collapses again
     once at least one job file has landed.

     config:
       mount        element to build into (required)
       jobsTitle    heading for the multi-file job zone
       jobsHint     sub-hint under it
       stockTitle   heading for the single stock zone
       stockHint    sub-hint under it
       isStockFile  (text) => bool  — routes a panel-level drop to jobs vs stock
       onChange     ()   => void    — fired after any add/remove/clear

     returns { getJobs(), getStock(), isEmpty(), clear(), expand(), collapse() }.
  */
  function dropZones(config) {
    // jobs/stock are this tab's DERIVED view of the one shared CsvPile — the
    // files themselves live there, not here. jobs is every pile file this tab's
    // isStockFile does NOT claim; stock is the last-added file it does (its one
    // stock slot). Both are rebuilt from the pile on every change, so a drop on
    // another tab or the Loaded-files panel flows straight through.
    const jobs = new Map();   // name -> { name, text }
    let stock = null;         // { name, text } | null
    let autoCollapsed = false;

    const mount = config.mount;
    mount.innerHTML =
      '<section class="drop" data-open="0">' +
        '<button type="button" class="drop-toggle" aria-expanded="false">' +
          '<span class="drop-caret">▸</span>' +
          '<span class="drop-title">Files</span>' +
          '<span class="drop-count"></span>' +
        '</button>' +
        '<div class="drop-body" hidden>' +
          '<div class="zone z-all">' +
            '<h3>' + esc(config.jobsTitle || 'CSV files') + '</h3>' +
            '<p class="sub-hint">Drop your material summaries and stock CSVs together, or click to choose. Each tab uses what it needs.</p>' +
          '</div>' +
          '<div class="files files-all"></div>' +
          '<div class="row files-actions" hidden style="justify-content:flex-end;margin-top:8px">' +
            '<button type="button" class="ghost clear-all" style="padding:4px 12px;font-size:12.5px">Clear all</button>' +
          '</div>' +
        '</div>' +
        '<input type="file" class="pick-all" accept=".csv,text/csv" multiple hidden>' +
      '</section>';

    const panel = mount.querySelector('.drop');
    const toggle = mount.querySelector('.drop-toggle');
    const body = mount.querySelector('.drop-body');
    const count = mount.querySelector('.drop-count');
    const zAll = mount.querySelector('.z-all');
    const flAll = mount.querySelector('.files-all');
    const pickAll = mount.querySelector('.pick-all');
    const clearAllBtn = mount.querySelector('.clear-all');
    const filesActions = mount.querySelector('.files-actions');

    function isOpen() { return panel.dataset.open === '1'; }
    function setOpen(open) {
      panel.dataset.open = open ? '1' : '0';
      panel.classList.toggle('open', open);
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    function expand() { setOpen(true); }
    function collapse() { setOpen(false); }

    function summarize() {
      const j = jobs.size;
      if (!j && !stock) { count.textContent = 'Drop CSVs, or click to add'; return; }
      const parts = [];
      parts.push(j + (j === 1 ? ' job file' : ' job files'));
      if (stock) parts.push('stock ✓');
      count.textContent = parts.join('  ·  ');
    }

    // Badge one pile file from THIS tab's point of view: its own stock, a stock
    // file for another tab ("other stock"), or a job it will feed to the server.
    function badgeFor(f) {
      if (stock && f.name === stock.name) return { label: 'stock', cls: 'b-stock' };
      if (looksLikeAnyStock(f.text)) return { label: 'other stock', cls: 'b-other' };
      return { label: 'job', cls: 'b-job' };
    }

    // The single list shows the WHOLE shared pile (drop once, see it on every
    // tab), each file badged for this tab. Nothing a tab doesn't use silently
    // vanishes — it shows as "other stock" instead.
    function paintFiles() {
      const pile = (typeof CsvPile !== 'undefined') ? CsvPile.list() : [];
      flAll.innerHTML = '';
      for (const f of pile) {
        const b = badgeFor(f);
        const row = document.createElement('div');
        row.innerHTML = '<span class="mono">' + esc(f.name) + '</span>' +
          '<span class="file-right"><span class="file-badge ' + b.cls + '">' + b.label + '</span>' +
          '<button class="rm" data-name="' + esc(f.name) + '" title="Remove">×</button></span>';
        flAll.appendChild(row);
      }
      filesActions.hidden = pile.length === 0;
    }

    // Re-derive jobs/stock from the shared pile, two-stage (see spec):
    //   jobs  = files that are NOT any kind of stock (looksLikeAnyStock) — so a
    //           plate/hanger/lumber/EWP stock file never lands in a job list;
    //   stock = the last-added stock file THIS tab's isStockFile claims.
    // Everything else in the pile (another tab's stock) is simply unused here.
    // The server re-classifies authoritatively on plan, so a client mis-sniff
    // only mislabels the panel, never mis-plans.
    function rebuild() {
      jobs.clear();
      stock = null;
      if (typeof CsvPile === 'undefined') return;
      const files = CsvPile.list();
      const isStock = typeof config.isStockFile === 'function' ? config.isStockFile : null;
      const pick = isStock ? CsvPile.pickStock(files, isStock) : null;
      for (const f of files) {
        if (looksLikeAnyStock(f.text)) continue;
        jobs.set(f.name, { name: f.name, text: f.text });
      }
      if (pick) stock = { name: pick.name, text: pick.text };
    }

    function changed() {
      paintFiles();
      summarize();
      if (typeof config.onChange === 'function') config.onChange();
    }

    // Read a list of File objects into the shared pile. A zone drop used to
    // pass a 'jobs'/'stock' hint that routed storage; every file now lands in
    // the one pile and each tab re-derives its own stock slot by sniffing, so
    // no hint is needed here. Writing to CsvPile fires the subscription below,
    // which rebuilds and repaints; the no-pile branch keeps the panel usable
    // if csvPile.js failed to load.
    async function addFiles(fileList) {
      const parsed = [];
      const unreadable = [];
      for (const f of fileList) {
        if (!f.name.toLowerCase().endsWith('.csv')) continue;
        try {
          parsed.push(await readFile(f));
        } catch {
          // A single bad file (permissions, a drive that disconnected mid-drop)
          // must not stop the rest of the batch from loading.
          unreadable.push(f.name);
        }
      }
      if (parsed.length) {
        if (typeof CsvPile !== 'undefined') CsvPile.add(parsed);
        else { for (const p of parsed) jobs.set(p.name, p); changed(); }
        // Auto-collapse once, the first time files land, so the results and the
        // action button aren't pushed down by the open panel.
        if (!autoCollapsed) { autoCollapsed = true; collapse(); }
      }
      if (unreadable.length) {
        alert('Could not read: ' + unreadable.join(', ') + '. Try dropping the file(s) again.');
      }
    }

    // Toggle open/closed on header click.
    toggle.addEventListener('click', () => setOpen(!isOpen()));

    // Click the zone (when open) to open the file picker; ignore clicks on the ×.
    zAll.addEventListener('click', (e) => { if (!e.target.closest('.rm')) pickAll.click(); });
    pickAll.addEventListener('change', () => { addFiles(pickAll.files); pickAll.value = ''; });

    // "Clear all" empties the whole shared pile.
    clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof CsvPile !== 'undefined') CsvPile.clear();
      else { jobs.clear(); stock = null; changed(); }
    });

    // Remove buttons (event-delegated on the panel). Removal is from the shared
    // pile by filename; the subscription rebuilds/repaints.
    mount.addEventListener('click', (e) => {
      const rm = e.target.closest('.rm');
      if (!rm) return;
      e.stopPropagation();
      const name = rm.dataset.name;
      if (name && typeof CsvPile !== 'undefined') CsvPile.remove(name);
      else { jobs.delete(name); if (stock && stock.name === name) stock = null; changed(); }
    });

    // Panel-level drag/drop (works collapsed OR open) — one pile, so no per-zone
    // routing; every file is classified by content.
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('over'); });
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('over');
    });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    // Initial paint from the pile only — do NOT fire onChange here. The caller
    // assigns the returned handle (often referenced from inside onChange) only
    // after this returns, so calling onChange now would hit it in the temporal
    // dead zone. The page decides whether to auto-run on load. AFTER that, wire
    // the subscription so every later pile change (this panel, the Loaded-files
    // panel, or another browser tab) rebuilds and fires onChange.
    rebuild();
    paintFiles();
    summarize();
    if (typeof CsvPile !== 'undefined') CsvPile.subscribe(() => { rebuild(); changed(); });
    return {
      getJobs: () => Array.from(jobs.values()),
      getStock: () => stock,
      isEmpty: () => jobs.size === 0,
      // Clears the whole shared pile (the pile is global — there is no per-tab
      // slice to clear). The subscription rebuilds/repaints and fires onChange.
      clear: () => {
        autoCollapsed = false;
        if (typeof CsvPile !== 'undefined') CsvPile.clear();
        else { jobs.clear(); stock = null; changed(); }
      },
      expand,
      collapse,
    };
  }

  // ── Column sorting for the Included Jobs tables ────────────────────────────
  // `state` is { col, dir } shared by a page; `col` null means "leave as-is"
  // (files stay in drop order until a header is clicked). Comparison is
  // numeric-aware, so "34220J" < "34221J" and "Lot 2" < "Lot 10" sort the way a
  // person reads them, for both the numeric Job # and the alphabetic Job Name.
  function sortRows(rows, state, accessors) {
    if (!state || !state.col || !accessors[state.col]) return rows.slice();
    const get = accessors[state.col];
    const dir = state.dir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      // Numeric columns (linear feet, board counts) compare by value — string
      // collation mis-orders decimals that share an integer part (2.5 vs 2.45).
      // Text columns (Job #, Job Name) keep numeric-aware collation so "Lot 2" <
      // "Lot 10" and "34220J" < "34221J" read the way a person expects.
      if (typeof va === 'number' && typeof vb === 'number') return dir * (va - vb);
      return dir * String(va == null ? '' : va)
        .localeCompare(String(vb == null ? '' : vb), undefined,
          { numeric: true, sensitivity: 'base' });
    });
  }

  // The ↕ / ▲ / ▼ indicator for a sortable column header. `active` is whether
  // this column is the one currently sorted; `dir` is 'asc' | 'desc'.
  function sortIcon(active, dir) {
    if (!active) return '<span class="sort-icon inactive" title="Click to sort">↕</span>';
    return dir === 'asc'
      ? '<span class="sort-icon active" title="Sorted ascending (A→Z, low→high)">▲</span>'
      : '<span class="sort-icon active" title="Sorted descending (Z→A, high→low)">▼</span>';
  }

  // Wire click-to-sort onto a painted table's headers. Each sortable header is
  // `<th class="sortable[ n]" data-<attr>="col">`; clicking sets/flips `state`
  // ({ col, dir }) and calls `repaint`. First click opens numeric columns
  // (class "n") descending and label columns ascending — the more useful order.
  function wireSort(table, attr, state, repaint) {
    table.querySelectorAll('th.sortable[data-' + attr + ']').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset[attr];
        if (state.col === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.col = col; state.dir = th.classList.contains('n') ? 'desc' : 'asc'; }
        repaint();
      });
    });
  }

  // ── Expandable drill-down rows ─────────────────────────────────────────────
  // One delegated click listener on `container` powers every expandable row
  // under it. Any element carrying both data-group and data-toggle is a trigger
  // (typically a whole <tr>): clicking it toggles the row `#drill-<group>-
  // <toggle>` and flips the `.caret` inside the trigger. Because it is
  // delegated, rows painted in later (e.g. a re-sorted jobs table) work with no
  // re-wiring. Returns { setOpen } for programmatic expand-all / collapse-all.
  function drilldowns(container) {
    function setOpen(group, toggle, open) {
      const drill = document.getElementById('drill-' + group + '-' + toggle);
      if (!drill) return;
      drill.style.display = open ? 'table-row' : 'none';
      const trigger = container.querySelector(
        '[data-group="' + group + '"][data-toggle="' + toggle + '"]');
      const caret = trigger && trigger.querySelector('.caret');
      if (caret) caret.textContent = open ? '▾' : '▸';
    }
    container.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-group][data-toggle]');
      if (!trigger || !container.contains(trigger)) return;
      const { group, toggle } = trigger.dataset;
      const drill = document.getElementById('drill-' + group + '-' + toggle);
      setOpen(group, toggle, !(drill && drill.style.display !== 'none'));
    });
    return { setOpen };
  }

  // Wires an "Expand all / Collapse all" button (by id) to bulk-open or
  // bulk-close every row in one drilldowns() group. Every buy-list-style
  // section (buy list, covered-in-stock, included jobs, by-depth, …) gets one
  // of these; this is the one copy instead of a near-identical block per
  // section per page.
  function wireExpandAll(container, drills, group, buttonId) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const rows = [...container.querySelectorAll('[data-group="' + group + '"][data-toggle]')];
      const expanding = btn.textContent.trim() === 'Expand all';
      rows.forEach((row) => drills.setOpen(group, row.dataset.toggle, expanding));
      btn.textContent = expanding ? 'Collapse all' : 'Expand all';
    });
  }

  // A repaint always closes the drill rows it repaints (simplest correct
  // behavior — see paintBuy()/paintDepths() comments); call this after
  // repainting a table to put its Expand-all button's label back in sync.
  function resetExpandAll(buttonId) {
    const btn = document.getElementById(buttonId);
    if (btn) btn.textContent = 'Expand all';
  }

  // Plate and hanger stock CSVs share this exact header shape (sku/item +
  // available/on_hand/qty, no span, no material name) — the one place that
  // shape check lives, so Plates' and Hangers' isStockFile don't each carry
  // their own copy. stockProductHints (below) then breaks the tie between them.
  //
  // Cell-level, not substring: a job summary's "Misc Items" line ("item") next
  // to its own "QTY,TYPE,SIZE,LENGTH" column header (anywhere in the first 8
  // lines) used to satisfy a raw substring scan and get picked up as this
  // tab's stock file, bumping the real stock CSV out of the one stock slot.
  // Real stock CSVs carry sku/item and available/on_hand/qty as columns on
  // the SAME header row, so require that instead — matching how the server's
  // authoritative sniffers (looksLikeHangerStockCsv, looksLikeAnyStock here)
  // already read these files.
  function looksLikePlateOrHangerStock(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
    const skuCols = ['sku', 'sku_display', 'item', 'product', 'description', 'part'];
    const qtyCols = ['available', 'on_hand', 'onhand', 'qty', 'quantity'];
    const has = (cells, arr) => cells.some((c) => arr.includes(c));
    return lines.some((line) => {
      const cells = line.toLowerCase().split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return has(cells, skuCols) && has(cells, qtyCols) &&
             !has(cells, ['span']) && !cells.includes('material name');
    });
  }

  // Plate stock and hanger stock carry IDENTICAL headers (sku,on_hand,…); only
  // the SKU data tells them apart. With one shared pile both the Plates and
  // Hangers tabs would otherwise claim each other's stock file, so their
  // isStockFile predicates disqualify by product hint using this — the one
  // client copy of the SKU-prefix test the server's hanger sniffer also runs.
  // Returns { plate, hanger } booleans (both false when nothing recognisable).
  function stockProductHints(text) {
    const sample = String(text || '').slice(0, 4096).toUpperCase();
    return {
      hanger: /\b(ITS|IUS|HUS|HGUS|THA|LUS|LU|H2\.5A|LRU|LSSR|LSSU|TC24|TC26|STC24|STC26|VPA2|MIU|BA)\b/.test(sample),
      plate: /\b(MT20|MT18|M20|M18|MP20|MP14|G20)\b/.test(sample),
    };
  }

  // Cell-level: does this CSV carry the bare item/span/qty stock shape (EWP's
  // own product, e.g. item,span,qty… or the wide on_hand export)? Not a
  // substring check — a job summary's "Product:,EWP" metadata must not read as
  // an 'item' alias. Shared by looksLikeAnyStock's own branch below and by
  // EWP's isStockFile ("is this file my stock" — the same shape, a narrower
  // question), so the tokenizer + shape check exists in exactly one place.
  function looksLikeItemSpanQtyStock(text, maxLines) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, maxLines);
    const has = (cells, arr) => cells.some((c) => arr.includes(c));
    return lines.some((line) => {
      const cells = line.toLowerCase().split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return has(cells, ['item', 'product', 'description']) &&
             has(cells, ['span', 'length', 'stock_length', 'stocklength']) &&
             has(cells, ['available', 'qty', 'quantity', 'on_hand', 'onhand']);
    });
  }

  // Stage 1 of classification (see the spec): is this ANY stock inventory CSV
  // (plate / hanger / lumber / EWP)? A stock file must never show as a job on
  // any tab — "not THIS tab's stock" is not the same as "a material summary".
  // Detects the inventory columns a MiTek summary never carries, plus the bare
  // item,span,qty (EWP) and size,grade,length,qty (lumber) shapes. Cell-level,
  // not substring — a summary's "Product:,EWP" metadata must not read as an
  // 'product' item alias. The server re-classifies authoritatively on Calculate.
  function looksLikeAnyStock(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
    const stockCols = ['on_hand', 'onhand', 'committed', 'available', 'threshold', 'incoming'];
    const qty = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
    const has = (cells, arr) => cells.some((c) => arr.includes(c));
    if (lines.some((line) => {
      const cells = line.toLowerCase().split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      return cells.some((c) => stockCols.includes(c)) ||
             (has(cells, ['size']) && has(cells, ['grade']) && has(cells, ['length']) && has(cells, qty));
    })) return true;
    return looksLikeItemSpanQtyStock(text, 8);
  }

  // Collapse a burst of calls into one trailing call `ms` later — a multi-file
  // drop or a flurry of cross-tab pile writes becomes a single recompute.
  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  if (typeof window !== 'undefined') {
    window.PlannerUI = {
      esc, fmtInt, fmtNum, readFile, renderStats, renderWarnings, renderRejected, sortRows, sortIcon,
      wireSort, drilldowns, wireExpandAll, resetExpandAll, expandAllButtonHtml, dropZones, debounce,
      stockProductHints, looksLikePlateOrHangerStock,
    };
  }

  // Node (tests): the pure CSV-sniffing helpers only — everything else here
  // (dropZones, drilldowns, sorting, …) touches the DOM and has no Node caller.
  //
  // looksLikeAnyStock and looksLikeItemSpanQtyStock are NOT published. Both stay
  // in use inside this file; their only reader was planner.html, which the port
  // deletes. An export with no reader does not ship (issue #39).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      stockProductHints, looksLikePlateOrHangerStock,
    };
  }
})();
