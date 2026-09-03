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
| Q7 | The Channel port's `readReplies` returns untrusted text with no author; the fixture routes by a `message_ref` convention. For a real Slack adapter, should the author be the Slack user id joined to a worker by email (SCIM on a tenant), and should scorecards ever arrive via Slack at all vs. a Rippling custom-object form? | Add `author_worker_id?` to `UntrustedDocument` in M2.5 when the real adapters are wired; scorecards via Slack stay a fixture convenience. |
| Q8 | **Blocker.** The tenant has no custom-object quota left (`setup_custom_object` → "No more quota left for creating new objects"; 48 Rippling-generated objects exist). Can an admin raise the quota, or is it plan-bound? If not, Tier-2 state stays in files (or a Rippling *Function*/App Studio app) and the "state in Rippling custom objects" claim becomes a demo of the write path only. | **Answered 2026-09-02:** raise the quota only if it adds no cost; otherwise file-backed. Proceeding file-backed. |
| Q9 | Two category creations returned ids but a later listing still shows only the 3 system categories. | **Resolved:** nothing persisted; no cleanup needed. |
| Q10 | Do you want a Rippling REST customer token (scopes: workers, departments, leave, custom objects, ATS reads) so scripts can call Rippling directly and dated absences are available? Without it the Rippling path is agent-executed only (D25) and absence is present-tense only. | **Answered 2026-09-02:** user will issue one. Used only for dated leave requests in the live run; no M3. |
| Q11 | In the live run, nudges to real Sleuth employees: outbox file only (default), or one real Slack DM to you alone as proof of the channel? | Outbox only unless you say otherwise. |
