# inventory-app

Neutral ground for merging two existing systems — the **materials planner** (Node and Express,
no database) and **hanger-web-app** (Postgres, live in production) — into one app for one client.

Both source repos are siblings of this one and are the primary reference material for every
decision made here. Under the `claude-pod` alias they are at `/workspace/`; elsewhere the path
differs, so resolve it before you trust it.

## Working style — non-developer owner, lean by default

- **Two layers.** Lead with a plain-language **Bottom line**; put technical detail in a
  skippable **Details** section. Define a term in parentheses the first time it appears.
- **Concise, and at the scope asked.** Lead with the answer; keep caveats short. Make routine
  calls yourself; flag a better approach in a sentence rather than quietly widening the task.
- **Delete before you add.** Resist new files, dependencies, and status docs unless they
  clearly earn their keep.
- **Spec before code for a feature.** `/to-spec` publishes it to the tracker as an issue;
  implement the logic with `/tdd`; run `/simplify`, then `/code-review`, on the diff before
  asking to commit.
- **State test results plainly** — real counts, real pass/fail, never "should pass".

## Writing code

`docs/CODING-STANDARDS.md` — the seams that make code testable, which changes need a test, dead
code, and the Vercel and Postgres rules. Read it before writing, reviewing, or testing code.

## Writing commits and PRs

See the `writing-commits-and-prs` skill (`.claude/skills/writing-commits-and-prs/SKILL.md`) —
trailer bans, ASD-STE100 phrasing, Conventional Commits, grade-token escaping, and the
`gh pr create` token gotcha.

## Hard constraints — do not break these

- **Siblings are read-only.** Read and grep `hanger-web-app` and `materials-planner` freely;
  changing them is the owner's job. Some environments enforce this and some do not, so the rule,
  not the filesystem, is what holds.
- **Feature branch and a PR.** `main` takes no direct push and no force push. A hook stops it,
  but treat the hook as a floor: under relaxed permissions an `ask` becomes a log line and the
  command proceeds.
- **Ask before committing or pushing.** The owner drives that decision every time.
- **Secrets stay out of the transcript.** `.env*`, `/keys/*` and private-key material.

## The effort — read before planning work

`../materials-planner/docs/handoff-inventory-app-wayfinder.md` carries the framing and the
working agreement. Read it first, with two corrections.

**One of its findings is wrong.** It says "only lumber and LVL are genuinely absent from the web
app." Lumber is **live in production**, backed by 18 `/api/lumber/*` routes and its own schema —
built-but-bypassed, not missing. LVL is the only thin family: one route, modelled inside EWP,
while the planner treats it as first-class (`src/lvl/`).

Presence is not the question — **quality is**. The planner's lumber parser has more utility and
better visibility than the web app's. So for each family where both exist, the real question is
which implementation wins, and the answer will not always be the web app's.

**Hosting is settled and the handoff predates it.** The rebuild runs on Vercel with Supabase
Postgres, starting from the materials planner (#10, #12). Web app access control today is
Tailscale injecting a `tailscale-user-login` header; Vercel removes it, so a login gets built
(#6).

## Vocabulary

`CONTEXT.md` is this repo's glossary; `hanger-web-app/CONTEXT.md` is canonical for inherited
terms, including the job lifecycle. Use those terms; do not coin a third dialect. Two overrides
live in `CONTEXT.md` and both bind here: it is the **materials planner**, never the "laptop
planner"; and **never the bare word "stock"** — name the quantity.

## Reference docs

- `docs/research/` — the Vercel and Supabase assessment, the managed-Postgres comparison, and
  the `hanger-web-app` schema survey. Read the relevant one before designing against the
  platform or the database: they carry the numbers, the sources, and the access dates.
- `CONTEXT.md` and `docs/adr/` — the glossary and the accepted decisions. See
  `docs/agents/domain.md`.
- `docs/agents/issue-tracker.md` — issues live as GitHub issues in `williamsonbm/inventory-app`,
  driven via `gh`. Includes the wayfinder map, sub-issue and dependency mechanics.
- `docs/agents/triage-labels.md` — the five triage label strings.
