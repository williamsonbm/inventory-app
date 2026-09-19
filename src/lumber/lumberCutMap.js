"use strict";

// =============================================================
// lumberCutMap.js — required cut lengths -> stock-piece (board) draws.
// =============================================================
// Ported byte-for-byte in behavior from the hanger-web-app's src/lumberCutMap.js
// (a pure function, no DB access — stockedLengths is passed in as data), so the
// two stay in sync. This is the "how many boards to buy" engine for the Lumber
// tab; it is deliberately SEPARATE from the EWP length-search optimizer, which
// is excluded from this port (it lives in the sibling materials-planner). That
// optimizer runs a combinatorial cut search; lumber instead draws from a fixed
// per-yard menu, so the two answer different questions and share no code.
//
// Given normalized demand lines (required_length_ft + qty per size/grade) plus
// the stocked lengths available for each (size, grade), decide which stock
// length(s) to draw and how many pieces.
//
// Chooser:
//   - required length IS a stocked length (within tolerance) -> stocked-exact,
//     1:1 draw, zero waste.
//   - otherwise, among every stocked length L >= required (within tolerance):
//       yield(L)  = floor((L + TOL) / required)   -- cuts of `required` that fit in L
//       boards(L) = ceil(qty / yield(L))
//       waste(L)  = boards(L) * L - qty * required
//     pick the L with minimum waste; ties broken by smallest L.
//     yield >= 2 -> rule "block"; yield === 1 -> rule "next-up".
//   - required length exceeds every stocked length -> unmatched.
//
// Tier 2: after the qty-aware chooser runs per demand line, each non-exact draw
// is split into a zero-waste "full boards" portion and an "odd" remainder. Odd
// pieces across ALL required lengths sharing a (size, grade) are pooled and a
// first-fit-decreasing consolidation is attempted (pack onto bins sized at the
// longest stocked length, then shrink each bin to the smallest stocked length
// that still fits). If consolidated waste beats the naive per-length odd waste,
// the mixed bins are emitted; otherwise the per-length shape wins.
//
// Commodity override: for 2x4 #2 and #1 only, required lengths of exactly 1'
// or exactly 2' are always drawn from 20' stock (see commodityOverrideStock),
// not whatever best-fit's shortest-wins tie-break would otherwise pick — every
// carried length divides evenly into 1' and 2', so best-fit would tie and land
// on the shortest stick. This is a fixed purchasing rule (short blocking is
// drop off long sticks, not a reason to buy short stock), so it bypasses
// Tier-2 consolidation entirely rather than being reconsidered as waste.

const TOL_FT = 0.0052; // 1/16" in decimal feet

function approxEq(a, b) {
  return Math.abs(a - b) <= TOL_FT;
}

function approxGte(a, b) {
  return a - b >= -TOL_FT;
}

function stockKey(size_norm, grade_norm) {
  return `${size_norm}|${grade_norm}`;
}

function getStockedLengths(stockedLengths, key) {
  if (stockedLengths instanceof Map) {
    return stockedLengths.get(key);
  }
  return stockedLengths[key];
}

// Is `requiredFt` a stocked length (within tolerance) for this (size,grade)?
// Returns the matched catalog length (not the noisy input value), or undefined.
function findStockedExact(requiredFt, stocked) {
  return stocked.find((s) => approxEq(requiredFt, s));
}

// (size, grade) keys and required lengths covered by the commodity override
// above. Deliberately narrow and hardcoded — this is a stated exception for
// two grades at two exact lengths, not a general per-yard policy.
const COMMODITY_OVERRIDE_KEYS = new Set(["2x4|#2", "2x4|#1"]);
const COMMODITY_OVERRIDE_LENGTHS_FT = [1, 2];
const COMMODITY_OVERRIDE_STOCK_FT = 20;

// Forced stock length for the 2x4 #2/#1 commodity-blocking override, or
// undefined if this (size, grade, required length) isn't covered by it, or
// 20' isn't carried for this grade (falls through to normal best-fit).
function commodityOverrideStock(size_norm, grade_norm, requiredFt, stocked) {
  if (!COMMODITY_OVERRIDE_KEYS.has(stockKey(size_norm, grade_norm))) return undefined;
  if (!COMMODITY_OVERRIDE_LENGTHS_FT.some((l) => approxEq(requiredFt, l))) return undefined;
  return stocked.find((s) => approxEq(s, COMMODITY_OVERRIDE_STOCK_FT));
}

// Qty-aware best-fit chooser: among stocked lengths >= requiredFt, pick the one
// minimizing total waste for `qty` required pieces (ties -> smallest length).
function bestFit(requiredFt, qty, stocked) {
  let best;
  for (const L of stocked) {
    if (!approxGte(L, requiredFt)) continue;
    const yield_ = Math.floor((L + TOL_FT) / requiredFt);
    if (yield_ < 1) continue;
    const boards = Math.ceil(qty / yield_);
    const waste = boards * L - qty * requiredFt;
    if (
      best === undefined ||
      waste < best.waste_ft_total - TOL_FT ||
      (Math.abs(waste - best.waste_ft_total) <= TOL_FT && L < best.stock_length_ft)
    ) {
      best = { stock_length_ft: L, yield: yield_, boards, waste_ft_total: waste };
    }
  }
  return best;
}

