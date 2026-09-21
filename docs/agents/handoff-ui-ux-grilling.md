# Handoff — scope the UI/UX redesign in a grilling (fresh session)

A ready-to-paste prompt for a **new session**. The owner scoped this work out of the #9 session
on 2026-09-21 to keep that session under budget. The job is to **grill the owner about the
UI/UX**, map the design tree, and produce a scope the owner can turn into a spec with `/to-spec`
(an agent cannot invoke `/to-spec`). **No application code ships from this grilling.**

Run it where both siblings (`materials-planner`, `hanger-web-app`) are present and read-only.
Paste the block below.

```
# Task: scope the inventory-app UI/UX redesign — a grilling, not a build

## Your role
Run a grilling with the `grilling` skill. Grill the owner; do not decide for them. The owner is
a non-developer with some design experience. Follow CLAUDE.md working style: lead with a
plain-language Bottom line, keep detail skippable, define terms on first use, plain words over
clever phrasing. Produce a per-decision resolution the owner can hand to `/to-spec` — the owner
runs that, not you.

## Read first (trust after re-deriving)
- CLAUDE.md, CONTEXT.md (glossary — use its terms, coin no third dialect).
- The #9 resolution comment (the per-family decisions this redesign must reflect):
  https://github.com/williamsonbm/inventory-app/issues/9  (the closing comment of 2026-09-21).
- ADR 0001 (the snapshot writes nothing; snapshot vs. commitment is the backbone).
- docs/agents/domain.md, docs/agents/issue-tracker.md.

## Settled context — do not relitigate
- The materials planner is already the app and stays the stateless front door. The snapshot
  writes nothing (ADR 0001).
- The backbone is snapshot (drop-and-forget buy list) vs. commitment (the ledger: counts,
  receiving, availability, thresholds). #9 set this once; the UI should express it, not fight it.
- Current UI, verified 2026-09-21: FOUR standalone pages — src/planner/{lumber,plates,hangers,
  lvl}.html — organized by family, each doing only the snapshot/buy-list. There is no unified
  shell, no EWP page (excluded per #41), no ledger UI yet, and no login yet. "Tabs tacked on"
  means family silos with no home and no commitment side.
- The database slice adds the ledger; #6 adds a login (Vercel removes the Tailscale header).
  The app runs on Vercel + Supabase.

## What the redesign must absorb
- Two user types: (1) owner/purchasing — snapshots, buy lists, commit-to-deduct, thresholds, at
  a desk; (2) yard personnel — receive material by pack/box from the Bill of Lading, physical
  counts, likely a tablet or phone in the yard.
- The real tasks: make a buy list; receive material; count inventory; set thresholds; look up
  availability.
- Per-family shape from #9: lumber receives by editable pack size and deducts by committing
  sheets; plates show boxes-to-buy and convert box/pallet to eaches; hangers receive by manual
  entry (supplier-PDF dropped); LVL and EWP have their own availability views.

## Process to drive the owner through (name each term)
Tasks -> user flows (the branching paths) -> information architecture (the set of screens) ->
wireframes (each screen) -> visual design. A wireframe is the layout of one screen; it comes
AFTER the flows and IA, not before. Start from tasks, not tabs.

## Round 1 is already drafted — open with it
Q1 - Users and where they land: confirm the two user types; decide one app role-aware (shared
login, yard lands on "Receive / Count", owner lands on "Buy list / Inventory") vs. separate
views. Recommend: one app, role-aware.
Q2 - The IA backbone: (A) by mode — "Buy list" (snapshot) and "Inventory" (ledger), family a
filter inside each; (B) by family (today's silos); (C) by task. Recommend (A) by mode — it is
the snapshot-vs-commitment split #9 already chose, and it maps onto the two user types.

## Constraints
- Siblings read-only. Re-derive and cite; where you have no command, write "I think".
- Do not build code. Do not change a recorded decision silently; name any you lean against.
- Output: a per-decision resolution (IA backbone, per-mode home screens, family-filter behavior,
  the receiving/counting flows, device/layout targets) ready for the owner to run `/to-spec`.
```
