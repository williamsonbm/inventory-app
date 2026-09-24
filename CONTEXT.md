# CONTEXT — inventory-app

Vocabulary for the merged materials app. What a term means and who owns it — never how it is
built.

This file holds only the terms settled in **this** repo. `hanger-web-app/CONTEXT.md` remains
canonical for the job lifecycle and for every term not listed here; inheriting it properly is
ticket #7 and is not done. Where a term appears in both files and this one does not say
otherwise, the web app's definition stands unchanged.

Started 2026-09-06, resolving ticket #4. Extended 2026-09-24 by the UI/UX grilling.

---

Two markers appear under a term. **_Avoid_** lists words never to use for it. **_Not_** names a
sibling term in this glossary that it must not be confused with — that sibling is legitimate
vocabulary in its own right.

## Units of work

**Port**:
The move of an existing, working program to a new host. A port may leave parts behind, and it
says which parts. What it carries, it carries unchanged — a port never improves behaviour on the
way across. The first piece of work in the rebuild is a port: the materials planner onto Vercel,
without its EWP tab.
_Avoid_: lift-and-shift, rehost, migration (this project uses that word for a schema change)
_Not_: slice — a slice adds behaviour; a port moves behaviour that already works.

**Slice**:
A thin piece of function, cut through every layer, that works end to end for the person using it.
Short for *vertical slice*.
_Avoid_: phase, milestone, sprint, increment
_Not_: port — a port changes nothing about what the app does.

## Planning and purchasing

**Snapshot**:
One run that reads a batch of job material sheets, compares them against available, and reports
what to buy. It writes nothing to the database. The **open-orders look-ahead** is the same operation —
the only difference is who chooses the jobs.
_Avoid_: projection, look-ahead, planning run, dry run

**Buy list**:
The on-screen result of a snapshot — what is needed, what is held, what to buy.
_Avoid_: shopping list, order list, requirements list

**Purchase report**:
The file a snapshot produces to be kept and referenced later. A record of one snapshot at one
moment, never a live document.
_Avoid_: export
_Not_: snapshot — the saved file is not the act that produced it.

**Purchasable length**:
A stock length the supplier will actually sell for a given product. Set per product, because each
product is priced and ordered separately.
_Avoid_: valid length
_Not_: available length — collides with *available*.

**Planner**:
The area of the app where snapshots are run and buy lists read. Like the snapshot, it writes
nothing.
_Avoid_: projected, buy list (as the name of the area)
_Not_: materials planner — the standalone program this area replaces.

## Jobs

**Job**:
One order, named by its full job number with its suffix — 44444R and 44444F are two jobs. The
job, not a material family, is what gets committed, built, shipped or cancelled; every family on
it moves together.
_Avoid_: order (a job-lifecycle stage), ticket

**Commitment** (narrowed from the web app):
Material a job is expected to consume. Created only when a person commits the job; dropping its
sheet into the Planner never creates one.
_Avoid_: allocation, hold
_Not_: reserved — an inherited term with its own web-app meaning.

**Built** and **Shipped** (extended from the web app):
The two points at which a job's committed material becomes consumed. Built consumes plates,
lumber and LVL, which are cut in the shop or yard; shipped consumes hangers, EWP, and anything the
job has not yet consumed. *Un-build* and *un-ship* reverse them for the whole job.
_Avoid_: completed, delivered, done

**Deduct directly**:
Committing a job and marking it shipped in one step, so all of its material is consumed at once.
It leaves the same job record as the longer path.
_Avoid_: deduct from stock, write off, quick deduct

**Cancel**:
Ending a job's commitment so its material returns to available. Only material not yet consumed
returns.
_Avoid_: release — the job lifecycle already uses it twice (*Released from Design*, *Release to
Shop*).

## Counting and levels

**Monthly count**:
A full count of one family, taken at the start of a month, that closes the month before. A count
taken on July 1 closes June.
_Avoid_: month-end count, end-of-month count — it happens at the start of the month.
_Not_: month-end record — the count is the act; the record is what its approval keeps.

**Month-end record**:
An approved monthly count, kept as the record of the month it closes. A correction adds a
revision; the original stays.
_Avoid_: month-end inventory, snapshot
_Not_: snapshot — a snapshot plans purchases and records nothing.

**Level**:
How an item's available compares with its threshold: *Short* when available is below zero, *Low*
when it is zero or more but under the threshold, otherwise *OK*.
_Avoid_: status, state
_Not_: stocking status — set by a person; level is worked out from the numbers.

---

## Inherited without change

*On hand*, *committed*, *available*, *forecast*, *reserved*, *consumed*, *receipt* and the job
lifecycle keep their `hanger-web-app/CONTEXT.md` meanings. Nothing decided in ticket #4 changes
any of them. The UI/UX grilling of 2026-09-24 narrows *commitment* and extends *built* and
*shipped* (see **Jobs**), and fixes one point about a *count*: it is true at the moment it was
taken, not the moment it was approved.

## Overrides — these bind everywhere in this repo

**It is the materials planner.** The handoff's "laptop planner" is wrong.

**Never use the bare word "stock."** It names a snapshot handed to the planner in one system and a
ledger maintained in the other, with on hand, committed and available tangled inside it. Name the
quantity meant. This applies to prose, to screen text, and to identifiers, column names and JSON
fields.

---

## Stocking status

Every item carries exactly one of three statuses. It is **set by a person and stays set.** It is
never worked out from how many happen to be in the yard, because leftovers arriving and being used
would otherwise change an item's status with nobody deciding anything.

**Stocked**:
An item bought deliberately and kept on hand. It has a reorder threshold.
_Avoid_: carried, in stock, standard

**Non-stock**:
An item no longer bought deliberately, but which leftovers from past jobs mean you may still hold.
On hand can be above zero, so a buy list nets against it.
_Avoid_: non-stocked, non-standard
_Not_: special order — leftovers may still be on hand here.

**Special order**:
An item never held. On hand is zero, and availability and lead time are unknown until somebody
contacts the supplier, so a buy list can flag it but cannot price or size the order.
_Avoid_: custom, one-off
_Not_: non-stock — on hand is zero here.

> These three are stages, not fixed buckets. An item stops being *stocked* the day you stop buying
> it, is *non-stock* while leftovers last, and becomes *special order* once they are gone.
>
> Staff use *non-stock* and *special order* interchangeably, and the web app's screens badge a
> non-stocked depth as "Special Order", so the two words being distinct is a decision this project
> is making, not existing practice it is describing.