/**
 * Map required cut-length demand to stock-piece draws.
 *
 * @param {Array<{size_norm:string, grade_norm:string, required_length_ft:number, qty:number, material_display?:string}>} demandLines
 * @param {Map<string, number[]>|Object<string, number[]>} stockedLengths keyed `${size_norm}|${grade_norm}` -> sorted stocked lengths (ft)
 * @returns {{draws: Array, unmatched: Array}}
 */
function cutMapLumber(demandLines, stockedLengths) {
  const unmatched = [];

  // Group demand lines by (size, grade) so Tier-2 consolidation can pool odd
  // pieces across different required lengths sharing the same stock pool.
  const groups = new Map(); // key -> { size_norm, grade_norm, stocked, lines: [...] }

  for (const line of demandLines) {
    const { size_norm, grade_norm, required_length_ft, qty } = line;
    const key = stockKey(size_norm, grade_norm);
    const stocked = getStockedLengths(stockedLengths, key);

    if (!stocked || stocked.length === 0) {
      unmatched.push({
        size_norm,
        grade_norm,
        required_length_ft,
        qty,
        material_display: line.material_display,
        reason: `Unknown size/grade: ${size_norm} ${grade_norm}`,
      });
      continue;
    }

    if (!groups.has(key)) groups.set(key, { size_norm, grade_norm, stocked, lines: [] });
    groups.get(key).lines.push({ required_length_ft, qty, material_display: line.material_display });
  }

  const drawsByKey = new Map();

  for (const group of groups.values()) {
    const { size_norm, grade_norm, stocked } = group;

    // Pre-aggregate lines sharing this (size, grade) by required_length_ft
    // (within tolerance) BEFORE running best-fit — two demand lines at the same
    // required length must be sized as one combined qty.
    const byRequired = [];
    for (const l of group.lines) {
      const existing = byRequired.find((r) => approxEq(r.required_length_ft, l.required_length_ft));
      if (existing) {
        existing.qty += l.qty;
      } else {
        byRequired.push({ required_length_ft: l.required_length_ft, qty: l.qty, material_display: l.material_display });
      }
    }

    // Odd pieces pooled for this (size, grade), across all non-exact required
    // lengths, to feed Tier-2 consolidation.
    const oddPool = [];
    let perLengthOddWaste = 0;
    const perLengthFallback = new Map(); // required_length_ft -> draw object

    for (const { required_length_ft, qty, material_display } of byRequired) {
      const stockedExact = findStockedExact(required_length_ft, stocked);
      if (stockedExact !== undefined) {
        addDraw(drawsByKey, {
          size_norm,
          grade_norm,
          stock_length_ft: stockedExact,
          pieces: qty,
          required_length_ft,
          qty_required: qty,
          waste_ft_total: 0,
          rule: "stocked-exact",
        });
        continue;
      }

      const overrideStock = commodityOverrideStock(size_norm, grade_norm, required_length_ft, stocked);
      if (overrideStock !== undefined) {
        const overrideYield = Math.floor((overrideStock + TOL_FT) / required_length_ft);
        const overrideBoards = Math.ceil(qty / overrideYield);
        addDraw(drawsByKey, {
          size_norm,
          grade_norm,
          stock_length_ft: overrideStock,
          pieces: overrideBoards,
          required_length_ft,
          qty_required: qty,
          waste_ft_total: overrideBoards * overrideStock - qty * required_length_ft,
          rule: "commodity-override",
        });
        continue;
      }

      const fit = bestFit(required_length_ft, qty, stocked);
      if (!fit) {
        unmatched.push({
          size_norm,
          grade_norm,
          required_length_ft,
          qty,
          material_display,
          reason: `Required length ${required_length_ft} exceeds longest stocked length for ${size_norm} ${grade_norm}`,
        });
        continue;
      }

      const rule = fit.yield >= 2 ? "block" : "next-up";
      const fullBoards = Math.floor(qty / fit.yield);
      const odd = qty - fullBoards * fit.yield; // qty mod yield

      if (odd === 0) {
        addDraw(drawsByKey, {
          size_norm,
          grade_norm,
          stock_length_ft: fit.stock_length_ft,
          pieces: fullBoards,
          required_length_ft,
          qty_required: qty,
          waste_ft_total: fullBoards * fit.stock_length_ft - qty * required_length_ft,
          rule,
        });
        continue;
      }

      const oddBoards = Math.ceil(odd / fit.yield);
      const oddWaste = oddBoards * fit.stock_length_ft - odd * required_length_ft;
      perLengthOddWaste += oddWaste;
      oddPool.push({ required_length_ft, count: odd });

      perLengthFallback.set(required_length_ft, {
        size_norm,
        grade_norm,
        stock_length_ft: fit.stock_length_ft,
        yield: fit.yield,
        fullBoards,
        oddBoards,
        qty_required: qty,
        fullWaste: fullBoards * fit.stock_length_ft - fullBoards * fit.yield * required_length_ft,
        oddWaste,
        required_length_ft,
        rule,
      });
    }

    // ── Tier 2: consolidate the pooled odd pieces (if any) ──
    if (oddPool.length) {
      const longest = Math.max(...stocked);
      const bins = ffdPack(oddPool, longest);
      let consolidatedWaste = 0;
      const shrunkBins = [];
      let overflow = false;
      for (const bin of bins) {
        const sum = bin.pieces.reduce((s, p) => s + p, 0);
        const shrunkL = nextStockedUp(sum, stocked);
        if (shrunkL === undefined) {
          overflow = true;
          break;
        }
        shrunkBins.push({ pieces: bin.pieces, stock_length_ft: shrunkL, waste: shrunkL - sum });
        consolidatedWaste += shrunkL - sum;
      }

      const consolidationWins = !overflow && consolidatedWaste < perLengthOddWaste - TOL_FT;

      if (consolidationWins) {
        for (const fb of perLengthFallback.values()) {
          if (fb.fullBoards > 0) {
            addDraw(drawsByKey, {
              size_norm,
              grade_norm,
              stock_length_ft: fb.stock_length_ft,
              pieces: fb.fullBoards,
              required_length_ft: fb.required_length_ft,
              qty_required: fb.fullBoards * fb.yield,
              waste_ft_total: fb.fullWaste,
              rule: fb.rule,
            });
          }
        }

        const mixedByKey = new Map();
        for (const bin of shrunkBins) {
          const contents = [...bin.pieces].sort((a, b) => a - b);
          const mkey = `${bin.stock_length_ft}|${contents.join(",")}`;
          const prev = mixedByKey.get(mkey);
          if (prev) {
            prev.pieces += 1;
            prev.waste_ft_total += bin.waste;
          } else {
            mixedByKey.set(mkey, {
              size_norm,
              grade_norm,
              stock_length_ft: bin.stock_length_ft,
              pieces: 1,
              required_length_ft: null,
              contents,
              qty_required: contents.length,
              waste_ft_total: bin.waste,
              rule: "mixed",
            });
          }
        }
        for (const mixedDraw of mixedByKey.values()) {
          addMixedDraw(drawsByKey, mixedDraw);
        }
      } else {
        for (const fb of perLengthFallback.values()) {
          const pieces = fb.fullBoards + fb.oddBoards;
          const waste_ft_total = fb.fullWaste + fb.oddWaste;
          addDraw(drawsByKey, {
            size_norm,
            grade_norm,
            stock_length_ft: fb.stock_length_ft,
            pieces,
            required_length_ft: fb.required_length_ft,
            qty_required: fb.qty_required,
            waste_ft_total,
            rule: fb.rule,
          });
        }
      }
    }
  }

  return { draws: [...drawsByKey.values()], unmatched };
}

