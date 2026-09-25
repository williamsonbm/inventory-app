/* =============================================================
   hangers-section.js — the Hangers section of the Planner.
   =============================================================
   Served at /hangers-section.js by src/planner/server.js and loaded by
   planner.html, which runs the plan and hands the response to render(). Moved
   from the old hangers.html (spec #72, step 1); the buy list is unchanged.

   Registers window.PlannerSections.hangers.

   NOT UNIT-TESTED: render() builds DOM, and this repo has no Node DOM harness.
   Checked by hand in the browser, one pass per family (spec #72). The route's
   output is proven by test/recorded-output.test.js.
   ============================================================= */
(function () {
  'use strict';
  const { esc, fmtInt: fmt, renderStats, renderWarnings, renderRejected, expandAllButtonHtml } = PlannerUI;
  const el = (id) => document.getElementById(id);

  // Sort state for the Buy list. col null = biggest-shortfall-first (the engine
  // order); 'sku'/'need'/'buy' sort those columns.
  let buySort = { col: null, dir: 'asc' };
  // Sort state for the Covered by on hand table. col null = alphabetical (the
  // engine order); 'sku'/'need'/'remaining' sort those columns.
  let coveredSort = { col: null, dir: 'asc' };

  // The Included Jobs summary columns after Job # and Job Name.
  const JOB_COLUMNS = [
    { label: 'Delivery', cell: (j) => j.deliveryDate || '—' },
    { label: 'Category', cell: (j) => j.category || '—' },
    { label: 'Hanger Lines', cls: 'n', cell: (j) => fmt((j.lines || []).length) },
  ];

  function render(p, out, drills) {
    const sum = p.summary;
    const hasStock = p.hasStock;
    let html = '';

    if (p.rerouted && p.rerouted.length) {
      html += `<div class="note ok">Auto-detected <b>${esc(p.rerouted.map(r=>r.name).join(', '))}</b> as the hanger on-hand file.</div>`;
    }
    if (p.stockError) {
      html += `<div class="note bad"><b>On-hand file not read:</b> ${esc(p.stockError)}<br>Planned as if the yard were empty — every hanger shows as a buy.</div>`;
    } else if (!hasStock) {
      html += '<div class="note"><b>No on-hand file.</b> Everything below is a full buy, not a shortfall.</div>';
    } else {
      html += `<div class="note ok"><b>On-hand file:</b> ${esc(p.stockFileName || 'file')}</div>`;
    }
    html += renderWarnings(p.warnings);

    // Stats bar. The stock-derived cards (Incoming, Special Order) only appear
    // when a stock file is loaded — with no stock they read 0/blank and mean
    // nothing.
    const stats = [
      { label: 'Jobs', value: fmt(sum.jobsCount) },
      { label: 'SKUs Needed', value: fmt(sum.skusNeeded) },
      { label: 'SKUs to Buy', value: fmt(sum.skusToBuy) },
      { label: 'Pieces to Buy', value: fmt(sum.totalBuyPieces), warn: true },
    ];
    if (hasStock) {
      stats.push({ label: 'Incoming', value: fmt(sum.totalIncomingPieces) });
      if (sum.skusUnmatched > 0) stats.push({ label: 'Special Order', value: fmt(sum.skusUnmatched), warn: true });
    }
    html += renderStats(stats);

    // Buy list. SKU / Need / Buy are sortable; the table is painted by paintBuy()
    // after the shell mounts, so re-sorting repaints only this table. Row
    // expansion is handled by the delegated `drills` listener. Without a stock
    // file this is a plain demand list (SKU / Need / Buy); the Have, Incoming and
    // Min columns only appear when there's stock to net against.
    if (p.buyList.length > 0) {
      html += `
        <div class="row" style="justify-content:space-between;margin-top:0">
          <div class="eyebrow" style="margin:0">Buy list — ${p.buyList.length} SKU(s)</div>
          <button class="ghost" id="hangers-btn-toggle-drills" style="padding:4px 12px;font-size:12.5px">Expand all</button>
        </div>
        <div class="tw"><table class="buy" id="hangers-buy-table"></table></div>
        ${hasStock ? `<p class="sub" style="font-size:13px;margin-top:0">Incoming is shown, never subtracted — whether an open order lands in time is your call, not the tool's.</p>` : ''}
      `;
    } else {
      html += `<div class="note ok">All requested hangers are fully covered by available inventory.</div>`;
    }

    // Covered by on hand — only meaningful with an on-hand file. Sortable and
    // expandable just like the buy list; paintCovered() fills the shell.
    if (hasStock && p.covered.length > 0) {
      html += `
        <details class="sec">
          <summary>Covered by on hand (${p.covered.length} SKUs)</summary>
          ${expandAllButtonHtml('btn-toggle-cov')}
          <div class="tw" style="margin-top:10px"><table id="hangers-covered-table"></table></div>
        </details>
      `;
    }

    const jobs = PlannerUI.includedJobs('hangers', p.jobs, JOB_COLUMNS);
    html += jobs.html;
    html += renderRejected(p.rejected);

    out.innerHTML = html;

    // Expand all / collapse all, one button per drilldown group. Individual
    // row clicks (buy list, covered) are handled by the delegated `drills`
    // listener; these drive each group in bulk.
    PlannerUI.wireExpandAll(out, drills, 'sku', 'hangers-btn-toggle-drills');
    PlannerUI.wireExpandAll(out, drills, 'cov', 'btn-toggle-cov');

    if (p.buyList.length > 0) paintBuy();
    if (hasStock && p.covered.length > 0) paintCovered();
    jobs.wire(out, drills);

    // Paint (or repaint) the Covered by on hand table for the current sort — the
    // buy list's twin: SKU / Need / Remaining sort, rows expand via `drills`.
    function paintCovered() {
      const table = el('hangers-covered-table');
      if (!table) return;
      const rows = PlannerUI.sortRows(p.covered, coveredSort,
        { sku: (r) => r.sku, need: (r) => r.demand, remaining: (r) => r.available - r.demand });
      table.innerHTML = coveredInner(rows);
      PlannerUI.wireSort(table, 'covsort', coveredSort, paintCovered);
      PlannerUI.resetExpandAll(out, 'btn-toggle-cov');
    }

    function coveredInner(rows) {
      const th = (col, label) =>
        `<th class="sortable n" data-covsort="${col}">${label} ${PlannerUI.sortIcon(coveredSort.col === col, coveredSort.dir)}</th>`;
      let s = `<thead><tr>
          <th class="sortable" data-covsort="sku">SKU ${PlannerUI.sortIcon(coveredSort.col === 'sku', coveredSort.dir)}</th>
          ${th('need', 'Need')}
          <th class="n">Have</th>
          ${th('remaining', 'Remaining')}
          <th class="n">Incoming</th>
          <th></th>
        </tr></thead><tbody>`;
      rows.forEach((r, idx) => {
        s += `
          <tr data-group="cov" data-toggle="${idx}">
            <td><span class="caret">▸</span><span class="mono"><strong>${esc(r.sku)}</strong></span></td>
            <td class="n">${fmt(r.demand)}</td>
            <td class="n">${fmt(r.available)}</td>
            <td class="n"><strong>${fmt(r.available - r.demand)}</strong></td>
            <td class="n ${r.incoming ? '' : 'zero-ink'}">${r.incoming ? `+${fmt(r.incoming)}` : '0'}</td>
            <td><span class="chip covered">Covered</span></td>
          </tr>
          ${skuJobDrill('cov', idx, 6, r)}
        `;
      });
      return s + '</tbody>';
    }

    // Paint (or repaint) the Buy list for the current sort. A repaint collapses
    // the drill rows, so the Expand-all button is reset to match.
    function paintBuy() {
      const table = el('hangers-buy-table');
      if (!table) return;
      const rows = PlannerUI.sortRows(p.buyList, buySort,
        { sku: (r) => r.sku, need: (r) => r.demand, buy: (r) => r.buyPieces });
      table.innerHTML = buyInner(rows);
      PlannerUI.wireSort(table, 'buysort', buySort, paintBuy);
      PlannerUI.resetExpandAll(out, 'hangers-btn-toggle-drills');
    }

    function buyInner(rows) {
      const colgroup = hasStock
        ? '<col class="c-sku"><col class="c-need"><col class="c-have"><col class="c-buy"><col class="c-inc"><col class="c-thresh"><col class="c-status">'
        : '<col class="c-sku"><col class="c-need"><col class="c-buy">';
      const span = hasStock ? 7 : 3;
      const th = (col, label) =>
        `<th class="sortable n" data-buysort="${col}">${label} ${PlannerUI.sortIcon(buySort.col === col, buySort.dir)}</th>`;
      let s = `<colgroup>${colgroup}</colgroup>
        <thead><tr>
          <th class="sortable" data-buysort="sku">SKU ${PlannerUI.sortIcon(buySort.col === 'sku', buySort.dir)}</th>
          ${th('need', 'Need')}
          ${hasStock ? '<th class="n">Have</th>' : ''}
          ${th('buy', 'Buy (Pcs)')}
          ${hasStock ? '<th class="n">Incoming</th><th class="n">Min</th><th>Notes</th>' : ''}
        </tr></thead><tbody>`;
      rows.forEach((row, idx) => {
        const isNeg = row.availableRaw != null && row.availableRaw < 0;
        const availCls = row.available === 0 || row.available == null ? 'zero-ink' : '';
        const incCls = row.incoming === 0 ? 'zero-ink' : '';
        const minCls = row.threshold === 0 ? 'zero-ink' : '';
        s += `
          <tr class="buy" data-group="sku" data-toggle="${idx}">
            <td>
              <span class="caret">▸</span><span class="mono"><b>${esc(row.sku)}</b></span>
              ${isNeg ? `<span class="chip neg">${row.availableRaw} in ledger</span>` : ''}
            </td>
            <td class="n">${fmt(row.demand)}</td>
            ${hasStock ? `<td class="n ${availCls}">${row.available != null ? fmt(row.available) : '—'}</td>` : ''}
            <td class="n"><strong style="color:var(--warn)">${fmt(row.buyPieces)}</strong></td>
            ${hasStock ? `
              <td class="n ${incCls}">${row.incoming ? `+${fmt(row.incoming)}` : '0'}</td>
              <td class="n ${minCls}">${row.threshold ? fmt(row.threshold) : '0'}</td>
              <td>
                ${row.incoming > 0 ? '<span class="chip incoming">Incoming</span>' : ''}
                ${row.isUnmatched ? '<span class="chip unmatched">Not Stocked</span>' : ''}
              </td>
            ` : ''}
          </tr>
          ${skuJobDrill('sku', idx, span, row)}
        `;
      });
      return s + '</tbody>';
    }

    // The expandable "which jobs drove this SKU" table, shared by the buy list
    // and the covered list (only the group/idx/colspan differ).
    function skuJobDrill(group, idx, span, row) {
      return `
        <tr class="jobs" id="drill-${group}-${idx}" style="display:none">
          <td colspan="${span}">
            <div class="drill">
              <h4>Driving demand — ${row.jobs.length} job(s) for ${esc(row.sku)}</h4>
              <table class="drill-t">
                <thead>
                  <tr>
                    <th>Job #</th><th>Job Name</th><th>Delivery</th>
                    <th>Section</th><th>On Sheet</th><th class="n">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  ${row.jobs.map((j) => `
                    <tr>
                      <td class="mono"><strong>${esc(j.jobNumber || '—')}</strong></td>
                      <td>${esc(j.jobName || '—')}</td>
                      <td>${esc(j.deliveryDate || '—')}</td>
                      <td>${esc(j.section || 'Hangers')}</td>
                      <td class="mono">${j.sourceSku
                        ? `<span class="chip unmatched" title="The material sheet says ${esc(j.sourceSku)}; we use the stocked ${esc(row.sku)} in its place.">${esc(j.sourceSku)}</span>`
                        : '<span class="zero-ink">—</span>'}</td>
                      <td class="n"><strong>${fmt(j.qty)}</strong></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </td>
        </tr>`;
    }
  }

  window.PlannerSections = window.PlannerSections || {};
  window.PlannerSections.hangers = {
    label: 'Hangers',
    blurb: 'Multi-job hanger and hardware demand consolidated and netted against on hand.',
    route: '/api/hangers/plan',
    busyText: 'Analyzing hardware requirements…',
    // Sniff a hanger on-hand file vs a MiTek material summary.
    isOnHandFile(text) {
      if (!PlannerUI.looksLikePlateOrHangerStock(text)) return false;
      // A plate on-hand file shares this exact header; reject it so the Plates
      // section keeps it. (A file with no recognisable hints stays claimable.)
      const hints = PlannerUI.stockProductHints(text);
      return !(hints.plate && !hints.hanger);
    },
    render,
  };
})();
