// =============================================================
// planLumber.js — "Across these jobs, how much dimensional lumber do we need —
// in linear feet AND in whole stock pieces (boards) to buy — netted against the
// yard?"
// =============================================================
// Standalone, DB-free lumber planner. Sibling of planLvl.js, but it answers TWO
// questions in one pass, so each size/grade row can show both side by side:
//
//   1. LINEAR FEET  — a demand roll-up, qty x lengthFt, exactly like planLvl.
//      Netted against on-hand as Need / Have / Buy (LF).
//   2. STOCK PIECES — how many boards to buy, via cutMapLumber (the ported
//      cut-optimizer). On-hand boards are consumed FIRST (a small first-fit-
//      decreasing pass), so pieces split into "from on-hand" vs "to purchase" —
//      the same on-hand-first / purchase split the EWP engine reports, but with
//      its own optimizer — the EWP engine (optimizeCuts) is excluded from this
//      port and lives in the sibling materials-planner.
//
// Grouping key is (size, grade): you cannot cut a #1 board from a #2 stick, and
// the yard stocks different lengths per grade. Material names are normalized to
// that key (normalizeLumber); a grade with no purchase-menu entry is reported in
// `unmatched`, never silently dropped.
//
// Packing is done ONCE across the whole batch (all jobs pooled), because boards
// are purchased for the batch, not per job — so per-job rows show linear feet and
// raw line items, while the piece counts live on the aggregate size/grade rows.
// =============================================================

"use strict";

const { parseLumberSheet } = require('./parseLumberSheet.js');
const { normalizeLumber, lumberLabel } = require('./normalizeLumber.js');
const { cutMapLumber } = require('./lumberCutMap.js');
const { DEFAULT_LUMBER_MENU, compareMenuKeys, sanitizeMenu, resolveRedirects, isCarried } = require('./lumberMenu.js');

const TOL_FT = 0.0052; // 1/16" in decimal feet — same tolerance as cutMapLumber

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Collapse cutMapLumber draws to "how many of each stock length to buy" —
// summed across cutting strategies, longest first. This is the order line: one
// board count per purchasable length, which is what maps to packs.
function boardsByLength(draws) {
  const m = new Map();
  for (const d of draws) m.set(d.stock_length_ft, (m.get(d.stock_length_ft) || 0) + d.pieces);
  return [...m.entries()]
    .map(([stockLengthFt, boards]) => ({ stockLengthFt, boards }))
    .sort((a, b) => b.stockLengthFt - a.stockLengthFt);
}

// Consume on-hand boards for one (size, grade) before anything is purchased.
// First-fit-decreasing: longest required piece first, placed into an already-
// opened board when it still fits (consolidating cuts onto a broken stick), else
// onto a fresh on-hand board. Pieces that fit no on-hand board become residual
// demand for the purchase pass.
//
// @param pieces  individual required cut lengths (feet)
// @param boards  [{ span, qty }] on-hand boards for this size/grade
// @returns { boardsUsed, residual: number[] }
//
// A board exists only once a piece opens it, so work is bounded by demand, not
// by on_hand. Placement order: an open board first, in stock-row order, then
// the first row with an unopened board long enough.
function consumeOnHand(pieces, boards) {
  const rows = boards.map((b) => ({ span: b.span, unopened: b.qty, open: [] }));
  const sorted = [...pieces].sort((a, b) => b - a);
  const residual = [];
  let boardsUsed = 0;

  for (const p of sorted) {
    let bin = null;
    for (const row of rows) {
      bin = row.open.find((b) => b.rem - p >= -TOL_FT);
      if (bin) break;
    }
    if (bin) { bin.rem -= p; continue; }
    const row = rows.find((r) => r.unopened > 0 && r.span - p >= -TOL_FT);
    if (row) {
      row.unopened -= 1;
      row.open.push({ rem: row.span - p });
      boardsUsed += 1;
      continue;
    }
    residual.push(p);
  }
  return { boardsUsed, residual };
}

