# Talent Loops — what the live run taught us

One clean run of the review-cycle loop against a real Rippling tenant, through the first-party Rippling MCP, with file-backed engine state. Evidence for every bullet is in `docs/testing/live-rippling.md` (the smoke pass), `docs/testing/live-run-report.md` (the run), and the run's ledger.

| | |
|---|---|
| Tenant | Sleuth Enterprises, Inc. (the user's own company) |
| Acting user | the user (CEO, G&A), per-user OAuth through the MCP Gateway proxy |
| Snapshot fetched at | 2026-09-03T03:07:55Z, 20 `codemode.*` calls, all ok |
| Workers / departments / locations | 5 in the org tree under the CEO / 7 (one nested) / 6 (3 people are remote with no location) |
| Cycle id | `tl_cycle_7c37f9d6` — "Sleuth H2 2026 review (live POC run)", 13 tasks (5 self, 4 peer, 4 manager) |
| Run window | opened 2026-09-03T03:09:59Z on the wall clock; later ticks under a frozen clock (`TL_NOW`, 09-04 → 09-08) to reach due dates, quiet windows and the escalation threshold without waiting a week |

---

## What we set out to prove

- Spec §1 claims 1–3 on real data: one cycle engine runs a loop as configuration; every write is ledgered and decisions of record are proposals only; the loop needs data from across the suite.
- The loop-1 story from spec §8: one message per person, a moved due date instead of a nudge for someone away, one escalation with evidence, an idempotent second tick, a packet whose every figure cites a record.
- That the M0–M2 engine, built and tested on fixtures, runs unchanged when the Tier-1 data comes from Rippling.

## What held

- **The engine and all ten CLIs ran unchanged.** `TL_ADAPTER=bridge` swapped only where Tier-1 data is read. `cycle create` → `open` built the real manager chain correctly (CEO reviews CTO and Head of Finance; CTO reviews the two engineers; engineers peer-review each other) — `data-live/state/tasks.json`.
- **Idempotence.** Tick 2 at the same clock: `changed: false`, zero actions. Repeated after every nudging or escalating tick: `changed: false` again.
- **One escalation with evidence, and a decision of record.** On the Monday tick the five overdue self-reviews produced exactly one `escalate` proposal to the owner with seven evidence refs and one DM; the cycle moved `running → escalated`; the owner's `decide.mjs approve` landed as a ledgered `state.update` with actor and permission context.
- **Per-person timezones, once fixed.** The Monday 08:00Z tick nudged the two Ljubljana engineers (10:00 local) while every US participant stayed quiet (01:00 Pacific, and Labor Day).
- **Quiet hours and overdue detection.** Tick 1 (20:10 Pacific) found 13 tasks quiet and nothing overdue, so it only assembled the packet. The frozen-clock tick at 10:00 Pacific on the day after the self-review due date found 5 overdue, 2 nudgeable, and sent exactly one DM each to the two people inside working hours, template `nudge.write_self_review.first`, into the outbox.
- **Ledger completeness.** 335 lines for the cycle by the end of the run, 51 writes (45 state, 6 channel), 0 rejected, 0 errors, every line `adapter: bridge`, actor = the connected user, zero lines without a `cycle_id`. `verify-loops` passed 114 checks over 11 rules.
- **The packet was honest about what it could not read.** Section 2 says "Compensation not available via MCP" with a citation instead of a fabricated compa-ratio; the AI-involvement header and the no-rating rule held; no email addresses appear.
- **More convincing than fixtures:** the org walk. Rippling's `lookup_direct_reports` plus `lookup_person` gave the exact reporting lines; nothing was guessed.

## What broke on contact with Rippling

- **Remote workers have no location** (3 of 5 here, `location: { type: 'REMOTE', id: null }`). The first mapping put them in a synthetic location on the policy's default timezone, so the two engineers in Ljubljana were "quiet" at 10:00 their time and reachable only during California hours. Fixed in `M2.5: quiet hours use worker timezone`: the person's own timezone governs quiet hours; location supplies work hours and holidays only. Fixture data never exercised this because every fixture worker has a location.
- **Locations carry no timezone and no hours.** Absorbed by the bridge: default work hours come from policy (`quiet_hours.default_work_hours`), timezone from the person.
- **`lookup_absence` is present-tense** (`is_on_leave`, `current_leave`). Absorbed for "no nudge while away today"; still open for "move the due date to return + N" and for interview scheduling, which need dated leave (REST `leave requests`). Nobody was on leave during the run, so `current_leave`'s shape is still unverified.
- **`level` and `teams` are null on this tenant.** Absorbed with synthetic `lvl_unknown`/`lvl_manager` and one team per department. Consequence: peer selection degraded to "same department", which for a four-person Engineering department meant the two engineers were each other's peers *and* both reviewed their manager upward. Spec §8's "same-level substitute" logic for interviews would degrade the same way.
- **`search_people` is name search only.** Absorbed by enumerating the org tree from the acting user. On a large tenant that is one `lookup_person` + one `lookup_absence` + one `lookup_direct_reports` per person, inside the 60-second isolate — fine for hundreds, a fan-out problem for thousands.
- **Departments nest.** Absorbed (`parent_department_id`); the cycle used whole-company scope.
- **The MCP is agent-executed.** The OAuth token lives in the Claude client; Node scripts cannot call `codemode.*`. The run therefore has a fetch step performed by the agent and an import step performed by a script, with provenance recording every call. Scripts still own every write to engine state, so "LLM plans, scripts enforce" survived — but "the adapter calls Rippling" did not.
- **Custom-object creation is blocked**: "No more quota left for creating new objects" (48 Rippling-generated objects exist). Tier-2 state stayed in files. Category creation succeeded twice but neither category is listed afterwards.
- **An approved escalation stopped counting as coverage.** The tick after the owner approved the escalation raised a second one for the same five tasks. Fixture tests had only ever decided proposals at the end of a scenario. Fixed in `M2.5: approved escalations stay covering`: `proposed` or `approved` escalations cover their tasks; only a `declined` one releases them.
- **Policy interaction:** with `escalation.overdue_days: 3`, a person whose quiet windows never met the tick cadence (the remote Head of Finance) reached escalation without ever receiving a first reminder. Escalation supersedes reminders by design, but the reminder ladder assumes at least one tick inside each person's working hours before day 3.
- Mapping warnings at import: four locations with no workers (noise), three people with no location (mattered — see the first bullet), no teams (mattered — peer selection).
- Not possible at all in this run: interview loop (candidates/applications are redacted from the MCP and there is no ATS REST token yet), compa-ratio (pay redacted), prior-cycle ratings (no API), a moved due date (nobody was on leave).

## What the MCP can and cannot do for talent loops

**Can:**

- Identify the acting user and inherit their permissions (`lookup_me`, `redacted_fields: []` for an admin).
- Walk the org (`lookup_direct_reports`, `lookup_person`), read departments with hierarchy, locations, leave types, present-tense absence, time-off balances.
- Read and describe custom objects, with paginated record listing; records carry native `name`, `external_id`, `created_by`, `owner_role` — a good fit for a ledger if objects can be created.
- Enforce its own contract: every call needs `telemetry: { intent }`, and validation errors name the missing argument, which made the schema discoverable without documentation.

**Cannot:**

- Read candidates, applications, requisitions, headcount or compensation (redacted by design). That blocks loops 2–4 entirely and half of the calibration packet. Those need REST with a customer token.
- Answer "is this person away on date X" or "when do they return" — only "are they away now".
- Give a location's timezone or hours, or a team or level unless the tenant maintains them.
- Enumerate people except by name or by tree.
- Create custom objects on a tenant at its quota, or delete a category.
- Be called from a script. Every `codemode.*` call is a model tool call.

## What AI Cloud should expose first (Tier 3 list, refined)

Ordered by what this run actually needed:

1. **Dated absence**: `lookup_absence({ worker_id, from, to })` returning approved leave ranges with return dates. Needed for the "moved due date" and for scheduling; the present-tense answer is not enough.
2. **Person enumeration with filters**: `search_people({ department_id, status, manager_id })`. The org walk works but fans out.
3. **Timezone and working hours as first-class facts** on the person (already there) and the location (missing), plus holidays by location.
4. **ATS reads through the MCP** (applications with stage, candidates, requisitions) under the same per-user permissions. Without them the interview loop cannot even be scoped.
5. **Compensation bands and compa-ratio as a derived, permissioned read** — the packet needs the ratio, never the amount.
6. **A custom-object quota and lifecycle that a POC can use**: create/delete objects and categories, and a visible quota.
7. **Review submissions, scorecards, interview slots** as real objects (the spec's Tier 3) — this run had to model all three in files.

## Recommendation

- The one-primitive claim held on real data: one engine, two loops on fixtures, one loop live, zero engine changes for the live run. Keep the engine and the safety seams; they are the reusable part.
- Treat the Rippling MCP as the **identity and org-graph layer**, agent-executed, and REST as the **data and write layer** for scripts. The bridge pattern (agent fetch with provenance → script import → scripts own every write) is the honest shape of an external build today.
- The next experiment that would teach the most is dated absence and one real Slack nudge to the acting user, both cheap. The next one that would change the architecture is a REST customer token with ATS scopes, because it is the only route to loops 2–4.
