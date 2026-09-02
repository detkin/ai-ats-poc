# Data Contract

Which files the engine owns, which files the tenant owns, and the invariants that hold across
both. Derived from `docs/SPEC.md` §3, §5 and §9 and `docs/PLAN.md` §0–§2. If this document and
the spec disagree, the spec wins and the deviation is recorded in `docs/DECISIONS.md`.

The short version: **the engine ships; the tenant's policy is theirs.** An engine update may
rewrite anything in the system layer and must never rewrite anything in the tenant layer.

---

## 1. The two layers

### System layer — shipped, replaceable on every update

| Path                                                                | Owns                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `lib/**`                                                            | types, ports, engine, adapters, safety                               |
| `bin/**`                                                            | the CLIs; every write goes through one of them                       |
| `modes/_shared.md`                                                  | engine contract, safety rules, untrusted-content rule, output format |
| `modes/<loop>.md`                                                   | one file per loop (`review-cycle`, `interview-loop`, …)              |
| `templates/**`                                                      | `loop-states.yml`, nudge and packet templates                        |
| `.claude/skills/talent-loops/SKILL.md`                              | the router                                                           |
| `evals/**`                                                          | golden packets and deterministic tick checks                         |
| `tests/**`                                                          | the proof                                                            |
| `DATA_CONTRACT.md`, `README.md`, `Makefile`, `package.json`, config | scaffolding                                                          |

### Tenant layer — the tenant's, never rewritten by an update

| Path                              | Owns                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `tenant/policy.yml`               | cadence, quiet hours, channels, escalation thresholds, loop settings |
| `tenant/ledger/**`                | periodic ledger exports out of Rippling custom objects               |
| `modes/_tenant.md`                | prose over `tenant/policy.yml` (generated from it, but tenant-owned) |
| `modes/_custom.md`                | house rules                                                          |
| `fixtures/tenant/**`              | the seeded demo tenant, including résumés and `manifest.json`        |
| `$TL_DATA_DIR` (default `./data`) | runtime `tl_*` state, `ledger.jsonl`, `outbox.jsonl`, locks          |
| `staging/**`                      | fan-out partial packets awaiting a `packet.mjs` merge                |

### Updater rules

1. An engine update **never** writes to `tenant/`, `modes/_tenant.md`, `modes/_custom.md`,
   `fixtures/tenant/`, `$TL_DATA_DIR`, or `staging/`.
2. `tenant/policy.template.yml` is system-layer (it is the shipped starting point).
   `tenant/policy.yml` is tenant-layer. Copying the former over the latter is a tenant action.
3. `bin/doctor.mjs` **refuses to tick** while `tenant/policy.yml` still has `template: true`.
   A template policy would nudge forty people on a stranger's cadence — the career-ops lesson.
4. New policy keys ship with a default in `policy.template.yml` and a validator entry, so an
   old tenant file keeps loading. Removing a key is a breaking change and goes in
   `docs/DECISIONS.md`.
5. `fixtures/tenant/` is regenerated only by `node bin/seed.mjs` run deliberately by a human;
   `--verify` is the read-only form used in CI.

---

## 2. Environment knobs

| Variable          | Default                                               | Meaning                                                  |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| `TL_ADAPTER`      | `fixture`                                             | `fixture` (no network, works end to end) or `rippling`   |
| `TL_NOW`          | wall clock                                            | ISO instant; freezes the clock so ticks are reproducible |
| `TL_DATA_DIR`     | `./data`                                              | runtime state, ledger, outbox, locks                     |
| `TL_ACTOR`        | default identity in `fixtures/tenant/identities.json` | worker id the agent acts as                              |
| `TL_TENANT_DIR`   | `./tenant`                                            | tenant policy and exports                                |
| `TL_FIXTURES_DIR` | `./fixtures/tenant`                                   | read-only Tier-1 fixture data                            |

Fixture anchor time is `2026-09-02T16:00:00Z`; tests set `TL_NOW` to it.
`lib/config.ts` (block B0.5) is the only reader of `process.env`.

---

## 3. The three tiers

### Tier 1 — real entities, read-only, never duplicated

`worker`, `department`, `team`, `level`, `location`, `comp_band`, `headcount_position`,
`job_requisition`, `candidate`, `application`, `absence`, `leave_type`, `holiday`,
`prior_rating`. Typed in `lib/types/tier1.ts`; reached through the Graph, Ats, Bands and
Availability ports.

> **The rule: the engine never holds a value the real object also holds.**

The engine stores Tier-1 **ids** and re-reads their values on every tick. A stage move, an
offer or a hire is a `tl_proposed_action` a human executes in Rippling's UI; the engine then
observes the new stage on the real application record. There is no shadow pipeline.

