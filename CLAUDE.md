# inventory-app

Neutral ground for merging the materials planner (Node/Express, no database) and hanger-web-app (Postgres, live in
production) for one client. Both sibling repos are primary references. Resolve their paths;
under `claude-pod` they are at `/workspace/`.

## Working style — non-developer owner, lean by default

- **Two layers.** Plain-language **Bottom line**, skippable **Details**. Define terms in
  parentheses on first use.
- **Concise, at the scope asked.** Answer first; short caveats. Make routine calls yourself.
  Flag a better approach; do not quietly widen the task.
- **Delete before you add.** New files, dependencies and status docs earn their keep.
- **Try the simpler thing first, and say you did.** Before new machinery, test the version
  without it; report both results. Name inherited assumptions before building on them.
- **Spec before code for a feature.** The owner runs `/to-spec` — agents cannot — to put the
  spec in a tracker issue. Implement logic with `/tdd`; then `/simplify`, re-run tests, `/code-review` the diff,
  ask to commit. `/simplify` is this repo's refactor stage, including where `tdd` says
  "the review stage"; it can break passing code.
- **State test results plainly** — real counts, real pass/fail, never "should pass".

## Getting facts right

Four rules from real mistakes. Not optional.

- **Re-derive after a scope change.** List and recheck facts inherited from removed scope.
  An EWP-derived field list survived the EWP tab's removal; all four surviving pages would
  have rejected every sheet.
- **A claim carries its command, or it says it is a guess.** Quote the output. Without a
  command, write "I think", not "X says". A run predicted at 40 minutes measured at 98 seconds.
- **Test a borrowed rule here before it ships.** Sibling rules belong to those repos.
  "Assertion messages go third" fails for `assert.ok`, used 110 times in the source.
- **Grep a new rule against the document that states it.** One commit fixed four glossary
  entries; the next repeated the defect two lines below.

## Writing code

Read `docs/CODING-STANDARDS.md` before writing, reviewing or testing code. Database and
access-control rules stay in #28 until the database slice starts.

**Precedence.** Recorded decisions in `docs/CODING-STANDARDS.md`, `CONTEXT.md` and accepted
ADRs beat generic skill advice; an ADR wins between them. A task may change a decision:
name the departure first. Nothing overrides **Hard constraints**, commit trailer bans or
`Safety`. Answer each `/code-review` finding on its merits or name the recorded decision
that covers it.

**Review lens: correctness before style.** You own wrong-output and edge-case bugs; naming
and formatting rank last.

## Writing commits and PRs

Read `.claude/skills/writing-commits-and-prs/SKILL.md` before writing either.

## Hard constraints — do not break these

- **Siblings are read-only.** Read and grep freely; changes are the owner's job, regardless
  of filesystem enforcement.
- **Feature branch and a PR.** No direct or force push to `main`. `.git/hooks/pre-push`
  enforces this however git is invoked; `--no-verify` skips it. Claude Code's `ask` can become only a log line
  under relaxed permissions.
- **Ask before committing or pushing.** The owner decides every time.
- **Secrets stay out of the transcript.** `.env*`, `/keys/*` and private-key material.

## The effort — read before planning work

Read the planning corrections and handoff instructions in `docs/agents/domain.md` before
planning; they correct the handoff's family coverage and hosting assumptions.

## Vocabulary

`CONTEXT.md` is this repo's glossary; `hanger-web-app/CONTEXT.md` is canonical for inherited
terms, including the job lifecycle. No third dialect. Both local overrides bind:
**materials planner**, never "laptop planner"; **never bare "stock"** — name the quantity.

## Reference docs

Read relevant `docs/research/` before platform or database design; `CONTEXT.md`,
`docs/adr/` and `docs/agents/domain.md` for domain decisions; `docs/agents/issue-tracker.md`
and `docs/agents/triage-labels.md` before tracker work.
