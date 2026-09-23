# inventory-app

One materials app for one client, built by merging two existing systems: the **materials
planner** (Node/Express, no database) and **hanger-web-app** (Postgres, live in production).
This repo is the neutral ground where that merge happens.

> **Not developer-owned.** The owner is a non-developer. Decisions are recorded before code is
> written, and the working agreement lives in [`CLAUDE.md`](CLAUDE.md). Read it first.

## Status (2026-09-21)

- **What runs today:** the materials planner, ported and stateless — four buy-list pages for
  **lumber, plates, hangers, and LVL**. You drop in material-summary sheets for a batch of jobs
  and it shows what to buy. It has **no database** and writes nothing.
- **Not built yet:** the database (the ledger — counts, receiving, availability, thresholds),
  a login, and the UI redesign. The **EWP** optimizer page is deliberately excluded from the
  hosted app (see the Map, below).
- **Target:** a ground-up rebuild on **Vercel + Supabase**, starting from the planner and adding
  the database family by family.

## The two source systems

Both are sibling repositories and are **read-only** from here — they are reference material, not
code to change.

- `../materials-planner` — Node/Express, no database, runs locally. The current base.
- `../hanger-web-app` — Postgres, LAN/Tailscale, live in production. The source of the stateful
  "ledger" model the rebuild absorbs.

Under the `claude-pod` alias both sit at `/workspace/`; elsewhere the path differs, so resolve it.

## Layout

| Path | What it holds |
|---|---|
| `src/lumber/`, `src/plates/`, `src/hangers/`, `src/lvl/`, `src/ewp/` | Per-family sheet parsers and buy-list planners |
| `src/planner/` | The Express server, the four HTML pages, and the shared UI (`planner-ui.js`, `planner.css`) |
| `test/` | Node test suites and sheet fixtures |
| `docs/adr/` | Accepted decisions (start with ADR 0001) |
| `docs/research/` | Platform, database, and schema assessments — the numbers behind the decisions |
| `docs/agents/` | The domain model, the issue-tracker map, and session handoffs |
| `CONTEXT.md` | The glossary — the words this project uses, and two it forbids |

## Run it

```sh
npm install
npm start      # node src/planner/server.js
npm test       # node --test
```

Node 22.x. The only runtime dependency is Express.

## How this repo makes decisions

Work is charted as GitHub issues in `williamsonbm/inventory-app`, driven with `gh`. The
**Map** ([#2](https://github.com/williamsonbm/inventory-app/issues/2)) is the index: standing
scope decisions, and one line per closed ticket. Feature work is specified before it is built
(a `/to-spec` issue), implemented test-first, then simplified and reviewed. Domain terms are
settled in `CONTEXT.md` and decisions in `docs/adr/` before they reach code.

## Contributing constraints

- The sibling repos are **read-only**.
- `main` takes **no direct push and no force push** — use a feature branch and a PR. A
  `pre-push` hook enforces this.
- **Ask before committing or pushing.** The owner decides every time.
- Keep secrets out of the repo and the transcript (`.env*`, `/keys/*`, private keys).

Start here: [`CLAUDE.md`](CLAUDE.md), then [`CONTEXT.md`](CONTEXT.md), then
[`docs/agents/domain.md`](docs/agents/domain.md).
