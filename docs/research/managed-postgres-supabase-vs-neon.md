# Managed Postgres: Supabase or Neon?

- **Ticket:** [#5](https://github.com/williamsonbm/inventory-app/issues/5), labelled `wayfinder:research`
- **Map:** [#2](https://github.com/williamsonbm/inventory-app/issues/2)
- **Type:** research finding, not a decision record — the map (#2) still has to accept this
  recommendation before it's locked. No ADR alternatives-and-consequences structure below;
  see `docs/adr/0001-snapshot-is-one-operation.md` for what an actual decision looks like in
  this repo.
- **Scope:** picks a managed Postgres provider only. Does not provision anything, does not
  touch app hosting (staying on office hardware), does not touch the Tailscale/login question
  (tracked separately in #6).
- **Access date for every source below:** 2026-09-07. Pricing and limits pages change often —
  re-check before acting on this if it's more than a few months old.

## Bottom line

**Recommendation: Neon.**

Both providers can run this database, and both do it well. Neon costs less and gives more:
roughly $5–20/month against Supabase's flat $25 floor, and it includes point-in-time recovery
(rolling the database back to any moment in the last seven days) where Supabase charges $100/month
extra for the same thing.

**Read the $100 figure carefully — it is not a bill either option makes you pay.** Supabase's
$25 plan already includes a daily backup kept for seven days, which is real protection. The
$100 add-on buys *granularity*, not backups. So the fair comparison is $25/month with a nightly
snapshot against $5–20/month with second-by-second rollback. Neon is cheaper *and* recovers
better; the $130/month configuration is a straw man and should not decide anything.

**The trade-off in one paragraph:** picking Neon means a smaller, cheaper, Postgres-only bill
with better built-in backup protection, but a bill that moves around a little month to month
instead of being one flat number, and a database that goes to sleep when nobody is using it —
so the first click of the morning waits a moment for it to wake. Picking Supabase means one
predictable monthly price, a friendlier dashboard, and a ready-made login system sitting there
if the app ever needs one, but paying more for less recovery — a flat $25 against Neon's $5–20,
and a nightly snapshot where Neon rolls back to the minute.

### Two things this recommendation depends on — read these before locking it

**The sleep/wake trade (Neon).** The cheap end of Neon's bill depends on *autosuspend*: compute
stops after five minutes of no queries, and you stop paying for it. The cost is a cold start on
the first query after each pause. For an app used in bursts through an office day, that is a
short, repeated wait somebody will notice and report as "it's slow when I open it." Autosuspend
can be turned off, but then compute bills continuously: a 0.25 CU instance at $0.106/CU-hour is
about **$19/month** running 24/7, which lands next to Supabase's $25 floor and erases most of
the cost argument. The honest framing is: Neon is much cheaper *and* occasionally slow to wake,
or roughly Supabase-priced and always warm. Pick knowingly.

**The login question is genuinely open (#6).** Access control today is Tailscale injecting a
header. [#6](https://github.com/williamsonbm/inventory-app/issues/6) records that moving off
Tailscale leaves no login system at all — and Supabase ships one. That is the single strongest
argument for Supabase, and it should not be dismissed as a bundled extra nobody wants.

It still does not carry the decision, for three reasons. The need is small — under ten people
and two roles (office, shop), for one client at one site. It only bites under one branch of
[#10](https://github.com/williamsonbm/inventory-app/issues/10): Supabase Auth pays off when the
app talks to it from a browser with row-level security, which is a rebuild-shaped change, not a
refactor-shaped one. And choosing Neon does not foreclose it — an authentication service can be
added later next to any database. Paying $100/month in backup protection now to hold an option
that only pays out on one branch of an undecided ticket is the wrong way round. **If #10 lands
on rebuild *and* #6 lands on "we want a hosted login system," revisit this** — that combination,
and only that combination, is where Supabase becomes the better answer.

**Assumption to verify with the owner:** the office's exact location is assumed to be somewhere
in the continental US, without a specific city. Both providers offer close, low-latency regions
on both US coasts (Virginia, Ohio, Oregon — plus California for Supabase), so this assumption
does not change the recommendation. It would only matter if the office were outside the US.

## 1. Pricing at this scale

**Supabase.** Free tier: 500 MB database, 1 GB file storage, 5 GB egress, no automatic backups
at all — the owner would have to run their own exports. Once outgrown, the cheapest paid tier
is **Pro at $25/month per organization**, which includes a $10/month compute credit that covers
one "Micro" database instance (1 GB RAM, shared CPU), 8 GB storage (then $0.125/GB), 250 GB
egress (then $0.09/GB), and daily backups kept 7 days. Real point-in-time recovery (PITR) is a
separate add-on. The pricing page states one rate — **$100/month per 7 days of retention** —
and PITR additionally requires at least the "Small" compute add-on, so the true cost of turning
it on is the $100 plus a compute upgrade beyond what Pro's $10 credit covers. (Longer windows
are self-serve up to 28 days; the page does not publish per-tier prices for them, so treat
"$200 for 14 days / $400 for 28 days" as an extrapolation of the stated rate, not a quote.)
For a single small shop, PITR alone takes the bill from $25 to roughly **$130/month**.
[Pricing](https://supabase.com/pricing) ·
[Backups](https://supabase.com/docs/guides/platform/backups)

**Neon.** Free tier: 100 CU-hours/month per project, 0.5 GB storage, 5 GB egress, single manual
snapshot, 6-hour restore history — plausibly enough to run this app's whole workload for a
while given how small and infrequent its traffic is. As of a December 2025 pricing change, paid
usage (the "Launch" plan) has **no monthly minimum**: compute is billed at $0.106/CU-hour,
storage at $0.35/GB-month, restore history at $0.20/GB-month, egress at 500 GB included then
$0.10/GB. For a database this size **with autosuspend left on** (compute pauses after 5 minutes
idle), a realistic bill lands in the range of a few dollars to perhaps $15–20/month — well under
Supabase's $25 floor, and far under it if PITR is wanted. That estimate depends on the pause:
with autosuspend disabled, a 0.25 CU compute running continuously is ~$19/month before storage.
See the sleep/wake trade in the Bottom line. [Pricing](https://neon.com/pricing) ·
[Pricing change announcement](https://neon.com/blog/new-usage-based-pricing) ·
[Dec 2025 changelog](https://neon.com/docs/changelog/2025-12-12)

## 2. Backup and restore story

**Supabase.** Two separate products. *Daily backups* (physical or logical, depending on
Postgres version) come free with Pro/Team/Enterprise: 7/14/30-day retention respectively, no
extra charge. *Point-in-time recovery* is the paid add-on described above — it disables daily
backups when turned on, gives recovery down to roughly a 2-minute worst case, and requires at
least the Small compute tier. **Restore is self-serve**: a dashboard button under
Database → Backups, or the Management API via `curl`; for PITR you pick a date/time on a
picker. No support ticket needed. Two caveats worth knowing: restoring causes downtime roughly
proportional to database size, and custom role passwords are not restored (they must be reset
after). [Backups doc](https://supabase.com/docs/guides/platform/backups)

**Neon.** One built-in mechanism, no separate purchase: **instant restore** (their name for
point-in-time recovery) rolls a database back to any timestamp or exact WAL position within the
configured history window, at no cost beyond the per-GB-month price for keeping that history
around. Retention: **1 day by default, up to 7 days on Launch, up to 30 days on Scale** (the
window is configurable up to the plan max). Restoring is self-serve via **console** (a
date/time picker with a preview — browse tables, compare schemas — before committing), **CLI**
(`neon branches restore ... --preserve-under-name`), or **API**. The original state is
automatically kept as a renamed branch, so a bad restore is itself reversible. Neon also
supports manual/scheduled snapshots as a second, independent recovery mechanism.
[History window](https://neon.com/docs/introduction/history-window) ·
[Backup & restore guide](https://neon.com/docs/guides/backup-restore) ·
[Instant restore](https://neon.com/docs/introduction/branch-restore)

**Net:** Neon gives point-in-time recovery inside its normal price; on Supabase the same
capability is a $100/month add-on this budget would rightly skip, leaving a nightly snapshot
kept seven days. Both are genuine protection. Neon's is finer-grained and cheaper, but the gap
is an advantage, not a disqualification of Supabase.

### Take your own dumps as well — on either provider

A scheduled `pg_dump` belongs in the runbook whichever provider wins, because it covers a
failure neither provider's backup can: **losing the provider.** An account lockout, a lapsed
card, a prolonged outage, or simply deciding to leave are all cases where the vendor's own
backups are unreachable by definition. A dump is portable and restores anywhere, which also
keeps the exit cheap.

The two mechanisms answer different questions, and neither substitutes for the other:

| | Protects against | Granularity |
|---|---|---|
| **Provider PITR / daily backup** | A mistake — a bad delete, a wrong import | Neon: to the minute. Supabase: to the night before. |
| **Your own `pg_dump`** | Losing the provider, or wanting to leave | To the last scheduled dump |

For a database this small the dumps are cheap enough to be uninteresting — well under a
gigabyte, so nightly copies cost pennies to keep and finish in seconds.

**This narrows the gap between the two providers.** With dumps running, provider PITR stops
being the thing standing between the owner and a lost day, and becomes a convenience that
shortens the worst case from "back to last night" to "back to 3:59pm." That is worth having and
it is free on Neon — but it is no longer the argument that decides this ticket. Price is:
$5–20 against $25, for the same database. Recovery is the tiebreak, not the case.

**One requirement the runbook must carry:** an untested backup is not a backup. The single most
common failure here is discovering at restore time that the dumps have been failing silently for
months. A restore has to be practised, on a schedule, against a throwaway target — and the
practice run is what the runbook documents, not just the dump command.

## 3. Region and latency from the office

**Supabase US regions:** West US (N. California, `us-west-1`), West US (Oregon, `us-west-2`),
East US (N. Virginia, `us-east-1`), East US (Ohio, `us-east-2`) — plus Canada Central.
[Regions](https://supabase.com/docs/guides/platform/regions)

**Neon US regions:** US East (N. Virginia, `aws-us-east-1`), US East (Ohio, `aws-us-east-2`),
US West (Oregon, `aws-us-west-2`) — all on AWS. [Regions](https://neon.com/docs/introduction/regions)

Either provider has a region within the continental US close to any plausible office location.
For a LAN app whose only change is that the database moves off-site, the realistic added
latency is one cross-country network round trip per query — typically 10–40 ms within the same
coast, 60–80 ms coast-to-coast on a wired connection — which is unlikely to be noticeable for a
handful of users running short queries, though it is worth picking the closest matching region
rather than defaulting to one. **Both providers fix the region at project creation**; moving to
a different region later means creating a new project and migrating data across, not a
one-click move — true for Supabase and explicitly stated in Neon's docs.

## 4. Connection limits and pooling

The app opens up to **~24 pooled connections at once** (3 `pg.Pool` pairs — hangers/plates,
EWP, lumber — each a read pool of 5 and a write pool of 3; confirmed directly in
`hanger-web-app/server.js`, e.g. `max: 5` / `max: 3` on each `new Pool(...)` call). Real
concurrent query load is tiny.

**Supabase.** Even the cheapest paid compute ("Micro," included in Pro's $10 credit) allows
**60 direct Postgres connections** and up to **200 pooler client connections** — comfortably
above the ~24 the app can ever open, with no pooler required at all at this scale. Supabase's
pooler (**Supavisor**) offers two modes: **session mode** (port 5432, default pool size 30,
supports prepared statements, recommended for a persistent backend app like this one) and
**transaction mode** (port 6543, for serverless/edge functions, does not support prepared
statements). This app is a long-running Express process, so session mode — or even a plain
direct connection — is the natural fit; no pool-size or code change is needed, just point the
connection string at the project (optionally via the pooler host).
[Connecting docs](https://supabase.com/docs/guides/database/connecting-to-postgres) ·
[Compute tiers](https://supabase.com/docs/guides/platform/compute-and-disk)

**Neon.** Even the smallest compute size (0.25 CU / 1 GB RAM) sets Postgres `max_connections`
to **104** (97 usable after 7 reserved for Neon's own role), again comfortably above 24. Neon's
built-in pooler is **PgBouncer in transaction mode only** — there is no session-mode option —
reached via a `-pooler` suffix on the connection host. Transaction mode forbids session-level
features (`SET`/`RESET` outside a transaction, `LISTEN`/`NOTIFY`, session advisory locks,
SQL-level `PREPARE`) but does support protocol-level prepared statements via named query
objects. A direct grep of `hanger-web-app` found **no use of named prepared statements**
(`{ name: ..., text: ..., values: ... }`) anywhere in `server.js` or elsewhere — the app relies
on plain parameterized queries — so transaction-mode pooling would not break anything it
currently does. The app's multi-statement transactions (the `BEGIN`/`COMMIT` blocks used for
on-hand-quantity deductions, also found directly in `server.js`) are also safe under transaction
mode, since each transaction holds one pooled connection for its own duration. As with Supabase,
the connection count here is small enough that the pooler is optional rather than necessary —
a direct connection string would work fine too.
[Connection pooling](https://neon.com/docs/connect/connection-pooling) ·
[Compute sizing / max_connections](https://neon.com/docs/manage/computes)

**Net:** neither provider forces a code change. At ~24 connections, both are well inside the
smallest paid compute's raw connection limit, so the existing `pg.Pool` setup can point at
either provider — direct or pooled — with only a connection-string change.

## 5. What migrating the existing schema actually involves

The existing role/grant setup (`hanger-web-app/sql/create_readonly_role.sql`,
`create_write_role.sql`, `grant_*.sql`) does three things per schema: `CREATE ROLE ... LOGIN
PASSWORD`, `GRANT USAGE`/`SELECT`/`INSERT`/`UPDATE` on specific schemas and tables, and `ALTER
DEFAULT PRIVILEGES`. A grep of the whole `sql/` directory found **no `CREATE EXTENSION`, no
`ALTER ... OWNER`, and no reference to superuser-only features** anywhere in the 4,230 lines of
migrations — this schema does not lean on anything either provider's restricted role model would
block.

**Supabase.** Standard path: `pg_dump --no-owner --no-privileges` (schema and data, per-schema
filtering with `--schema=`), then `pg_restore --no-owner --no-privileges` against the pooler
connection string. Roles and RLS status are explicitly **not** migrated by the dump/restore —
expected, and no different from what the app already does today (it hand-runs its role/grant
scripts as a separate step). The `postgres` role Supabase hands out is not a true superuser, but
the only two documented restrictions are `COPY ... FROM PROGRAM` and `ALTER USER ... WITH
SUPERUSER` — neither used anywhere in this schema — so `create_readonly_role.sql` and
`create_write_role.sql` should run against it with no changes. One wrinkle the scripts do not
cover: the app connects as two *custom* roles, and reaching a custom role through Supavisor
needs the username written `<role>.<project-ref>` rather than the bare role name. The SQL is
unchanged; the connection strings are not.
[Migration guide](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres) ·
[Roles and superuser](https://supabase.com/docs/guides/database/postgres/roles-superuser)

**Neon.** Same shape: `pg_dump -Fc` from the source (unpooled connection string — Neon's docs
explicitly warn against dumping over a pooled one), `pg_restore -O` (no-owner) into Neon. The
connecting role Neon provisions carries `neon_superuser` membership, which includes
`CREATEROLE`, `CREATEDB`, and `BYPASSRLS` — enough to run the existing grant scripts basically
verbatim. The one documented gap is that `neon_superuser` cannot run `ALTER OWNER` — irrelevant
here since `--no-owner` already strips those statements from the dump. Neon also doesn't support
`pg_dumpall`, tablespaces, or large objects, none of which this schema uses.
[Migrate from Postgres](https://neon.com/docs/import/migrate-from-postgres) ·
[Manage roles](https://neon.com/docs/manage/roles)

**Net:** migration mechanics are a wash. Both are plain `pg_dump`/`pg_restore`, both strip
ownership on the way in, and both hand the connecting role enough privilege to re-run the
existing grant scripts unmodified. Neither provider's managed-role model conflicts with how
this schema is actually built.

## Recommendation

**Neon**, for this specific case:

1. **It costs less for the same database.** Pricing tracks actual (tiny) usage — roughly $5–20
   a month with autosuspend on — against a flat $25/month floor that partly buys features (auth,
   storage, generated APIs) this app does not currently call. This is the argument that carries
   the decision.
2. **Point-in-time recovery comes free rather than costing $100/month.** With scheduled dumps
   running — which the runbook should require on either provider — this is a tiebreak rather
   than the case: it shortens the worst case from "back to last night" to "back to the minute."
   Worth having, not worth paying $100/month for, and Neon does not ask.
3. Region/latency, connection limits, and migration mechanics are effectively tied between the
   two — none is a deciding factor on its own.

Supabase remains a reasonable second choice if the owner would rather pay a flat, predictable
monthly number and use its friendlier all-in-one dashboard, and is willing to either accept
daily-backup-only protection or pay extra for real point-in-time recovery. The one scenario
that would make it the *better* choice is spelled out in the Bottom line: #10 landing on
rebuild together with #6 wanting a hosted login system.

**A note on the question itself.** "Supabase or Neon?" is inherited from the handoff, which
flagged those two as unevaluated. It is worth saying once that both are unusual Postgres —
Supabase is a bundle built around Postgres, Neon re-architects its storage so compute can pause
and branch. The plainest reading of this app's need is "one small shop wants a boring database
that stays up and gets backed up," and that description also fits conventional managed Postgres
(DigitalOcean, Crunchy Bridge, RDS), none of which were in the handoff's frame and none of which
were evaluated here. Answering the question as asked: Neon. If the sleep/wake trade above is
unattractive and a flat, always-warm, boring database sounds better than either option, that is
a different ticket, and a short one.
