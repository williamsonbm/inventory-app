# Coding standards

How code is written in this repo. `/code-review` already carries a twelve-smell baseline that
covers naming, duplicated logic and speculative abstraction. This file carries what it does not.

**Review lens: correctness before style.** Lead with wrong-output and edge-case bugs. Naming and
formatting rank last.

## Seams

- **Logic lives in a module with exports. A route handler calls it and shapes the response.**
  A handler reads on one screen.
- **One code path per operation.** Material families differ in data — a table keyed by family —
  not in a branch or a copy per family.
- **Resolve a fact once and pass the result.** Identity, role and mode are decided in one place.
  Call sites receive the answer.
- **A rule that spans routes lives in middleware.** Write-lock checks, transaction wrappers and
  error shaping are applied once.

## Readers

Every export has a caller. Every returned field has a reader. Every column and every flag has a
reader. In the same diff.

- **A replacement ships with the deletion it replaces**, in the same PR.
- **An API path appears at its caller as one complete literal string**, so `grep` finds every
  caller of a route.
- **Cite code by symbol name.** Line numbers go stale inside a session.

## Tests

A test is required for **logic**, not for **glue**.

- **Logic** — parsers, planners, quantity math, date windows, anything with a return value worth
  getting wrong. Required.
- **Glue** — route registration, config loading, static file serving, a one-line pass-through.
  Not required.
- **A bug fix ships with a test that fails before the fix.**
- **A refactor's enabling test belongs to the refactor's own ticket**, never to a follow-up.
- **Code that cannot be tested says so in its own file header**, with the reason and what
  verifies it instead.
- Name the seams before writing tests. The `tdd` skill owns that loop and pulls in
  `codebase-design` for the vocabulary.

Mechanics:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
```

- Flat `test/`, one file per domain, named for the domain. No `describe()`.
- Every assertion carries a message as its third argument.
- An HTTP test boots the real app on an ephemeral port (`app.listen(0, ...)`) and calls it with
  `fetch()`. No test dependencies.
- **Expected values come from a worked example, the spec, or a known-good literal.** A test
  freezes its own copy of a constant and asserts the shipped constant against it. Do not paste in
  whatever the code returned.

## Drift

- **One type throughout a formula.** A window compared as `timestamptz` in one term and as
  `date` in another reports a quietly wrong quantity rather than an error: same-day work never
  deducts, and on hand stays overstated.
- **A change to purchasing data or to a seed constant is its own commit**, with a message that
  says so.
- **Code ported from a sibling stays byte-identical.** Document a deliberate divergence at the
  divergence.

## Platform

- **Nothing survives a request.** No module-scope cache, no local file. A function copy is
  short-lived and there are many of them.
- **4.5 MB caps a request body and a response body.** A file moves between the browser and
  storage directly; the app handles the reference.
- **One schema, and every database object fully qualified.** A transaction-mode pooler drops
  session state, so a query that leans on `search_path` returns silently wrong numbers.
- **No schema per material family** (#28).
- **Object names carry no environment suffix.** Environments are separate databases.
- **Scheduled or background work is a new architectural decision**, not a small addition.
- **A new dependency is a decision, named in the spec before it is added.** Write it, or reuse
  what exists, first.
- Plain JavaScript. No build step, no bundler.

Numbers and sources: `docs/research/vercel-and-supabase-for-the-rebuild.md`.

## Deliberately

A comment explains a **choice**, in three parts: the choice, flagged `deliberately`; the
alternative it rejects, named; and that alternative's cost, in specifics — a dependency count, a
wall-clock number, a named failure mode. `grep -rn deliberately src/` then lists every constraint
the code is holding.

## Words

Identifiers, column names, JSON fields and screen text use the `CONTEXT.md` term. Name the
quantity — on hand, committed, available.
