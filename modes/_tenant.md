<!-- generated-from: tenant/policy.yml — keep in sync; tests/modes/consistency.test.ts checks the numbers -->

# `_tenant.md` — this tenant's policy, in prose

Tenant layer (`DATA_CONTRACT.md` §1): the tenant's, never rewritten by an engine update. Every
number below is restated from `tenant/policy.yml` with its key path, because the engine reads
the YAML and you read this. **The YAML wins.** If a value here disagrees with what a script
reports, the script is right and this file is stale — say so in your summary and stop.

Nothing here is a safety rule. Policy sets the rhythm; `_shared.md` sets the limits.

## Who

This tenant is **Acme Robotics** (`tenant.name: Acme Robotics`). Unless `TL_ACTOR` says
otherwise, the agent acts as the seeded HR business partner identity
(`tenant.acting_identity_default: hrbp`) — worker `w_0021` in the fixture tenant — and reads
only what that person can read.

The policy is personalised, not the shipped starting point (`template: false`).
`node bin/doctor.mjs` refuses to tick while it is still a template, because a template policy
would nudge a hundred and twenty people on a stranger's cadence.

## Rhythm

- One tick a day (`cadence.tick_interval_hours: 24`). Ticks are idempotent, so an extra one is
  harmless — it just reports `changed: false`.
- A task is nudged at most three times (`cadence.max_attempts: 3`).
- Two nudges for the same task are never less than forty-eight hours apart
  (`cadence.nudge_min_gap_hours: 48`). A tick inside that window records the reason and sends
  nothing.

## Quiet hours

The engine stays silent outside the recipient's working hours in their own location's timezone
(`quiet_hours.respect_location_hours: true`), at weekends (`quiet_hours.weekends: true`), and on
their location's public holidays (`quiet_hours.holidays: true`). Quiet hours defer a nudge; they
do not move a due date and they do not skip an attempt.

## Channels

- Nudges go by Slack DM (`channels.nudge: slack_dm`).
- Escalations go by Slack DM (`channels.escalation: slack_dm`).
- Cycle summaries are posted to a channel (`channels.summary: slack_channel`), namely
  (`channels.summary_channel: #people-ops`).

## Escalation

An open task escalates once it is three days past due (`escalation.overdue_days: 3`) **or** once
it has already had two nudge attempts (`escalation.after_attempts: 2`), whichever trips first.
Every offender in the cycle is bundled into **one** escalation, addressed to the cycle owner
(`escalation.escalate_to: cycle_owner`). The escalation is a `tl_proposed_action` — a human
decides what to do about it.

## Absence

Rippling absence is authoritative. Someone with an approved absence is never nudged
(`absence.skip_nudge: true`); instead their due date moves once, to two days after they return
(`absence.move_due_date_days_after_return: 2`), and the move is recorded with the reason. A
pending absence is not an absence.

## Review cycles

Work is staggered from the day the cycle opens: self reviews are due immediately
(`review_cycle.stagger_days.self: 0`), peer reviews a week later
(`review_cycle.stagger_days.peer: 7`), and manager reviews two weeks later
(`review_cycle.stagger_days.manager: 14`). Each subject gets two peer reviewers
(`review_cycle.peers_per_subject: 2`), chosen deterministically from their own team.

## Interview loops (M2)

Panels are four interviewers (`interview_loop.panel_size: 4`). A scorecard is due within a day
of the interview (`interview_loop.scorecard_due_hours: 24`). When an interviewer declines, the
substitute must be at the same level (`interview_loop.substitute_same_level: true`).
