# Talent Loops — what the live run taught us

Filled in by the orchestrator **after** the run in `modes/live-run.md`, from what actually
happened on the tenant. Every bullet names the command, record id or ledger line it came from;
a bullet that cannot cite one does not belong here. `TODO(run)` markers are placeholders and
must all be gone before this document is shown to anyone.

Run metadata (fill in from `node bin/bridge.mjs status` and the ledger):

| | |
|---|---|
| Tenant | TODO(run) |
| Acting user | TODO(run) |
| Snapshot fetched at | TODO(run) |
| Workers / departments / locations | TODO(run) |
| Cycle id | TODO(run) |
| Run window (wall clock, `TL_NOW` unset) | TODO(run) |

---

## What we set out to prove

- TODO(run) — the claim from `docs/SPEC.md` §1 this run was meant to test.
- TODO(run) — the specific behaviours the demo scenario promises (one message per person, a
  moved due date instead of a nudge for somebody away, one escalation with evidence, an
  idempotent second tick, a packet whose every figure cites a record).
- TODO(run) — what "one engine, many loops" was supposed to look like on real data.

## What held

- TODO(run) — behaviours that worked unchanged against real people, with the command that
  showed it.
- TODO(run) — the safety invariants that held: ledger completeness, the write allowlist, the
  proposal-only path for decisions of record.
- TODO(run) — anything that was *more* convincing on real data than on fixtures.

## What broke on contact with Rippling

- TODO(run) — each fixture assumption that failed, and what it cost. Start from the seven in
  `docs/testing/live-rippling.md` and say which the bridge absorbed and which are still open.
- TODO(run) — every mapping warning the import printed, and whether it mattered in the run.
- TODO(run) — anything the run could not do at all, and why.

## What the MCP can and cannot do for talent loops

**Can:**

- TODO(run) — the reads that carried the loop.

**Cannot:**

- TODO(run) — the redactions (candidates, applications, requisitions, headcount, pay) and what
  each one blocks.
- TODO(run) — the shape gaps: no location timezone or hours, no dated absence, no team or level
  on this tenant, name-only people search.
- TODO(run) — the write story: custom-object quota, and what that means for Tier-2 state.

## What AI Cloud should expose first (Tier 3 list, refined)

Ordered by what this run actually needed, not by what would be nice:

1. TODO(run) — the object or field, why the loop needed it, and what the bridge had to invent
   in its absence.
2. TODO(run)
3. TODO(run)

## Recommendation

- TODO(run) — is the "one cycle engine, many loops, on Rippling" thesis supported by this run?
  Say yes or no plainly, then qualify.
- TODO(run) — what a real deployment would need next, in order.
- TODO(run) — what should *not* be built until something else changes.
