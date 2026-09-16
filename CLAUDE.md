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
- **Try the simpler thing first, and say you did.** Before adopting an approach that needs new
  machinery — a new module, a new file, a new dependency — test whether the version without it
  works. Report both results, not only the one you chose. `/simplify` runs after code exists;
  this applies before it. An approach inherited from a spec, a research document or another
  agent carries its author's assumptions: name the premise before you build on it.
- **Spec before code for a feature.** The spec goes to the tracker as an issue — the owner runs
  `/to-spec`, which an agent cannot invoke. Then implement the logic with `/tdd`; then
  `/simplify`, re-run the tests, and `/code-review` the diff before asking to commit. Simplifying
  can break what passed before it, and `/simplify` is this repo's refactor stage — where `tdd`
  says "the review stage", read `/simplify`.
- **State test results plainly** — real counts, real pass/fail, never "should pass".

## Getting facts right

Four rules, each from a real mistake made in this repo. They cost seconds and they are not
optional.

- **Re-derive after a scope change.** When a decision removes part of the system, every recorded
  fact that came from the removed part is suspect. List those facts and check them again. A field
  list read off the EWP parser outlived the EWP tab's removal, and following it would have made
  all four surviving pages reject every sheet.
- **A claim carries its command, or it says it is a guess.** Quote the output that produced it.
  Where there is no command, write "I think", not "X says". Confident arithmetic is where this
  repo's wrong answers have come from: a run predicted at 40 minutes measured at 98 seconds.
- **Test a borrowed rule here before it ships.** A rule copied from `materials-planner` or
  `hanger-web-app` was written for that repo. "Every assertion carries a message as its third
  argument" is wrong for `assert.ok`, which the source repo uses 110 times.
- **Grep a new rule against the document that states it.** A rule is easiest to break in its own
  file. One commit fixed four glossary entries, and the next reintroduced the same defect two
  lines below the fix.

## Writing code

`docs/CODING-STANDARDS.md` — the seams that make code testable, which changes need a test, dead
code, and the Vercel and Postgres rules. Read it before writing, reviewing, or testing code.
The database and access-control rules live in #28 until the database slice starts.

**Precedence.** Where a skill's generic advice conflicts with a decision recorded in
`docs/CODING-STANDARDS.md`, in `CONTEXT.md`, or in an accepted ADR, the recorded decision wins;
between those three, an ADR wins. A task can ask you to change a recorded decision, but not to
ignore one silently — name the decision you are departing from before you depart. Nothing here
overrides **Hard constraints**, the commit trailer bans, or `Safety`.

A `/code-review` finding is not generic advice. It is a claim about this diff: answer it on the
merits, or record why a recorded decision covers it.

**Review lens: correctness before style.** Lead with wrong-output and edge-case bugs. Naming and
formatting rank last. Note that no skill in the pipeline hunts bugs — `/simplify` disclaims it and
`/code-review` checks conformance — so this is yours to carry.

## Writing commits and PRs

See the `writing-commits-and-prs` skill (`.claude/skills/writing-commits-and-prs/SKILL.md`) —
trailer bans, ASD-STE100 phrasing, Conventional Commits, grade-token escaping, and the
`gh pr create` token gotcha.

## Hard constraints — do not break these

- **Siblings are read-only.** Read and grep `hanger-web-app` and `materials-planner` freely;
  changing them is the owner's job. Some environments enforce this and some do not, so the rule,
  not the filesystem, is what holds.
- **Feature branch and a PR.** `main` takes no direct push and no force push.
  `.git/hooks/pre-push` enforces this however git is invoked, your own terminal included, and only
  `--no-verify` skips it. A Claude Code `ask` fires first, but under relaxed permissions it
  becomes a log line — `pre-push` is the layer that stops it.
- **Ask before committing or pushing.** The owner drives that decision every time.
- **Secrets stay out of the transcript.** `.env*`, `/keys/*` and private-key material.

## The effort — read before planning work

`../materials-planner/docs/handoff-inventory-app-wayfinder.md` carries the framing and the
working agreement. Read it first, with two corrections. It is pod-local: `docs/` is gitignored in
that sibling, so the file is in no clone.

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
