# Research 6 — Rippling developer surface (REST + MCP) as of 2026-09-02

*Worker briefing for the POC spec; fetched content treated as untrusted; [inferred] marked. Date correction: Rippling AI launched 2026-03-18 (in-app approvals); the first-party Rippling MCP launched 2026-08-25; AI Governance suite (MCP Gateway, Agent Identity) 2026-08-20.*

## REST ("Rippling Platform API")
- Base `https://rest.ripplingapis.com`; docs developer.rippling.com/documentation/rest-api. Legacy v1 at api.rippling.com/platform/api for App Shop apps.
- **Auth:** (a) customer API token created in-app by Super/Full Admin, scoped (e.g. `candidate-applications.read`, `job-requisitions-write.read-write`, `headcount-positions.read`), = creator's permissions ∩ scopes, auto-revoked after 30 days unused, version-pinned; (b) partner OAuth via App Shop listing (partner company, ~10-day review, seeded test company). Portal "is not for Rippling customers building an integration for their own internal use."
- **Resources:** Workers/Users/Companies (R; `expand=employment,compensation`, manager on worker) · Departments/Teams/Locations (RW) · Levels/Tracks/Titles/Job functions (RW) · Custom fields (R) · **Custom objects/fields/records (full CRUD + bulk + query)** · Leave (RW) · Time (RW) · Compensation + bands (R; variable-comp payout W) · **Headcount positions/priorities (R only; expands to job_requisition, recruiter)** · **Draft hires (W → human review)** · **ATS job requisitions (R + create; no update/close listed)** · **ATS candidates (R)** · **ATS applications (R; status ACTIVE/REJECTED/HIRED/ARCHIVED, free-text stage, job_id)** · **ATS interviews/scorecards/offers/pipeline stages: NONE** · **Performance cycles/reviews/goals/calibration: NONE** · Approval/workflow objects: none · Supergroups (R + membership W) · **Functions (serverless, full CRUD + execute)** · **Webhooks: custom-object create/update/delete only** (customer side; employee/leave events only for partner apps).

## Rippling MCP (first-party, 2026-08-25)
- Remote MCP, per-user OAuth with Rippling identity; "works with any MCP-compliant client" (Claude, ChatGPT, Cursor, Gemini named; Claude Code via generic remote URL [inferred]).
- Gating: on by default per company, but NO employee has access until a Super/Full Admin creates an access assignment (IT › MCP Gateway › Rippling MCP › Access assignments, by Supergroup, tool-by-tool). **Tool calls return no data unless the company is on a Rippling AI trial/subscription.**
- **Shape: exactly one tool, `code`** — model writes JS against typed `codemode.*` functions, run in a fresh Cloudflare Dynamic Worker isolate (no network, no creds, 60s). 31 functions:
  - `ask_ai` (grounded NL read across products)
  - People/org (R): `lookup_me`, `lookup_person`, `lookup_direct_reports`, `search_people`, `get_department_size`, `search_departments`, `search_teams`, `search_work_locations`, `search_legal_entities`
  - Time off (R): `lookup_absence`, `lookup_time_off_balance`, `search_leave_types`; (W) `request_time_off` → normal manager approval queue
  - Hiring (W): `create_draft_hire` → draft for human review
  - Custom objects (R): `list_custom_objects`, `list_custom_categories`, `describe_custom_object`, `list_custom_records`, `lookup_custom_record`, `search_custom_records`; (W) `create/update/delete_custom_record`, `create/update/delete_custom_field`, `create_custom_category`, `update/delete/setup_custom_object` (deletes require confirmation)
- Redacted by design: candidates, applications, requisitions, headcount, compensation, performance, SSN/address/personal email/tax IDs/EEO/pay.
- Context: Runlayer sued Rippling 2026-07-28 alleging MCP Gateway copies its design.

## Action model
- Rippling AI in-app: actions "tee'd up for review… go through whatever approvals your company requires." Via MCP: time-off → pending approval; hire → draft; custom-object writes → direct per user privilege. **No generic "stage an action for approval" primitive exposed to third parties**; approval routing lives in Workflow Studio / App Studio (data-change / schedule / manual triggers, approvals, notifications) — workflow definitions not API-creatable [inferred]. Agent Identity Management (2026-08-20) registers third-party agents as governed identities.

## Slack / Calendar
- Nothing in REST or MCP. Rippling AI for Slack/Teams is a Rippling-installed bot; Workflow Studio can push Slack messages in-app only; Smart Scheduling reads Google/O365 calendars internally, no API. **A POC brings Slack's and Google Calendar's own APIs/MCPs.**

## Access for an outsider
- Partner test company only after App Shop acceptance; customer sandbox = copy of a live tenant; free trial exists for Rippling IT only; HR/Recruiting need a contract; Rippling AI needs its own trial; MCP needs an admin assignment. **A candidate cannot get real access without a customer admin's token or a partner account. Options: partner program (weeks), ask the hiring team for a test-company token/MCP assignment, or mock.**

## Comparables
- Community: bifrost-mcp/rippling-mcp (18 read tools, Feb 2026, dormant); BusyBee3333/Rippling-MCP-2026-Complete (claims ATS stage-update endpoints Rippling does not publish — treat as fictional); StackOne (37 actions mirroring REST); Truto (custom-object CRUD). No open-source multi-step HR loop orchestrator over Rippling found.
- **Greenhouse MCP** (open beta; read+write): candidates, applications (advance/reject), interviews (schedule/reschedule), scorecards, jobs, notes, users/departments. **Ashby MCP** (beta, per-user OAuth): read search/records/interviews/feedback/pipeline/tasks; write create candidate, add note, change stage, consider for job.

## Buildability matrix
| Loop | Rippling REST | Rippling MCP | Must mock |
|---|---|---|---|
| Review cycle | workers, manager lines, depts, levels, comp bands (R); custom objects model cycles/reviews (CRUD) | people lookups, `ask_ai`, custom-object CRUD | review cycles/reviews/goals/calibration (no API); Slack nudges; calendar |
| Interview loop | reqs (R/create), candidates + applications (R), draft hire (W) | `create_draft_hire`, people lookups, custom objects (interviews/scorecards) | interview events, scorecards, stage moves, offers; GCal + Slack via own APIs |
| Req/offer approvals | headcount positions (R), req create, comp bands, draft hire | `create_draft_hire` (real approval), custom "approval request" records | approval-chain state, offer objects, req open/close, workflow triggers |
| Rediscovery/mobility | workers + custom fields, levels/tracks, teams, headcount ↔ reqs, applications (status) | `search_people`, `lookup_person`, `ask_ai`, custom skills/match records | skills profiles, silver-medalist detail beyond status enum, performance signals, outreach |

Unverifiable from outside: field lists behind `expand`; whether `job-requisitions-write` supports later status updates; MCP client setup text; Rippling AI trial terms; whether the partner test company includes Recruiting/Performance data.
