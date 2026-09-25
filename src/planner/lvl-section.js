/* =============================================================
   lvl-section.js — the LVL section of the Planner.
   =============================================================
   Served at /lvl-section.js by src/planner/server.js and loaded by
   planner.html, which runs the plan and hands the response to render(). Moved
   from the old lvl.html (spec #72, step 1); the buy list is unchanged.

   Registers window.PlannerSections.lvl.

   NOT UNIT-TESTED: render() builds DOM, and this repo has no Node DOM harness.
   Checked by hand in the browser, one pass per family (spec #72). The route's
   output is proven by test/recorded-output.test.js.
   ============================================================= */
(function () {
  'use strict';
  const { esc, fmtNum: fmt, renderStats, renderWarnings, renderRejected } = PlannerUI;
  const el = (id) => document.getElementById(id);

  // Sort state for the By-depth table. col null = natural depth order; 'depth'
  // sorts the label, 'need'/'buy' sort those linear-foot columns.
  let depthSort = { col: null, dir: 'asc' };

  // The Included Jobs summary columns after Job # and Job Name.
  const JOB_COLUMNS = [
    { label: 'Delivery', cell: (j) => j.deliveryDate || '—' },
    { label: 'By Depth', cell: (j) => j.byDepth.map((d) => `${d.label}: ${fmt(d.lf)}`).join(', ') || '—' },
    { label: 'Total LF', cls: 'n', strong: true, cell: (j) => fmt(j.totalLf) },
  ];

  function render(p, out, drills) {
    const sum = p.summary;
    let html = '';

    if (p.rerouted && p.rerouted.length) {
      html += `<div class="note ok">Auto-detected <b>${esc(p.rerouted.map(r=>r.name).join(', '))}</b> as the LVL stock file.</div>`;
    }
    if (p.stockError) {
      html += `<div class="note bad"><b>Stock file not read:</b> ${esc(p.stockError)}<br>Totaled usage only — nothing was netted against stock.</div>`;
    } else if (!p.hasStock) {
      html += '<div class="note"><b>No stock file.</b> Figures below are usage totals only — no remaining/needed columns.</div>';
    } else {
      html += `<div class="note ok"><b>Stock:</b> ${esc(p.stockFileName || 'file')}</div>`;
    }
    html += renderWarnings(p.warnings);

    // Stats bar. Labels mirror the By-depth column vocabulary (Need / Have /
    // Buy) so the same concept never wears two names.
    const stats = [
      { label: 'Jobs', value: fmt(sum.jobsCount) },
      { label: 'Depths', value: fmt(sum.depthsCount) },
      { label: 'Need (LF)', value: fmt(sum.totalUsedLf) },
    ];
    if (p.hasStock) {
      stats.push({ label: 'Have (LF)', value: fmt(sum.totalStockLf) });
      stats.push({ label: 'Buy (LF)', value: fmt(sum.totalNeededLf), warn: true });
    }
    html += renderStats(stats);

    // By-depth table. Depth / Need / Buy are sortable; the table is painted by
    // paintDepths() after the shell mounts, so re-sorting repaints only this
    // table. Row expansion is handled by the delegated `drills` listener.
    if (p.byDepth.length > 0) {
      html += `
        <div class="row" style="justify-content:space-between;margin-top:0">
          <div class="eyebrow" style="margin:0">By depth — ${p.byDepth.length} size(s)</div>
          <button class="ghost" id="btn-toggle-depths" style="padding:4px 12px;font-size:12.5px">Expand all</button>
        </div>
        <div class="tw"><table id="lvl-depth-table"></table></div>
      `;
    } else {
      html += `<div class="note ok">No LVL usage found in these files.</div>`;
    }

    const jobs = PlannerUI.includedJobs('lvl', p.jobs, JOB_COLUMNS);
    html += jobs.html;
    html += renderRejected(p.rejected);

    out.innerHTML = html;

    PlannerUI.wireExpandAll(out, drills, 'depth', 'btn-toggle-depths');
    if (p.byDepth.length > 0) paintDepths();
    jobs.wire(out, drills);

    // Paint (or repaint) the By-depth table for the current sort. A repaint
    // collapses the drill rows, so the Expand-all button is reset to match.
    function paintDepths() {
      const table = el('lvl-depth-table');
      if (!table) return;
      const rows = PlannerUI.sortRows(p.byDepth, depthSort,
        { depth: (r) => r.label, need: (r) => r.usedLf, buy: (r) => r.neededLf });
      table.innerHTML = depthsInner(rows);
      PlannerUI.wireSort(table, 'depthsort', depthSort, paintDepths);
      PlannerUI.resetExpandAll('btn-toggle-depths');
    }

    function depthsInner(rows) {
      const hasStock = p.hasStock;
      const sortableTh = (col, label) =>
        `<th class="sortable n" data-depthsort="${col}">${label} ${PlannerUI.sortIcon(depthSort.col === col, depthSort.dir)}</th>`;
      let s = `
        <thead>
          <tr>
            <th class="sortable" data-depthsort="depth">Depth ${PlannerUI.sortIcon(depthSort.col === 'depth', depthSort.dir)}</th>
            ${sortableTh('need', 'Need (LF)')}
            ${hasStock ? `<th class="n">Have (LF)</th><th class="n">Remaining (LF)</th>${sortableTh('buy', 'Buy (LF)')}<th class="n">Incoming (LF)</th>` : ''}
            <th></th>
          </tr>
        </thead>
        <tbody>`;
      rows.forEach((row, idx) => {
        const isShort = hasStock && row.neededLf > 0;
        s += `
          <tr class="depth${isShort ? ' short' : ''}" data-group="depth" data-toggle="${idx}">
            <td><span class="caret">▸</span><span class="mono"><b>${esc(row.label)}</b></span></td>
            <td class="n">${fmt(row.usedLf)}</td>
            ${hasStock ? `
              <td class="n ${row.stockLf === 0 ? 'zero-ink' : ''}">${fmt(row.stockLf)}</td>
              <td class="n">${fmt(row.remainingLf)}</td>
              <td class="n"><strong style="color:${isShort ? 'var(--warn)' : 'inherit'}">${fmt(row.neededLf)}</strong></td>
              <td class="n ${row.incomingLf ? '' : 'zero-ink'}">${row.incomingLf ? `+${fmt(row.incomingLf)}` : '0'}</td>
            ` : ''}
            <td>${isShort ? '<span class="chip short">Short</span>' : (hasStock ? '<span class="chip covered">Covered</span>' : '')}</td>
          </tr>
          <tr class="jobs" id="drill-depth-${idx}" style="display:none">
            <td colspan="${hasStock ? 7 : 3}">
              <div class="drill">
                <h4>Driving usage — ${row.jobs.length} job(s) at ${esc(row.label)}</h4>
                <table class="drill-t">
                  <thead>
                    <tr><th>Job #</th><th>Job Name</th><th>Delivery</th><th class="n">LF</th></tr>
                  </thead>
                  <tbody>
                    ${row.jobs.map((j) => `
                      <tr>
                        <td class="mono"><strong>${esc(j.jobNumber || '—')}</strong></td>
                        <td>${esc(j.jobName || '—')}</td>
                        <td>${esc(j.deliveryDate || '—')}</td>
                        <td class="n"><strong>${fmt(j.lf)}</strong></td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            </td>
          </tr>`;
      });
      return s + '</tbody>';
    }
  }

  window.PlannerSections = window.PlannerSections || {};
  window.PlannerSections.lvl = {
    label: 'LVL',
    blurb: 'Multi-job LVL usage by depth, in linear feet, netted against stock.',
    route: '/api/lvl/plan',
    busyText: 'Totaling LVL usage…',
    // Sniff an on-hand file (item,span,qty/available) vs a MiTek material
    // summary (header cells "Job Name:", "LABEL", …).
    isOnHandFile(text) {
      const head = String(text || '').slice(0, 1024).toLowerCase();
      return (head.includes('item') || head.includes('product') || head.includes('description')) &&
             head.includes('span') &&
             (head.includes('available') || head.includes('qty') || head.includes('on_hand'));
    },
    render,
  };
})();
