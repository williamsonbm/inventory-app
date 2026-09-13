---
name: writing-commits-and-prs
description: Rules for writing commit messages, PR titles, PR descriptions, and PR comments in this repo — trailer bans, ASD-STE100 phrasing, Conventional Commits, grade-token escaping, and a gh pr create token gotcha. Use whenever drafting or editing a commit message, PR title, PR body, or PR comment in inventory-app.
---

# Writing commits and PRs

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
