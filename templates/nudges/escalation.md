Hi {{first_name}} — one escalation for **{{cycle_name}}**, not a pile of reminders.

{{task_count}} task(s) are past due (worst: {{worst_overdue_days}} day(s)) after the reminders
policy allows. Nobody who is on approved leave is in that count — their due dates moved instead.

Proposal **{{proposal_id}}** is waiting for your decision, with {{evidence_count}} record id(s)
attached as evidence. Nothing has been decided on your behalf:

    node bin/decide.mjs --proposal {{proposal_id}} --by <your_worker_id> --decision approve|decline

The cycle closes {{cycle_deadline}}.

_Cycle {{cycle_id}} · sent by the Talent Loops cycle engine._
