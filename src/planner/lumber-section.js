/* =============================================================
   lumber-section.js — the Lumber section of the Planner.
   =============================================================
   Served at /lumber-section.js by src/planner/server.js and loaded by
   planner.html, which runs the plan and hands the response to render(). Moved
   from the old lumber.html (spec #72, step 1); the buy list and the editable
   purchasable lengths and grade redirects are unchanged. Those buying options
   stay stored per computer until spec #72 step 3 moves them to Settings.

   Registers window.PlannerSections.lumber.

   NOT UNIT-TESTED: render() and the options editor build DOM, and this repo
   has no Node DOM harness. Checked by hand in the browser, one pass per family
   (spec #72). The route's output is proven by test/recorded-output.test.js.
   ============================================================= */
(function () {
  'use strict';
  const { esc, fmtNum: fmt, fmtInt, ftLabel, buyLf, renderStats, renderWarnings, renderRejected } = PlannerUI;
  const el = (id) => document.getElementById(id);

  const TOL = 0.0052;
  // Candidate lengths the menu editor offers as chips for every group. A group's
  // own lengths render "on"; the rest render "off" and can be toggled in.
  const CANDIDATE_LENGTHS = [6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24];
  const STORE_KEY = 'lumberMenu.v1';

  // row.fullyRedirected, row.ownLf, and row.redirect/.redirectedIn are all
  // computed and rounded once server-side (planLumber.js) — read directly
  // here rather than re-derived, so the UI can't drift from what the server
  // actually decided, and never re-sums already-rounded LF itself.

  // The Need (LF) figure for one row: usedLf, unless fullyRedirected — then
  // it's the original amount, from row.redirect.lf, so the buyer can still
  // see what this grade would have needed.
  function needLf(row) { return row.fullyRedirected ? row.redirect.lf : row.usedLf; }

  // The Need (LF) CELL for one row: the total, plus a "(own + redirected)"
  // breakdown when some of it flowed in from another grade's redirect — so a
  // merged total's composition is visible at a glance, without expanding the
  // row to read the rollup note.
  function needCellHtml(row) {
    const need = needLf(row);
    if (!row.redirectedIn || !row.redirectedIn.length) return fmt(need);
    const parts = [row.ownLf, ...row.redirectedIn.map((r) => r.lf)].map(fmt).join(' + ');
    return `${fmt(need)} <span class="sub">(${parts})</span>`;
  }

  // ── Editable stock-length menu ─────────────────────────────────────────────
  let defaultMenu = {};   // from /api/lumber/menu
  let menu = {};          // effective (default overlaid with the user's edits)

  // Grade redirects ("send 2x6 #2's demand to 2x6 DSS instead") live in this
  // same panel, next to the lengths they depend on (a target must be carried
  // — have lengths — to be offered). Persisted (lumberRedirects.v1) and
  // reconciled against the current menu on load, so reloading the page keeps
  // them; "Reset to default" clears them.
  let activeRedirects = {};   // "size|fromGrade" -> toGrade

  // The SAME strength ranking planLumber.js enforces server-side — fetched
  // from /api/lumber/menu (see below) rather than a second hardcoded copy,
  // so the picker's options can't drift out of sync with what the server
  // will actually accept. The server still re-validates whatever's picked
  // regardless, so a request sent before this loads just gets dropped with
  // a warning rather than silently applied.
  let gradeOrder = [];   // from /api/lumber/menu
  function validRedirectTargets(size, grade) {
    const gi = gradeOrder.indexOf(grade);
    if (gi === -1) return [];
    return gradeOrder.filter((g, i) => i > gi && menu[`${size}|${g}`] && menu[`${size}|${g}`].length);
  }

  // A small localStorage-backed store: load parses (swallowing a corrupt or
  // missing value down to {}), save swallows a write failure (private-mode
  // Safari) rather than surface it. The menu and the redirects are both this
  // exact shape, one JSON blob under one key, so they share the one factory.
  function makeStore(key) {
    return {
      load: () => { try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch { return {}; } },
      save: (value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory */ } },
    };
  }
  const menuStore = makeStore(STORE_KEY);
  function loadStoredMenu() { return menuStore.load(); }
  function saveMenu() { menuStore.save(menu); }

  // Grade redirects persist alongside the menu (keyed the same way). On load
  // they're reconciled against the current menu so a stored redirect to a grade
  // you no longer carry is quietly dropped rather than applied to a plan.
  const REDIR_KEY = 'lumberRedirects.v1';
  const redirectStore = makeStore(REDIR_KEY);
  function loadStoredRedirects() { return redirectStore.load(); }
  function saveRedirects() { redirectStore.save(activeRedirects); }
  function reconcileRedirects(saved) {
    const out = {};
    for (const key of Object.keys(saved || {})) {
      const [size, from] = key.split('|');
      if (validRedirectTargets(size, from).includes(saved[key])) out[key] = saved[key];
    }
    return out;
  }

  // The "Redirect to" picker for one menu row — only rendered when there's a
  // stronger, carried grade to send this one to. Applies on your next
  // Calculate, same as a length-chip edit; unlike a chip, it's not saved.
  function redirectSelectHtml(key) {
    const [size, grade] = key.split('|');
    const targets = validRedirectTargets(size, grade);
    if (!targets.length) return '';
    const current = activeRedirects[key] || '';
    const opts = ['<option value="">— no redirect —</option>']
      .concat(targets.map((g) => `<option value="${esc(g)}"${g === current ? ' selected' : ''}>${esc(g)}</option>`))
      .join('');
    return `<span class="redirect-lbl">Redirect to</span><select class="redirect-sel" data-key="${esc(key)}" title="Send ${esc(key.replace('|', ' '))}'s demand to a stronger carried grade instead">${opts}</select>`;
  }

  function paintMenu() {
    const mount = el('menu-mount');
    const keys = Object.keys(menu).sort();
    mount.innerHTML = keys.map((key) => {
      const label = key.replace('|', ' ');
      const set = new Set(menu[key].map(Number));
      const chips = CANDIDATE_LENGTHS.map((L) =>
        `<span class="len-chip ${set.has(L) ? 'on' : ''}" data-key="${esc(key)}" data-len="${L}">${L}′</span>`,
      ).join('');
      return `<div class="menu-row"><span class="lbl">${esc(label)}</span>${chips}${redirectSelectHtml(key)}</div>`;
    }).join('');
  }

  // Redirect picks persist (lumberRedirects.v1) and are reconciled on load, but
  // like the length chips they don't repaint or re-plan on change — they apply
  // on your next Calculate. A full paintMenu() here would blow away whatever the
  // user just picked on every unrelated chip click elsewhere.
  //
  // One handler, wired to BOTH the Stock-lengths panel's rows and the results
  // area's "Not carried" rows (render, below) — the same redirectSelectHtml
  // markup shows up in both places, so one listener body covers it rather than
  // two copies that could drift.
  function onRedirectChange(e) {
    const sel = e.target.closest('.redirect-sel');
    if (!sel) return;
    if (sel.value) activeRedirects[sel.dataset.key] = sel.value;
    else delete activeRedirects[sel.dataset.key];
    saveRedirects();
  }

  // Resolves once the menu is loaded (or its fetch has failed), so the first
  // plan never goes out before the menu and redirects it depends on.
  let menuLoaded = null;

  // Builds the editor into the section's tools slot, wires it, and starts the
  // menu load. Called once by planner.html.
  function mount({ out, tools }) {
    tools.innerHTML = `
      <details class="sec" id="menu-sec">
        <summary>Stock lengths we carry (editable)</summary>
        <p class="sub" style="margin:8px 0 0">Click a length to toggle whether it's a buyable stock length for that size &amp; grade — those edits are remembered on this computer. Where a stronger grade is carried, a Redirect picker sends that grade's whole demand there instead (e.g. buy DSS instead of #2); redirects apply on your next Calculate and are remembered here too, until you reset or clear them.</p>
        <div class="menu-wrap" id="menu-mount"></div>
        <div class="row" style="margin-top:10px">
          <button class="ghost" id="btn-menu-reset" style="padding:4px 12px;font-size:12.5px">Reset to default</button>
        </div>
      </details>`;

    el('menu-mount').addEventListener('click', (e) => {
      const chip = e.target.closest('.len-chip');
      if (!chip) return;
      const key = chip.dataset.key;
      const L = Number(chip.dataset.len);
      const set = new Set((menu[key] || []).map(Number));
      if (set.has(L)) set.delete(L); else set.add(L);
      menu[key] = [...set].sort((a, b) => a - b);
      chip.classList.toggle('on');
      saveMenu();
    });
    el('menu-mount').addEventListener('change', onRedirectChange);
    out.addEventListener('change', onRedirectChange);

    el('btn-menu-reset').addEventListener('click', () => {
      menu = JSON.parse(JSON.stringify(defaultMenu));
      activeRedirects = {};
      saveMenu();
      saveRedirects();   // clears the stored redirects too
      paintMenu();
    });

    // Fetch the default seed once, overlay any stored edits, and paint the
    // editor. Reconciling redirects and painting must happen on the failure
    // path too: the plan still works there, because the server falls back to
    // its default menu.
    function finishMenuLoad() {
      activeRedirects = reconcileRedirects(loadStoredRedirects());
      paintMenu();
    }
    menuLoaded = fetch('/api/lumber/menu').then((r) => r.json()).then((d) => {
      defaultMenu = (d && d.menu) || {};
      gradeOrder = (d && d.gradeOrder) || [];
      const stored = loadStoredMenu();
      menu = Object.keys(stored).length ? stored : JSON.parse(JSON.stringify(defaultMenu));
      finishMenuLoad();
    }).catch(() => finishMenuLoad());
  }

  // Cut instruction for one purchase draw, derived from the draw record only.
  function cutInstruction(d) {
    if (d.rule === 'mixed' && Array.isArray(d.contents)) {
      return `cut ${d.contents.map(ftLabel).join(' + ')} from one board`;
    }
    const req = d.requiredLengthFt;
    if (req == null || Math.abs(req - d.stockLengthFt) <= TOL) return 'full length';
    const n = Math.floor((d.stockLengthFt + TOL) / req);
    return n >= 2 ? `${n} × ${ftLabel(req)} per board` : `cut to ${ftLabel(req)}`;
  }

  // Sort state, shared across in-place repaints.
  let grpSort = { col: null, dir: 'asc' };

  // The Included Jobs summary columns after Job # and Job Name.
  const JOB_COLUMNS = [
    { label: 'Delivery', cell: (j) => j.deliveryDate || '—' },
    { label: 'By size & grade', cell: (j) => j.byGroup.map((d) => `${d.label}: ${fmt(d.lf)}`).join(', ') || '—' },
    { label: 'Total LF', cls: 'n', strong: true, cell: (j) => fmt(j.totalLf) },
    { label: 'Boards', cls: 'n', strong: true, cell: (j) => fmtInt(j.totalPieces) },
  ];

  function render(p, out, drills) {
    const sum = p.summary;
    let html = '';

    // Grades these jobs use that aren't on the carried-lengths list are FLAGGED,
    // not ordered and not auto-added — the same treatment non-stocked plates get.
    // A redirected grade is excluded here even if it also isn't carried — its
    // own banner below already explains why nothing was ordered for it.
    //
    // Each row gets its OWN "Redirect to" picker — the exact same
    // redirectSelectHtml() the Stock-lengths panel uses, keyed off g.key. It
    // was written to need only a "size|grade" key, never assuming that grade
    // is carried, so a not-carried grade can use it unchanged: pick a
    // stronger carried grade here and it applies on the next Calculate, same
    // as a redirect set in the panel above. A grade with no stronger carried
    // grade to offer (redirectSelectHtml returns '') falls back to the
    // original redesign-or-special-order wording, for that row only.
    const notCarried = p.bySizeGrade.filter((g) => !g.inMenu && !g.redirect);
    if (notCarried.length) {
      const rows = notCarried.map((g) => {
        const picker = redirectSelectHtml(g.key);
        const action = picker || '<span class="sub">no stronger carried grade — redesign or special-order</span>';
        return `<div class="menu-row" style="margin-top:8px"><span class="lbl">${esc(g.label)}</span><span class="sub">${fmt(g.usedLf)} LF needed</span>${action}</div>`;
      }).join('');
      html += `<div class="note bad"><b>Not carried:</b> ${notCarried.length === 1 ? 'this grade is' : 'these grades are'} not on your carried-lengths list, so no boards were ordered for ${notCarried.length === 1 ? 'it' : 'them'}. Pick a substitute below, or redesign to a carried grade / special-order.${rows}</div>`;
    }

    // Every fact this banner needs already lives on the rows just rendered
    // below (a row's own label, its redirect's toLabel/lf) — derived here
    // instead of a separate list from the server, so it can't disagree with
    // what those rows show.
    const activeRedirectRows = p.bySizeGrade.filter((row) => row.redirect);
    if (activeRedirectRows.length) {
      html += `<div class="note ok"><b>Redirected:</b> ${activeRedirectRows.map((row) => `${esc(row.label)} → ${esc(row.redirect.toLabel)} (${fmt(row.redirect.lf)} LF moved)`).join('; ')}</div>`;
    }

    if (p.rerouted && p.rerouted.length) {
      html += `<div class="note ok">Auto-detected <b>${esc(p.rerouted.map((r) => r.name).join(', '))}</b> as the lumber stock file.</div>`;
    }
    if (p.stockError) {
      html += `<div class="note bad"><b>Stock file not read:</b> ${esc(p.stockError)}<br>Totaled usage only — nothing was netted against stock.</div>`;
    } else if (!p.hasStock) {
      html += '<div class="note"><b>No stock file.</b> Boards-to-buy assume you start from zero on hand; no on-hand columns.</div>';
    } else {
      html += `<div class="note ok"><b>Stock:</b> ${esc(p.stockFileName || 'file')}</div>`;
    }
    html += renderWarnings(p.warnings);

    const stats = [
      { label: 'Jobs', value: fmtInt(sum.jobsCount) },
      { label: 'Sizes', value: fmtInt(sum.groupsCount) },
      { label: 'Need (LF)', value: fmt(sum.totalUsedLf) },
      { label: 'Boards to buy', value: fmtInt(sum.totalPiecesToBuy), warn: sum.totalPiecesToBuy > 0 },
    ];
    if (p.hasStock) {
      stats.splice(3, 0, { label: 'Have (LF)', value: fmt(sum.totalStockLf) });
      stats.push({ label: 'From on-hand', value: fmtInt(sum.totalPiecesOnHand) });
    }
    html += renderStats(stats);

    if (p.bySizeGrade.length > 0) {
      html += `
        <div>
          <div class="eyebrow" style="margin:0">By size &amp; grade — ${p.bySizeGrade.length} group(s)</div>
          <p class="sub" style="margin:2px 0 0">Pooled order for the whole batch — expand a row for how many of each stock length to buy, the cut detail, and the driving jobs. Per-job boards are in Included Jobs below.</p>
          ${PlannerUI.expandAllButtonHtml('btn-toggle-grps')}
          <div class="tw" style="margin-top:10px"><table id="lum-grp-table"></table></div>
        </div>`;
    } else {
      html += `<div class="note ok">No lumber usage found in these files.</div>`;
    }

    html += renderUnmatched(p.unmatched);

    const jobs = PlannerUI.includedJobs('lumber', p.jobs, JOB_COLUMNS);
    html += jobs.html;
    html += renderRejected(p.rejected);
    out.innerHTML = html;

    PlannerUI.wireExpandAll(out, drills, 'grp', 'btn-toggle-grps');
    if (p.bySizeGrade.length > 0) paintGroups();
    jobs.wire(out, drills);

    // ── By size & grade table ──
    function paintGroups() {
      const table = el('lum-grp-table');
      if (!table) return;
      // Pin the status column (see .stock-cols CSS) only when the wide stock
      // columns are what push the table past the panel edge.
      table.classList.toggle('stock-cols', !!p.hasStock);
      const rows = PlannerUI.sortRows(p.bySizeGrade, grpSort,
        { grp: (r) => r.label, need: (r) => r.usedLf, buy: (r) => r.piecesToBuy });
      table.innerHTML = groupsInner(rows);
      PlannerUI.wireSort(table, 'grpsort', grpSort, paintGroups);
      PlannerUI.resetExpandAll('btn-toggle-grps');
    }

    function groupsInner(rows) {
      const hasStock = p.hasStock;
      const colCount = hasStock ? 8 : 4;
      const sortableTh = (col, label) =>
        `<th class="sortable n" data-grpsort="${col}">${label} ${PlannerUI.sortIcon(grpSort.col === col, grpSort.dir)}</th>`;
      let s = `
        <thead>
          <tr>
            <th class="sortable" data-grpsort="grp">Size / Grade ${PlannerUI.sortIcon(grpSort.col === 'grp', grpSort.dir)}</th>
            ${sortableTh('need', 'Need (LF)')}
            ${hasStock ? `<th class="n">Have (LF)</th><th class="n">Buy (LF)</th><th class="n">Incoming (LF)</th><th class="n">On hand</th>` : ''}
            ${sortableTh('buy', 'Buy')}
            <th></th>
          </tr>
        </thead>
        <tbody>`;
      rows.forEach((row, idx) => {
        const isShort = row.piecesToBuy > 0 || (hasStock && row.neededLf > 0);
        // Expand whenever there's ANYTHING to show — the driving jobs (always
        // present) or a cut plan. A "no menu" row has no cut plan but still has
        // the jobs that need it, which is exactly what you want to see there.
        // A fully-redirected row DOES get a caret too: row.jobs there is its
        // own native driving-usage list (see planLumber's fullyRedirected
        // swap), so it still has something worth expanding — its Raw lengths
        // and Driving usage, just no Order/Cut detail.
        const hasDrill = (row.jobs && row.jobs.length > 0) || (row.draws && row.draws.length > 0);
        // Not-carried is moot once the demand's been redirected elsewhere —
        // the redirect note explains the empty order, not a sourcing gap.
        const notInMenu = !row.inMenu && !row.redirect;
        // A row that's ALSO a real target (row.fullyRedirected false — see
        // planLumber.js) keeps its normal Buy/Covered status here — the
        // redirect note above the label already says what else happened to
        // it; the chip's job is just "is there an order on this row or not."
        const statusChip = row.fullyRedirected
          ? '<span class="chip incoming" title="This grade’s demand was redirected — see the note above the label">Redirected</span>'
          : notInMenu
            ? '<span class="chip bad" title="This size/grade isn’t on your carried-lengths list — special order, or redesign to a carried grade">Not Carried</span>'
            : (isShort ? '<span class="chip short">Buy</span>' : (hasStock ? '<span class="chip covered">Covered</span>' : ''));
        s += `
          <tr class="grp${isShort ? ' short' : ''}${notInMenu ? ' non-stock' : ''}"${hasDrill ? ` data-group="grp" data-toggle="${idx}"` : ''}>
            <td>${hasDrill ? '<span class="caret">▸</span>' : ''}<span class="mono"><b>${esc(row.label)}</b></span>${row.redirect ? ` <span class="sub">redirected to <b>${esc(row.redirect.toLabel)}</b></span>` : ''}</td>
            <td class="n">${needCellHtml(row)}</td>
            ${hasStock ? `
              <td class="n ${row.stockLf === 0 ? 'zero-ink' : ''}">${fmt(row.stockLf)}</td>
              <td class="n"><strong style="color:${row.neededLf > 0 ? 'var(--warn)' : 'inherit'}">${fmt(row.neededLf)}</strong></td>
              <td class="n ${row.incomingLf ? '' : 'zero-ink'}">${row.incomingLf ? `+${fmt(row.incomingLf)}` : '0'}</td>
              <td class="n ${row.piecesOnHand ? '' : 'zero-ink'}">${fmtInt(row.piecesOnHand)}</td>
            ` : ''}
            <td class="n"><strong style="color:${row.piecesToBuy > 0 ? 'var(--warn)' : 'inherit'}">${notInMenu ? '—' : fmtInt(row.piecesToBuy)}</strong></td>
            <td>${statusChip}</td>
          </tr>
          <tr class="jobs" id="drill-grp-${idx}" style="display:none">
            <td colspan="${colCount}">
              <div class="drill">
                ${planTable(row)}
              </div>
            </td>
          </tr>`;
      });
      return s + '</tbody>';
    }

    // Which jobs drive this size/grade, biggest first — shown for EVERY group,
    // menu or not, so a "no menu" row can still be traced back to its jobs.
    // Stacked under Raw lengths (not Order) so Cut detail — nested under Order,
    // on the other side — can expand or collapse without shifting this at all.
    // The gap above this heading is `.drill h4:not(:first-child)` in
    // planner.css, not inline — it's the second heading in this column.
    function drivingJobsTable(row) {
      if (!row.jobs || !row.jobs.length) return '';
      return `
        <h4>Driving usage — ${row.jobs.length} job(s) at ${esc(row.label)}</h4>
        <table class="drill-t">
          <thead><tr><th>Job #</th><th>Job Name</th><th>Delivery</th><th class="n">LF</th></tr></thead>
          <tbody>
            ${row.jobs.map((j) => `
              <tr>
                <td class="mono"><strong>${esc(j.jobNumber || '—')}</strong></td>
                <td>${esc(j.jobName || '—')}</td>
                <td>${esc(j.deliveryDate || '—')}</td>
                <td class="n"><strong>${fmt(j.lf)}</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    // The pooled ORDER for one size/grade: how many of each stock length to buy
    // for the whole batch — the number that maps to packs — shown beside the RAW
    // LENGTHS these jobs actually call for (raw lengths on the left, order on the
    // right), so the two read side by side. Two independent columns, each with
    // its own expanding detail stacked underneath: Raw lengths gets Driving usage
    // (which jobs call for these lengths), Order gets Cut detail (how the ordered
    // boards get cut — literally what happened to what you just bought). Keeping
    // them in separate columns means opening Cut detail only grows the Order
    // column; it can never push Driving usage down. The order side becomes a
    // short note when there's nothing to buy; the raw-lengths table shows either
    // way, wherever there's demand.
    function planTable(row) {
      let orderSide;
      if (!row.buyByLength || !row.buyByLength.length) {
        // row.fullyRedirected, not raw row.redirect: a row that's both a
        // source AND a target (rare — see planLumber's "does not chain" case)
        // can still land here with nothing to buy for an ordinary reason (e.g.
        // on-hand stock covers its real, nonzero demand) — that's "on-hand
        // covers it," not "redirected," even though row.redirect is set too.
        const why = row.fullyRedirected
          ? `Redirected to ${esc(row.redirect.toLabel)} — see that row for the order and cut plan.`
          : !row.inMenu
            ? `${esc(row.label)} isn’t on your carried-lengths list — add it in the Stock lengths panel, then Calculate again to get a board count.`
            : `Nothing to buy for ${esc(row.label)} — on-hand covers it.`;
        orderSide = `<h4 style="color:var(--muted)">${why}</h4>`;
      } else {
        const total = row.buyByLength.reduce((t, b) => t + b.boards, 0);
        // Purchased footage — distinct from the group's Need (LF) demand (that's
        // gross board LF bought, offcuts included; see PlannerUI.buyLf).
        const totalBuyLf = row.buyByLength.reduce((t, b) => t + buyLf(b), 0);
        orderSide = `
          <h4>Order — buy ${fmtInt(total)} board(s) for ${esc(row.label)}${row.piecesOnHand ? ` (${fmtInt(row.piecesOnHand)} more come from on-hand)` : ''}</h4>
          <table class="drill-t">
            <thead><tr><th>Stock length</th><th class="n">Boards to buy</th><th class="n">LF</th></tr></thead>
            <tbody>
              ${row.buyByLength.map((b) => `
                <tr><td class="mono">${ftLabel(b.stockLengthFt)}</td><td class="n"><strong>${fmtInt(b.boards)}</strong></td><td class="n">${fmt(buyLf(b))}</td></tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr><td class="mono"><strong>Total</strong></td><td class="n"><strong>${fmtInt(total)}</strong></td><td class="n"><strong>${fmt(totalBuyLf)}</strong></td></tr>
            </tfoot>
          </table>`;
        orderSide += `
          <details style="margin-top:8px">
            <summary class="sub" style="cursor:pointer">Cut detail — how each board is cut</summary>
            <table class="drill-t" style="margin-top:6px">
              <thead><tr><th class="n">Boards</th><th>Length</th><th>Cut instruction</th><th class="n">Waste (ft)</th></tr></thead>
              <tbody>
                ${row.draws.map((d) => `
                  <tr>
                    <td class="n"><strong>${fmtInt(d.pieces)}</strong></td>
                    <td class="mono">${ftLabel(d.stockLengthFt)}</td>
                    <td class="cut-instr">${esc(cutInstruction(d))}</td>
                    <td class="n">${fmt(d.wasteFt)}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </details>`;
      }
      return `<div class="plan-cols"><div>${rawLengthsTable(row)}${drivingJobsTable(row)}</div><div>${orderSide}</div></div>`;
    }

    // The RAW demanded cut lengths for one size/grade, longest first, with qty and
    // linear feet accumulated across all jobs — sitting to the left of the Order
    // table so the buyer can compare the lengths these jobs actually need against
    // the stock lengths we'd buy. The totals row ties Σ LF back to Need (LF).
    function rawLengthsTable(row) {
      const raws = row.rawLengths || [];
      if (!raws.length) return '';
      const totQty = raws.reduce((s, r) => s + r.qty, 0);
      // Tie the footer to the row's Need (LF) directly. Summing the per-row LF
      // (each already rounded to the cent) can drift a cent or two from Need,
      // which round2s the un-rounded total once — so use needLf(row), that
      // single-rounded total, and the footer equals the Need column by
      // construction (same figure, fully-redirected-away row or not).
      const totLf = needLf(row);
      // Lengths redirected IN from a weaker grade are already merged into
      // `raws` above (same length key, summed) — this note just says how much
      // of the total came from where, so the buyer isn't left guessing why a
      // length's qty is bigger than any one job's line items would explain.
      const redirectNote = (row.redirectedIn && row.redirectedIn.length)
        ? `<p class="sub" style="margin:2px 0 8px">Includes ${row.redirectedIn.map((r) => `${fmt(r.lf)} LF redirected from ${esc(r.fromLabel)}`).join(', ')}.</p>`
        : '';
      return `
        <div>
          <h4>Raw lengths — ${fmtInt(raws.length)} distinct for ${esc(row.label)}</h4>
          ${redirectNote}
          <table class="drill-t">
            <thead><tr><th>Length</th><th class="n">Qty</th><th class="n">LF</th></tr></thead>
            <tbody>
              ${raws.map((r) => `
                <tr><td class="mono">${ftLabel(r.lengthFt)}</td><td class="n">${fmtInt(r.qty)}</td><td class="n">${fmt(r.lf)}</td></tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr><td class="mono"><strong>Total</strong></td><td class="n"><strong>${fmtInt(totQty)}</strong></td><td class="n"><strong>${fmt(totLf)}</strong></td></tr>
            </tfoot>
          </table>
        </div>`;
    }
  }

  // "Not carried" grades are flagged inline on their own red rows above. This
  // section surfaces only pieces we can't source another way — e.g. a required
  // cut longer than any stocked length for a grade we DO carry.
  function renderUnmatched(unmatched) {
    unmatched = (unmatched || []).filter((u) => /exceeds longest/i.test(u.reason || ''));
    if (!unmatched.length) return '';
    return `
      <details class="sec"><summary>Too long for any carried length (${unmatched.length})</summary>
        <div class="tw" style="margin-top:10px"><table>
          <thead><tr><th>Material</th><th class="n">Qty</th><th>Reason</th></tr></thead>
          <tbody>
            ${unmatched.map((u) => `<tr><td class="mono">${esc(u.material || (u.size + ' ' + u.grade))}</td><td class="n">${fmtInt(u.qty)}</td><td>${esc(u.reason || '')}</td></tr>`).join('')}
          </tbody>
        </table></div>
      </details>`;
  }

  window.PlannerSections = window.PlannerSections || {};
  window.PlannerSections.lumber = {
    label: 'Lumber',
    blurb: 'Multi-job dimensional-lumber usage by size & grade — linear feet and whole stock pieces to buy, netted against on-hand.',
    route: '/api/lumber/plan',
    busyText: 'Totaling lumber usage…',
    isOnHandFile(text) {
      const head = String(text || '').slice(0, 1024).toLowerCase();
      return head.includes('size') && head.includes('grade') && head.includes('length') &&
             (head.includes('available') || head.includes('qty') || head.includes('on_hand'));
    },
    mount,
    // The lumber route alone takes page-editable options. Waits for the menu,
    // so a plan never goes out with an empty one.
    async planOptions() {
      await menuLoaded;
      return { menu, redirects: activeRedirects };
    },
    render,
    // Clear drops the redirect picks AND their stored copy — a save-less reset
    // used to let the old value silently reappear on the next page load.
    clear() {
      activeRedirects = {};
      saveRedirects();
    },
  };
})();
