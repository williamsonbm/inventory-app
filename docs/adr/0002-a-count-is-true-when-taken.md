# ADR 0002 — A count is true at the moment it was taken

- **Status:** Accepted — 2026-09-24
- **Deciders:** repo owner
- **Resolves:** the UI/UX grilling of 2026-09-24 (Q26)
- **Related:** `hanger-web-app` STATUS.md F11; `docs/research/hanger-web-app-schema-review.md`
  findings E1 and E2

> This is **this repo's** ADR 0002. The web app has its own ADR 0002 ("Available" is physical;
> forecast is reported, never netted). They are different documents.

## Context

The web app loses movements that happen near a count, for two separate reasons.

- **F11.** Builds and shipments are recorded as a calendar date with no time of day, but a count
  has a full timestamp. A job built or shipped on count day, after the count, is never deducted:
  "Same-day count-then-consume never deducts — arrivals compare full timestamps, ships/builds
  compare dates only" (`hanger-web-app/STATUS.md`, F11). The bug is in all four families' on-hand
  calculations.
- **E2.** A count's cutoff is the moment the office approved it, not the moment the material was
  counted. A receipt or build between the count and its approval can be excluded wrongly.

Staff avoid both by building and shipping everything due out before they count. That works, but it
depends on everyone remembering.

## Decision

**A count holds what was physically there at the moment it was counted.** That moment is recorded
separately from when the count was submitted and when it was approved. Every receipt, build and
shipment carries a full time of day. On hand is the approved count's figure plus every movement
timed after the moment of the count.

Approval decides whether a count is accepted. It does not decide the moment the count is true.

## Alternatives considered

**Keep approval time as the cutoff, and keep dates for builds and shipments.** This is how the web
app works today, and it is the source of F11 and E2. Rejected.

**Fix only F11 by adding times to builds and shipments, and keep approval time.** This leaves E2
in place: anything between the count and its approval is still handled wrongly. Rejected.

## Consequences

- **A movement is timed when a person enters it, not when it physically happened.** A job built at
  10:00, counted around at 11:00, and marked built at 15:00 will be deducted twice: once by the
  count and once by the late entry. The build-first-then-count habit still prevents this. Whether
  to let a person enter the real time is a database-slice decision.
- **Under the old rule, a late approval could change on hand. Under this rule it cannot.**
- **The web app's `STATUS.md` cannot be updated from here**, because sibling repos are read-only.
  Marking F11 as fixed by the rebuild is the owner's call.
