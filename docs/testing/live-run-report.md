# Live run — review cycle on the real Rippling tenant (2026-09-02/03)

**Verdict: PASS with two engine bugs found and fixed during the run.** The spec §8 loop-1 story ran end to end against real people at Sleuth through the Rippling MCP, with file-backed engine state, one message per person in their own timezone, one escalation with evidence, an owner decision of record, idempotent re-ticks, a complete ledger, and verify-loops green.

Runbook: `modes/live-run.md`. Adapter: `TL_ADAPTER=bridge`, data dir `data-live/` (gitignored; contains work emails). Acting user: the connected Rippling account (CEO). Nudges went to `data-live/outbox.jsonl` only (Q11) — no real Slack message was sent.

## Timeline

| Step | Clock | Command | What happened |
|---|---|---|---|
| Fetch | wall 03:07Z | Rippling `code` tool, plan from `bridge.mjs fetch-plan` | 20 `codemode.*` calls, all ok: `lookup_me`, departments (7), locations (6), leave types (12), teams (0), org walk 5 people (`lookup_person` + `lookup_absence` + `lookup_direct_reports` each). Nobody on leave. |
| Import | wall | `bridge.mjs import --from data-live/bridge/snapshot.json` | workers 5, departments 7, synthetic teams 3, synthetic levels 2, locations 7 (incl. `loc_unassigned` for 3 remote people), leave types 13, absences 0. Provenance written. Warnings: 4 empty offices, 3 remote people, no teams. |
| Doctor | wall | `doctor.mjs` | 10 checks: 9 ok, 1 warn (Slack/Calendar placeholders), `tier1_snapshot` ok. |
| Create | wall 03:09Z | `cycle.mjs create --type review --owner <me> --deadline 2026-09-17` | `tl_cycle_7c37f9d6`, whole-company scope. |
| Open | wall | `cycle.mjs open` | 5 participants, 13 tasks: 5 self (due 09-03), 4 peer (due 09-10), 4 manager (due 09-17); 13 pending review submissions. Manager chain correct: CEO→CTO, Head of Finance; CTO→two engineers. |
| Tick 1 | wall 03:10Z (20:10 PT) | `tick.mjs` | 13 quiet, 0 overdue; only `refresh_packet` (calibration). |
| Tick 2 | wall | `tick.mjs` | `changed: false`. |
| Tick 3 | `TL_NOW` 09-04 17:00Z (10:00 PT) | `tick.mjs` | 5 overdue; nudged CEO and CTO (`nudge.write_self_review.first`); 7 quiet (two engineers in Ljubljana at 19:00 — and, wrongly, the remote Head of Finance in LA). |
| Tick 3 again | same | `tick.mjs` | `changed: false`. |
| Tick 4 | `TL_NOW` 09-05 08:00Z (10:00 Ljubljana) | `tick.mjs` | 13 quiet — **bug 1**: remote people (no Rippling location) inherited the default LA timezone. Fixed in `c15c72e` (quiet hours from `Worker.timezone`). Also a Saturday, so the re-check moved to Monday. |
| Re-import | wall | `bridge.mjs import` | tier1 refreshed with the fixed mapper; state kept. |
| Tick 7 | `TL_NOW` 09-07 08:00Z (Mon 10:00 Ljubljana, US Labor Day) | `tick.mjs` | nudged both Ljubljana engineers; **one** `escalate` to the owner bundling all 5 overdue self-reviews, 7 evidence refs; cycle `running → escalated`. US participants quiet. |
| Tick 7 again | same | `tick.mjs` | `changed: false`. |
| Tick 8 | `TL_NOW` 09-08 17:00Z (10:00 PT) | `tick.mjs` | `changed: false` — all five self-review tasks are `escalated`, nothing left to nudge. |
| Decide | `TL_NOW` 09-08 17:30Z | `decide.mjs --decision approve --by <me>` | `tl_proposed_action_7eddae3c` → `approved`, `decided_by` = owner, note recorded; ledger `state.update` line carries actor and permission context. |
| Tick 9 | `TL_NOW` 09-08 18:00Z | `tick.mjs` | **bug 2**: a second `escalate` for the same five tasks, because only a `proposed` escalation counted as covering them. Fixed in `32fd6d2` (approved escalations keep covering; only a declined one releases). |
| Tick 10 | `TL_NOW` 09-08 19:00Z, after the fix | `tick.mjs` | `changed: false`; cycle stays `escalated` while the approved escalation is unresolved. |
| Cleanup | `TL_NOW` 09-08 19:10Z | `decide.mjs --decision decline` on the duplicate | Declined with a note naming the bug; the approved escalation stands. Final tick: `changed: false`. |
| Audit | — | `audit.mjs --format json` | final: 380 lines, 52 writes (46 state, 6 channel), 0 rejected, 0 errors, 9 ticks, 1 actor, 0 lines without `cycle_id`, every line `adapter: bridge`. |
| Verify | — | `verify-loops.mjs` | PASS, 114 checks, 0 findings. |

