# inventory-app

One materials app for one client, built by merging two existing systems: the **materials
planner** (Node/Express, no database) and **hanger-web-app** (Postgres, live in production).
This repo is the neutral ground where that merge happens.

> **Not developer-owned.** The owner is a non-developer. Decisions are recorded before code is
> written, and the working agreement lives in [`CLAUDE.md`](CLAUDE.md). Read it first.

## Status (2026-09-29)

- **What runs today:** the materials planner, ported and stateless, as one **Planner** page
  with a section each for **lumber, plates, hangers, and LVL**. You drop in material-summary
  sheets for a batch of jobs and it shows what to buy. The Planner writes nothing.
- **Step 2 (#77):** each person signs in with their email address and a password the app keeps
  itself. **Settings** has **Users** (admins manage the list) and the **Activity log**. The
  database is Supabase Postgres: a users table and an activity log so far.
- **Not built yet:** the ledger (counts, receiving, availability, thresholds) and the rest of
  the UI redesign (#72: the Jobs and Inventory modes).
  The **EWP** optimizer page is deliberately excluded from the hosted app (see the Map, below).
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
| `src/app.js` | The whole app: sign-in in front of every route, then Settings and the Planner |
| `src/planner/` | The Planner's Express app, its page (`planner.html`), one section file per family (`<family>-section.js`), and the shared UI (`planner-ui.js`, `planner.css`) |
| `src/auth/`, `src/settings/` | Sign-in, passwords and the session cookie; the Users and Activity log pages and routes |
| `src/db/`, `migrations/` | The database connection, the migration runner, the first-user setup, and the numbered schema files |
| `test/` | Node test suites and sheet fixtures |
| `docs/adr/` | Accepted decisions (start with ADR 0001) |
| `docs/research/` | Platform, database, and schema assessments — the numbers behind the decisions |
| `docs/agents/` | The domain model, the issue-tracker map, and session handoffs |
| `docs/runbook.md` | The owner's steps: setting up the database, the first user, signing everyone out, and restoring a backup |
| `CONTEXT.md` | The glossary — the words this project uses, and two it forbids |

## Run it

```sh
npm install
npm start      # the whole app at http://127.0.0.1:3000, on a local practice database (inv_local)
npm test       # node --test; needs a Postgres too (TEST_DATABASE_URL)
```

Both need a Postgres 17. In the pod, run `pg-test-up`. On your own computer, start one in a
container once; it keeps its data until you remove it:

```sh
podman run -d --name inv-postgres -p 127.0.0.1:5432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -v inv-postgres:/var/lib/postgresql/data docker.io/library/postgres:17
podman start inv-postgres   # after a restart of the computer
```

The first `npm start` prints the command that adds you as the first admin. The local database
is for trying the app by hand; the deployed app uses Supabase (`docs/runbook.md`).

Node 22.x. Runtime dependencies: Express, `pg` and `@vercel/functions` (#77).

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
