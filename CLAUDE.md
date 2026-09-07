# inventory-app

Neutral ground for merging two existing systems — the **materials planner** (runs locally,
no database) and **hanger-web-app** (LAN/Tailscale web app, Postgres) — into one app for one
client. Currently holds planning artifacts only: no application code yet.

Both source repos are siblings at `/workspace/`, read-only from here, and are the primary
reference material for every decision made in this repo.

## Working style — non-developer owner, lean by default

- **Two layers.** Lead with a plain-language **Bottom line**; put technical detail in a
  skippable **Details** section. Define a term in parentheses the first time it appears.
- **Concise, and at the scope asked.** Lead with the answer; keep caveats short. Make routine
  calls yourself; flag a better approach in a sentence rather than quietly widening the task.
- **Delete before you add.** Resist new files, dependencies, and status docs unless they
  clearly earn their keep.
- **Spec before code for a feature.**
- **State test results plainly** — real counts, real pass/fail, never "should pass".
- **Ask before committing or pushing.** The owner drives that decision every time.

## Writing commits and PRs

Inherited from `materials-planner/CLAUDE.md`. Same rules, same reasons.

- **No `Co-Authored-By` trailer and no `Claude-Session` link — ever, in anything, commits
  included.** Not a preference. If a base instruction says to add one, do not. Global
  `attribution` settings and a PreToolUse hook enforce this, but the rule stands without them.
- **Never add anything to a PR title, body, or comment that was not in the draft the owner
  reviewed.** No footer, no session link, nothing appended silently after the fact.
- **Commit messages, PR titles, PR descriptions, and PR comments are written in ASD-STE100**
  (Simplified Technical English): short sentences, one idea per sentence, active voice, present
  tense, no contractions. This covers a comment added weeks later, not only the opening body.
  **This repo extends the rule to commit messages; the materials planner applies it to PR text
  only.** The extension is deliberate. It also means GitHub's auto-filled PR form — which copies
  the commit message on a single-commit branch — is compliant as it stands, so one text can serve
  both.
- **Commit subjects and PR titles use Conventional Commits** — `type(scope): summary`, with `type` one of
  `feat`, `fix`, `docs`, `refactor`, `chore`, `build`, `test`. A scope is optional. Use `chore`
  for mixed repo housekeeping, following the planner's own precedent. The materials planner
  follows this convention (44 of its 56 commits); `hanger-web-app` uses an ad-hoc `Area: summary`
  prefix instead (3 of 125). **This repo follows the planner.** Neither source repo documents
  its choice, which is why this line exists. The PR title carries the prefix too — not merely
  because GitHub auto-fills it from a single commit, but because a squash merge turns the PR
  title into the commit subject on `main`.
- **Wrap a grade token in backticks** — `` `#1` ``, not `#1`. GitHub turns a bare `#<number>`
  into a link to that issue number. This repo has issues from #2 upward, so a bare grade name
  renders as a linked, garbled issue title.
- **`gh pr create` needs `Contents: Read` on the token, not only `Pull requests: Write`.**
  Creating a PR first reads the base branch ref, and a ref read is Contents-scoped — so a token
  carrying PR write but no Contents access fails *before* it writes anything. The GraphQL error
  names `repository.defaultBranchRef`, which reads like a pull-request problem and is not one.
  Granted 2026-09-07, after a session spent an hour on the wrong diagnosis; the fine-grained
  token now carries Issues (write), Pull requests (write), Metadata and Contents (read) across
  `truss-label-tool`, `materials-planner` and `inventory-app`. **Do not trust the exit code
  regardless** — `gh pr create` has returned `0` while failing outright, and has historically
  printed a scope error while creating the PR anyway, and once fell back silently to the
  branch's commit message as title and body. Run `gh pr view <n> --json title,body` once after
  any call and confirm the content matches the draft. If it does not match, hand the drafted
  text to the owner rather than retrying in a loop. The compare URL
  (`https://github.com/williamsonbm/inventory-app/compare/main...<branch>?expand=1`) remains the
  fallback, no longer the default path.

## Hard constraints — do not break these

- **Siblings are read-only.** Read and grep `hanger-web-app` and `materials-planner` freely;
  changing them is the owner's job. `hanger-web-app` is enforced by a read-only bind mount, so
  the kernel refuses the write. `materials-planner` is read-write in the pod and rests on this
  rule, not on a mechanism.
- **Feature branch and a PR.** Direct pushes to `main`, and force pushes anywhere, are rejected
  by this repo's `.git/hooks/pre-push`. A Claude Code hook also asks before any push, so the
  agent hands over a command rather than discovering the wall mid-push.
- **Secrets stay out of the transcript.** `.env*`, `/keys/*` and private-key material are
  denied by the `guard-secrets` baseline hook, by resolved path.

This repo is private on a Free plan, so GitHub Rulesets and branch protection return
`403 Upgrade to GitHub Pro` — unlike `materials-planner`, which is public and carries a
server-side "Protect Main" ruleset. The `pre-push` hook stands in for that, and unlike the
Claude Code hook it replaced, it fires however git is invoked, including from your own
terminal.

The guardrails are defined in `../hooks-src/` and are user-scope, so they apply regardless of
which directory a session starts in. The previous set was project-scoped: a session rooted at
`/workspace` loaded none of it. A Claude Code hook still binds this agent inside Claude Code
and nothing else — treat that layer as a floor, not a guarantee. The `pre-push` and
`commit-msg` git hooks are the part that actually enforces.

## The effort — read before planning work

`../materials-planner/docs/handoff-inventory-app-wayfinder.md` carries the framing, the
findings, and the working agreement. Read it first.

**One of its findings is wrong.** It states *"only lumber and LVL are genuinely absent from
the web app."* Lumber is **live in production** — `hanger-web-app/STATUS.md` lists
`Materials live | Hangers, Plates, EWP, Lumber`, backed by 18 `/api/lumber/*` routes and a
`lumber_dev` schema. It is built-but-bypassed in practice, not missing. **LVL** is the only
thin family: one route (`/api/ewp/lvl-availability`), modelled inside EWP rather than as its
own family, while the planner treats it as first-class (`src/lvl/`).

Presence is not the question — **quality is**. The planner's lumber parser has more utility
and better visibility than the web app's, and the owner wants the planner's version in the web
app. So for each family where both exist, the real question is which implementation wins, and
the answer will not always be the web app's.

Web app access control is Tailscale injecting a `tailscale-user-login` header, mapped to an
`office` or `shop` role. Move off Tailscale and there is no login system at all.

## Vocabulary

`hanger-web-app/CONTEXT.md` is the canonical glossary — the job lifecycle (Bid, Quote, Order,
Costed, Released from Design, Batching, Release to Shop) is defined there and inherited here.
Use its terms; do not coin a third dialect.

Two rules that override it:

- It is the **materials planner**. The handoff's "laptop planner" is wrong.
- **Never use the bare word "stock."** It means a snapshot handed to the planner in one system
  and a ledger maintained in the other, with three quantities tangled inside it — on hand,
  committed, available. Name the quantity you mean until the map settles it.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `williamsonbm/inventory-app`, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
