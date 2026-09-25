/* =============================================================
   plates-section.js — the Plates section of the Planner.
   =============================================================
   Served at /plates-section.js by src/planner/server.js and loaded by
   planner.html, which runs the plan and hands the response to render(). Moved
   from the old plates.html (spec #72, step 1); the buy list is unchanged.

   Registers window.PlannerSections.plates.

   NOT UNIT-TESTED: render() builds DOM, and this repo has no Node DOM harness.
   Checked by hand in the browser, one pass per family (spec #72). The route's
   output is proven by test/recorded-output.test.js.
   ============================================================= */
(function () {
  'use strict';
  const { esc, fmtInt: n, renderStats, renderWarnings, renderRejected } = PlannerUI;

  // A buy-list sort or Expand all redraws the whole section from the same plan.
  // col is 'sku' | 'need' | 'buy'; dir is 'asc' | 'desc'.
  const DEFAULT_SORT = { col: 'buy', dir: 'desc' };
  const buySort = { ...DEFAULT_SORT };
  // The Buy List's open rows, kept across a re-sort — see the note on
  // tr[data-key] in planner.css.
  const openDrills = new Set();

  // NOTE: the stocked-plate list lives in ONE place — STOCKED_PLATES in
  // src/plates/planPlates.js — and reaches this page as `isStocked` on every buy
  // row. Do not reintroduce a browser-side copy: if a plate is miscategorized,
  // the list to fix is the one on the server.

  // "box" -> "boxes", not "boxs". Only the units that actually occur.
  const plural = (w, k) => k === 1 ? w : (w === 'box' ? 'boxes' : w + 's');

  // The Included Jobs summary columns after Job # and Job Name.
  const JOB_COLUMNS = [
    { label: 'Plate Lines', cls: 'n', cell: (j) => n(j.plateLines) },
    { label: 'Eaches', cls: 'n', cell: (j) => n(j.eaches) },
    { label: 'Notes', cls: 'spare', cell: (j) => (j.plateLines === 0 ? 'no plates in this job' : '') },
  ];

  function optionsHtml(p) {
    if (!p) return '<span class="spare">no pack factor</span>';
    return p.map((o, i) =>
      '<span class="opt' + (i === 0 ? ' best' : '') + '">' + n(o.units) + ' ' + plural(o.unit, o.units) +
      ' of ' + n(o.eachesPerUnit) +
      (o.productLine ? ' <span class="spare">(' + esc(o.productLine) + ')</span>' : '') +
      ' <span class="spare">' + n(o.leftover) + ' spare</span></span>').join('');
  }

  // Rows that tie on Need or Buy stay in SKU order, whichever way the column
  // sorts: sortRows keeps ties in input order, so sort the input by SKU first.
  function getSortedBuyList(buyList) {
    const bySku = (buyList || []).slice().sort((a, b) => a.sku.localeCompare(b.sku));
    return PlannerUI.sortRows(bySku, buySort,
      { sku: (r) => r.sku, need: (r) => r.needEaches, buy: (r) => r.shortEaches });
  }

  const sortIndicator = (col) => PlannerUI.sortIcon(buySort.col === col, buySort.dir);

  function render(d, out, drills) {
    const hasStock = !!d.stockInfo;
    let h = '';

    // Staleness first. The stock file is a manual export, so it can be old — and a
    // planner quietly costing out last week's stock is worse than no planner.
    if (d.stockError) {
      h += '<div class="note bad"><b>On-hand file not read:</b> ' + esc(d.stockError) +
        '<br>Planned as if the yard were empty — every plate shows as a buy.</div>';
    } else if (!hasStock) {
      h += '<div class="note"><b>No on-hand file.</b> Everything below is a full buy, ' +
        'not a shortfall.</div>';
    } else {
      h += '<div class="note ok"><b>On-hand file:</b> ' + esc(d.stockFileName || 'file') + ' · ' +
        n(d.stockInfo.rows) + ' rows · comparing against <span class="mono">' +
        esc(d.stockInfo.qtyColumn) + '</span>' +
        (d.stockInfo.lastCounted ? ' · last counted ' + esc(d.stockInfo.lastCounted) : '') +
        '</div>';
    }
    h += renderWarnings((d.stockInfo && d.stockInfo.warnings) || [], 'bad');
    h += renderWarnings(d.warnings);

    h += renderStats([
      { label: 'Jobs', value: n(d.totals.jobs) },
      { label: 'Plate SKUs', value: n(d.totals.skusDemanded) },
      { label: 'Short', value: n(d.totals.skusShort) },
      { label: 'Eaches needed', value: n(d.totals.eachesDemanded) },
      { label: 'Eaches to buy', value: n(d.totals.eachesShort) },
    ]);

    const rawBuy = d.toBuy || [];
    const buy = getSortedBuyList(rawBuy);

    if (buy.length) {
      h += '<div class="row" style="justify-content:space-between;margin-top:0">' +
        '<p class="eyebrow" style="margin:0">Buy list — ' + n(buy.length) + ' SKU(s)</p>' +
        '<button class="ghost" id="plates-btn-toggle-drills" style="padding:4px 12px;font-size:12.5px">' +
        (buy.every((r) => openDrills.has(r.key)) ? 'Collapse all' : 'Expand all') + '</button></div>';
    } else {
      h += '<p class="eyebrow" style="margin-top:0">Buy list — ' + n(buy.length) + ' SKU(s)</p>';
    }
    if (!buy.length) {
      h += '<div class="note ok">Nothing to buy — on hand covers every plate in these jobs.</div>';
    } else {
      // Have and Incoming are stock-derived; they only appear with a stock file.
      const colgroup = hasStock
        ? '<col class="c-sku"><col class="c-need"><col class="c-have"><col class="c-buy"><col class="c-order"><col class="c-inc">'
        : '<col class="c-sku"><col class="c-need"><col class="c-buy"><col class="c-order">';
      const span = hasStock ? 6 : 4;
      h += '<div class="tw"><table class="buy">' +
        '<colgroup>' + colgroup + '</colgroup>' +
        '<thead><tr>' +
        '<th class="sortable" data-col="sku">SKU ' + sortIndicator('sku') + '</th>' +
        '<th class="sortable" data-col="need" data-first-sort="desc">Need ' + sortIndicator('need') + '</th>' +
        (hasStock ? '<th>Have</th>' : '') +
        '<th class="sortable" data-col="buy" data-first-sort="desc">Buy (eaches) ' + sortIndicator('buy') + '</th>' +
        '<th>Order as</th>' +
        (hasStock ? '<th class="n">Incoming</th>' : '') +
        '</tr></thead><tbody>';

      buy.forEach((r) => {
        const isStocked = r.isStocked;
        const isExpanded = openDrills.has(r.key);

        h += '<tr class="buy' + (!isStocked ? ' non-stock' : '') + '" data-key="' + esc(r.key) + '">' +
          '<td><span class="caret">' + (isExpanded ? '▾' : '▸') + '</span>' +
          '<span class="mono"><b>' + esc(r.sku) + '</b></span>' +
          (!isStocked ? '<span class="chip bad">Non-Stock</span>' : '') +
          '</td>' +
          '<td>' + n(r.needEaches) + '</td>' +
          (hasStock ? '<td' + (r.negativeStock ? ' style="color:var(--bad)"' : '') + '>' +
            n(r.availableEaches) + '</td>' : '') +
          '<td><b>' + n(r.shortEaches) + '</b>' +
          (r.shortFromLedger > 0
            ? '<br><span class="spare" title="This SKU is already below zero in the on-hand file, so '
              + 'the buy figure covers that existing shortfall as well as these jobs. Count it '
              + 'before ordering.">' + n(r.shortFromJobs) + ' jobs + ' + n(r.shortFromLedger)
              + ' short</span>'
            : '') + '</td>' +
          '<td>' + optionsHtml(r.purchase) + '</td>' +
          (hasStock ? '<td class="n">' + (r.incoming ? n(r.incoming) : '<span class="spare">—</span>') + '</td>' : '') +
          '</tr>';

        h += '<tr class="jobs' + (isExpanded ? '' : ' hide') + '" id="j-' + esc(r.key) + '"><td colspan="' + span + '"><div class="drill">' +
          '<h4>Driving demand — ' + n(r.byJob.length) + ' job(s) for ' + esc(r.sku) + '</h4>' +
          '<table class="drill-t"><thead><tr><th>Job #</th><th>Name</th>' +
          '<th class="n">Qty</th><th>Delivery</th></tr></thead><tbody>' +
          r.byJob.map((j) => '<tr><td>' + esc(j.job) + '</td>' +
            '<td><span class="spare">' + esc(j.jobName || '') + '</span></td>' +
            '<td class="n">' + n(j.qty) + '</td>' +
            '<td><span class="spare">' + esc(j.deliveryDate || '—') + '</span></td></tr>').join('') +
          '</tbody></table></div></td></tr>';
      });
      h += '</tbody></table></div>';
      if (hasStock) {
        h += '<p class="sub" style="font-size:13px;margin-top:6px">Incoming is shown, never subtracted — whether an ' +
          'open order lands in time is your call, not the tool\'s.</p>';
      }
      h += '<div class="note bad" style="margin-top:10px;font-size:13.5px">' +
        '<b>Non-Stock Plate Notice:</b> Any non-stocked plates should be identified and redesigned to use stocked plates.</div>';
    }

    const jobs = PlannerUI.includedJobs('plates', d.jobs || [], JOB_COLUMNS);
    h += jobs.html;
    h += renderRejected(d.rejected);

    out.innerHTML = h;
    jobs.wire(out, drills);

    // Buy-list column sort. Scoped to headers with data-col so it never fires on
    // the Included Jobs headers (which use data-jobsort and sort in place).
    PlannerUI.wireSort(out, 'col', buySort, () => render(d, out, drills));

    out.querySelectorAll('tr.buy[data-key]').forEach((row) => row.addEventListener('click', () => {
      const key = row.dataset.key;
      const r = document.getElementById('j-' + key);
      if (!r) return;
      const caret = row.querySelector('.caret');
      const isClosed = r.classList.contains('hide');
      if (isClosed) {
        r.classList.remove('hide');
        if (caret) caret.textContent = '▾';
        openDrills.add(key);
      } else {
        r.classList.add('hide');
        if (caret) caret.textContent = '▸';
        openDrills.delete(key);
      }
    }));

    const btnToggleDrills = document.getElementById('plates-btn-toggle-drills');
    if (btnToggleDrills) {
      btnToggleDrills.addEventListener('click', () => {
        const expanding = buy.some((r) => !openDrills.has(r.key));
        buy.forEach((r) => (expanding ? openDrills.add(r.key) : openDrills.delete(r.key)));
        render(d, out, drills);
      });
    }
  }

  window.PlannerSections = window.PlannerSections || {};
  window.PlannerSections.plates = {
    label: 'Plates',
    blurb: 'Multi-job plate demand consolidated and converted to orderable units.',
    route: '/api/plates/plan',
    busyText: 'Working…',
    isOnHandFile(text) {
      if (!PlannerUI.looksLikePlateOrHangerStock(text)) return false;
      // A hanger on-hand file shares this exact header; reject it so the
      // Hangers section keeps it. (A file with no recognisable hints stays
      // claimable here.)
      const hints = PlannerUI.stockProductHints(text);
      return !(hints.hanger && !hints.plate);
    },
    render,
    // Clear starts the next plan from the default sort with every row shut.
    clear() {
      openDrills.clear();
      Object.assign(buySort, DEFAULT_SORT);
    },
  };
})();
