# Open questions for the user

Each has a recommended default; the build proceeds on the default until told otherwise.

| # | Question | Default we are proceeding on |
|---|---|---|
| Q1 | Who is the acting user per loop? The engine runs "as the user, with the user's permissions" (spec §9). | Review cycle: the HRBP. Interview loop: the recruiter on the req. Req approval: the hiring manager. Fixture `identities.json` models all three; `TL_ACTOR` switches. |
| Q2 | Rippling MCP / REST tenant: none available. M0–M2 run on fixtures only. | `rippling` adapters are stubs with real `codemode.*` names that throw `RipplingNotConnectedError`. When M3's `create_draft_hire` path needs a real call we stop and ask you to connect the Rippling MCP. |
| Q3 | Slack and Google Calendar: connect real MCPs for the demo? | Fixture channel/calendar adapters (outbox/inbox files) until you connect them. |
| Q4 | Spec says "3 reqs"; we seed 3 OPEN + 1 CLOSED historical req (see D5). OK? | Yes, unless you object. |
| Q5 | Should the calibration packet's `derived` summaries call an LLM in the POC, or stay template-rendered? | Template-rendered for M1; LLM summary + judge added in M4 evals. |
| Q6 | Prior-cycle ratings have no Rippling API (research 06: performance is redacted). The calibration packet reads `prior_ratings` straight from the fixture bundle — the only place `lib/cli` bypasses a port. On a real tenant, where would prior ratings come from (a `tl_review_submission` of the previous cycle, an export, or nothing)? | Keep the fixture read behind a clearly labeled seam; M4 turns it into a `PriorRatings` read on the Ats/Graph port with a Rippling stub. |
