# inventory-app

Neutral ground for merging two existing systems — the **materials planner** (runs locally,
no database) and **hanger-web-app** (LAN/Tailscale web app, Postgres) — into one app for one
client. Currently holds planning artifacts only: no application code yet.

Both source repos are siblings of this one, read-only from here, and are the primary reference
material for every decision made in this repo. Under the `claude-pod` alias they are at
`/workspace/`. That path is the alias's bind mount, not a fact about the repos — the Claude
Desktop container holds the same repos under `~/Projects/claude-sandbox/`. **Resolve the path
before you trust it**; a session that assumes `/workspace/` concludes the repos are missing.

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

See the `writing-commits-and-prs` skill (`.claude/skills/writing-commits-and-prs/SKILL.md`) for
the full rules — trailer bans, ASD-STE100 phrasing, Conventional Commits, grade-token escaping,
and the `gh pr create` token gotcha. Inherited from `materials-planner/CLAUDE.md`.

## Hard constraints — do not break these

- **Siblings are read-only.** Read and grep `hanger-web-app` and `materials-planner` freely;
  changing them is the owner's job. **The rule holds everywhere. The mechanism that enforces it
  does not.** Under `claude-pod`, `hanger-web-app` is bind-mounted `:ro` and the kernel refuses
  the write, while `materials-planner` is read-write and rests on the rule alone. The `:ro` is a
  flag on that one alias, not a property of the repository: in the Claude Desktop container there
  is no such flag, and a write to `hanger-web-app` succeeds — confirmed by test 2026-09-13.
  Outside `claude-pod`, **both siblings rest on the rule alone.** So treat the kernel as a floor
  you cannot count on, the same way this file treats the Claude Code `ask` hook, and verify the
  mount rather than assume it.
- **Feature branch and a PR.** Direct pushes to `main`, and force pushes anywhere, are rejected
  by this repo's `.git/hooks/pre-push`, which fires however git is invoked. A Claude Code hook
  also asks before any push, so the agent hands over a command rather than discovering the wall
  mid-push — but **an `ask` is a no-op when permissions are relaxed**: it logs to
  `~/.claude/hook-decisions.jsonl` and the command proceeds. `pre-push` is the layer that
  actually stops it. Confirmed 2026-09-07, both directions: `guard-push` logged `ask` on two
  pushes that then went through unprompted, and two direct `git push origin main` attempts were
  logged the same way and stopped by `pre-push`, not by the ask.
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
