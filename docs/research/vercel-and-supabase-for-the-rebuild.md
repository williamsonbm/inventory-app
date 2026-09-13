# Vercel and Supabase for the rebuild

- **Ticket:** section 4 is filed as
  [#28](https://github.com/williamsonbm/inventory-app/issues/28), labelled `wayfinder:task` and
  linked as a child of [#2](https://github.com/williamsonbm/inventory-app/issues/2). This
  document is not itself filed as a research ticket, because it was written outside the tracker
  (see *Access note* below).
- **Feeds:** [#10](https://github.com/williamsonbm/inventory-app/issues/10) (refactor vs.
  rebuild) and [#6](https://github.com/williamsonbm/inventory-app/issues/6) (login), and
  **revises** [#5](https://github.com/williamsonbm/inventory-app/issues/5) (managed Postgres).
- **Type:** research finding, not a decision record. The map (#2) still has to accept it.
- **Scope:** what hosting the rebuild on Vercel costs and constrains, and whether that changes
  the managed-Postgres answer. Does not provision anything. Does not pick a framework. Does not
  decide which family's implementation wins (that is
  [#9](https://github.com/williamsonbm/inventory-app/issues/9)).
- **Access date for every source below:** 2026-09-13. Vercel and Supabase pricing and limits
  change often — re-check before acting on this if it is more than a few months old.
- **How this was verified:** claims about `hanger-web-app` and `materials-planner` were read
  directly out of the source in this session and are cited by file and line. Claims about
  Vercel and Supabase product limits were written from memory, then **checked against the
  live vendor documentation on 2026-09-13** by a later session that could reach it. All four
  marked claims held; two turned out to be narrower than stated and are corrected in place. The
  pages used are listed under *Vendor sources*.

## Access note — why no ticket number

This session ran inside the Claude Desktop app's own container (`ubuntu:24.04`, named
`claude-desktop`), not the `claude-sandbox:latest` container the `claude-pod` alias starts. The
GitHub CLI, the deploy keys and `GH_TOKEN` are all wired into `claude-pod` and are absent from
the desktop container, so no issue could be filed or read. See *Corrections to `CLAUDE.md`* at
the end — the same root cause explains two wrong statements in that file.

---

## Bottom line

**The rebuild changes the answer. Vercel plus Supabase is a reasonable target, and it is a
materially safer bet than the lift-and-shift it first looked like.**

The original framing was "move `hanger-web-app` to Vercel." Assessed that way it looked bad:
the app's login would evaporate, its file imports would break, and its database connection
setup would misbehave in ways that corrupt data silently rather than erroring. Assessed as
**"build a new app on Vercel, starting from the planner, and carry functionality across
deliberately,"** three of those four problems stop being migration hazards and become design
decisions to get right once, at the start, in code that does not exist yet.

The one that survives is the **database connection problem**, and it survives in a much
reduced form. It is worth its own ticket. It is not worth delaying the start.

**On the provider question:** going to Vercel does flip the recommendation from Neon to
Supabase — but for a narrower reason than "Supabase is better." As a database, Neon is still
the better buy for this workload, exactly as [#5](https://github.com/williamsonbm/inventory-app/issues/5)
found. What changes is that the rebuild needs a login system built from nothing, and Supabase
ships one that is already wired to the database the app is using. That is worth paying for.
The database comparison did not change; a second requirement appeared that Supabase answers
and Neon does not.

**On cost:** Vercel Pro is **$20/month per seat, and a seat is someone who manages or deploys
the app — not someone who uses it.** Office staff opening the app in a browser cost nothing and
need no Vercel account. For one person managing it, that is $20/month, plus Supabase at $25/month.

## 1. What changed since #5 recommended Neon

Ticket [#5](https://github.com/williamsonbm/inventory-app/issues/5) recommended Neon, and named
precisely one scenario that would flip it:

> The one scenario that would make it the *better* choice is [...] #10 landing on rebuild
> together with #6 wanting a hosted login system.

**Both halves are now true.** The owner has settled on a ground-up rebuild rather than a
refactor, starting from `materials-planner`, hosted on Vercel, with access control and audit
built in from the first slice. That is #10 landing on rebuild. And hosting on Vercel *forces*
#6, because the current access-control mechanism cannot survive the move — see §3.

So this is not a reversal of #5. It is #5's own stated condition being met. That doc should
stay as written and gain a pointer to this one.

**What did not change:** Neon is still cheaper ($5–20/month against a $25 floor) and still
includes point-in-time recovery that Supabase charges $100/month for. Anyone comparing the two
*as databases* should still reach Neon. The recommendation below is not a claim that Supabase's
Postgres is better. It is a claim that a bundled, already-integrated login system is worth more
to this project than the price difference — roughly $5–20/month — and that is a judgement about
the project, not about the databases.

**The honest counter-argument**, which should be recorded rather than buried: an authentication
service can be added next to any database. Choosing Neon and adding a separate auth provider is
a real option and is not much harder. The case for Supabase is that one vendor, one dashboard
and one set of credentials is worth something concrete to a non-developer owner maintaining
this alone. If that convenience turns out not to materialise in practice, the decision is
cheap to revisit early and expensive to revisit late.

Supabase's side of the cost comparison was re-checked on 2026-09-13 and holds: Pro is "from
$25/month" and includes $10 of compute credits, backups are daily with 7-day retention, and
point-in-time recovery is a $100/month add-on per 7 days of retention. The Neon figures are #5's
and were not re-checked here.

## 2. Vercel pricing — what a seat is

This was a direct question and it has a clean answer.

| | Cost | Who needs one |
|---|---|---|
| **Vercel seat (Pro)** | $20/month each | People who deploy, configure, or administer the project |
| **App user** | $0 | Everyone who just opens the app in a browser |

End users of a deployed site are visitors. They never hold a Vercel account, and traffic is
billed as bandwidth and compute, not per person. For an office of under ten people where one
person manages the deployment, the seat cost is **$20/month total**, not $20 × 10.

**Confirmed 2026-09-13:** "Developer seats cost **$20 per user / month**, while Viewer seats are
free." There is also a **Viewer** seat worth knowing about: free, unlimited, and it lets a person
read dashboards, deployments and analytics without being able to deploy or to see sensitive data.
So a second person can watch the deployment without adding $20.

**The Hobby (free) tier is not an option here.** Vercel's terms restrict Hobby to
non-commercial use, and this is a business application for a client. Budget for Pro from the
start rather than discovering the restriction after go-live.

**Confirmed 2026-09-13:** "the Hobby plan restricts users to non-commercial, personal use only,"
stated in the Hobby plan page and sourced there to the fair-use guidelines on commercial usage.

Note that Vercel seats and the app's own user accounts are unrelated. Building an access
control list with office and shop roles has no effect on the Vercel bill.

## 3. What Vercel actually constrains

Four things. Assessed against a **rebuild**, not a port.

### 3.1 Access control — forced, and that is fine

Today's mechanism: `hanger-web-app` binds to `127.0.0.1` and trusts a `tailscale-user-login`
header, which is safe only because the sole route in is the local `tailscaled` proxy. The
reasoning is written out at `hanger-web-app/server.js:448-456`.

On Vercel the app is on the public internet, and any client can send that header. **The
mechanism does not weaken — it stops existing.** Anyone could claim to be any office user.

For a port, that is a blocker. For a rebuild it is a requirement that was already on the list:
the owner wants a functioning ACL and audit trail in the first slice. Nothing is lost and
nothing needs a workaround. It does mean **authentication is slice one, not a later
hardening pass** — the app cannot be publicly deployed even once before it exists.

This is also the requirement that pulls Supabase ahead of Neon in §1.

### 3.2 File uploads — a design constraint to absorb now

`hanger-web-app` accepts job CSVs and packing-list PDFs as base64 inside a JSON body, capped at
10 MB (`hanger-web-app/server.js:445`). Vercel's functions cap request bodies at **4.5 MB**, and
the rejection happens at the platform layer where application code never sees it.

**Confirmed 2026-09-13, and the limit is broader than stated above:** 4.5 MB is the maximum for
"the request body **or the response body**" of a Vercel Function, and a breach returns
`413 FUNCTION_PAYLOAD_TOO_LARGE`. The response half matters here and was missed: any endpoint that
returns a whole file — a generated packing list, a CSV export — sits under the same ceiling as the
upload does. Vercel publishes a bypass guide for the limit, and it describes the direct-to-storage
pattern below.

Rebuilding means this is a choice rather than a breakage. The standard pattern is to upload the
file directly to object storage from the browser and hand the app only a reference to it.
Supabase includes storage, which is a second small argument for it. Worth deciding in the slice
that first accepts a file, not retrofitted.

### 3.3 Background work — currently none, keep it that way

Serverless functions run only while handling a request. A grep of `hanger-web-app/server.js`
found no `setInterval`, no cron, no `LISTEN`/`NOTIFY` — only one 30-second fetch timeout at
line 5422. **Nothing to migrate.** Recorded so that the first feature wanting a scheduled job
is recognised as a new architectural need rather than a small addition.

### 3.4 The connection problem — the one that needs its own ticket

Covered in §4, because it needs more than a paragraph and it is the item most likely to cause
a subtle, hard-to-see failure.

## 4. The connection problem, explained

**Filed as [#28](https://github.com/williamsonbm/inventory-app/issues/28).** It is the only item
here that can produce wrong answers without producing an error message.

### What a connection pool is, and why serverless breaks it

Talking to a database requires opening a connection, which is slow enough that apps keep a
small set open and reuse them. That set is a **pool**. A traditional app starts once, opens its
pool, and serves every request from it.

Serverless works differently. Each request may land on a fresh, short-lived copy of the app. If
each copy opens its own pool, and thirty requests arrive together, thirty pools open at once.
Databases cap total connections, so the app stops working under exactly the load it should
handle.

**The standard fix is a pooler** — a small service that sits in front of the database and
multiplexes many short-lived app connections onto a few real ones. Supabase's is called
Supavisor, and for serverless it runs in **transaction mode** on port 6543, meaning a connection
is borrowed for one transaction and handed back.

**Confirmed 2026-09-13:** port **6543** reaches Supavisor in shared transaction mode and port
**5432** reaches it in session mode. Transaction mode is the mode Supabase recommends for
serverless and edge functions, because those environments "open many short-lived connections."

### Why this is worse than usual in `hanger-web-app`

The current app opens **six pools**, not one: a read pool and a write pool each for
hangers/plates, EWP, and lumber — up to roughly 24 connections
(`hanger-web-app/server.js:217-258`).

They are separate for a specific reason. Each pool sets a different `search_path` — the list of
schemas Postgres searches to resolve an unqualified name. The comments are explicit that EWP
defines its own `norm()` which **must** resolve ahead of the hangers version, and lumber the
same (`server.js:229-250`).

**Here is the danger.** `search_path` is a per-connection setting, and transaction-mode poolers
are exactly where per-connection settings become unreliable. If it does not carry across, the
app does not crash. It resolves the *wrong* `norm()` function and returns subtly wrong numbers.
A buy list that is quietly wrong is worse than one that fails.

**The vendor documentation confirms the mechanism, not only the risk.** Supabase states that in
transaction mode "anything that depends on session state doesn't survive between transactions,"
and it names temporary tables, cursors and advisory locks. A `search_path` set once per connection
is that kind of session state. The same page adds a second constraint to carry into the ticket:
transaction mode **does not support prepared statements**, so they must be turned off in the
connection library. That one is a driver setting, and getting it wrong raises an error instead of
returning a wrong number — the easier half of the problem.

### Why the rebuild mostly dissolves this

The six pools exist to paper over a schema problem the schema survey
([#21](https://github.com/williamsonbm/inventory-app/issues/21)) already documented: seven
database objects built once per material family, four times over, **64% of the structural SQL
being near-identical repetition.** The `search_path` juggling is a symptom of four parallel
family schemas each defining same-named functions.

A rebuild that does not reproduce that shape does not inherit the problem. Two rules make it
go away:

1. **Do not create one schema per material family.** The survey is the evidence that the
   nothing depends on the families having separate schemas.
2. **Never depend on `search_path`.** Fully qualify every database object, or use exactly one
   schema. Then a transaction-mode pooler has nothing to lose.

That is a design constraint to adopt on day one and forget. Adopted late, it is a rewrite of
every query.

**Still true after the rebuild:** pool sizes must be small (1 or 2 per instance, not 5), and
the app must point at the transaction-mode pooler rather than the database directly.

## 5. Internet dependency — resolved, and narrower than assumed

The handoff and #5 both flagged an open question: does the office keep working when the
internet drops, given a cloud database?

**Answered by the owner, 2026-09-13:** the shop keeps working, because the shop does not use
this app at all. It is used by **operations, in the office, only**. The people who lose the app
during an outage are the same people who lose email, and the shop floor is unaffected either
way.

This materially lowers the risk of cloud hosting and closes the objection. It also corrects a
factual error carried in earlier documents, including this project's own framing: the app is
described as a "LAN app." **It is not.** It runs on the homelab and office users reach it over
Tailscale. There is no LAN-only path today, so moving to Vercel does not remove a local
fallback — that fallback was already gone.

Worth noting for [#3](https://github.com/williamsonbm/inventory-app/issues/3)-adjacent planning:
this also means an outage is an *operations* problem with a known blast radius, not a
production stoppage.

## 6. Recommendation

1. **Supabase**, for this project, reversing [#5](https://github.com/williamsonbm/inventory-app/issues/5)
   on the strength of its stated condition being met — not on the database comparison, which
   still favours Neon. Record it as a decision that buys an integrated login system and object
   storage for roughly $5–20/month over Neon.
2. **Vercel Pro at $20/month for one seat.** App users are free.
3. **Authentication and audit in slice one.** Not a hardening pass. The app cannot be deployed
   publicly without it.
4. **Adopt two schema rules before the first table exists:** one schema (or fully-qualified
   names everywhere), and no dependence on `search_path`. This is what keeps §4 from following
   the project into the rebuild.
5. **Keep scheduled `pg_dump` in the runbook**, exactly as #5 required. Nothing here changes
   that, and Supabase's daily-backup-only tier makes it more important rather than less.

## 7. What this supersedes

| Document | Line | Status |
|---|---|---|
| `docs/research/managed-postgres-supabase-vs-neon.md` | "Recommendation: Neon" | **Superseded** for this project by §1. The reasoning stays correct; its own flip condition fired. |
| `docs/handoff-inventory-app-wayfinder.md` (in `materials-planner`) | "App containerized on office hardware" | **Superseded.** Hosting is Vercel. |
| `docs/handoff-inventory-app-wayfinder.md` | "does the office ever lose internet?" | **Answered** — see §5. |
| Any description of `hanger-web-app` as a "LAN app" | — | **Wrong.** Homelab plus Tailscale. See §5. |
| [#20](https://github.com/williamsonbm/inventory-app/issues/20) | "Both parts stay in the office. A managed database is rejected." | **Superseded by a later owner decision.** See the note below — this is the largest item in this table and the session that wrote this document could not see it. |

**On [#20](https://github.com/williamsonbm/inventory-app/issues/20) — added 2026-09-13 by the
session that verified this document.** #20 closed on 2026-09-08 with the opposite answer to the
one this document assumes: both the app and the database stay on office hardware, a managed
database is rejected, and Tailscale survives as the login system, which it recorded as making
[#6](https://github.com/williamsonbm/inventory-app/issues/6) "largely dissolve." This document's
premise is a **later** owner decision, of 2026-09-13, to rebuild and host on Vercel. The dates
put the owner's decision after #20's resolution, so this document does not contradict #20 so much
as record that #20 was overtaken.

Three consequences follow, and all three are the owner's call rather than this document's:

- **#20 needs a comment recording the reversal**, so a future reader does not act on its answer.
- **[#27](https://github.com/williamsonbm/inventory-app/issues/27) may be moot.** It is open and
  labelled `ready-for-human` to build the Windows/Docker deployment, which was #20's condition. On
  Vercel there is nothing for it to build. It may still be worth keeping as the offline-fallback
  question in §8, open question 2.
- **#6 is back on, not dissolved.** #20 set it aside because Tailscale survived. Vercel removes
  Tailscale, so a login system has to be built, and §3.1 puts it in slice one.

One thing #20 got right and this document should inherit: **#20 found the same `search_path`
hazard independently**, through Neon's PgBouncer rather than Supabase's Supavisor, and used it as
an argument *against* a managed database. That argument does not disappear when the host changes.
It is the reason §4 gets its own ticket.

## 8. Open questions

1. **Framework for the rebuild.** Unasked and undecided. Vercel is strongly optimised for
   Next.js; plain Express works but gives up much of what the platform does well. This deserves
   its own short ticket before slice one, because it is expensive to change later.
2. **What happens to `materials-planner`'s offline Windows build** once the planner lives on
   Vercel. #5's open question 2 asked this and it is still open — though §5 weakens the case
   for keeping an offline fallback.
3. **Audit scope.** "Audit functionality" is on the owner's list for slice one but undefined:
   which events, retained how long, visible to whom. Needs a spec before it is built.
4. **Region.** Both Vercel and Supabase fix a region at creation. Pick the one closest to the
   office rather than accepting a default.

## Vendor sources

Every page below was read on **2026-09-13**. Vercel and Supabase change pricing and limits often;
re-check before acting on these numbers.

| Claim | Source |
|---|---|
| $20/month developer seat, free unlimited viewer seat | [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) (*Upgrading to Pro*, and the Hobby/Pro comparison) |
| $20/month per seat, app visitors need no account | [Vercel pricing](https://vercel.com/pricing) |
| Hobby restricted to non-commercial, personal use | [Vercel Hobby plan](https://vercel.com/docs/plans/hobby), citing [fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage) |
| 4.5 MB request **or response** body, `413 FUNCTION_PAYLOAD_TOO_LARGE` | [Vercel Functions limits](https://vercel.com/docs/functions/limitations) (*Request body size*) |
| Transaction mode on 6543, session mode on 5432, transaction mode recommended for serverless, no prepared statements, session state does not survive | [Supabase — connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres) |
| Pro from $25/month, daily backups at 7-day retention, PITR a $100/month add-on per 7 days | [Supabase pricing](https://supabase.com/pricing) |

One further Vercel limit is recorded here because it belongs to the connection ticket rather than
to any section above: a Vercel Function gets **1,024 file descriptors shared across all concurrent
executions**, and database connections consume them
([Vercel Functions limits](https://vercel.com/docs/functions/limitations), *File descriptors*).
It is a second, independent reason to keep per-instance pool sizes at 1 or 2.

## Corrections to `CLAUDE.md`

Both were found by direct test in this session, and both have the same root cause: `CLAUDE.md`
describes the `claude-pod` container as if it were the only environment a session can run in.
This session ran in the Claude Desktop app's container instead, where neither statement holds.

**1. The sibling path.** `CLAUDE.md` says the source repos are "siblings at `/workspace/`."
That path is the `claude-pod` bind mount (`-v ~/Projects/claude-sandbox:/workspace`). It does
not exist in the desktop container, where the same repos are at
`/home/bwilliamson/Projects/claude-sandbox/`. An agent that trusts the stated path concludes
the repos are missing.

**2. The read-only claim — the more serious one.** `CLAUDE.md` says `hanger-web-app` "is
enforced by a read-only bind mount, so the kernel refuses the write." That is true under
`claude-pod`, which passes `-v ~/Projects/claude-sandbox/hanger-web-app:/workspace/hanger-web-app:ro`.
It is a **flag on one shell alias, not a property of the repository.** In the desktop container
there is no such flag, and a write to `hanger-web-app` succeeds — confirmed by test on
2026-09-13.

The distinction matters because of how `CLAUDE.md` uses it: it contrasts `hanger-web-app`
("enforced by the kernel") with `materials-planner` ("rests on this rule, not on a mechanism").
Outside `claude-pod` **both rest on the rule alone.** The guardrail is real but conditional,
and it is stated unconditionally.

Suggested fix: state the guarantee as belonging to `claude-pod` specifically, and tell an agent
to verify rather than assume — the same treatment `CLAUDE.md` already gives the Claude Code
`ask` hook, which it correctly describes as a no-op under relaxed permissions.