## Outbox (the only messages "sent")

| ts | to | template |
|---|---|---|
| 2026-09-04T17:00:00Z | CTO | nudge.write_self_review.first |
| 2026-09-04T17:00:00Z | CEO | nudge.write_self_review.first |
| 2026-09-07T08:00:00Z | engineer (Ljubljana) | nudge.write_self_review.first |
| 2026-09-07T08:00:00Z | engineer (Ljubljana) | nudge.write_self_review.first |
| 2026-09-07T08:00:00Z | CEO (owner) | escalation |
| 2026-09-08T18:00:00Z | CEO (owner) | escalation — the bug-2 duplicate |

The Head of Finance (remote, LA timezone) never received a nudge: quiet under bug 1 on 09-04, 01:00 local on 09-07, and by 09-08 already covered by the escalation. Policy interaction worth knowing: `escalation.overdue_days: 3` can supersede a person's first reminder when quiet windows and the tick cadence do not line up.

## Packet

`tl_packet` assembled at open: AI-involvement header; section 1 (prior ratings) empty because no prior-cycle data exists; section 2 states "Compensation not available via MCP" with a citation rather than a number; tenure and submission-completion tables cite worker and cycle ids; no email addresses. Weak spots: "Company mean across 0 rated workers: 0.00" should be suppressed when empty; "no manager on record" is the owner's own tasks and should say so.

## Sample ledger line (email redacted)

```json
{"cycle_id":"tl_cycle_7c37f9d6","actor":{"worker_id":"5e77920ebc3bc72a8281f73b","email":"<redacted>","adapter":"bridge"},"port":"channel","function":"sendDirect","args_hash":"9882010e…","args_summary":"{to_worker_id:5e779226fa9c4e6aac2d07b0,text:<redacted:350>,template_id:nudge.write_self_review.first}","permission_context":["rippling-mcp:access-assignment"],"tick_id":"163643dd…","ts":"2026-09-04T17:00:00Z","result":"ok","result_ref":"msg_63f42230","id":"tl_agent_action_182e7542"}
```

## Defects found by the run

| id | Where | What | Fix |
|---|---|---|---|
| L-1 | `lib/adapters/fixture/availability.ts`, bridge mapper | Quiet hours used the location's timezone; remote workers have no location → default zone → Ljubljana engineers reachable only during California hours | `c15c72e` — worker timezone wins; location supplies hours and holidays |
| L-2 | `lib/engine/plan.ts` rule (e), `detect.ts` | An approved escalation no longer counted as covering its tasks → duplicate escalation after the owner's decision | `32fd6d2` — `proposed` or `approved` escalations cover; `declined` releases |
| L-3 (cosmetic) | `lib/engine/packet-sections.ts` | Empty rating table prints a 0.00 mean; owner's own tasks labeled "no manager on record" | open |