// Netting expands a group into one entry per piece. Deliberately capped: the
// 50-sheet corpus peaks at ~18,700 pieces in one group, so past a million is a
// QTY typo, and expanding it would crash the request instead of naming the group.
const MAX_NETTING_PIECES = 1_000_000;

/**
 * Plan lumber across a batch of job files against optional stock and a purchase
 * menu.
 *
 * @param {Array<{ name: string, text: string }>} jobFiles
 * @param {ReturnType<import('./readLumberStockCsv').parseLumberStockCsv> | null} parsedStock
 * @param {{ menu?: Object }} [opts]  menu overrides the default carried-lengths seed
 */
function planLumber(jobFiles, parsedStock = null, opts = {}) {
  const jobs = [];
  const rejected = [];
  const warnings = [];
  const unmatched = [];
  const notCarried = new Map();   // size|grade -> one aggregated unmatched entry

  const hasStock = Boolean(parsedStock && parsedStock.byKey instanceof Map);
  // Carry the stock reader's data-fault warnings (e.g. negative on-hand) into the
  // response so the buyer sees them beside the plan, not just in a discarded field.
  if (hasStock) for (const w of parsedStock.warnings || []) warnings.push(w);
  // Effective purchase menu: caller's edited menu, else the default seed.
  const edited = sanitizeMenu(opts.menu);
  const menu = Object.keys(edited).length ? edited : { ...DEFAULT_LUMBER_MENU };

  // Grade redirects: "don't buy 2x6 #2, put that demand on 2x6 DSS instead."
  // Validated once against this plan's menu (a redirect into a grade this
  // plan doesn't carry is dropped, not applied) — see resolveRedirects.
  const { redirects, dropped: droppedRedirects } = resolveRedirects(opts.redirects, menu);
  for (const d of droppedRedirects) {
    const [rSize, rGrade] = d.fromKey.split('|');
    warnings.push(`Redirect ${lumberLabel(rSize, rGrade)} → ${d.toGrade} skipped: ${d.reason}.`);
  }
  // key -> aggregate usage: label + demand pieces + LF + per-job attribution.
  // `redirect` is always present (null for the common case) so every group
  // carries the same shape regardless of whether a redirect ever touches it
  // — see the per-line loop below.
  //
  // `pieces`/`jobs` drive PURCHASING (packing, on-hand netting) and are only
  // ever fed via a line's EFFECTIVE grade — untouched by this feature, so
  // buying math can't drift. `nativePieces`/`nativeJobs` are a second,
  // display-only copy fed via a line's ORIGINAL grade, used only to show a
  // redirected-away row its own "what was actually called for" breakdown
  // (Raw lengths / Driving usage) without that breakdown ever reaching the
  // purchase pass.
  const byKey = new Map();
  const getGroup = (size, grade) => {
    const key = `${size}|${grade}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key, size, grade, label: lumberLabel(size, grade),
        usedLf: 0, pieces: new Map(), jobs: [],   // pieces: lengthKey -> { length, qty }
        nativePieces: new Map(), nativeJobs: [],
        redirect: null,   // { toGrade, toLabel, lf } once any of this group's demand moves
      });
    }
    return byKey.get(key);
  };

  // ---- Parse + normalize every job, accumulating demand and LF ----
  for (const f of jobFiles || []) {
    let res;
    try {
      res = parseLumberSheet(String(f.text || ''));
    } catch (err) {
      rejected.push({ name: f.name, reason: `parse failed: ${err.message}` });
      continue;
    }
    if (!res.ok) {
      rejected.push({ name: f.name, reason: res.reason });
      continue;
    }
    for (const w of res.warnings || []) warnings.push(w);

    const header = res.meta;
    const jobId = { jobNumber: header.jobNumber || 'Unknown', jobName: header.jobName || 'Unknown', deliveryDate: header.deliveryDate || 'Unknown' };
    const jobDemand = new Map();  // key -> Map(lenKey -> { length, qty }), this job only
    const nativeJobDemand = new Map();  // fromKey -> LF, this job's own redirected-away demand

    for (const line of res.lines) {
      const { size, grade, gradeKnown } = normalizeLumber(line.material);
      if (!size) {
        warnings.push(`[${jobId.jobNumber}] Could not read a lumber size from "${line.material}" — its ${line.qty} piece(s) were skipped.`);
        continue;
      }
      if (!gradeKnown) {
        // Keep counting its footage, but flag that its grade doesn't map to a
        // known stock/menu token — the buyer decides how to source it. Aggregate
        // per size/grade so a grade on 40 lines is reported once, with total qty.
        const uk = `${size}|${grade}`;
        const e = notCarried.get(uk) ||
          { material: line.material, size, grade, qty: 0, reason: 'Unrecognized grade — not in the purchase menu.' };
        e.qty += line.qty;
        notCarried.set(uk, e);
      }

      const lf = line.qty * line.lengthFt;

      // Always resolve the line's own (size, grade) group first, whether or
      // not a redirect is active — this is the SAME group getGroup() would
      // hand back for a plain non-redirected line, so a redirected-away grade
      // stays a normal byKey entry (usedLf left at 0, tagged with `redirect`)
      // instead of needing a placeholder synthesized after the fact.
      const fromKey = `${size}|${grade}`;
      const gSource = getGroup(size, grade);

      // Redirect applies per LINE, looked up on its ORIGINAL grade only —
      // never on an already-redirected effGrade. That single non-chained
      // lookup is what stops a redirect from cascading: if both 2x6 #2→DSS
      // and 2x6 DSS→MSR2400 are active, #2's demand still lands at DSS, not
      // MSR2400, because we never re-look-up the grade we just redirected to.
      let effGrade = grade;
      const toGrade = gradeKnown ? redirects.get(fromKey) : undefined;
      if (toGrade) {
        effGrade = toGrade;
        if (!gSource.redirect) gSource.redirect = { toGrade, toLabel: lumberLabel(size, toGrade), lf: 0 };
        gSource.redirect.lf += lf;
      }

      // Only re-look-up when a redirect actually moved this line — the
      // common case (no redirect) already has the right group in gSource.
      const g = toGrade ? getGroup(size, effGrade) : gSource;
      g.usedLf += lf;
      const lk = line.lengthFt.toFixed(4);
      const piece = g.pieces.get(lk) || { length: line.lengthFt, qty: 0 };
      piece.qty += line.qty;
      g.pieces.set(lk, piece);

      // This line got redirected — also record it under its OWN grade's
      // display-only copy, so that row's Raw lengths / Driving usage still
      // show what was actually called for. Guarded on g !== gSource so a
      // normal (non-redirected) line — where they're the same group — isn't
      // double-counted onto itself.
      if (g !== gSource) {
        const srcPiece = gSource.nativePieces.get(lk) || { length: line.lengthFt, qty: 0 };
        srcPiece.qty += line.qty;
        gSource.nativePieces.set(lk, srcPiece);
        nativeJobDemand.set(fromKey, (nativeJobDemand.get(fromKey) || 0) + lf);
      }

      if (!jobDemand.has(g.key)) jobDemand.set(g.key, new Map());
      const jd = jobDemand.get(g.key);
      const jp = jd.get(lk) || { length: line.lengthFt, qty: 0 };
      jp.qty += line.qty;
      jd.set(lk, jp);
    }

    // Per-job board plan: pack THIS job on its own (greenfield — no on-hand, no
    // cross-job offcut sharing), so the saw sees what each job needs. These
    // per-job counts total MORE than the pooled order below; the UI labels the
    // two distinctly so they're not mistaken for each other.
    const jobLines = [];
    for (const [key, lenMap] of jobDemand) {
      const [size, grade] = key.split('|');
      for (const p of lenMap.values()) jobLines.push({ size_norm: size, grade_norm: grade, required_length_ft: p.length, qty: p.qty });
    }
    const jobDrawsByKey = new Map();
    for (const d of cutMapLumber(jobLines, menu).draws) {
      const key = `${d.size_norm}|${d.grade_norm}`;
      if (!jobDrawsByKey.has(key)) jobDrawsByKey.set(key, []);
      jobDrawsByKey.get(key).push(d);
    }

    const jobGroups = [...jobDemand.keys()].map((key) => {
      const buyByLength = boardsByLength(jobDrawsByKey.get(key) || []);
      let lf = 0;
      for (const p of jobDemand.get(key).values()) lf += p.qty * p.length;
      return {
        key,
        label: byKey.get(key).label,
        lf: round2(lf),
        piecesToBuy: buyByLength.reduce((s, x) => s + x.boards, 0),
        buyByLength,
        inMenu: isCarried(menu, key),
      };
    }).sort((a, b) => compareMenuKeys(a.key, b.key));

    jobs.push({
      name: f.name,
      ...jobId,
      byGroup: jobGroups,
      totalLf: round2(jobGroups.reduce((s, d) => s + d.lf, 0)),
      totalPieces: jobGroups.reduce((s, d) => s + d.piecesToBuy, 0),
      // Raw line items in sheet order for the "as it appears on the material
      // sheet" drill-down.
      items: res.lines.map((it) => ({ material: it.material, qty: it.qty, length: it.rawLength })),
    });

    for (const jg of jobGroups) {
      byKey.get(jg.key).jobs.push({ ...jobId, lf: jg.lf });
    }
    // Same push, for each redirected-away grade's own display-only jobs list
    // (see nativeJobDemand above) — a job whose demand got relabeled still
    // shows up in ITS original grade's Driving usage, not just the target's.
    for (const [key, lf] of nativeJobDemand) {
      byKey.get(key).nativeJobs.push({ ...jobId, lf: round2(lf) });
    }
  }

  // One unmatched entry per not-carried grade (qty summed across all jobs/lines).
  for (const e of notCarried.values()) unmatched.push(e);

  // Redirected-away groups already have their own byKey entry (usedLf left
  // at 0, tagged with `redirect` — see the per-line loop above), so this is
  // just a derived index: which groups redirected demand IN, for the
  // receiving row's rollup note.
  const redirectedInByKey = new Map();   // toKey -> [{ fromLabel, lf }]
  for (const g of byKey.values()) {
    if (!g.redirect) continue;
    const toKey = `${g.size}|${g.redirect.toGrade}`;
    if (!redirectedInByKey.has(toKey)) redirectedInByKey.set(toKey, []);
    redirectedInByKey.get(toKey).push({ fromLabel: g.label, lf: round2(g.redirect.lf) });
  }

  // ---- Piece netting: consume on-hand per group, then pack the residual once ----
  const residualDemand = [];      // demand lines feeding the purchase pass
  const piecesOnHandByKey = new Map();
  for (const g of byKey.values()) {
    const stockGroup = hasStock ? parsedStock.byKey.get(g.key) : null;

    // Expand this group's demand into individual pieces (once), reused for both
    // the on-hand pass and, as {length, qty} lines, the purchase pass.
    const pieceLines = [...g.pieces.values()];       // [{ length, qty }]

    let boardsUsed = 0;
    let residualLines = pieceLines;
    if (stockGroup && stockGroup.boards.length) {
      const pieceCount = pieceLines.reduce((s, l) => s + l.qty, 0);
      if (pieceCount > MAX_NETTING_PIECES) {
        throw new Error(`${g.label}: ${pieceCount.toLocaleString('en-US')} pieces across the batch is over the `
          + `${MAX_NETTING_PIECES.toLocaleString('en-US')}-piece limit for netting against on-hand. Check the QTY column.`);
      }
      const expanded = [];
      for (const { length, qty } of pieceLines) for (let i = 0; i < qty; i++) expanded.push(length);
      const consumed = consumeOnHand(expanded, stockGroup.boards);
      boardsUsed = consumed.boardsUsed;
      // Re-aggregate the residual pieces back into {length, qty} lines.
      const agg = new Map();
      for (const L of consumed.residual) {
        const lk = L.toFixed(4);
        const e = agg.get(lk) || { length: L, qty: 0 };
        e.qty += 1;
        agg.set(lk, e);
      }
      residualLines = [...agg.values()];
    }
    piecesOnHandByKey.set(g.key, boardsUsed);

    for (const { length, qty } of residualLines) {
      residualDemand.push({ size_norm: g.size, grade_norm: g.grade, required_length_ft: length, qty });
    }
  }

  const { draws, unmatched: cutUnmatched } = cutMapLumber(residualDemand, menu);
  for (const u of cutUnmatched) {
    unmatched.push({
      material: lumberLabel(u.size_norm, u.grade_norm), size: u.size_norm, grade: u.grade_norm,
      qty: u.qty, requiredLengthFt: u.required_length_ft, reason: u.reason,
    });
  }

  // Group purchase draws by key for per-row display + piece totals.
  const drawsByKey = new Map();
  for (const d of draws) {
    const key = `${d.size_norm}|${d.grade_norm}`;
    if (!drawsByKey.has(key)) drawsByKey.set(key, []);
    drawsByKey.get(key).push(d);
  }

  // ---- Assemble one row per size/grade (demand or stock), netting LF too ----
  const allKeys = new Set([...byKey.keys(), ...(hasStock ? parsedStock.byKey.keys() : [])]);
  const bySizeGrade = [...allKeys].map((key) => {
    const g = byKey.get(key);
    const [size, grade] = key.split('|');
    const stockGroup = hasStock ? parsedStock.byKey.get(key) : null;

    const usedLf = round2(g ? g.usedLf : 0);
    // `toGrade` stays internal (byKey's own g.redirect keeps it, needed to
    // build redirectedInByKey's key above) — nothing outside this file reads
    // it off a row, only toLabel/lf, so the public object doesn't carry it.
    const redirect = g && g.redirect ? { toLabel: g.redirect.toLabel, lf: round2(g.redirect.lf) } : null;
    // True when a row has NO real purchasing demand of its own left — its
    // whole native demand moved elsewhere, so it shows its OWN breakdown
    // (below) instead of the (empty) purchasing one. A grade can be
    // simultaneously a redirect SOURCE and TARGET (its own demand moves on,
    // while it also receives someone else's — see the "does not chain"
    // test): that row's usedLf is the real, nonzero demand it's actually
    // buying, so it's NOT fullyRedirected — it keeps its real numbers
    // everywhere; `redirect` still flags what else moved. Returned on the
    // row (not just used internally) so the UI reads this SAME computed
    // value instead of re-deriving it from redirect/usedLf itself.
    const fullyRedirected = Boolean(redirect) && usedLf === 0;
    // What flowed IN from other grades' redirects, and this row's OWN share
    // of its current usedLf once that's subtracted back out — computed once,
    // rounded, here, so the UI's Need-column breakdown ("56 (20 + 36)") never
    // has to re-derive a total from already-rounded numbers itself.
    const redirectedIn = redirectedInByKey.get(key) || [];
    const ownLf = round2(usedLf - redirectedIn.reduce((s, r) => s + r.lf, 0));
    const stockLf = hasStock ? round2(stockGroup ? stockGroup.onHandLf : 0) : null;
    const remainingLf = hasStock ? round2(Math.max(0, (stockLf || 0) - usedLf)) : null;
    const neededLf = hasStock ? round2(Math.max(0, usedLf - (stockLf || 0))) : null;
    const incomingLf = hasStock ? round2(stockGroup ? stockGroup.incomingLf : 0) : null;

    const groupDraws = (drawsByKey.get(key) || []).slice()
      .sort((a, b) => b.stock_length_ft - a.stock_length_ft);
    const piecesToBuy = groupDraws.reduce((s, d) => s + d.pieces, 0);
    const piecesOnHand = piecesOnHandByKey.get(key) || 0;
    const inMenu = isCarried(menu, key);

    // The raw DEMAND, one row per distinct required cut length (qty summed across
    // all jobs), longest first — so the buyer can compare the actual lengths these
    // jobs call for against the stock lengths on the order beside it. Near-identical
    // cuts stay separate on purpose. LF sums back to this row's usedLf — except when
    // fullyRedirected, where it's the display-only nativePieces copy instead (the true
    // total there is redirect.lf, same source the UI reads for that row's Need column).
    const rawLengths = (g ? [...(fullyRedirected ? g.nativePieces : g.pieces).values()] : [])
      .map((pc) => ({ lengthFt: pc.length, qty: pc.qty, lf: round2(pc.qty * pc.length) }))
      .sort((a, b) => b.lengthFt - a.lengthFt);

    return {
      key,
      size,
      grade,
      label: g ? g.label : lumberLabel(size, grade),
      usedLf,
      stockLf,
      remainingLf,
      neededLf,
      incomingLf,
      piecesOnHand,
      piecesToBuy,
      inMenu,
      rawLengths,
      // The pooled ORDER: how many of each stock length to buy for this size/
      // grade across the whole batch (offcuts shared, on-hand netted). This is
      // the number that maps to packs.
      buyByLength: boardsByLength(groupDraws),
      // The cut plan for this group's purchase — one entry per distinct draw.
      draws: groupDraws.map((d) => ({
        stockLengthFt: d.stock_length_ft,
        pieces: d.pieces,
        requiredLengthFt: d.required_length_ft,
        contents: d.contents || null,
        rule: d.rule,
        wasteFt: round2(d.waste_ft_total),
      })),
      // Driving jobs — same fullyRedirected swap as rawLengths above: a fully
      // redirected-away row shows who drove ITS OWN demand, not the (empty)
      // list of who's actually buying under this grade.
      jobs: g ? [...(fullyRedirected ? g.nativeJobs : g.jobs)].sort((a, b) => b.lf - a.lf) : [],
      // Grade-redirect state for this row (see getGroup/resolveRedirects
      // above): `redirect` is set when THIS row's own demand was moved away
      // (the picker that sets it lives in the Stock-lengths panel, not here);
      // `redirectedIn` lists what flowed IN from other grades' redirects;
      // `ownLf` is this row's own share of usedLf once redirectedIn is
      // subtracted back out (only interesting when redirectedIn is
      // non-empty); `fullyRedirected` is the single "does this row have any
      // real demand of its own" fact the UI branches on everywhere.
      redirect,
      redirectedIn,
      ownLf,
      fullyRedirected,
    };
  }).sort((a, b) => compareMenuKeys(a.key, b.key));

  const summary = {
    jobsCount: jobs.length,
    groupsCount: bySizeGrade.length,
    totalUsedLf: round2(bySizeGrade.reduce((s, d) => s + d.usedLf, 0)),
    totalStockLf: hasStock ? round2(bySizeGrade.reduce((s, d) => s + (d.stockLf || 0), 0)) : null,
    totalNeededLf: hasStock ? round2(bySizeGrade.reduce((s, d) => s + (d.neededLf || 0), 0)) : null,
    totalPiecesOnHand: bySizeGrade.reduce((s, d) => s + d.piecesOnHand, 0),
    totalPiecesToBuy: bySizeGrade.reduce((s, d) => s + d.piecesToBuy, 0),
    hasStock,
  };

  // No separate top-of-results-banner list: every fact it needs (fromLabel =
  // a row's own label, toLabel/lf = that row's redirect) already lives on
  // bySizeGrade, so lumber.html derives the banner from that directly rather
  // than this shipping the same data twice.
  return { jobs, bySizeGrade, summary, hasStock, unmatched, warnings, rejected };
}

module.exports = { planLumber };
