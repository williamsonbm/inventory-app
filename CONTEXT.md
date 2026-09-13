# CONTEXT — inventory-app

Vocabulary for the merged materials app. What a term means and who owns it — never how it is
built.

This file holds only the terms settled in **this** repo. `hanger-web-app/CONTEXT.md` remains
canonical for the job lifecycle and for every term not listed here; inheriting it properly is
ticket #7 and is not done. Where a term appears in both files and this one does not say
otherwise, the web app's definition stands unchanged.

Started 2026-09-06, resolving ticket #4.

---

## Planning and purchasing

**Snapshot**:
One run that reads a batch of job material sheets, compares them against stock, and reports what
to buy. It writes nothing to the database. The **open-orders look-ahead** is the same operation —
the only difference is who chooses the jobs.
_Avoid_: projection, look-ahead, planning run, dry run

**Buy list**:
The on-screen result of a snapshot — what is needed, what is held, what to buy.
_Avoid_: shopping list, order list, requirements list

**Purchase report**:
The file a snapshot produces to be kept and referenced later. A record of one snapshot at one
moment, never a live document.
_Avoid_: snapshot (the saved file is not the act that produced it), export

**Purchasable length**:
A stock length the supplier will actually sell for a given product. Set per product, because each
product is priced and ordered separately.
_Avoid_: available length (collides with *available*), valid length

---

## Inherited without change

*On hand*, *committed*, *available*, *forecast*, *reserved*, *consumed*, *receipt* and the job
lifecycle keep their `hanger-web-app/CONTEXT.md` meanings. Nothing decided in ticket #4 changes
any of them.

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
_Avoid_: special order, non-stocked, non-standard

**Special order**:
An item never held. On hand is zero, and availability and lead time are unknown until somebody
contacts the supplier, so a buy list can flag it but cannot price or size the order.
_Avoid_: non-stock, custom, one-off

> These three are stages, not fixed buckets. An item stops being *stocked* the day you stop buying
> it, is *non-stock* while leftovers last, and becomes *special order* once they are gone.
>
> Staff use *non-stock* and *special order* interchangeably, and the web app's screens badge a
> non-stocked depth as "Special Order", so the two words being distinct is a decision this project
> is making, not existing practice it is describing.