// First-fit-decreasing bin packing: sort pieces desc by length, pack each into
// the first open bin with enough remaining capacity, else open a new bin.
function ffdPack(pool, capacity) {
  const pieces = [];
  for (const { required_length_ft, count } of pool) {
    for (let i = 0; i < count; i++) pieces.push(required_length_ft);
  }
  pieces.sort((a, b) => b - a);

  const bins = []; // { pieces: [...], remaining }
  for (const p of pieces) {
    let placed = false;
    for (const bin of bins) {
      if (approxGte(bin.remaining, p)) {
        bin.pieces.push(p);
        bin.remaining -= p;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({ pieces: [p], remaining: capacity - p });
    }
  }
  return bins;
}

// Smallest stocked length >= requiredFt (within tolerance), or undefined.
function nextStockedUp(requiredFt, stocked) {
  let best;
  for (const s of stocked) {
    if (approxGte(s, requiredFt)) {
      if (best === undefined || s < best) best = s;
    }
  }
  return best;
}

function addDraw(drawsByKey, draw) {
  const key = [
    draw.size_norm,
    draw.grade_norm,
    draw.stock_length_ft,
    draw.required_length_ft,
    draw.rule,
  ].join("|");
  const prev = drawsByKey.get(key);
  if (prev) {
    prev.pieces += draw.pieces;
    prev.qty_required += draw.qty_required;
    prev.waste_ft_total += draw.waste_ft_total;
  } else {
    drawsByKey.set(key, { ...draw });
  }
}

// Mixed draws are keyed on stock length + exact contents.
function addMixedDraw(drawsByKey, draw) {
  const key = [
    draw.size_norm,
    draw.grade_norm,
    draw.stock_length_ft,
    "mixed",
    draw.contents.join(","),
  ].join("|");
  const prev = drawsByKey.get(key);
  if (prev) {
    prev.pieces += draw.pieces;
    prev.qty_required += draw.qty_required;
    prev.waste_ft_total += draw.waste_ft_total;
  } else {
    drawsByKey.set(key, { ...draw });
  }
}

module.exports = { cutMapLumber };
