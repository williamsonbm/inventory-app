# Coding standards

How code is written in this repo. `/code-review` already carries a twelve-smell baseline covering
naming, duplicated logic and speculative abstraction, so this file mostly carries what that
baseline does not. Where it does overlap — `Readers`, `Words`, one code path per operation — the
repo rule is the sharper one and is meant to bind; the baseline still applies everywhere else.

## Seams

- **Logic lives in a module with exports. A route handler calls it and shapes the response.**
  A handler reads on one screen.
- **One code path per operation.** Material families differ in data — a table keyed by family —
  not in a branch or a copy per family.
- **Identity, role and mode are decided in one place.** Call sites receive the answer; they do
  not re-derive it.
- **A cross-cutting request concern lives in middleware** — identity and request context,
  request-wide policy, consistent error shaping. Applied once.
- **A transaction wraps the business operation whose writes must be atomic**, not the request.
  Several routes may call that one operation.
- **A failure reports itself.** Queued is not delivered, and a discarded HTTP status is a silent
  failure.

## Readers

Every export has a caller. Every returned field has a reader. Every column and every flag has a
reader. In the same diff.

- **A replacement ships with the deletion it replaces**, in the same PR.
- **An API path appears at its caller as one complete literal string**, so `grep` finds every
  caller of a route.
- **Cite code by symbol name.** Line numbers go stale inside a session.

This binds what a diff **adds**. A port inherits existing violations: list them in the PR body and
fix them in a follow-up. A test counts as a caller only for a seam the file header names as
test-only.

## Tests

A test is required for **logic**, not for **glue**.

- **Logic** — parsers, planners, quantity math, date windows, anything with a return value worth
  getting wrong. Required.
- **Glue** — route registration, config loading, static file serving, a one-line pass-through.
  Not required.
- **Risk overrides size.** Wiring whose failure breaks correctness, security or atomicity gets an
  integration test however few lines it is: an authorization check, a transaction boundary, a
  route that moves quantities, or **a step that selects which input a calculation reads**.
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
- An assertion whose default failure message would not name what broke carries one — always for
  `assert.ok` and other predicate forms, where the message is the **second** argument. For the
  two-value forms it is the third, and `assert/strict` already prints a readable diff, so add one
  there only when the diff does not explain the invariant.
- `assert.throws` takes the expected error in slot two — a RegExp or a validator, **never a
  string**. A string there is read as the message and the error goes unchecked, so the test passes
  unconditionally.
- An HTTP test boots the real app on an ephemeral port (`app.listen(0, ...)`) and calls it with
  `fetch()`. No test dependencies.
- **Beyond `tdd`'s tautological anti-pattern: a test freezes its own copy of a constant** and
  asserts the shipped constant against it. Do not paste in whatever the code returned.
- **A port is the one exception**, and only for proving it. A recorded-output test captured from
  the pre-port build is legitimate; its header names the commit it was captured from and the
  options that make the output deterministic.

## Drift

- **One type throughout a formula.** A window compared as `timestamptz` in one term and as
  `date` in another reports a quietly wrong quantity rather than an error: same-day work never
  deducts, and on hand stays overstated.
- **A change to purchasing data or to a seed constant is its own commit**, with a message that
  says so.
- **Numbers state their unit, precision and rounding** — quantities and money alike. Decide the
  rounding; do not inherit whatever floating point does.
- **A port lands byte-identical** in its behaviour-bearing modules, so the change that moves
  behaviour never also changes it. New wiring the platform requires is not a divergence. Improve
  it afterwards in its own change, and say at the divergence why it now differs.

## Platform

- **Correctness never depends on a process outliving a request.** Vercel shares one instance
  across concurrent invocations, so immutable constants and one reusable client or pool at module
  scope are correct — a per-request pool multiplies connections. Keep that pool to 1 or 2 per
  instance (#28).
- **Module-scope mutable state is never a channel between two requests.** Configuration written
  from a request body is that channel even when it is reset at the top of each call: add one
  `await` and two concurrent requests cross-contaminate. Read-only files shipped in the deployment
  are fine; the writable filesystem is scratch, never authoritative for data.
- **A function has a wall-clock ceiling.** Name it in the spec and measure the slowest real
  request against it before porting a handler.
- **4.5 MB caps a request body and a response body.** A file moves between the browser and
  storage directly; the app handles the reference.
- **One schema, and every database object fully qualified.** #28 allows either; this repo
  requires both, because on day one it costs nothing. A transaction-mode pooler drops session
  state, `search_path` included, so an unqualified name resolves against whatever path comes
  back: an error if nothing matches, and a *different same-named object* if something does.
- **No schema per material family** (#28).
- **Object names carry no environment suffix** (#21). Environments are separate databases.
- **Scheduled or background work is a new architectural decision**, not a small addition.
- **A new dependency is a decision, named in the spec before it is added.** Write it, or reuse
  what exists, first.
- Plain JavaScript. No build step, no bundler, no static analyser — `node --test` is the gate.
  Generic advice to add typechecking is not authority to introduce TypeScript or a compiler.

Numbers and sources: `docs/research/vercel-and-supabase-for-the-rebuild.md`.

## Deliberately

A comment explains a **choice**, in three parts: the choice, flagged `deliberately`; the
alternative it rejects, named; and that alternative's cost, in specifics — a dependency count, a
wall-clock number, a named failure mode. `grep -rni deliberately src/` then lists every constraint
the code is holding.

Reserve it for a choice a competent reader would otherwise try to simplify away. When the
explanation outgrows a short comment, it is an ADR.

## Words

Check `CONTEXT.md` before you introduce or rename a domain concept, an identifier, a table or
column, a JSON field, or screen text. It carries the terms, the scope of the rule, and the two
overrides. Name the quantity — on hand, committed, available.

This binds new code. Ported code keeps the names it arrives with — note them in the PR rather
than renaming inside a port.
