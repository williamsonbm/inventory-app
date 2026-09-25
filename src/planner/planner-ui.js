/* =============================================================
   planner-ui.js — shared browser helpers for every planner tab.
   =============================================================
   Served at /planner-ui.js by src/planner/server.js and loaded by every page.
   The tabs used to each inline their own copy of file-reading, drag-and-drop
   wiring, escaping, number formatting, the warnings block and the stat bar —
   the same code four times, drifting apart. This is the one copy.

   It owns the SHELL (drop zones, stats, warnings, the Included Jobs panel),
   never a family's buy list. Each family section still writes its own render()
   for its own data; it calls PlannerUI.renderStats()/renderWarnings() for the
   blocks that are identical everywhere and PlannerUI.includedJobs() for the
   per-job panel. The Planner page calls PlannerUI.dropZones() for intake.

   Exposes a single global: window.PlannerUI.

   NOT UNIT-TESTED: dropZones and the closures inside it (rebuild, paintFiles,
   badgeFor), and includedJobs, read CsvPile or the DOM, and this repo has no
   Node DOM harness. They are checked by hand in the browser.
   test/planner-ui.test.js covers the pure helpers (looksLikePlateOrHangerStock,
   redact, jobBreakdown, renderBreakdown, and pickOnHand, which decides each
   family's on-hand file: the server takes that file as given, so a wrong pick
   would mis-plan).
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

  // Feet to a length label: 16 -> "16′", 7.4583 -> "7′ 6″" (inches rounded to
  // the nearest whole inch). Same rounding as the pull-list builder.
  function ftLabel(ft) {
    const n = Number(ft) || 0;
    const f = Math.floor(n + 1e-9);
    const inch = Math.round((n - f) * 12);
    if (inch === 0) return `${f}′`;
    if (inch === 12) return `${f + 1}′`;
    return `${f}′ ${inch}″`;
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
  // table (Included Jobs, Covered by on hand, By depth, …) — right-aligned, no
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
       mount         element to build into (required)
       jobsTitle     heading for the drop zone
       families      { family: { label, isOnHandFile(text) => bool } } — the
                     badge name and on-hand sniffer of each family
       onChange      () => void — fired after any add/remove/clear

     returns { getJobs(), getOnHand(family), isEmpty(), clear(), expand(), collapse() }.
  */
  function dropZones(config) {
    // jobs/onHand are the page's DERIVED view of the one shared CsvPile — the
    // files themselves live there, not here; pickOnHand decides which is which.
    // Both are rebuilt from the pile on every change, so a drop in another
    // browser tab flows straight through. Without the pile (csvPile.js failed
    // to load) onHand stays empty and jobs is kept by hand, so the panel still
    // plans.
    const jobs = new Map();   // name -> { name, text }
    let onHand = {};          // family -> { name, text }
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
            '<p class="sub-hint">Drop your material summaries and on-hand CSVs together, or click to choose. Each family uses what it needs.</p>' +
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

    // The families whose on-hand file this is (usually one; plate and hanger
    // files share a header, so a file with no telling SKUs can be both).
    function onHandFamilies(name) {
      return Object.keys(onHand).filter((family) => onHand[family].name === name);
    }

    function summarize() {
      const j = jobs.size;
      const labels = Object.keys(onHand).map((family) => config.families[family].label);
      if (!j && !labels.length) { count.textContent = 'Drop CSVs, or click to add'; return; }
      const parts = [];
      parts.push(j + (j === 1 ? ' job file' : ' job files'));
      if (labels.length) parts.push('on hand: ' + labels.join(', '));
      count.textContent = parts.join('  ·  ');
    }

    // Badge one pile file: a family's on-hand file, an on-hand file no family
    // claims (badged "unused on-hand"), or a job fed to every family's plan.
    function badgeFor(f) {
      const families = onHandFamilies(f.name);
      if (families.length) return { label: families.map((family) => config.families[family].label).join(', ') + ' on hand', cls: 'b-stock' };
      if (looksLikeAnyStock(f.text)) return { label: 'unused on-hand', cls: 'b-other' };
      return { label: 'job', cls: 'b-job' };
    }

    // The single list shows the WHOLE shared pile, each file badged. Nothing
    // unused silently vanishes — it shows as "unused on-hand" instead.
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

    function rebuild() {
      jobs.clear();
      onHand = {};
      if (typeof CsvPile === 'undefined') return;
      const picked = pickOnHand(CsvPile.list(), config.families);
      for (const f of picked.jobs) jobs.set(f.name, { name: f.name, text: f.text });
      for (const [family, f] of Object.entries(picked.onHand)) onHand[family] = { name: f.name, text: f.text };
    }

    function changed() {
      paintFiles();
      summarize();
      if (typeof config.onChange === 'function') config.onChange();
    }

    // Read a list of File objects into the shared pile. A zone drop used to
    // pass a 'jobs'/'stock' hint that routed storage; every file now lands in
    // the one pile and each family's on-hand file is found by sniffing, so no
    // hint is needed here. Writing to CsvPile fires the subscription below,
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
      else { jobs.clear(); changed(); }
    });

    // Remove buttons (event-delegated on the panel). Removal is from the shared
    // pile by filename; the subscription rebuilds/repaints.
    mount.addEventListener('click', (e) => {
      const rm = e.target.closest('.rm');
      if (!rm) return;
      e.stopPropagation();
      const name = rm.dataset.name;
      if (name && typeof CsvPile !== 'undefined') CsvPile.remove(name);
      else { jobs.delete(name); changed(); }
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
    // the subscription so every later pile change (this panel or another
    // browser tab) rebuilds and fires onChange.
    rebuild();
    paintFiles();
    summarize();
    if (typeof CsvPile !== 'undefined') CsvPile.subscribe(() => { rebuild(); changed(); });
    return {
      // Redact on READ, never at intake: the shared pile keeps the raw text so
      // the panel badges, the client sniffers and the server all classify the
      // real sheet, and a pile written before this change shipped is redacted
      // the first time autoRun() reads it (spec #41 §5 constraint 2/3). The file
      // name is left as-is: it is the job number, which travels by design, and
      // the recorded baseline echoes it back.
      getJobs: () => Array.from(jobs.values()).map((j) => ({ name: j.name, text: redact(j.text) })),
      getOnHand: (family) => (onHand[family] ? { name: onHand[family].name, text: redact(onHand[family].text) } : null),
      isEmpty: () => jobs.size === 0,
      // Clears the whole shared pile. The subscription rebuilds/repaints and
      // fires onChange.
      clear: () => {
        autoCollapsed = false;
        if (typeof CsvPile !== 'undefined') CsvPile.clear();
        else { jobs.clear(); changed(); }
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
  // A header with data-first-sort="desc" opens descending without class "n",
  // which also right-aligns it: the Plates buy list keeps its numbers
  // left-aligned (#74).
  function wireSort(table, attr, state, repaint) {
    table.querySelectorAll('th.sortable[data-' + attr + ']').forEach((th) => {
      th.addEventListener('click', () => {
        const col = th.dataset[attr];
        if (state.col === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else {
          state.col = col;
          state.dir = th.classList.contains('n') || th.dataset.firstSort === 'desc' ? 'desc' : 'asc';
        }
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
  //
  // This helper, wireExpandAll and resetExpandAll look up ids inside
  // `container` only, never the whole page (#74). Each family section repeats
  // group names such as 'sku', so a page-wide lookup would find the first
  // section's row or button, not this one's.
  function byIdIn(container, id) {
    return container.querySelector('#' + CSS.escape(id));
  }

  function drilldowns(container) {
    function setOpen(group, toggle, open) {
      const drill = byIdIn(container, 'drill-' + group + '-' + toggle);
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
      const drill = byIdIn(container, 'drill-' + group + '-' + toggle);
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
    const btn = byIdIn(container, buttonId);
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
  function resetExpandAll(container, buttonId) {
    const btn = byIdIn(container, buttonId);
    if (btn) btn.textContent = 'Expand all';
  }

  // Plate and hanger stock CSVs share this exact header shape (sku/item +
  // available/on_hand/qty, no span, no material name) — the one place that
  // shape check lives, so Plates' and Hangers' isOnHandFile don't each carry
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
  // Hangers sections would otherwise claim each other's on-hand file, so their
  // isOnHandFile predicates disqualify by product hint using this — the one
  // client copy of the SKU-prefix test the server's hanger sniffer also runs.
  // Returns { plate, hanger } booleans (both false when nothing recognisable).
  function stockProductHints(text) {
    const sample = String(text || '').slice(0, 4096).toUpperCase();
    return {
      hanger: /\b(ITS|IUS|HUS|HGUS|THA|LUS|LU|H2\.5A|LRU|LSSR|LSSU|TC24|TC26|STC24|STC26|VPA2|MIU|BA)\b/.test(sample),
      plate: /\b(MT20|MT18|M20|M18|MP20|MP14|G20)\b/.test(sample),
    };
  }

  // Cell-level: does this CSV carry the bare item/span/qty stock shape (the
  // EWP stock export LVL reads, e.g. item,span,qty… or the wide on_hand
  // export)? Not a substring check — a job summary's "Product:,EWP" metadata
  // must not read as an 'item' alias. Its one caller is looksLikeAnyStock
  // below; the EWP tab's isStockFile, which shared it, left with the tab (#41).
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
  // 'product' item alias. The server re-classifies authoritatively on each
  // plan request.
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

  // Sort the pile into each family's on-hand file and the job files, two-stage:
  //   onHand = per family, the last-added file its isOnHandFile claims;
  //   jobs   = files that are NOT any kind of on-hand file (looksLikeAnyStock)
  //            and not a file picked above, so a claimed on-hand file never
  //            lands in the job list even when looksLikeAnyStock misses it. An
  //            on-hand file no family claims and looksLikeAnyStock misses does
  //            land in jobs; there is no third check.
  // The server takes a named on-hand file as given, so this choice decides
  // what each family plans against; test/planner-ui.test.js covers it.
  // files: the pile's [{ name, text, addedAt }]; families: { family: { isOnHandFile } }.
  // The last-added-wins rule is CsvPile.pickStock, the pile's own; Node (the
  // tests) has no CsvPile global, so it loads the same module.
  function pickOnHand(files, families) {
    const { pickStock } = typeof CsvPile !== 'undefined' ? CsvPile : require('./csvPile.js');
    const onHand = {};
    for (const [family, { isOnHandFile }] of Object.entries(families)) {
      const pick = pickStock(files, isOnHandFile);
      if (pick) onHand[family] = pick;
    }
    const picked = new Set(Object.values(onHand).map((f) => f.name));
    const jobs = files.filter((f) => !looksLikeAnyStock(f.text) && !picked.has(f.name));
    return { onHand, jobs };
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

  // ── Redaction: strip the sensitive values before a sheet leaves the browser ─
  // The Planner POSTs getJobs()/getOnHand() to a hosted server, so the sheet
  // now leaves the office machine. A MiTek summary carries per-line and per-job
  // costs, the customer name and addresses, the job-site address, phone numbers,
  // the sales representative, the designer, the customer ID, the customer P.O.
  // number, the company line in row 1, and a footer naming the company, its
  // address and the report creator — none of which any surviving parser reads
  // (spec #41 §5, #38).
  // Remove them here, at the single chokepoint every request body is built from.
  //
  // The mechanism is find-and-replace on the RAW text: it never parses the sheet
  // beyond finding where column 0 ends, and never rebuilds a line, so it cannot
  // re-quote a cell and silently corrupt a buy list (the round-trip hazard in
  // docs/research/browser-side-redaction-…).
  // Every byte a pass does not match reaches the server exactly as it arrived.
  // The passes port the owner's scrub-mats.py blocklist; MiTek's export format
  // is fixed, so the blocklist stays enumerated.
  //
  // Every pass rewrites within one line, so none can span a newline: the row
  // count, the column count and every `Total` section-marker are preserved,
  // which is what keeps the buy list identical (proven by
  // test/redaction-invariance.test.js). The customer-block and footer passes
  // alone read neighboring rows, to find their rows; they still rewrite only
  // cell contents, never a comma.
  const REDACT_STRUCTURAL = /^[\s,"']*$/;
  const REDACT_MARK = '-';
  // A labeled value is one cell: a quoted cell whole, commas and all, or else
  // the text up to the next comma. Stopping at the first comma of
  // `"Thompson, Richard"` would send ` Richard"`, and the stray quote makes the
  // plates parseCsv() merge every row below it into one cell.
  const CELL = '"(?:[^"]|"")*"|[^,]*';
  const labeled = (label) => new RegExp('(' + label.source + ')(?:' + CELL + ')', 'g');
  const SALES_REP = labeled(/Sales Rep:,/);
  const DESIGNER = labeled(/^Designer,/);
  const ADDRESS = labeled(/Address:,/);
  const CUSTOMER_ID = labeled(/Customer ID:,/);
  const CUSTOMER_PO = labeled(/Customer P\.O\. #:,/);
  function redactLine(line) {
    // A number is a digit run, optionally thousands-grouped and/or decimal:
    // 42, 865.13, 1,871.56, 9,701.59. It must START with a digit — a class like
    // [\d,]+ would also match a run of empty cells (their commas), eating column
    // separators off a row such as `,,,,,,,,,,42.5%` and dropping its columns.
    const strip = (mark) => line
      .replace(/\$[ \t]?\d+(?:,\d{3})*(?:\.\d+)?/g, mark)       // money
      .replace(/-?\d+(?:,\d{3})*(?:\.\d+)?%/g, mark)            // percentages
      .replace(SALES_REP, '$1' + mark)
      .replace(DESIGNER, '$1' + mark)
      .replace(ADDRESS, '$1' + mark)                            // job-site address
      .replace(CUSTOMER_ID, '$1' + mark)
      .replace(CUSTOMER_PO, '$1' + mark)
      .replace(/\(?\d{3}\)?[ \t.\-]?\d{3}[ \t.\-]?\d{4}/g, mark); // phone
    const out = strip('');
    // Constraint 1 (spec #41 §5): never empty a row completely. A fully blank
    // row TERMINATES the hangers section (parseHangerSheet.js isBlankRow→break),
    // so a cost-only subtotal row like `,,,,,,,"$1,871.56"` must not collapse to
    // all-commas. If it would, strip it again with a dash in place of each
    // removed value (#38): the row stays non-blank and the cost still goes.
    if (REDACT_STRUCTURAL.test(out) && !REDACT_STRUCTURAL.test(line)) return strip(REDACT_MARK);
    return out;
  }
  // End of a line's first cell, honoring a double-quoted cell such as
  // `"Rodriguez, Barbara"`, whose comma is not a column separator.
  function firstCellEnd(line) {
    if (line[0] !== '"') {
      const comma = line.indexOf(',');
      return comma === -1 ? line.length : comma;
    }
    for (let k = 1; k < line.length; k++) {
      if (line[k] !== '"') continue;
      if (line[k + 1] === '"') { k++; continue; }
      return k + 1;
    }
    return line.length;
  }
  // The labels that end the block, as in the owner's scrub-mats.py. A known
  // label, not any cell ending in `:`, so a customer line such as `C/O Smith:`
  // cannot end the block early and send the lines below it.
  const CUSTOMER_BLOCK_END = /^(?:Address|Job Name|Delivery Notes|Notes):$/;
  function endsCustomerBlock(line) {
    return CUSTOMER_BLOCK_END.test(line.slice(0, firstCellEnd(line)).trim());
  }
  // The SOLD TO / SHIP TO block: the customer name and the addresses, in column
  // 0 of the rows between the Delivery Date row and the next header label
  // (`Address:` on all 50 corpus sheets). The block has no label of its own —
  // MiTek spells SOLD TO down the rows one letter at a time — so no find-and-
  // replace pass can match it; its position is the only anchor (#38). Each
  // non-empty first cell becomes a dash, so no row is emptied (constraint 1).
  //
  // Deliberately fails open: with no end label within 40 rows (the corpus
  // block is 15 to 17), the layout has changed and the block is left whole.
  // Blanking on regardless would reach a section header such as LUMBER SUMMARY
  // and drop that section from the buy list without a word.
  const CUSTOMER_BLOCK_MAX_ROWS = 40;
  function redactCustomerBlock(lines) {
    const start = lines.findIndex((l) => l.startsWith('Delivery Date:,'));
    if (start === -1) return;
    let end = -1;
    const limit = Math.min(lines.length, start + CUSTOMER_BLOCK_MAX_ROWS + 1);
    for (let i = start + 1; i < limit; i++) {
      if (endsCustomerBlock(lines[i])) { end = i; break; }
    }
    if (end === -1) return;
    for (let i = start + 1; i < end; i++) {
      const cut = firstCellEnd(lines[i]);
      if (lines[i].slice(0, cut).trim()) lines[i] = REDACT_MARK + lines[i].slice(cut);
    }
  }
  // The two footer rows: the company, its address and phone in one quoted cell,
  // then the report creator, the print date and `Page: N of M`. Neither row has
  // a label, so the pair is found by its two markers, and every non-empty cell
  // of both rows becomes a dash: the text goes, the row and column counts stay.
  //
  // Deliberately anchored on the markers, not on "the last two rows" as in the
  // owner's scrub-mats.py: a sheet already scrubbed of its footer would lose
  // its totals and Gross Profit rows instead. Without both markers, the rows
  // are left whole.
  const FOOTER_PAGE = /Page: ?\d+ of \d+/;
  const EACH_CELL = new RegExp(CELL, 'g');
  const dashCells = (line) => line.replace(EACH_CELL, (c) => (c.trim() ? REDACT_MARK : c));
  function redactFooter(lines) {
    for (let i = 1; i < lines.length; i++) {
      if (!FOOTER_PAGE.test(lines[i]) || !lines[i - 1].includes('Phone:')) continue;
      lines[i - 1] = dashCells(lines[i - 1]);
      lines[i] = dashCells(lines[i]);
    }
  }
  // Row 1: the report title, then the company name, its P.O. box, its town and
  // `Business:` with its phone. parseHangerSheet reads the title cell, so it
  // stays; every other non-empty cell becomes a dash.
  //
  // Deliberately anchored on the `Business:` label, not on the title
  // `Material Summary`: the Invoice layout (test/plate-fixtures/10001R) has
  // another title and would send its company line. Without the label, row 1
  // is left whole.
  function redactCompanyLine(lines) {
    if (!lines[0].includes('Business:')) return;
    const cut = firstCellEnd(lines[0]);
    lines[0] = lines[0].slice(0, cut) + dashCells(lines[0].slice(cut));
  }
  function redact(text) {
    if (typeof text !== 'string' || text === '') return text;
    // Split keeping the terminators (even indices = content, odd = the newline)
    // so the exact newline style survives the rejoin.
    const parts = text.split(/(\r\n|\n|\r)/);
    const lines = parts.filter((_, i) => i % 2 === 0).map((l) => redactLine(l));
    redactCustomerBlock(lines);
    redactFooter(lines);
    redactCompanyLine(lines);
    return lines.map((l, i) => l + (parts[2 * i + 1] || '')).join('');
  }

  // ── One job's Included Jobs detail, for any family ─────────────────────────
  // The tables a job's row expands to, as data: each is { heading, columns,
  // rows, footer? }, with every cell already formatted as the screen shows it.
  // Families differ only in the entries of JOB_BREAKDOWN, never in the code
  // that reads them (spec #72, "one code path per operation"); the Planner
  // renders these with renderBreakdown, and Jobs will too (spec #72, step 4).
  // A column is { label, cls?, strong? } — cls is the cell class ('n'
  // right-aligns a number, 'mono' sets a code in monospace); strong bolds it.
  const JOB_BREAKDOWN = {
    lumber: {
      lines: (j) => j.items || [],
      tables: [
        {
          heading: (j, lines) => 'Line items — ' + lines.length + " row(s) on " + (j.jobNumber || j.name) + "'s material sheet",
          columns: [{ label: 'Material' }, { label: 'Qty', cls: 'n' }, { label: 'Length', cls: 'mono' }],
          rows: (j, lines) => lines.map((it) => [it.material, fmtInt(it.qty), it.length]),
          footer: (j) => ['Total LF', fmtNum(j.totalLf)],
        },
        // Boards this one job needs, cut on its own (no on-hand, no sharing with
        // other jobs), by size/grade and stock length. For the saw. These per-job
        // totals add up to MORE than the pooled order, since pooling shares
        // boards across jobs — hence the hover title. Total LF here is bought
        // footage (stock length × boards, offcuts included), a different number
        // from the line items' Total LF (raw sheet demand).
        {
          heading: (j) => 'Boards to cut — ' + fmtInt(j.totalPieces) + ' total',
          title: 'Cut per job, on its own — totals run higher than the pooled order above, since pooling shares boards across jobs.',
          columns: [{ label: 'Size / Grade', strong: true }, { label: 'Stock length', cls: 'mono' }, { label: 'Boards', cls: 'n', strong: true }],
          rows: (j) => lumberBoards(j).map((b) => [b.first ? b.label : '', ftLabel(b.stockLengthFt), fmtInt(b.boards)]),
          footer: (j) => ['Total LF', fmtNum(lumberBoards(j).reduce((lf, b) => lf + buyLf(b), 0))],
        },
      ],
    },
    plates: {
      lines: (j) => j.items || [],
      tables: [{
        heading: (j, lines) => 'Material list — ' + fmtInt(lines.length) + ' plate line(s) on ' + j.jobNumber + "'s sheet",
        columns: [{ label: 'SKU', cls: 'mono' }, { label: 'Qty', cls: 'n' }],
        rows: (j, lines) => lines.map((it) => [it.sku, fmtInt(it.qty)]),
      }],
    },
    hangers: {
      lines: (j) => j.lines || [],
      tables: [{
        heading: (j, lines) => 'Material list — ' + lines.length + ' hanger line(s) on ' + (j.jobNumber || j.name) + "'s sheet",
        columns: [{ label: 'Size', cls: 'mono' }, { label: 'Qty', cls: 'n' }, { label: 'Section' }],
        rows: (j, lines) => lines.map((it) => [it.sku, fmtInt(it.qty), it.section || 'Hangers']),
      }],
    },
    // Qty through fmtNum (at most two decimals), as the LVL page showed it;
    // fmtInt would keep three.
    lvl: {
      lines: (j) => j.items || [],
      tables: [{
        heading: (j, lines) => 'Line items — ' + lines.length + ' row(s) on ' + (j.jobNumber || j.name) + "'s material sheet",
        columns: [{ label: 'Label', cls: 'mono' }, { label: 'Size' }, { label: 'Qty', cls: 'n' }, { label: 'Length', cls: 'mono' }],
        rows: (j, lines) => lines.map((it) => [it.label || '—', it.size, fmtNum(it.qty), it.length]),
      }],
    },
  };

  // Purchased footage for one lumber buyByLength row: stock length × boards
  // (offcuts included). The one formula behind every "boards -> LF" total, here
  // and in the lumber section, so the pooled and per-job views cannot drift.
  function buyLf(b) { return b.stockLengthFt * b.boards; }

  // A lumber job's boards to cut, one entry per size/grade and stock length;
  // `first` marks the first stock length of each size/grade.
  function lumberBoards(j) {
    return j.byGroup.flatMap((g) => (g.buyByLength || []).map((b, i) =>
      ({ label: g.label, stockLengthFt: b.stockLengthFt, boards: b.boards, first: i === 0 })));
  }

  // A job with no lines for this family has no breakdown. Otherwise every
  // table that has rows: a lumber job with nothing to cut shows its lines alone.
  function jobBreakdown(family, job) {
    const { lines: linesOf, tables } = JOB_BREAKDOWN[family];
    const lines = linesOf(job);
    if (!lines.length) return [];
    return tables
      .map((t) => ({
        heading: t.heading(job, lines),
        title: t.title,
        columns: t.columns,
        rows: t.rows(job, lines),
        footer: t.footer && t.footer(job),
      }))
      .filter((t) => t.rows.length > 0);
  }

  // One <td> for a column: its class, and bold where the column asks.
  function cellHtml(col, text, extra) {
    const cls = col.cls ? ' class="' + col.cls + '"' : '';
    const body = col.strong ? '<strong>' + esc(text) + '</strong>' : esc(text);
    return '<td' + cls + (extra || '') + '>' + body + '</td>';
  }

  // A column's header: right-aligned for a number column, plain otherwise.
  function thHtml(col) {
    return '<th' + (col.cls === 'n' ? ' class="n"' : '') + '>' + esc(col.label) + '</th>';
  }

  // jobBreakdown's tables as HTML. Two tables sit side by side (lumber's line
  // items beside its boards to cut); one stands alone. A footer is a label and
  // its totals: the label spans the columns the totals leave free, and every
  // total is right-aligned as a number.
  function renderBreakdown(tables) {
    const html = tables.map((t) => {
      const head = t.columns.map(thHtml).join('');
      const body = t.rows.map((r) => '<tr>' + r.map((v, i) => cellHtml(t.columns[i], v)).join('') + '</tr>').join('');
      let foot = '';
      if (t.footer) {
        const span = t.columns.length - t.footer.length + 1;
        foot = '<tfoot><tr>' + t.footer.map((v, i) => i === 0
          ? cellHtml({ strong: true }, v, span > 1 ? ' colspan="' + span + '"' : '')
          : cellHtml({ cls: 'n', strong: true }, v)).join('') + '</tr></tfoot>';
      }
      return '<div><h4' + (t.title ? ' title="' + esc(t.title) + '"' : '') + '>' + esc(t.heading) + '</h4>' +
        '<table class="drill-t"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>' + foot + '</table></div>';
    });
    return html.length > 1 ? '<div class="plan-cols">' + html.join('') + '</div>' : html.join('');
  }

  // ── The Included Jobs panel, for any family ────────────────────────────────
  // One row per job, which expands to its jobBreakdown. Job # and Job Name
  // lead every family's table and sort; `columns` are the family's own summary
  // columns after them ({ label, cls?, strong?, cell: (job) => text }).
  // Returns { html, wire(out, drills) }: put html where the panel belongs, then
  // call wire once it is in the page. Sort order survives a re-plan, per family.
  const jobSorts = {};
  function includedJobs(family, jobs, columns) {
    if (!jobs.length) return { html: '', wire() {} };
    const sort = jobSorts[family] || (jobSorts[family] = { col: null, dir: 'asc' });
    const group = family + '-job';
    const buttonId = family + '-btn-toggle-jobs';
    const tableId = family + '-jobs-table';
    const lead = [
      { label: 'Job #', sort: 'num', cls: 'mono', strong: true, cell: (j) => j.jobNumber || '—' },
      { label: 'Job Name', sort: 'name', cell: (j) => j.jobName || '—' },
    ];
    const all = lead.concat(columns);

    function tableHtml(rows) {
      const head = '<tr><th></th>' + all.map((c) => c.sort
        ? '<th class="sortable" data-jobsort="' + c.sort + '">' + esc(c.label) + ' ' + sortIcon(sort.col === c.sort, sort.dir) + '</th>'
        : thHtml(c)).join('') + '</tr>';
      const body = rows.map((j, idx) => {
        const tables = jobBreakdown(family, j);
        const open = tables.length > 0;
        return '<tr' + (open ? ' data-group="' + group + '" data-toggle="' + idx + '"' : '') + '>' +
          '<td>' + (open ? '<span class="caret">▸</span>' : '') + '</td>' +
          all.map((c) => cellHtml(c, c.cell(j))).join('') + '</tr>' +
          (open ? '<tr class="jobs" id="drill-' + group + '-' + idx + '" style="display:none">' +
            '<td colspan="' + (all.length + 1) + '"><div class="drill">' + renderBreakdown(tables) + '</div></td></tr>' : '');
      }).join('');
      return '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    }

    function paint(out) {
      const table = byIdIn(out, tableId);
      if (!table) return;
      table.innerHTML = tableHtml(sortRows(jobs, sort, { num: (j) => j.jobNumber, name: (j) => j.jobName }));
      wireSort(table, 'jobsort', sort, () => paint(out));
      resetExpandAll(out, buttonId);
    }

    return {
      html: '<details class="sec"><summary>Included Jobs (' + fmtInt(jobs.length) + ' files)</summary>' +
        expandAllButtonHtml(buttonId) +
        '<div class="tw" style="margin-top:10px"><table id="' + tableId + '"></table></div></details>',
      wire(out, drills) {
        wireExpandAll(out, drills, group, buttonId);
        paint(out);
      },
    };
  }

  if (typeof window !== 'undefined') {
    window.PlannerUI = {
      esc, fmtInt, fmtNum, ftLabel, buyLf, renderStats, renderWarnings, renderRejected, sortRows, sortIcon,
      wireSort, drilldowns, wireExpandAll, resetExpandAll, expandAllButtonHtml, dropZones, debounce,
      stockProductHints, looksLikePlateOrHangerStock, includedJobs,
    };
  }

  // Node (tests): the pure helpers only — looksLikePlateOrHangerStock, redact(),
  // jobBreakdown(), renderBreakdown() and pickOnHand(), which their own tests
  // drive directly. Everything else here (dropZones, drilldowns, sorting, …)
  // touches the DOM and has no Node caller. redact(), jobBreakdown() and
  // renderBreakdown() are NOT put on window.PlannerUI: getJobs()/getOnHand()
  // and includedJobs() call them from this closure, so a browser export would
  // have no reader — and an export with no reader does not ship (issue #39).
  // Jobs (spec #72, step 4) puts jobBreakdown on it when it calls it.
  // looksLikeAnyStock and looksLikeItemSpanQtyStock are held back for the same
  // reason: dropZones calls them from this closure, and their only outside
  // reader, the EWP tab's isStockFile, left with the tab (#41).
  // stockProductHints is held back too: its readers are the Plates and Hangers
  // on-hand sniffers, which reach it on window.PlannerUI. The pickOnHand test
  // drives it through them (#74).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      looksLikePlateOrHangerStock, redact, jobBreakdown, renderBreakdown, pickOnHand,
    };
  }
})();
