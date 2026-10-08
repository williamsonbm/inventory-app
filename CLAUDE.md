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
  spec in a tracker issue. Implement logic with `/tdd`; then `/simplify`, re-run tests, ask
  to commit. A fresh Opus session reviews the PR; run `/code-review` in the authoring session
  only when asked. `/simplify` is this repo's refactor stage, including where `tdd` says
  "the review stage"; it can break passing code.
- **State test results plainly** — real counts, real pass/fail, never "should pass".
- **Short replies to the owner.** Under 300 words, at most 3 questions per reply. Log every
  question, recommendation and answer in the open-questions memory, numbered continuously.
- **Say it, then do it.** If a reply says work is starting, it makes the first tool call in the
  same reply. Otherwise say what waits and why.
- **Show exact PR or issue text before posting.** A yes to "reply on the PR" approves the
  action, not wording the owner has not seen.

## Getting facts right

Five rules from real mistakes. Not optional.

- **Re-derive after a scope change.** List and recheck facts inherited from removed scope.
  An EWP-derived field list survived the EWP tab's removal; all four surviving pages would
  have rejected every sheet.
- **A claim carries its command, or it says it is a guess.** Quote the output. Without a
  command, write "I think", not "X says". A run predicted at 40 minutes measured at 98 seconds.
- **Test a borrowed rule here before it ships.** Sibling rules belong to those repos.
  "Assertion messages go third" fails for `assert.ok`, used 110 times in the source.
- **Grep a new rule against the document that states it.** One commit fixed four glossary
  entries; the next repeated the defect two lines below.
- **Read large files by range.** For a file over ~300 lines (migrations, `test/*.test.js`),
  `grep -n` for the symbol, then read only that range. Do not read one file twice in a session.
  For a long issue, fetch the section you need. One session read `004-purchase-orders.sql` whole
  three times, which added about 40K tokens.

## Writing code

Read `docs/CODING-STANDARDS.md` before writing, reviewing or testing code. It holds the
database and access-control rules too.

**Precedence.** Recorded decisions in `docs/CODING-STANDARDS.md`, `CONTEXT.md` and accepted
ADRs beat generic skill advice; an ADR wins between them. A task may change a decision:
name the departure first. Nothing overrides **Hard constraints**, commit trailer bans or
`Safety`. Answer each review finding on its merits or name the recorded decision
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

## Vocabulary

`CONTEXT.md` is this repo's glossary; `hanger-web-app/CONTEXT.md` is canonical for inherited
terms, including the job lifecycle. No third dialect. Both local overrides bind:
**materials planner**, never "laptop planner"; **never bare "stock"** — name the quantity.

## Reference docs

Read relevant `docs/research/` before platform or database design; `CONTEXT.md`,
`docs/adr/` and `docs/agents/domain.md` for domain decisions; `docs/agents/issue-tracker.md`
and `docs/agents/triage-labels.md` before tracker work.
