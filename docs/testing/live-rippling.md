# M2.5 — Live Rippling MCP smoke (2026-09-02)

**Verdict: PARTIAL.** Connection and every read path work. Custom-object writes are blocked by the tenant's object quota. Several fixture assumptions must change before the `rippling` adapter can run the loops.

Tenant: Sleuth Enterprises, Inc. (the user's own company). Acting identity: the user (CEO, G&A, `America/Los_Angeles`). Connection: first-party Rippling MCP via MCP Gateway proxy, registered as a claude.ai connector, one tool `code` over `codemode.*`.

## What was run

| # | Call | Result |
|---|---|---|
| 1 | `claude mcp list` | `claude.ai Rippling … ✔ Connected` (gateway proxy URL, now in `.mcp.json`) |
| 2 | `lookup_me` | ok. Full profile: id, work_email, title, status, start_date, timezone, employment_type, manager, department, location (with address), legal_entity, `teams: null`, `level: null`, `redacted_fields: []` |
| 3 | `search_departments` | ok, 7 (Customer Success, Engineering, Finance→G&A, G&A, Marketing, Product, Sales). Departments have `parent_id` and `department_hierarchy_id` — the fixture has a flat list |
| 4 | `search_work_locations` | ok, 6 (with postal addresses; two in Berlin, one in Vilnius). **No work hours, no timezone on the location** — timezone is on the person |
| 5 | `search_leave_types` | ok, 12; each has `type` enum (`VACATION`, `SICK`, `CUSTOM`, `WFH`, …), `is_paid` |
| 6 | `search_teams` | ok, **0 teams** on this tenant |
| 7 | `search_legal_entities` | ok, 1 |
| 8 | `get_department_size` (Engineering) | ok, `active_employee_count: 3` |
| 9 | `search_people` | **requires a `query` string of ≥ 2 chars and matches names, not departments** (`Engineering` → 0). No department/status filter args are accepted. Enumeration must go through the org tree (`lookup_direct_reports` recursively) or `ask_ai` |
| 10 | `lookup_direct_reports` | ok. Returns `{ manager_id, total_direct_reports, direct_reports: [{id, display_name, status, title}] }` — thin rows; `is_manager` needs a `lookup_person` per row. Org walk from the CEO: 4 people (CTO → 2 senior engineers; Head of Finance) |
| 11 | `lookup_person` | ok, same shape as `lookup_me`. `manager` is `{id, display_name, work_email}` |
| 12 | `lookup_absence` | ok but **returns only `{ is_on_leave, current_leave }` — present-tense**. No date argument, no list of upcoming absences. Nobody was on leave, so the `current_leave` shape (and whether it carries an end date) is unverified |
| 13 | `lookup_time_off_balance` | ok; per-leave-type hour balances incl. `balance_including_future_requests_hours` — future PTO exists as hours, not dates |
| 14 | `list_custom_objects` / `list_custom_categories` | ok, 48 objects, all `zobject_generated.*` (LMS, Spend, Title, Files); 3 categories, all system |
| 15 | `create_custom_category` | **requires `description`** (an "Invalid request!" without it). Created `Talent Loops` (`6a98dcf42afd98fc7459dce9`) and, by a fallback in the same probe, a duplicate `talent_loops` (`6a98dcf77fd089520a59db5e`). Neither appears in `list_custom_categories` afterwards (still 3) — unexplained; both need cleanup or reuse from the UI |
| 16 | `setup_custom_object` (`tl_cycle`, 7 fields) | **`No more quota left for creating new objects.`** Blocked |
| 17 | `describe_custom_object` (`title`) | ok. Schema learned: every record has system fields `id`, `name`, `external_id`, `created_at`, `updated_at`, `system_updated_at`, `created_by`, `last_modified_by`, `owner_role`; field types are `TEXT`, `DATETIME`, `NATIVE_EDGE` (employee links), etc.; `list_custom_records` is cursor-paginated (`has_more`, `next_cursor`) |
| 18 | `create_custom_record` | not reachable (no object); the validator did reveal that records **must include a non-empty `name`** |

Argument contract learned the hard way: every `codemode.*` call must carry `telemetry: { intent }` inside its args, or the gateway rejects it.

## Fixture assumptions that do not survive contact

| Fixture / plan assumption | Reality | Consequence |
|---|---|---|
| `Location` has `work_hours` and `timezone` | Locations carry only an address; `timezone` is per person | Quiet hours must be computed from the worker's timezone with tenant-policy default hours (policy gets `work_hours.default`) |
| `Absence` is a dated list; `absenceOn(worker, date)` answers any date | MCP gives present-tense `is_on_leave` only | "No nudge while absent" works for *today*; "move the due date to return + N" needs `current_leave`'s end date (unverified) and **future-dated scheduling needs the REST Leave requests resource**, not the MCP |
| `Worker.level_id`, `team_id` | `level: null`, `teams: null` on this tenant | Same-level substitute logic and peer selection need a fallback (title match, or department) when levels/teams are unset |
| `search_people` enumerates by department | Name search only | Participants come from an org walk rooted at the cycle owner or department head |
| Departments are flat | Departments nest (`parent_id`) | Scope by `department_hierarchy_id` |
| Tier-2 objects are custom objects | Object creation quota exhausted on this tenant | Blocker for the custom-object design until the quota is raised (admin/plan setting) — see Q8 |
| `bin/*.mjs` call Rippling through `lib/adapters/rippling/*` | The MCP is reachable only from the Claude client that holds the OAuth token; Node cannot call it | The MCP path is **agent-executed**: the mode file has the agent run `codemode.*` and hand results to scripts; only the REST path (customer token) is script-executed. See D25 |

## Recommended next block (B2.6 — rippling adapter, once Q8 is answered)

1. Tier-1 mapping layer `lib/adapters/rippling/map.ts`: MCP profile → `Worker` (timezone from person, `level_id`/`team_id` nullable, `location_group` from `location.address.country`), departments with hierarchy, leave types, present-tense absence.
2. Agent-executed bridge: `bin/bridge.mjs import --from <json>` that ingests a snapshot the agent fetched via `codemode.*` into `TL_DATA_DIR/tier1/` and makes the Graph/Availability ports read it; the mode file gains a "fetch" step listing the exact `codemode.*` calls. Ledger lines record `adapter: rippling-bridge`.
3. Custom-object State/Ledger adapter behind the same bridge (`create_custom_record` with `external_id = tl_*` id and mandatory `name`), gated on quota.
4. Policy: `quiet_hours.default_work_hours`, `absence.source: mcp_current_leave | rest_leave_requests`.