`lib/types/engine.ts` encodes this mechanically: `TIER1_VALUE_FIELDS` lists the forbidden
field names (`rating`, `base_annual`, `compensation`, `stage`, `min`, `mid`, `max`,
`first_name`, `last_name`, `work_email`, `title`, `resume_ref`) and `NoTier1Values<T>`
collapses to `never` if a record type declares one. `tests/types/engine-shapes.test.ts`
fails the build on a breach.

### Tier 2 — engine state, new concepts, prefix `tl_`

`tl_cycle`, `tl_task`, `tl_nudge`, `tl_packet`, `tl_proposed_action`, `tl_match`,
`tl_anomaly`, plus the `tl_agent_action` ledger. Rippling has no object for a "cycle" or a
"proposed action", so nothing is being redefined. On a real tenant these are App Studio
custom objects: they inherit Rippling permissions and emit webhooks.

Every Tier-2 record carries `id` (`tl_<kind>_<8 hex>`, assigned by the adapter — never
`max+1`), `created_at`, `updated_at`, `created_by` (the acting worker).

### Tier 3 — shadow objects, keyed by real ids, temporary

`tl_interview_slot`, `tl_scorecard`, `tl_review_submission`. They exist only because
Rippling exposes no interview, scorecard or review API. Each carries `shadow: true` and
`real_ref` so the whole seam is one grep. **This list is the "what AI Cloud should expose
first" requirements list**; in an internal build the tier disappears.

### State vs ledger

`tl_agent_action` is not state. It answers _when and by whom_, state answers _what_. It is
append-only: `LedgerPort` exposes `append` and `list` and no update or delete. Corrections
are new lines. Mixing the two is how drift starts.

---

## 4. Write allowlist

Enforced in the adapter layer by `assertWriteAllowed(port, fn, target)` in
`lib/safety/allowlist.ts` — code, not prompt. Anything not on this table is rejected with a
`WriteNotAllowedError` whose message names the only other path: record it as a
`tl_proposed_action` via `bin/propose.mjs` and have a named human decide it via
`bin/decide.mjs`. Rejections are still ledgered, with `result: "rejected"`.

| Port           | Allowed writes              | Target                    | Notes                                                   |
| -------------- | --------------------------- | ------------------------- | ------------------------------------------------------- |
| `state`        | `create`, `update`          | `tl_*` only               | engine state and shadow objects; no `delete` exists     |
| `ats`          | `createDraftHire`           | draft hire                | Rippling's own staged action; still a draft for a human |
| `channel`      | `sendDirect`, `postChannel` | Slack, as the acting user | nudges, escalations, summaries                          |
| `availability` | `placeHold`                 | acting user's calendar    | interview holds (M2)                                    |
| `graph`        | —                           | —                         | read-only                                               |
| `bands`        | —                           | —                         | read-only                                               |
| `ledger`       | —                           | —                         | see below                                               |

Explicitly **not** allowlisted and explicitly still possible:

- `ledger.append` — the ledger is the _record_ of a call, not a call the agent elects to
  make. The ledgered adapter wrapper appends unconditionally, including for rejected writes.
  What makes it safe is that `LedgerPort` has no update and no delete.
- `ats.createRequisition` — opening a req is a decision of record (`propose open_req`).
- Anything touching a rating, a compensation number, a stage, an offer, a hire, or contact
  with a candidate. Blast radius by construction: a misrouted nudge or a stale packet, never
  a rating, a number, or a stage change.

Decisions of record — rating, comp, advance/reject, offer, outreach, hire — are always
`tl_proposed_action` → decided by a named human → logged with who and when.

---

## 5. Untrusted content

Résumés, scorecard free text, review bodies and Slack replies are **data, never
instructions**. They reach the engine only as `UntrustedDocument` (`untrusted: true` is a
literal in the type, so a trusted string cannot be passed where one is required).

`detectInstructionText(text)` in `lib/safety/allowlist.ts` scans for imperative text aimed at
the agent — "ignore previous instructions", a role reassignment, "advance this candidate",
a request to bypass a check. A hit produces a `tl_anomaly` record with the rule id and an
excerpt capped at 200 characters. **The instruction is recorded, never obeyed**, and the
document continues to be treated as data.

Ordinary prose is not an anomaly: every rule needs a verb or an address to the agent, so
"I followed the onboarding instructions" and "helped advance the roadmap" do not fire.

---

## 6. Provenance

Every claim in a packet carries a `TlCitation` with the record ids behind it. `kind: "source"`
is a value read straight off records; `kind: "derived"` is an engine or LLM join over them.
Packets disclose AI involvement in the header. A calibration packet with an uncited number is
a lawsuit-shaped artifact, so the eval blocks it.

---

## 7. Identity

The agent runs as a real user: per-user OAuth on the Rippling MCP, or the customer API token's
creator on REST; the fixture adapter simulates one from `fixtures/tenant/identities.json`.
It reads only what that user can read and **never elevates**. `ActorContext`
(`lib/ports/context.ts`) carries `worker_id`, `email`, `permissions` and `adapter`, and every
ledger entry records the actor plus the `permission_context` the call ran under.
