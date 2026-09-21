# Handoff — scope #9: which implementation wins per family

A ready-to-paste prompt for a **fresh session** that scopes issue
[#9](https://github.com/williamsonbm/inventory-app/issues/9). Scoping means preparing the
evidence and the questions for the owner's grilling session — not deciding the winners. Run it
in an environment that has both siblings (`materials-planner` and `hanger-web-app`) present and
read-only. Paste everything in the block below.

```
# Task: scope issue #9 — for each material family, which implementation wins?

## Your role
Prepare the evidence and framing to decide, per material family, whether the rebuild should
carry the **materials planner's** implementation or **hanger-web-app's**. #9 is a
`wayfinder:grilling` ticket: it is resolved by the owner in a grilling session, not by an
agent deciding. Your job is to make that session productive — gather comparative evidence and
put sharp questions to the owner. Do NOT declare final winners yourself.

## Context (read these first, and trust them only after re-deriving)
- `CLAUDE.md` (repo root) — working style, hard constraints, and "The effort" section.
- `CONTEXT.md` and `docs/agents/*` — glossary and tracker mechanics.
- Issue #9 itself, the map (#2), and `../materials-planner/docs/handoff-inventory-app-wayfinder.md`.
- The two web-app-schema evidence docs, both in this repo:
  `docs/research/hanger-web-app-schema-complexity-survey.md` (#21) and
  `docs/research/hanger-web-app-schema-review.md` (the 2026-09-20 review).

## Framing that is already settled — do not relitigate
- The rebuild runs on Vercel + Supabase and **starts from the materials planner** (already
  ported, #41). So the planner is the current base; #9 asks which families to replace with the
  web app's version and which to keep from the planner.
- **"Presence is not the question, quality is."** Four of five families exist in both systems.
  The decision is which implementation is better for this client, per family — not which exists.
- The planner's **EWP optimizer tab was deliberately excluded from the hosted app** (#39/#41):
  it runs 58-230s against a 300s Vercel ceiling and the client never asked for multi-job
  optimization. Be precise about what "EWP wins" could even mean when the heavy optimizer is
  out of the hosted scope; LVL stays and is first-class in the planner.
- Snapshot-first, commitment-later (see the map's standing scope decisions).

## Known asymmetries to verify, not assume (CLAUDE.md records these; confirm them)
- **Lumber:** live in production in the web app (CLAUDE.md says ~18 `/api/lumber/*` routes and
  its own schema — verify the count), i.e. built-but-bypassed, not missing. The planner has a
  first-class `src/lumber/` whose parser is said to have "more utility and better visibility."
  The map already leans planner-wins-for-lumber — test that claim, don't inherit it.
- **LVL:** thin in the web app (one route, modelled inside EWP); first-class in the planner
  (`src/lvl/`).
- **Plates, hangers:** exist in both; the web-app side is DB-backed and reviewed in #21 and the
  2026-09-20 schema review.
- The handoff doc's claim that "only lumber and LVL are genuinely absent" is WRONG (CLAUDE.md
  corrects it). Do not build on it.

## Comparison dimensions (apply per family)
1. Parser robustness and input coverage (how each handles real sheets/exports).
2. Feature completeness against what the client actually uses.
3. Code and test quality, and existing test coverage in each repo.
4. On-screen visibility / workflow quality.
5. Fit with the target: the planner is stateless (no DB); the web-app families are Postgres-
   backed. Weigh what each implies for the Vercel+Supabase rebuild and the coming database slice.
6. Maintainability for a solo non-developer owner.

## What to produce
A single Markdown document with, for each of lumber, plates, hangers, LVL, EWP:
- The evidence, each claim carrying its command or `file:line` (both repos).
- A **tentative** recommendation (planner / web-app / hybrid) with the reason — clearly marked
  as a proposal for the grilling session, not a decision.
- The specific questions the owner must answer to finalize that family.
Plus a short cross-family summary and any decisions that must be made together.

## Constraints
- `hanger-web-app` and `materials-planner` are **read-only**. Resolve their paths before
  trusting them (siblings under `/workspace/` on the claude-pod alias; different elsewhere).
- Re-derive and cite; where you have no command, write "I think," not "X says."
- Do not decide #9 or change any recorded decision; name any decision you lean against.
- Lead with a plain-language summary for a non-developer owner, then the detail.
```
